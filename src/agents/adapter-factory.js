/**
 * V12-11：AdapterFactory（按 verified adapter+version 实例化）与 SessionLaunchLedger
 * （profile 恢复记录 / 重启对账）。
 *
 * 契约来源：主方案 §7.1/§8.2/§8.3 与 src/agents/adapter-contract.md §0/§2/§4：
 *   - create_session 携带 agent_profile_id 时，启动规格只能来自该 profile 的冻结 spec——
 *     任何解析失败都是明确错误（ProfileRouteError.code），绝不 fallback defaultSpec（§8.2/N09）；
 *   - adapter_id 保持协议路由，启动配方及 verified create 按 agent_key 单独验证；
 *     没有本地配方或该产品 verification.create 未 verified 时不拉新进程；
 *   - bridge 二次验证本地 profile：存在/未删除/未停用/revision 一致/agent_key 一致/
 *     可执行文件真实路径存在（§8.2）；profile 自带 workspace_allowlist 由 session-manager
 *     叠加校验（spec 携带冻结副本）；
 *   - spec 生成即冻结（Object.freeze）：运行中 profile 热改不影响已创建会话（T07）；
 *   - 启动参数默认取随发行的 product-runtime 静态配方；可注入 launchArgsResolver
 *     覆盖测试规格，不接受云端下发可执行参数模板。
 */
import fs from 'node:fs';
import path from 'node:path';
import { getCatalogEntry } from './catalog.js';
import { ADAPTER_CAPABILITIES } from '../adapters/capabilities.js';
import { getProductRuntime } from './product-runtime.js';
import { JUNIE_PLAN_PROFILE_VERSION } from './junie-plan-client.js';
import { DSH_RUNTIME_VERSION } from './dsh-sdk-client.js';
import { WORKBUDDY_PROFILE_VERSION, workbuddyRuntimeRoot } from './workbuddy-native-worker.js';
import { ZCODE_PROFILE_VERSION, zcodeProfileRuntime } from './zcode-runtime-probe.js';
import { GEMINI_PROFILE_VERSION, geminiProfileRuntime } from './gemini-runtime-probe.js';

/** profile 路由失败码（与 event-protocol.md §14.4 扁平错误串对齐；§14.4 未列的为本机校验扩展）。 */
export const PROFILE_ROUTE_ERROR_CODES = Object.freeze([
  'profile-not-found',
  'profile-deleted',
  'profile-disabled',
  'profile-revision-conflict',
  'profile-agent-mismatch',
  'profile-capability-unsupported',
  'profile-executable-missing',
  'invalid-profile-route',
]);

export class ProfileRouteError extends Error {
  constructor(message, { code = 'invalid-profile-route' } = {}) {
    super(message);
    this.name = 'ProfileRouteError';
    this.code = code;
  }
}

