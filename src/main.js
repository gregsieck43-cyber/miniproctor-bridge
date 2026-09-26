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
import { ProfileStore, ProfileStoreError, PERMISSION_POLICY_MODES, PROFILE_REGIONS } from './agents/profile-store.js';
import { AdapterFactory, SessionLaunchLedger } from './agents/adapter-factory.js';
import { identifyRuntime, sanitizeSelfReport, SELF_REPORT_MAX_BYTES } from './agents/identify.js';
import { resolveAgentKey, getCatalogEntry } from './agents/catalog.js';
import { EventOutbox } from './lib/outbox.js';
import { CommandInbox } from './lib/inbox.js';
import { WorkspaceLockManager, WORKSPACE_LOCK_DIR_NAME } from './lib/workspace-lock.js';
import { acquireInstanceLock, InstanceLockError, inspectInstanceLock } from './lib/instance-lock.js';
import { isRevocationError } from './agent/session-manager.js';
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
  status [--offline]                   只读状态：单实例锁 + 配对 + 服务端绑定真实读回
                                       （device.json 存在 ≠ 绑定有效，§9；--offline 跳过网络往返）
  profiles list [--all]                列出本机 Agent 配置实例（--all 含已停用；不含已删除）
  profiles register --agent-key <key> --command <cmd>
      [--display-name <n>] [--region cn|global|unknown] [--mode readonly|ask|allowlist]
      [--cwd <path>] [--self-report-file <path>]
                                       登记/幂等更新 profile（受控发现 + --version 探测，V12-08；
                                       §9 自报 JSON 经白名单校验后仅作来源记录，V12-14）
  profiles doctor [--profile <id>]     逐 profile 复检可执行/版本/工作区并更新 health
  doctor [--no-check-agent]            环境自检
  pair [--relay-url ...]               配对
  demo                                 本机 mock Agent 演示`;

export async function main(argv = process.argv.slice(2)) {
  const [command = 'doctor', ...rest] = argv;
  if (command === 'doctor') return doctor(rest);
  if (command === 'pair') return pair(rest);
  if (command === 'run') return runSession(rest);
  if (command === 'workspace') return workspaceCmd(rest);
  if (command === 'status') return statusCmd(rest);
  if (command === 'profiles') return profilesCmd(rest);
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
    // V12-11：单 supervisor 逐任务适配调度——本机 profile 存储（V12-08）→ AdapterFactory
    // 生成冻结启动 spec；launch ledger 记录 profile 会话（原生 ID 归档 + 重启对账恢复）。
    const profileStore = new ProfileStore({ dir: config.bridge.dataDir });
    const launchLedger = new SessionLaunchLedger({ dir: config.bridge.dataDir });
    const adapterFactory = new AdapterFactory({ profileStore });
    // V12-13：写任务工作区互斥锁——同 realpath（盘符大小写/symlink/WSL 统一）只允许
    // 一个任务；崩溃残留锁在 SessionManager 构造对账中回收（不抢活锁）。
    const workspaceLocks = new WorkspaceLockManager({
      dir: path.join(config.bridge.dataDir, WORKSPACE_LOCK_DIR_NAME),
    });
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
      // V12-11：profile 路由（create_session 携带 agent_profile_id 时按冻结 spec 执行，
      // 绝不 fallback defaultSpec，§8.2/N09）+ 恢复记录（构造时重启对账）
      adapterFactory,
      launchLedger,
      // V12-13：写任务工作区互斥 + 每 profile 并发上限（§8.3；保守默认 2，2/4/8 实测挂 T22）
      workspaceLocks,
      maxSessionsPerProfile: Number(config.bridge.maxSessionsPerProfile) || 2,
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
    // V12-13：初始会话同样占工作区锁——远程 create 与初始会话同目录双写也被拦截；
    // 初始会话是用户本机显式操作（CLI run 即授权）：占锁失败只告警不拒绝启动。
    const initialLock = workspaceLocks.acquire({
      cwd: session.cwd,
      sessionId,
      profileId: null,
      agentKey: agentType,
    });
    if (!initialLock.ok) {
      console.warn(`[workspace-lock] 初始会话占锁未成功（reason=${initialLock.reason}）：该目录的远程 create 互斥可能不完整`);
    }
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
 * status 子命令（V12-14，§9）：只读状态——单实例锁 + 本地配对 + 服务端绑定真实读回。
 *
 * 为什么要真实读回（§9 原文）：device.json 存在不等于绑定有效——本地文件可能是撤销前的
 * 陈旧身份。这里做一次真实 pullCommands 往返（与 run 心跳同一条通道、同一种鉴权），
 * 按响应分类：ok → 绑定有效；unauthorized + revoked/binding-not-active → 已撤销；
 * 其他网络/服务端错误 → active=null（结果未知，诚实呈现，不猜）。
 *
 * 用途：
 *   1. 安装提示词的幂等检查（取代「扫描任意 main.js/run 进程」的宽泛进程探测——
 *      §9：安装进程识别用自己数据目录的锁/实例ID）；
 *   2. 配对幂等检查不再只看 device.json 是否存在；
 *   3. 新旧安装路径 / 权限 / 绑定错误可诊断。
 * 不修改任何文件；一次 pull 会刷新服务端 last_seen_at（与 run 心跳同语义，无副作用）。
 */
async function statusCmd(args) {
  const offline = args.includes('--offline');
  const config = loadConfig();
  const state = loadDeviceState(config);
  const lockStatus = inspectInstanceLock(config.bridge.dataDir);
  const skipRoundTripReason = !state ? 'no-device-state'
    : offline ? 'offline-flag'
      : config.relay.kind === 'wss' ? 'wss-status-not-supported'
        : null;
  const out = {
    data_dir: config.bridge.dataDir,
    paired: Boolean(state),
    device_id: state?.device_id || null,
    instance_lock: lockStatus,
    binding: {
      checked: false,
      active: null,
      generation: null,
      reason: skipRoundTripReason,
    },
  };
  if (skipRoundTripReason === null) {
    try {
      // 与 run 心跳同一条通道、同一种鉴权：一次真实 pullCommands 往返即绑定读回
      //（云端 pullCommands 成功响应携带 binding_generation，一并读回展示，§9）
      const transport = makeTransport(config, {
        deviceId: state.device_id,
        tokenHash: state.token_hash || null,
        privateKey: state.private_key || null,
      });
      const res = await transport.pullCommands();
      out.binding = {
        checked: true,
        active: res.ok === true,
        generation: Number.isFinite(res.data?.binding_generation) ? res.data.binding_generation : null,
        reason: res.ok ? 'pull-ok' : 'unexpected-response',
      };
    } catch (err) {
      if (isRevocationError(err)) {
        // 已撤销：明确 active=false（本地 device.json 是陈旧身份，需重新配对）
        out.binding = { checked: true, active: false, generation: null, reason: 'binding-revoked' };
      } else {
        // 网络/服务端/凭据错误：绑定有效性未知——不伪造成功也不误判撤销
        out.binding = { checked: true, active: null, generation: null, reason: String(err?.code || err?.message || 'transport-error').slice(0, 120) };
      }
    }
  }
  console.log(JSON.stringify(out, null, 2));
  return { ok: true, ...out };
}

/**
 * profiles 子命令（V12-08）：本机 Agent 配置实例的 list / register / doctor。
 * 输出与 doctor/workspace 一致走 JSON；错误路径显式设置退出码（脚本可判定，P3-I 口径）。
 * 安全边界：register 只接受本机 CLI 参数——手机端任意 command/args/env/path 一律不在此通道
 * （§7.1）；unknown agent_key 一律拒绝，绝不回退 claude-code（T12）。
 */
async function profilesCmd(args) {
  const [action = 'list', ...rest] = args;
  const config = loadConfig();
  const store = new ProfileStore({ dir: config.bridge.dataDir });
  try {
    if (action === 'list') {
      const includeDisabled = rest.includes('--all');
      const profiles = store.list({ includeDisabled });
      const rows = profiles.map((p) => ({
        profile_id: p.profile_id,
        agent_key: p.agent_key,
        display_name: p.display_name,
        revision: p.revision,
        status: p.status,
        region: p.region,
        adapter_version: p.adapter_version,
        health: p.health?.status ?? 'unknown',
        workspaces: Array.isArray(p.workspace_allowlist) ? p.workspace_allowlist.length : 0,
      }));
      const out = { profiles: rows };
      console.log(JSON.stringify(out, null, 2));
      return { ok: true, ...out };
    }

    if (action === 'register') {
      const flag = (name) => {
        const idx = rest.indexOf(name);
        return idx >= 0 ? rest[idx + 1] : undefined;
      };
      const agentKeyInput = flag('--agent-key');
      const commandInput = flag('--command');
      if (!agentKeyInput || !commandInput) {
        console.error('usage: node src/main.js profiles register --agent-key <key> --command <cmd> [--display-name <n>] [--region <r>] [--mode <m>] [--cwd <path>] [--self-report-file <path>]');
        process.exitCode = 2;
        return { ok: false, reason: 'missing-required-flag' };
      }
      // 目录解析：unknown 一律拒绝（识别优先级最低为 unknown，不猜 Claude）
      const agentKey = resolveAgentKey(agentKeyInput);
      if (!agentKey) {
        console.error(`[profiles] 未知 agent_key：${agentKeyInput}（目录中不存在该产品；请核对 xcx/bridge/src/agents/catalog-entries/）`);
        process.exitCode = 1;
        return { ok: false, reason: 'unknown-agent-key' };
      }
      const entry = getCatalogEntry(agentKey);
      if (entry.lifecycle === 'deprecated') {
        console.error(`[profiles] ${agentKey} 已停服（lifecycle=deprecated），不推荐新安装（见 ${entry.docs_ref}）`);
        process.exitCode = 1;
        return { ok: false, reason: 'agent-deprecated' };
      }
      // 受控发现 + --version 探测（只走 PATH/用户指定路径，带超时与输出上限；§7.1）
      // V12-14（§9）：自报 JSON（installer_identity/runtime_candidate）属不可信输入——
      // 先白名单化再交给 identifyRuntime（只用于选择探测参数与记录来源，绝不升级身份）。
      // 文件大小受 SELF_REPORT_MAX_BYTES 约束；提供但非法 → 明确告警并不记录（unknown 不编造），
      // 不阻塞登记本身（agent_key 永远来自本机校验过的 --agent-key）。
      let selfReportInput = null;
      const selfReportFile = flag('--self-report-file');
      const selfReportInline = flag('--self-report');
      if (selfReportFile !== undefined && selfReportInline !== undefined) {
        console.error('[profiles] --self-report-file 与 --self-report 只能二选一');
        process.exitCode = 2;
        return { ok: false, reason: 'self-report-ambiguous' };
      }
      if (selfReportFile !== undefined) {
        try {
          const stat = fs.statSync(selfReportFile);
          if (stat.size > SELF_REPORT_MAX_BYTES) {
            console.warn(`[profiles] 警告：自报文件超过 ${SELF_REPORT_MAX_BYTES} 字节上限，已忽略（installer_identity 将记为 null）`);
          } else {
            selfReportInput = fs.readFileSync(selfReportFile, 'utf8');
          }
        } catch (err) {
          console.warn(`[profiles] 警告：自报文件不可读（${err?.message || err}），已忽略（installer_identity 将记为 null）`);
        }
      } else if (selfReportInline !== undefined) {
        selfReportInput = selfReportInline;
      }
      let sanitizedReport = null;
      if (selfReportInput !== null) {
        const sanitized = sanitizeSelfReport(selfReportInput);
        if (sanitized.ok) {
          sanitizedReport = sanitized.self_report;
        } else {
          // 畸形/超限/未知 schema：不阻塞登记，但绝不编造身份字段（§9「unknown 不编造」）
          console.warn(`[profiles] 警告：自报 JSON 未通过白名单校验（${sanitized.reason}），本次登记不记录 installer_identity/self_report`);
        }
      }
      const identification = await identifyRuntime({ command: commandInput, agentKey, selfReport: sanitizedReport });
      if (identification.verdict === 'suspicious') {
        console.error(`[profiles] 拒绝登记：解析出的二进制存在疑点 ${JSON.stringify({ resolved_path: identification.runtime.resolved_path, reasons: identification.reasons })}`);
        process.exitCode = 1;
        return { ok: false, reason: 'suspicious-binary', identification };
      }
      if (identification.verdict === 'unknown') {
        console.warn(`[profiles] 警告：版本探测未通过（${identification.reasons.join('; ')}），profile 将以 health=unreachable 登记；可用 profiles doctor 复检`);
      }
      const regionInput = flag('--region') ?? 'unknown';
      if (!PROFILE_REGIONS.includes(regionInput)) {
        console.error(`[profiles] --region 必须是 ${PROFILE_REGIONS.join('|')} 之一`);
        process.exitCode = 2;
        return { ok: false, reason: 'invalid-region' };
      }
      const modeInput = flag('--mode') ?? 'ask';
      if (!PERMISSION_POLICY_MODES.includes(modeInput)) {
        console.error(`[profiles] --mode 必须是 ${PERMISSION_POLICY_MODES.join('|')} 之一（无自动批准形态）`);
        process.exitCode = 2;
        return { ok: false, reason: 'invalid-permission-policy' };
      }
      const cwdInput = flag('--cwd');
      // V12-14：自报身份仅作来源记录（§7.1 第 1/2 种身份严格分离）——不参与运行身份，
      // 不改变 display_name/权限；display_name 仍以 CLI 显式值 > 目录默认值。
      const selfReportRecord = sanitizedReport
        ? { ...sanitizedReport, captured_at: Date.now(), identify_verdict: identification.verdict }
        : undefined;
      const result = store.register({
        agent_key: agentKey,
        command: commandInput,
        resolved_path: identification.runtime.resolved_path,
        display_name: flag('--display-name') ?? entry.display_name,
        region: regionInput,
        adapter_version: identification.runtime.version_line,
        workspace_allowlist: cwdInput ? [cwdInput] : [],
        permission_policy: { mode: modeInput },
        health: identification.verdict === 'probe-ok'
          ? { status: 'ok', last_checked_at: Date.now(), detail: `probe-ok: ${identification.runtime.version_line ?? ''}`.trim() }
          : { status: 'unreachable', last_checked_at: Date.now(), detail: identification.reasons.join('; ').slice(0, 200) },
        installer_identity: sanitizedReport ? sanitizedReport.installer_identity : undefined,
        self_report: selfReportRecord,
      });
      console.log(`[profiles] ${result.created ? 'created' : 'updated'} profile`, JSON.stringify({
        profile_id: result.profile.profile_id,
        agent_key: result.profile.agent_key,
        revision: result.profile.revision,
        health: result.profile.health.status,
      }));
      return { ok: true, ...result };
    }

    if (action === 'doctor') {
      const idx = rest.indexOf('--profile');
      const targetId = idx >= 0 ? rest[idx + 1] : null;
      const candidates = targetId
        ? [store.get(targetId)].filter(Boolean)
        : store.list({ includeDisabled: true });
      if (targetId && candidates.length === 0) {
        console.error(`[profiles] profile 不存在：${targetId}`);
        process.exitCode = 1;
        return { ok: false, reason: 'profile-not-found' };
      }
      const rows = [];
      for (const p of candidates) {
        // 复检 = 重新受控发现 + 版本探测 + 工作区存在性（纯本机，无网络、无提权）
        const identification = await identifyRuntime({ command: p.executable_ref.command, agentKey: p.agent_key });
        const workspaceIssues = [];
        for (const ws of p.workspace_allowlist) {
          try {
            if (!fs.statSync(ws).isDirectory()) workspaceIssues.push(`not-directory:${ws}`);
          } catch {
            workspaceIssues.push(`missing:${ws}`);
          }
        }
        const catalogEntry = getCatalogEntry(p.agent_key);
        let health;
        if (identification.verdict === 'suspicious') {
          health = { status: 'degraded', last_checked_at: Date.now(), detail: `suspicious:${identification.runtime.suspicious.join('+')}` };
        } else if (workspaceIssues.length > 0) {
          health = { status: 'degraded', last_checked_at: Date.now(), detail: `workspace:${workspaceIssues.join(';').slice(0, 160)}` };
        } else if (identification.verdict === 'probe-ok') {
          health = { status: 'ok', last_checked_at: Date.now(), detail: `probe-ok: ${identification.runtime.version_line ?? ''}`.trim() };
        } else {
          health = { status: 'unreachable', last_checked_at: Date.now(), detail: identification.reasons.join('; ').slice(0, 200) };
        }
        const updated = store.update(p.profile_id, { health });
        rows.push({
          profile_id: p.profile_id,
          agent_key: p.agent_key,
          lifecycle: catalogEntry?.lifecycle ?? 'unknown',
          verdict: identification.verdict,
          resolved_path: identification.runtime.resolved_path,
          version_line: identification.runtime.version_line,
          workspaces: { total: p.workspace_allowlist.length, issues: workspaceIssues },
          health: { status: updated.health.status, detail: updated.health.detail },
          revision: updated.revision,
        });
      }
      const out = { profiles: rows, recovered_from_backup: store.recoveredFromBackup() };
      console.log(JSON.stringify(out, null, 2));
      const degraded = rows.some((r) => r.health.status !== 'ok');
      if (degraded) process.exitCode = 1; // 有不健康项：退出码 1（脚本可判定），报告仍完整输出
      return { ok: !degraded, ...out };
    }

    console.error('usage: node src/main.js profiles [list [--all]|register ...|doctor [--profile <id>]]');
    process.exitCode = 2;
    return { ok: false, reason: 'unknown-action' };
  } catch (err) {
    if (err instanceof ProfileStoreError) {
      console.error(`[profiles] ${err.message}`);
      process.exitCode = 1;
      return { ok: false, reason: err.code };
    }
    throw err;
  }
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
