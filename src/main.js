import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadConfig, inferAgentType } from './lib/config.js';
// inferAgentType 实现移至 lib/config.js（P1-A 参数预设与能力协商共用同一推断源）；
// 此处保留导出兼容既有 import 路径。
export { inferAgentType };
import { SessionManager } from './agent/session-manager.js';
import { buildDoctorReport } from './lib/doctor.js';
import { resolveCommandPath } from './lib/command-resolve.js';
import { HttpPollTransport } from './transport/http-poll.js';
import { WssTransport } from './transport/wss.js';
import { CloudGatewayTransport } from './transport/cloud-gateway.js';
import { EndpointTransport } from './transport/endpoint.js';
import { createPairingOffer, evaluatePairingStatus } from './pairing/pair.js';
import { loadAgentConfig } from './lib/agent-config.js';
import { EventOutbox } from './lib/outbox.js';
import { CommandInbox } from './lib/inbox.js';
import { acquireInstanceLock, InstanceLockError, inspectInstanceLock } from './lib/instance-lock.js';
import { setEventPolicy } from './lib/events.js';
import { createLogger } from './lib/log.js';
import { writeDeviceStateFile } from './cloud/device-keys.js';

const eventLog = createLogger('events');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEMO_AGENT = path.resolve(__dirname, '../demo/demo-agent.mjs');

const USAGE = `usage: node src/main.js [doctor|pair|run|demo|workspace]

  run [options]                        启动 bridge daemon（初始会话 + 手机命令轮询）
    --command <cmd>      覆盖 config 的 agent.command（CLI 显式覆盖时不再追加 config.agent.args）
    --arg <value>        追加 agent 参数（可重复）
    --agent-type <t>     claude-code|codex|generic（缺省按 command 名推断；决定能力协商）
    --cwd <path>         初始会话工作区（本机操作即授权，不受工作区列表限制）
    --exit-when-idle     所有会话结束后退出；缺省驻留等待手机新建任务（create_session）
    --max-run-ms <ms>    看门狗：到期停止全部会话
    --relay-url <url> --relay-kind <kind> --device-id <id> --poll-ms <ms> --push-batch-ms <ms>
  workspace add <path>|list            维护授权工作区（远程 create_session 只允许落在列表内，D4）
  doctor [--no-check-agent]            环境自检
  pair [--relay-url ...]               配对
  demo                                 本机 mock Agent 演示`;

export async function main(argv = process.argv.slice(2)) {
  const [command = 'doctor', ...rest] = argv;
  if (command === 'doctor') return doctor(rest);
  if (command === 'pair') return pair(rest);
  if (command === 'run') return runSession(rest);
  if (command === 'workspace') return workspaceCmd(rest);
  if (command === 'demo') return runSession(['--command', process.execPath, '--arg', DEMO_AGENT, '--relay-url', 'http://127.0.0.1:8790', '--max-run-ms', '10000', '--exit-when-idle']);
  console.error(`unknown command: ${command}`);
  console.error(USAGE);
  process.exitCode = 2;
  return { ok: false, reason: 'unknown-command' };
}

// 按 command 名推断 agent 类型：实现见 lib/config.js inferAgentType（P1-A 起与
// config 参数预设共用同一推断源），此处仅 re-export 供既有 import 使用。

async function doctor(args = []) {
  const checkAgent = !args.includes('--no-check-agent');
  const config = loadConfig();
  const state = loadDeviceState(config);
  const agentConfig = loadAgentConfig(config.agent.cwd);
  const out = buildDoctorReport({
    config,
    paired: Boolean(state),
    deviceId: state?.device_id || null,
    agentConfig: {
      source: agentConfig.source,
      miniproctor: agentConfig.miniproctor,
      ui: Boolean(agentConfig.ui),
    },
    // 真实探测：win32 走 where、posix 走 which（5s 超时）；--no-check-agent 可跳过
    checkAgent,
    probe: (command) => resolveCommandPath(command, { cwd: config.agent.cwd }),
    // CLOSE-010：单实例锁状态（只读检查；held/corrupt/stale 等异常状态在 checks 中可见）
    lockStatus: inspectInstanceLock(config.bridge.dataDir),
  });
  console.log(JSON.stringify(out, null, 2));
  return out;
}