/** pid 存活探测（与 profile-store.js pidAlive 同口径；EPERM=存在但无权信号 → 视为存活）。 */
function pidAliveDefault(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

export class AdapterFactory {
  /**
   * @param {object} opts
   * @param {ProfileStore} opts.profileStore 本机 profile 存储实例（V12-08）
   * @param {Function} [opts.launchArgsResolver] ({ agentKey, adapterId, profile }) => string[]
   *   测试注入启动参数；生产缺省取 product-runtime 的产品静态配方。
   * @param {Function} [opts.fileExists] 路径存在性检查（测试注入）；默认 fs.existsSync
   */
  constructor({ profileStore, launchArgsResolver = null, fileExists = (p) => fs.existsSync(p) } = {}) {
    if (!profileStore) throw new TypeError('AdapterFactory requires profileStore');
    this.profileStore = profileStore;
    this.launchArgsResolver = typeof launchArgsResolver === 'function' ? launchArgsResolver : null;
    this._fileExists = fileExists;
  }

  /**
   * 解析 profile.agent_key → verified adapter（能力校验 create 最低门槛）：
   *   - catalog 条目必须存在（profile 登记时已拒绝 unknown，防御兜底）；
   *   - adapter_id 必须是已实现适配器（ADAPTER_CAPABILITIES 有行）；
   *   - 产品必须有本机静态启动配方；verified create 双闸门：① catalog 的该产品
   *     verification.create.status='verified'；② 产品开放能力 create=true。
   *     不能借同一个 generic adapter 下其他产品的验证结果放行。
   * @returns {{ entry, adapterId, runtime }}
   * @throws {ProfileRouteError} 'profile-capability-unsupported'
   */
  resolveVerifiedAdapter(agentKey) {
    const entry = getCatalogEntry(agentKey);
    if (!entry) {
      throw new ProfileRouteError(`profile.agent_key 无目录条目：${JSON.stringify(agentKey)}`, { code: 'profile-capability-unsupported' });
    }
    const adapterId = entry.adapter_id;
    if (!ADAPTER_CAPABILITIES[adapterId]) {
      throw new ProfileRouteError(`adapter 未实现：${adapterId}（agent_key=${agentKey}）`, { code: 'profile-capability-unsupported' });
    }
    const runtime = getProductRuntime(agentKey);
    const verifiedCreate = entry.verification?.create?.status === 'verified'
      && runtime?.adapterId === adapterId
      && runtime.open.create === true;
    if (!verifiedCreate) {
      throw new ProfileRouteError(
        `adapter ${adapterId}（agent_key=${agentKey}）create 能力未通过验证门槛，不得实例化新会话`,
        { code: 'profile-capability-unsupported' },
      );
    }
    return { entry, adapterId, runtime };
  }

  /**
   * 按 profile 生成冻结启动 spec（V12-11/N09 核心）。任何校验失败抛 ProfileRouteError，
   * 调用方（session-manager）绝不 fallback defaultSpec。
   *
   * @param {object} p
   * @param {string} p.profileId 命令携带的 agent_profile_id
   * @param {number|null} [p.revision] 命令携带的 agent_profile_revision（成对出现由 session-manager 强制）
   * @param {string|null} [p.commandAgentKey] 云端命令盖章的 agent_key（存在则与 profile 比对）
   * @returns {FrozenSpec} { profileId, profileRevision, agentKey, agentType, command, args,
   *   adapterVersion, capabilitySnapshot, workspaceAllowlist }（整体与数组字段均冻结）
   */
  createFrozenSpec({ profileId, revision = null, commandAgentKey = null } = {}) {
    const id = String(profileId || '').trim();
    if (!id) throw new ProfileRouteError('agent_profile_id 为空', { code: 'invalid-profile-route' });
    const profile = this.profileStore.get(id);
    if (!profile) throw new ProfileRouteError(`profile 不存在：${id}`, { code: 'profile-not-found' });
    if (profile.deleted_at !== null) throw new ProfileRouteError(`profile 已删除：${id}`, { code: 'profile-deleted' });
    if (profile.status !== 'active') throw new ProfileRouteError(`profile 已停用：${id}`, { code: 'profile-disabled' });
    if (revision !== null && revision !== undefined) {
      const rev = Number(revision);
      if (!Number.isInteger(rev) || rev < 1 || rev !== profile.revision) {
        throw new ProfileRouteError(
          `profile revision 冲突：命令携带 ${JSON.stringify(revision)}，本机 profile.revision=${profile.revision}`,
          { code: 'profile-revision-conflict' },
        );
      }
    }
    if (commandAgentKey) {
      const normalized = String(commandAgentKey).trim().toLowerCase();
      if (normalized && normalized !== profile.agent_key) {
        throw new ProfileRouteError(
          `命令 agent_key=${normalized} 与 profile.agent_key=${profile.agent_key} 不一致`,
          { code: 'profile-agent-mismatch' },
        );
      }
    }
    const { adapterId, runtime } = this.resolveVerifiedAdapter(profile.agent_key);
    if (profile.agent_key === 'junie' && profile.adapter_version !== JUNIE_PLAN_PROFILE_VERSION) {
      throw new ProfileRouteError('Junie 原生版本未经此单轮 Plan 配方验证', { code: 'profile-capability-unsupported' });
    }
    if (profile.agent_key === 'dsh' && profile.adapter_version !== DSH_RUNTIME_VERSION) {
      throw new ProfileRouteError('DSH 原生版本未经此单轮 SDK 配方验证', { code: 'profile-capability-unsupported' });
    }
    if (profile.agent_key === 'workbuddy' && profile.adapter_version !== WORKBUDDY_PROFILE_VERSION) {
      throw new ProfileRouteError('WorkBuddy 桌面与内嵌CLI版本未经固定原生配方验证', { code: 'profile-capability-unsupported' });
    }
    if (profile.agent_key === 'zcode' && profile.adapter_version !== ZCODE_PROFILE_VERSION) {
      throw new ProfileRouteError('ZCode CLI/Node/SDK版本未经固定配方验证', { code: 'profile-capability-unsupported' });
    }
    if (profile.agent_key === 'gemini-cli' && profile.adapter_version !== GEMINI_PROFILE_VERSION) {
      throw new ProfileRouteError('Gemini CLI/Node/Core版本未经固定配方验证', { code: 'profile-capability-unsupported' });
    }
    const ref = profile.executable_ref || {};
    const command = String(ref.resolved_path || ref.command || '').trim();
    if (!command) throw new ProfileRouteError(`profile 缺少可执行命令：${id}`, { code: 'profile-executable-missing' });
    // 真实路径存在性（§8.2 二次验证）：resolved_path 必须存在；无 resolved_path 的路径形态
    // command（含分隔符）也检查——裸命令名留给 spawn 期 PATH 解析（与 defaultSpec 同口径）。
    if (ref.resolved_path) {
      if (!this._fileExists(command)) {
        throw new ProfileRouteError(`profile 可执行文件不存在：${command}`, { code: 'profile-executable-missing' });
      }
    } else if (/[\\/]/.test(command) && !this._fileExists(command)) {
      throw new ProfileRouteError(`profile 可执行文件不存在：${command}`, { code: 'profile-executable-missing' });
    }
    const args = this.resolveLaunchArgs({ agentKey: profile.agent_key, adapterId, profile, runtime });
    const isJunie = profile.agent_key === 'junie';
    const isDsh = profile.agent_key === 'dsh';
    const isWorkbuddy = profile.agent_key === 'workbuddy';
    const isZcode = profile.agent_key === 'zcode';
    const isGemini = profile.agent_key === 'gemini-cli';
    let geminiRuntime;
    if (isGemini) {
      try { if (!ref.resolved_path) throw new Error(); geminiRuntime = geminiProfileRuntime(command); }
      catch { throw new ProfileRouteError('Gemini 需要已解析的官方CLI入口绝对路径', { code: 'profile-executable-missing' }); }
    }
    let zcodeRuntime;
    if (isZcode) {
      try { if (!ref.resolved_path) throw new Error(); zcodeRuntime = zcodeProfileRuntime(command); }
      catch { throw new ProfileRouteError('ZCode 需要已解析的官方CLI入口绝对路径', { code: 'profile-executable-missing' }); }
    }
    let workbuddyRoot;
    if (isWorkbuddy) {
      try { if (!ref.resolved_path) throw new Error(); workbuddyRoot = workbuddyRuntimeRoot(command); }
      catch { throw new ProfileRouteError('WorkBuddy 需要本机已解析的签名宿主绝对路径', { code: 'profile-executable-missing' }); }
    }
    if (isJunie && (!ref.resolved_path || !path.isAbsolute(command))) {
      throw new ProfileRouteError('Junie 需要本机已解析的原生绝对路径', { code: 'profile-executable-missing' });
    }
    if (isDsh && (!ref.resolved_path || !path.isAbsolute(command) || !/\.[cm]?js$/i.test(command))) {
      throw new ProfileRouteError('DSH 需要本机已解析的官方 Node CLI 入口绝对路径', { code: 'profile-executable-missing' });
    }
    return Object.freeze({
      profileId: profile.profile_id,
      profileRevision: profile.revision, // 冻结创建时刻 revision（profile 热改不影响本会话）
      agentKey: profile.agent_key,
      agentType: adapterId,
      command: isJunie || isDsh || isWorkbuddy || isZcode || isGemini ? process.execPath : command,
      args: Object.freeze([...args]),
      productEnv: isJunie ? Object.freeze({ ...runtime.env, MINIPROCTOR_JUNIE_EXECUTABLE: command })
        : isDsh ? Object.freeze({ ...runtime.env, MINIPROCTOR_DSH_ENTRY: command })
          : isWorkbuddy ? Object.freeze({ ...runtime.env, MINIPROCTOR_WORKBUDDY_RUNTIME_ROOT: workbuddyRoot })
            : isZcode ? Object.freeze({ ...runtime.env, MINIPROCTOR_ZCODE_SOURCE: zcodeRuntime.sourceRoot, MINIPROCTOR_ZCODE_NODE: zcodeRuntime.nodeExecutable })
              : isGemini ? Object.freeze({ ...runtime.env, MINIPROCTOR_GEMINI_SOURCE: geminiRuntime.sourceRoot, MINIPROCTOR_GEMINI_NODE: geminiRuntime.nodeExecutable }) : runtime.env,
      adapterVersion: profile.adapter_version || null,
      executionCapabilities: runtime.open,
      capabilitySnapshot: runtime.open,
      workspaceAllowlist: Object.freeze([...(profile.workspace_allowlist || [])]),
    });
  }

  /** 启动参数：注入 resolver 优先；否则只取随发行的产品静态配方。 */
  resolveLaunchArgs({ agentKey, adapterId, profile, runtime }) {
    if ((agentKey === 'junie' || agentKey === 'dsh' || agentKey === 'workbuddy' || agentKey === 'zcode' || agentKey === 'gemini-cli') && this.launchArgsResolver) {
      throw new ProfileRouteError(`${agentKey} 不支持覆盖单轮 worker 配方`, { code: 'invalid-profile-route' });
    }
    if (this.launchArgsResolver) {
      const out = this.launchArgsResolver({ agentKey, adapterId, profile });
      return Array.isArray(out) ? out.map(String) : [];
    }
    const args = runtime ? [...runtime.args] : [];
    if (agentKey === 'aider' && profile.permission_policy?.mode === 'readonly') {
      // CLI 参数优先于用户配置；保留其他策略的正常编辑，不扩大 readonly 权限。
      return [...args.slice(0, -1), '--chat-mode', 'ask', '--dry-run', args.at(-1)];
    }
    return args;
  }
}

/**
 * SessionLaunchLedger（V12-11 profile 恢复记录）：本会话桥接器拉起的 profile 会话启动台账。
 *
 * 用途（任务卡「ACK与重启对账」「原生ID到profile命名空间」）：
 *   - 每次按 profile 创建会话记录 { bridge_session_id, profile_id/revision, agent_key/adapter_id,
 *     pid, instance_id, spawned_at, command }；
 *   - Agent 原生会话 ID（claude system/init 的 session_id、codex thread.started 的 thread_id）
 *     到达后追加记录到对应 profile 命名空间；
 *   - bridge 重启时 reconcile()：pid 已死的记录补 closed；仍存活的记为孤儿（只登记告警，
 *     不自动终止——§8.3「不停止用户独立启动的进程」同理，自动清理挂 V15 专项边界测试）。
 * 存储：<dataDir>/session-launches.jsonl（append-only JSONL + 折叠读取；单实例锁保证单写者）。
 */
export class SessionLaunchLedger {
  constructor({ dir, now = Date.now, maxRecords = 500 } = {}) {
    this.dir = dir ? path.resolve(String(dir)) : null;
    this._now = now;
    this.maxRecords = Math.max(50, Number(maxRecords) || 500);
  }

  _file() { return path.join(this.dir, 'session-launches.jsonl'); }

  _append(record) {
    if (!this.dir) return;
    fs.mkdirSync(this.dir, { recursive: true });
    fs.appendFileSync(this._file(), `${JSON.stringify(record)}\n`, 'utf8');
  }

  /** 记录一次 profile 会话启动（startSession 成功后调用；pid/instance_id 来自 runner 归属身份）。 */
  recordLaunch({ bridgeSessionId, profileId, profileRevision = null, agentKey = null, adapterId = null, pid = null, instanceId = null, spawnedAt = null, command = null } = {}) {
    if (!bridgeSessionId || !profileId) return;
    this._append({
      kind: 'launch',
      at: this._now(),
      bridge_session_id: String(bridgeSessionId),
      profile_id: String(profileId),
      profile_revision: profileRevision,
      agent_key: agentKey,
      adapter_id: adapterId,
      pid: Number.isInteger(pid) ? pid : null,
      instance_id: instanceId || null,
      spawned_at: spawnedAt || null,
      command: command ? String(command).slice(0, 1024) : null,
    });
  }

  /** 原生会话 ID 归档到对应会话/profile 命名空间（≤128 字符，NATIVE_SESSION_REF 上限）。 */
  recordNativeSessionRef(bridgeSessionId, nativeSessionRef) {
    const ref = String(nativeSessionRef || '').trim().slice(0, 128);
    if (!bridgeSessionId || !ref) return;
    this._append({ kind: 'native-ref', at: this._now(), bridge_session_id: String(bridgeSessionId), native_session_ref: ref });
  }

  /** 记录关闭（reconcile 内部/测试用）。 */
  recordClosed(bridgeSessionId, reason) {
    if (!bridgeSessionId) return;
    this._append({ kind: 'closed', at: this._now(), bridge_session_id: String(bridgeSessionId), reason: reason || null });
  }

  /** 折叠读取：按 bridge_session_id 归并 launch/native-ref/closed 为最新视图。 */
  list() {
    if (!this.dir || !fs.existsSync(this._file())) return [];
    const folded = new Map();
    let lines = [];
    try {
      lines = fs.readFileSync(this._file(), 'utf8').split('\n');
    } catch {
      return [];
    }
    for (const line of lines) {
      const text = line.trim();
      if (!text) continue;
      let rec = null;
      try { rec = JSON.parse(text); } catch { continue; } // 半写/损坏行跳过（append-only 读取端容忍）
      if (!rec || typeof rec !== 'object' || !rec.bridge_session_id) continue;
      const cur = folded.get(rec.bridge_session_id) || {
        bridge_session_id: rec.bridge_session_id,
        profile_id: null, profile_revision: null, agent_key: null, adapter_id: null,
        pid: null, instance_id: null, spawned_at: null, command: null,
        native_session_ref: null, closed: null,
      };
      if (rec.kind === 'launch') {
        cur.profile_id = rec.profile_id ?? cur.profile_id;
        cur.profile_revision = rec.profile_revision ?? cur.profile_revision;
        cur.agent_key = rec.agent_key ?? cur.agent_key;
        cur.adapter_id = rec.adapter_id ?? cur.adapter_id;
        cur.pid = rec.pid ?? cur.pid;
        cur.instance_id = rec.instance_id ?? cur.instance_id;
        cur.spawned_at = rec.spawned_at ?? cur.spawned_at;
        cur.command = rec.command ?? cur.command;
      } else if (rec.kind === 'native-ref') {
        cur.native_session_ref = rec.native_session_ref ?? cur.native_session_ref;
      } else if (rec.kind === 'closed') {
        cur.closed = { reason: rec.reason || null, at: rec.at || null };
      }
      folded.set(rec.bridge_session_id, cur);
    }
    return [...folded.values()];
  }

  /**
   * 重启对账（构造/启动时调用一次）：未关闭记录按 pid 存活性收敛。
   *   - pid 已死 → 补 closed('process-gone')；
   *   - pid 仍存活 → 孤儿（保持未关闭，返回计数并告警；不自动终止）；
   *   - 无 pid 记录 → 补 closed('no-pid-record')。
   * @returns {{ total, closed, orphaned }}
   */
  reconcile({ pidAlive = pidAliveDefault } = {}) {
    const entries = this.list();
    let closed = 0;
    let orphaned = 0;
    for (const e of entries) {
      if (e.closed) continue;
      if (!Number.isInteger(e.pid) || e.pid <= 0) {
        this.recordClosed(e.bridge_session_id, 'no-pid-record');
        closed += 1;
        continue;
      }
      if (pidAlive(e.pid)) {
        orphaned += 1;
      } else {
        this.recordClosed(e.bridge_session_id, 'process-gone');
        closed += 1;
      }
    }
    // 台账容量治理：折叠视图超过上限时重写（只保留最新折叠态，丢弃历史行）
    if (this.dir && entries.length > this.maxRecords) {
      try {
        const keep = entries.slice(-this.maxRecords)
          .map((e) => ({ kind: e.closed ? 'closed' : 'launch', ...e }));
        fs.writeFileSync(this._file(), `${keep.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8');
      } catch { /* 重写失败不影响主语义：台账只增不改也能折叠读取 */ }
    }
    return { total: entries.length, closed, orphaned };
  }
}
