/**
 * V12-06（桥接部分）：本地适配器 HTTP 服务的安全基座（零依赖，node:http）。
 *
 * 任务卡要点：「本地 ACP/HTTP 适配端口仅 loopback + 随机端口 + 每实例认证」。
 * 适用于 local-api 集成形态的适配器（如 OpenCode 本地 server、codearts local server）：
 * 这类端口一旦绑到 0.0.0.0/局域网地址，同网段任何机器都能对 Agent 下发指令。
 *
 * 三道硬约束（都在本模块内强制，调用方无法绕过）：
 *   1. 仅 loopback：listen 地址硬编码 127.0.0.1（调用方传 host 一律忽略并告警）；
 *      URL 白名单 assertLoopbackUrl 只接受字面量回环地址——'localhost' 依赖 DNS 解析
 *      （hosts 文件/解析器可改指局域网），同样拒绝（fail-closed）；
 *   2. 随机端口：固定 port=0 由操作系统分配，杜绝固定端口被本机其他进程抢占/预绑；
 *   3. 每实例认证：创建时生成 256-bit 随机 token，比对用 crypto.timingSafeEqual
 *      （防时序侧信道）；无 token / 错 token 请求一律 401，不进 handler。
 *
 * token 明文只在创建返回值里出现一次（供本机合法调用方持有）；后续核对只透出 sha256
 * 摘要（token_hash）。凭据材料绝不进日志（打印该对象时注意，见 V12-06 验收）。
 */
import http from 'node:http';
import crypto from 'node:crypto';

/** 回环地址白名单（字面量）：IPv4 回环段 127.0.0.0/8 与 IPv6 ::1。 */
const LOOPBACK_V4 = /^127(?:\.\d{1,3}){3}$/;

/** 判断 hostname 是否为字面量回环地址（'localhost' 一律 false——依赖 DNS 解析，fail-closed）。 */
export function isLoopbackHost(hostname) {
  const host = String(hostname ?? '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) return false;
  if (LOOPBACK_V4.test(host)) return true;
  return host === '::1';
}

/**
 * URL 回环校验：协议必须 http/https、必须带端口显式形态之外的正常解析、host 必须是
 * 字面量回环地址、禁止 userinfo（user:pass@host——凭据进 URL 本身就是泄漏面）。
 * @returns {{ ok: true, url: URL } | { ok: false, reason: string }}
 */
export function assertLoopbackUrl(rawUrl) {
  let url;
  try {
    url = new URL(String(rawUrl ?? ''));
  } catch {
    return { ok: false, reason: 'invalid-url' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { ok: false, reason: 'invalid-protocol' };
  if (url.username || url.password) return { ok: false, reason: 'userinfo-forbidden' };
  if (!isLoopbackHost(url.hostname)) return { ok: false, reason: 'host-not-loopback' };
  return { ok: true, url };
}

function sha256Hex(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

/** 恒时比较两个字符串（长度不一致也走完整比较路径，不泄漏长度信息）。 */
function timingSafeEqualStr(a, b) {
  const bufA = Buffer.from(String(a ?? ''), 'utf8');
  const bufB = Buffer.from(String(b ?? ''), 'utf8');
  if (bufA.length !== bufB.length) {
    // 长度不同时仍做一次假比较以恒定耗时形态返回 false
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * 创建受控 loopback 服务。
 * @param {object} opts handler(req,res) 已认证后才调用；tokenHeader 认证头名；
 *   host 仅接受 127.0.0.1（其余值忽略并告警——不给任何绑到非回环的口子）。
 * @returns {{ host:'127.0.0.1', port:number, token, token_hash, url,
 *             authenticate(req), listen(), close(), address() }}
 */
export function createLoopbackServer({ handler, tokenHeader = 'x-miniproctor-token', host = '127.0.0.1' } = {}) {
  if (typeof handler !== 'function') throw new TypeError('createLoopbackServer requires handler');
  if (host !== '127.0.0.1') {
    // fail-closed：调用方想绑别的地址一律忽略——本地适配端口只允许回环（V12-06 要点）
    process.stderr.write('[loopback-server] host 参数被忽略：本地适配端口仅允许 127.0.0.1\n');
  }
  const token = crypto.randomBytes(32).toString('hex'); // 每实例独立 token（要点 3）
  const server = http.createServer((req, res) => {
    const presented = req.headers?.[tokenHeader.toLowerCase()];
    if (!timingSafeEqualStr(presented, token)) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }
    try {
      handler(req, res);
    } catch (err) {
      // handler 抛错不向未认证/已认证双方泄漏堆栈细节，只回 500 计数
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
      }
      res.end(JSON.stringify({ error: 'handler-failed' }));
    }
  });
  // 连接登记：close() 时主动断开 keep-alive 存量连接，保证 close 语义确定（不悬挂）
  const connections = new Set();
  server.on('connection', (conn) => {
    connections.add(conn);
    conn.on('close', () => connections.delete(conn));
  });
  // port 固定 0：由操作系统随机分配（要点 2），杜绝固定端口抢占/预绑。
  // 注意：不在构造时启动监听——由 listen() 显式启动，事件监听先于启动注册。
  server.on('error', () => { /* 未 listen() 前的异常由 listen() 的 promise 路径裁决 */ });

  return {
    host: '127.0.0.1',
    get port() {
      return server.address()?.port ?? null;
    },
    token,
    token_hash: sha256Hex(token),
    get url() {
      return `http://127.0.0.1:${this.port}/`;
    },
    /** 供非 HTTP 通道复用的认证判定（与 HTTP 层同一套 token/比对逻辑）。 */
    authenticate(req) {
      const presented = req?.headers?.[tokenHeader.toLowerCase()];
      return timingSafeEqualStr(presented, token);
    },
    /** 启动监听并校验真实绑定地址/端口（resolve 后 address 必为 127.0.0.1）。 */
    listen() {
      return new Promise((resolve, reject) => {
        const onError = (err) => {
          server.removeListener('listening', onListening);
          reject(err);
        };
        const onListening = () => {
          server.removeListener('error', onError);
          const addr = server.address();
          resolve({ host: addr.address, port: addr.port });
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(0, '127.0.0.1');
      });
    },
    address() {
      return server.address();
    },
    close() {
      return new Promise((resolve) => {
        server.close(() => resolve());
        for (const conn of connections) {
          try { conn.destroy(); } catch { /* 已断开 */ }
        }
      });
    },
  };
}