async function pair(args) {
  const config = loadConfig();
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--relay-url') config.relay.baseUrl = args[i + 1];
    if (args[i] === '--device-id') config.bridge.deviceName = args[i + 1];
    if (args[i] === '--max-wait-ms') config.bridge.maxWaitMs = Number(args[i + 1]);
  }
  const maxWaitMs = config.bridge.maxWaitMs || 10 * 60 * 1000;
  const offer = createPairingOffer({ deviceId: config.bridge.deviceName });
  // WssTransport 无配对方法（registerPairing/pairingStatus），配对阶段回退 http-poll（与重构前行为一致）
  const transport = config.relay.kind === 'wss'
    ? new HttpPollTransport({ baseUrl: config.relay.baseUrl, timeoutMs: config.relay.timeoutMs, deviceId: config.bridge.deviceName, tokenHash: offer.token_hash })
    : makeTransport(config, {
        deviceId: config.bridge.deviceName,
        tokenHash: offer.token_hash,
        privateKey: offer.private_key,
      });

  // TASK-006：transport 失败（网络/非2xx/非法响应）统一抛 TransportError——
  // 配对阶段失败必须显式呈现，不再把失败对象误当响应消费。
  let registered;
  try {
    registered = await transport.registerPairing(offer);
  } catch (err) {
    registered = { ok: false, data: { error: err?.message || String(err) } };
  }
  if (!registered.ok) {
    console.warn('[pairing] register failed', JSON.stringify(registered.data || {}));
    // P3-I（CLOSE-007）：失败路径显式设置退出码——脚本可判定（旧版打印 ok:false 但 exit=0）
    process.exitCode = 1;
    return { ok: false, reason: 'register-pairing-failed', response: registered };
  }

  console.log('[pairing] waiting for phone');
  console.log(`[pairing] code=${offer.pairing_code}`);
  console.log(`[pairing] url=miniproctor://bind?pairing_id=${offer.pairing_id}&nonce=${offer.nonce}`);

  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1000));
    // 查询失败（网络抖动/配对尚未注册可见）不中断轮询，等待下次或超时
    let status = null;
    try {
      status = await transport.pairingStatus(offer.pairing_id);
    } catch {
      status = null;
    }
    const verdict = evaluatePairingStatus(status?.data?.status);
    if (verdict.action === 'bound') {
      const state = {
        // TASK-004 ①：device_id 由服务端在领取时生成（稳定随机 hex）并随 checkPairing
        // 返回，新版 bridge 优先采用；旧云端无该字段时回退本地 offer.device_id，
        // 与已部署版本行为一致（向后兼容：checkPairing 响应字段只加不删）。
        device_id: (status?.data && status.data.device_id) || offer.device_id,
        device_name: config.bridge.deviceName,
        token_hash: offer.token_hash,
        token: offer.token,
        pairing_id: offer.pairing_id,
        public_key: offer.public_key,
        private_key: offer.private_key,
        paired_at: Date.now(),
      };
      saveDeviceState(config, state);
      console.log('[pairing] bound', JSON.stringify({ device_id: state.device_id, paired_at: state.paired_at }));
      return { ok: true, bound: true, device_id: state.device_id };
    }
    if (verdict.action === 'abort') {
      // 终态（过期/尝试超限作废）提前退出，不再空等到 max-wait-ms
      console.warn(`[pairing] ${verdict.reason}`);
      process.exitCode = 1; // P3-I：失败路径显式退出码（脚本可判定）
      return { ok: false, reason: verdict.reason, pairing_id: offer.pairing_id };
    }
  }
  // P3-I：等待窗口耗尽（手机未扫码/未确认）同为失败——显式退出码供脚本判定
  process.exitCode = 1;
  return { ok: false, reason: 'pairing-timeout', pairing_id: offer.pairing_id };
}

/**
 * run：bridge daemon 主入口（TASK-012 生命周期解耦）。
 *   - 初始会话退出/失败只结束该会话（session_exit 终态事件），daemon 继续驻留服务
 *     手机新建任务（E12 修复：不再 stopAll 连坐全部会话）；
 *   - --exit-when-idle：所有会话结束后优雅退出（测试/一次性运行）；
 *   - SIGINT/SIGTERM：整体关停（stopAll + outbox 排空后退出，复用 TASK-006 语义）。
 */
async function runSession(args) {
  const config = loadConfig();
  // TASK-019 ②①：thinking/sensitive 事件上传策略——config bridge.uploadThinking 默认
  // 缺省（=false，降级为脱敏占位事件），config.json 显式 bridge.uploadThinking=true 才透传正文。
  setEventPolicy({ uploadThinking: config.bridge?.uploadThinking === true });
  let command = config.agent.command;
  let maxRunMs = 0;
  let exitWhenIdle = args.includes('--exit-when-idle');
  let agentTypeFlag = null;
  let cwdOverride = null;
  const agentArgs = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--command') command = args[i + 1];
    if (args[i] === '--max-run-ms') maxRunMs = Number(args[i + 1]);
    if (args[i] === '--arg') agentArgs.push(args[i + 1]);
    if (args[i] === '--relay-url') config.relay.baseUrl = args[i + 1];
    // 测试/本地联调用：强制 transport 形态（mock relay 只会说 http-poll 协议）
    if (args[i] === '--relay-kind') config.relay.kind = args[i + 1];
    if (args[i] === '--device-id') config.bridge.deviceName = args[i + 1];
    if (args[i] === '--poll-ms') config.bridge.pollIntervalMs = Number(args[i + 1]);
    if (args[i] === '--push-batch-ms') config.bridge.pushBatchMs = Number(args[i + 1]);
    if (args[i] === '--agent-type') agentTypeFlag = args[i + 1];
    if (args[i] === '--cwd') cwdOverride = args[i + 1];
  }
  // E12 修复：config.agent.args 对【所有】适配器生效（不再仅 claude）——
  // 用户配置 agent.command=codex 时其专属参数必须到达命令行。
  // CLI 显式 --command 覆盖时视为本地临时调试，不混入 config 参数。
  if (!args.includes('--command')) agentArgs.push(...(config.agent.args || []));

  // 能力协商的 agent 类型：CLI flag > config.agent.adapter（显式非 auto）> 按 command 推断
  const inferred = inferAgentType(command);
  const explicitAdapter = config.agent.adapter && config.agent.adapter !== 'auto' ? config.agent.adapter : null;
  const agentType = agentTypeFlag || explicitAdapter || inferred;
  if (agentTypeFlag && agentTypeFlag !== inferred) {
    console.warn(`[agent-type] CLI 显式指定 ${agentTypeFlag}（按 command 推断为 ${inferred}）——能力协商以显式值为准`);
  }

  // CLOSE-010：单实例锁——同一 dataDir 只允许一个 bridge 实例执行命令循环。
  // 双开/锁不可用（权限、磁盘）都明确拒绝启动：宁可不起，也不出现两实例同时
  // 执行同一批不可逆命令。
  let instanceLock = null;
  try {
    instanceLock = acquireInstanceLock(config.bridge.dataDir);
  } catch (err) {
    if (err instanceof InstanceLockError) {
      console.error(`[instance-lock] ${err.message}`);
      process.exitCode = 1;
      return { ok: false, reason: err.code || 'instance-lock', holder: err.holder || null };
    }
    throw err;
  }
  console.log(`[instance-lock] acquired pid=${process.pid} dir=${config.bridge.dataDir}`);

  try {
    const agentConfig = loadAgentConfig(config.agent.cwd);
    if (agentConfig.ok) {
      console.log('[agent-config]', JSON.stringify({ source: agentConfig.source, miniproctor: agentConfig.miniproctor, ui_block_present: Boolean(agentConfig.ui) }));
      const poll = agentConfig.miniproctor?.bridge?.poll_interval_ms;
      if (Number.isInteger(poll) && poll > 0) config.bridge.pollIntervalMs = poll;
    }

    const state = loadDeviceState(config);
    const sessionId = `s_${crypto.randomUUID()}`;
    const transport = makeTransport(config, {
      deviceId: state?.device_id || config.bridge.deviceName,
      tokenHash: state?.token_hash || null,
      privateKey: state?.private_key || null,
    });
    if (transport instanceof WssTransport) await transport.connect();
    // TASK-006/007：持久 outbox/inbox 与 device.json 同目录（config.bridge.dataDir）——
    // 事件先落盘再发送；命令执行记录持久化；重启后自动恢复重发/去重。
    // 持久化仅对真实云端 transport（endpoint/cloud）启用；http-poll（mock/自建测试中继）
    // 与 wss（预留）用内存模式——避免本地测试向数据目录写入跨运行状态。
    const persistentQueues = config.relay.kind === 'endpoint' || config.relay.kind === 'cloud';
    const outbox = new EventOutbox({
      dir: persistentQueues ? path.join(config.bridge.dataDir, 'outbox') : null,
      transport,
    });
    const inbox = new CommandInbox({
      dir: persistentQueues ? path.join(config.bridge.dataDir, 'inbox') : null,
    });
    if (persistentQueues) {
      console.log(`[queues] persistent outbox/inbox at ${config.bridge.dataDir} (outbox pending=${outbox.stats().pending}, inbox=${inbox.stats().total})`);
    }
    const auditFile = path.join(config.bridge.dataDir, 'audit.log');
    const manager = new SessionManager({
      transport,
      pollIntervalMs: config.bridge.pollIntervalMs,
      pushBatchMs: Number(config.bridge.pushBatchMs) || 0,
      outbox,
      inbox,
      // TASK-008：审批 deadline / 超时动作（config.bridge.permissionTimeout*）
      permissionTimeoutMs: Number(config.bridge.permissionTimeoutMs) || 10 * 60 * 1000,
      permissionTimeoutAction: config.bridge.permissionTimeoutAction,
      // TASK-012：授权工作区 / 并发上限 / 本机审计
      workspaces: Array.isArray(config.bridge.workspaces) ? config.bridge.workspaces : [],
      maxSessions: Number(config.bridge.maxSessions) || 8,
      auditFile,
      // TASK-011：授权撤销感知——pull 收到 unauthorized(binding-not-active/revoked) 时
      // SessionManager 停止轮询并回调这里；本地 device.json 改名归档（不删除：用户密钥
      // 资产，重新配对会生成新文件），outbox 存量由撤销后的 flush 按永久失败 dead-letter。
      onRevoked: () => archiveDeviceState(config),
      onEvent: (sid, event) => {
        // TASK-019/E21：完整 event 不再 console.log 全文（正文可能含消息/diff/密钥形态文本）。
        // 默认只打摘要（type/session_id/字节数/标记，复用 TASK-022 log.js 脱敏管线写 stderr）；
        // MINIPROCTOR_DEBUG=1 时才输出全文（本地排障专用，不进常规日志）。
        if (process.env.MINIPROCTOR_DEBUG === '1') {
          console.log(`[event ${event.seq}] ${sid} ${event.event_type} ${JSON.stringify(event)}`);
          return;
        }
        let bytes = 0;
        try { bytes = Buffer.byteLength(JSON.stringify(event), 'utf8'); } catch { bytes = -1; }
        eventLog.info('event', {
          session_id: sid,
          seq: event.seq,
          event_type: event.event_type,
          bytes,
          truncated: event.metadata?.truncated === true ? 1 : undefined,
          redacted: event.metadata?.redacted === true ? 1 : undefined,
        });
      },
      onSessionEnded: (sid) => {
        console.log(`[session-ended] ${sid} (active=${manager.sessions.size})`);
        // E12 修复：初始会话退出只结束该会话；仅 --exit-when-idle 且全部会话结束时收尾
        if (exitWhenIdle && !shuttingDown && manager.sessions.size === 0) {
          shutdown('exit-when-idle');
        }
      },
      // create_session（手机新建任务）用本机 agent 配置拉起会话
      defaultSpec: { agentType, command, args: agentArgs },
    });
    outbox.start(1000); // 后台 pump：驱动退避重试
    const session = manager.startSession({
      sessionId,
      agentType,
      command,
      args: agentArgs,
      cwd: cwdOverride || config.agent.cwd,
    });
    manager.startPolling();
    console.log(`[started] ${sessionId} agent=${agentType} ${command} ${agentArgs.join(' ')}`);

    let initialExitInfo = null;
    session.runner.once('exit', (info) => {
      initialExitInfo = info;
      // E12 修复：初始会话退出只打日志（终态已由 session_exit 事件回流），daemon 继续运行。
      // status 取会话终态（显式停止 → ended；崩溃/异常 → failed），与 session_exit 事件一致。
      console.log(`[initial-session-exit] ${sessionId} status=${session.status} code=${info.code} signal=${info.signal || ''}${info.error ? ` error=${info.error.message || info.error}` : ''}`);
    });

    // 优雅退出：SIGINT/SIGTERM / exit-when-idle / watchdog → stopAll（含退出排空期限）后退出
    let shuttingDown = false;
    let keepAlive = null;
    let resolveRun;
    const runPromise = new Promise((resolve) => { resolveRun = resolve; });
    const shutdown = (reason) => {
      if (shuttingDown) return;
      shuttingDown = true;
      if (keepAlive) clearInterval(keepAlive);
      console.warn(`[shutdown] ${reason} received, draining outbox (deadline ${manager.drainDeadlineMs}ms)…`);
      void (async () => {
        try {
          await manager.stopAll();
        } catch (err) {
          console.error('[shutdown] stopAll failed:', err?.message || err);
        } finally {
          outbox.stop();
          resolveRun({
            ok: initialExitInfo ? session.status === 'ended' : true,
            reason,
            exit_info: initialExitInfo
              ? { code: initialExitInfo.code, signal: initialExitInfo.signal, error: initialExitInfo.error?.message || null }
              : null,
          });
        }
      })();
    };
    process.once('SIGINT', () => shutdown('SIGINT'));
    process.once('SIGTERM', () => shutdown('SIGTERM'));

    if (!exitWhenIdle) {
      // daemon 驻留：无会话时仍等待手机 create_session（keep-alive 不 unref，撑住事件循环）
      keepAlive = setInterval(() => {}, 60 * 60 * 1000);
    }

    let watchdog = null;
    if (Number.isInteger(maxRunMs) && maxRunMs > 0) {
      watchdog = setTimeout(async () => {
        console.warn(`[watchdog] max-run-ms=${maxRunMs} reached, stopping sessions`);
        try {
          await manager.stopAll();
        } catch (err) {
          console.error('[watchdog] stopAll failed:', err?.message || err);
        }
        // exit-when-idle 下 stopAll 触发的退出回调会收尾；驻留模式下会话已全停，直接关停
        if (!exitWhenIdle) shutdown('watchdog');
      }, maxRunMs);
      watchdog.unref?.();
    }

    const result = await runPromise;
    if (watchdog) clearTimeout(watchdog);
    return result;
  } finally {
    // 所有退出路径（优雅关停/异常/看门狗）都释放单实例锁；释放失败留下的锁文件
    // 由下次启动的陈旧检测接管（持有进程已不存在）。
    instanceLock.release();
  }
}

/** workspace 子命令：维护授权工作区列表（realpath 规范化后写入 config 文件，D4）。 */
async function workspaceCmd(args) {
  const [action = 'list', ...rest] = args;
  const configPath = process.env.MINIPROCTOR_CONFIG || 'config.json';
  if (action === 'list') {
    const config = loadConfig(configPath);
    const workspaces = Array.isArray(config.bridge.workspaces) ? config.bridge.workspaces : [];
    console.log(JSON.stringify({ workspaces }, null, 2));
    return { ok: true, workspaces };
  }
  if (action === 'add') {
    const target = rest[0];
    if (!target) {
      console.error('usage: node src/main.js workspace add <path>');
      process.exitCode = 2;
      return { ok: false, reason: 'missing-path' };
    }
    let real = null;
    try {
      const st = fs.statSync(target);
      if (!st.isDirectory()) throw new Error('not a directory');
      real = fs.realpathSync(target);
    } catch (err) {
      console.error(`[workspace] invalid path (${err?.message || err})`);
      process.exitCode = 1;
      return { ok: false, reason: 'invalid-path' };
    }
    let fileConfig = {};
    if (fs.existsSync(configPath)) {
      try {
        fileConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      } catch (err) {
        console.error(`[workspace] config parse failed: ${err?.message || err}`);
        process.exitCode = 1;
        return { ok: false, reason: 'config-parse-failed' };
      }
    }
    const list = Array.isArray(fileConfig?.bridge?.workspaces) ? fileConfig.bridge.workspaces.map(String) : [];
    if (!list.includes(real)) list.push(real);
    fileConfig.bridge = { ...(fileConfig.bridge || {}), workspaces: list };
    try {
      fs.mkdirSync(path.dirname(path.resolve(configPath)), { recursive: true });
      fs.writeFileSync(configPath, `${JSON.stringify(fileConfig, null, 2)}\n`, 'utf8');
    } catch (err) {
      console.error(`[workspace] config write failed: ${err?.message || err}`);
      process.exitCode = 1;
      return { ok: false, reason: 'config-write-failed' };
    }
    console.log(`[workspace] authorized: ${real}`);
    return { ok: true, workspaces: list };
  }
  console.error('usage: node src/main.js workspace [add <path>|list]');
  process.exitCode = 2;
  return { ok: false, reason: 'unknown-action' };
}

function statePath(config) {
  return path.join(config.bridge.dataDir, 'device.json');
}

/**
 * 授权撤销后的本地身份归档（TASK-011 ⑤）：device.json → device.json.revoked。
 * 改名而非删除：文件内是用户密钥资产（私钥/token），归档保留审计与用户自证能力；
 * 重新配对会生成全新的 device.json（旧 token 已在云端吊销，不复用、不复活）。
 * 归档失败只告警不抛错——撤销处理不应因文件系统问题阻塞停止轮询的主语义。
 */
export function archiveDeviceState(config, logger = console) {
  const src = statePath(config);
  const dest = `${src}.revoked`;
  try {
    if (!fs.existsSync(src)) return { ok: false, reason: 'no-device-state' };
    // Windows 上 rename 不能覆盖已存在目标：先清旧归档（只覆盖归档件，不碰源件）
    try { fs.rmSync(dest, { force: true }); } catch { /* ignore */ }
    fs.renameSync(src, dest);
    logger.warn?.(`[revoked] device.json 已归档为 device.json.revoked（凭据已吊销；重新配对将生成新身份文件）`);
    return { ok: true, archived: dest };
  } catch (err) {
    logger.error?.(`[revoked] device.json 归档失败（不影响停止轮询）: ${err?.message || err}`);
    return { ok: false, reason: 'archive-failed', error: err?.message || String(err) };
  }
}

/** 按 relay.kind 构造 transport：cloud=AppSecret 网关（开发者自用）；endpoint=公网直连（公开运营，无 AppSecret）；wss/http-poll=自建中继。 */
function makeTransport(config, { deviceId, tokenHash, privateKey }) {
  if (config.relay.kind === 'cloud') {
    return new CloudGatewayTransport({ config, deviceId, tokenHash, privateKey });
  }
  if (config.relay.kind === 'endpoint') {
    return new EndpointTransport({ config, deviceId, tokenHash, privateKey });
  }
  if (config.relay.kind === 'wss') {
    return new WssTransport({ url: config.relay.baseUrl, timeoutMs: config.relay.timeoutMs, tokenHash });
  }
  return new HttpPollTransport({ baseUrl: config.relay.baseUrl, timeoutMs: config.relay.timeoutMs, deviceId, tokenHash });
}

function saveDeviceState(config, state) {
  fs.mkdirSync(config.bridge.dataDir, { recursive: true });
  // TASK-019 ④：device.json 含 ed25519 私钥——原子写（临时文件+rename）+ 最小权限
  // （POSIX chmod 600 / Windows attrib +h 与 icacls 尽力而为），实现见 cloud/device-keys.js
  writeDeviceStateFile(statePath(config), state);
}

function loadDeviceState(config) {
  try {
    return JSON.parse(fs.readFileSync(statePath(config), 'utf8'));
  } catch {
    return null;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (result) => console.log('[done]', JSON.stringify(result)),
    (err) => { console.error(err); process.exitCode = 1; },
  );
}
