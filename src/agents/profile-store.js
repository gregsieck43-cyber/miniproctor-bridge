/**
 * V12-08：AgentProfile 本机配置实例存储（ProfileStore）。
 *
 * 契约来源：主方案 §7.1/§7.2/§8.1/§9 与 src/agents/adapter-contract.md §0。
 *   - profile_id 由 bridge 生成 UUID，不拿显示名称做主键（§7.1 第 3 种身份）；
 *   - agent_key 必须能映射到目录（catalog.js）；unknown 一律拒绝，绝不回退 claude-code（T12）；
 *   - revision 随每次变更递增——创建命令时冻结 profile/revision（§8.1/§8.2）；
 *   - workspace_allowlist 存 realpath 规范化后的绝对路径（§8.3：禁止字符串前缀判断，
 *     存储/校验统一归一）；executable_ref（真实命令路径）只在本机，不上云（§7.2）；
 *   - permission_policy 无「自动批准」形态（§1.3：不得打开全自动批准权限）；
 *   - 原子写（临时文件→校验→rename）+ 备份（.bak）+ 跨进程锁（O_EXCL 独占创建 + 陈旧接管，
 *     模式与 lib/instance-lock.js 一致）——并发写与断电半写都不产生损坏配置（§9）；
 *   - 同一安装重复执行幂等更新同一 profile，不产生无限 profile（§9）；
 *   - 删除默认为停用（软删除），记录与来源保留，历史 session 引用不被破坏（§8.1）。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { resolveAgentKey, getCatalogEntry } from './catalog.js';
import { normalizeWorkspacePath, redactHomeSegment } from '../lib/security.js';

export const PROFILES_SCHEMA_VERSION = 1;
export const PROFILE_FILE_NAME = 'profiles.json';
export const PROFILE_BACKUP_NAME = 'profiles.json.bak';
export const PROFILE_LOCK_NAME = 'profiles.lock';
export const PROFILE_LOCK_CORRUPT_GRACE_MS = 10 * 1000;

/** 权限策略形态：只读 / 审批转手机 / 白名单放行。刻意不提供 auto/full 等自动批准形态。 */
export const PERMISSION_POLICY_MODES = Object.freeze(['readonly', 'ask', 'allowlist']);
/** region 枚举（§9 runtime_candidate.region）。 */
export const PROFILE_REGIONS = Object.freeze(['cn', 'global', 'unknown']);
/** health 状态（§7.2 AgentProfile.health）。 */
export const PROFILE_HEALTH_STATUSES = Object.freeze(['unknown', 'ok', 'degraded', 'unreachable']);

const MAX_WORKSPACES = 50;
const MAX_PROFILES = 200;
const MAX_TEXT_CHARS = 100;
const MAX_PATH_CHARS = 1024;

export class ProfileStoreError extends Error {
  constructor(message, { code = 'profiles-store-error' } = {}) {
    super(message);
    this.name = 'ProfileStoreError';
    this.code = code;
  }
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM'; // 存在但无权发信号 → 视为存活
  }
}

/**
 * 获取 profiles 写锁（profiles.lock）：O_EXCL 独占创建在 Windows/Linux 上都原子；
 * 持有者存活 → 明确拒绝；陈旧/损坏 → 接管（崩溃残留恢复）。模式与 lib/instance-lock.js 一致。
 */
function acquireProfilesLock(dir) {
  const lockPath = path.join(dir, PROFILE_LOCK_NAME);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const token = crypto.randomBytes(8).toString('hex');
    let fd;
    try {
      fd = fs.openSync(lockPath, 'wx');
    } catch (err) {
      if (err?.code === 'EEXIST') {
        let info = null;
        try { info = JSON.parse(fs.readFileSync(lockPath, 'utf8')); } catch { info = null; }
        if (info && Number.isInteger(info.pid) && pidAlive(info.pid)) {
          throw new ProfileStoreError(
            `profiles 配置被其他进程持有（pid=${info.pid}）；确认其已停止后重试或人工删除 ${lockPath}`,
            { code: 'profiles-lock-held' },
          );
        }
        // 陈旧/损坏锁：接管重试
        try { fs.rmSync(lockPath, { force: true }); } catch { /* 重试时再裁决 */ }
        continue;
      }
      throw new ProfileStoreError(`profiles 锁不可用：${err?.message || err}（${lockPath}）`, { code: 'profiles-lock-unavailable' });
    }
    try {
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, token, started_at: Date.now() }), 'utf8');
    } finally {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
    return {
      path: lockPath,
      release() {
        try {
          const cur = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
          if (cur && cur.token && cur.token !== token) {
            return { ok: false, reason: 'token-mismatch' }; // 已被接管，不误删接管者的锁
          }
        } catch { /* 已消失：幂等成功 */ }
        try { fs.rmSync(lockPath, { force: true }); return { ok: true }; } catch (err) {
          return { ok: false, reason: err?.message || 'rm-failed' };
        }
      },
    };
  }
  throw new ProfileStoreError('profiles 锁竞争：多次接管均失败，放弃本次写入', { code: 'profiles-lock-unavailable' });
}

function cleanText(value, maxChars) {
  if (value === null || value === undefined) return null;
  const out = String(value).replace(/[\u0000-\u001F\u007F]/g, '').trim();
  return out ? out.slice(0, maxChars) : null;
}

/**
 * workspace 逐条校验（V12-06 安全边界接入 lib/security.js）：
 *   - 字符门禁：引号/换行/控制字符一律拒绝（'workspace-unsafe-chars'）——路径不会成为
 *     日志注入面或 cmd-shell 解释面；
 *   - 词法规范化统一：盘符大小写 / 正反斜杠 / WSL /mnt/x 挂载形态（'workspace-…'）；
 *   - 绝对路径 + stat 目录 + realpath 归一（存储统一 realpath，授权比较时两侧同形）。
 */
function assertRealpathWorkspace(entry) {
  const raw = String(entry || '').trim();
  if (!raw) throw new ProfileStoreError('工作区路径为空', { code: 'workspace-invalid' });
  const norm = normalizeWorkspacePath(raw);
  if (!norm.ok) {
    const code = norm.reason === 'path-unsafe-chars' ? 'workspace-unsafe-chars'
      : norm.reason === 'path-not-absolute' ? 'workspace-not-absolute' : 'workspace-invalid';
    throw new ProfileStoreError(`工作区路径非法（${norm.reason}）：${redactHomeSegment(raw.slice(0, 200))}`, { code });
  }
  let st = null;
  try { st = fs.statSync(norm.path); } catch {
    throw new ProfileStoreError(`工作区不存在或不可访问：${redactHomeSegment(norm.path)}`, { code: 'workspace-not-found' });
  }
  if (!st.isDirectory()) throw new ProfileStoreError(`工作区不是目录：${redactHomeSegment(norm.path)}`, { code: 'workspace-not-directory' });
  try {
    return fs.realpathSync(norm.path); // 存储统一 realpath 归一（§8.3）
  } catch {
    throw new ProfileStoreError(`工作区 realpath 归一失败：${redactHomeSegment(norm.path)}`, { code: 'workspace-not-found' });
  }
}

function normalizeWorkspaceAllowlist(list) {
  if (list === null || list === undefined) return [];
  if (!Array.isArray(list)) throw new ProfileStoreError('workspace_allowlist 必须是路径数组', { code: 'workspace-invalid' });
  const out = [];
  for (const entry of list) {
    const real = assertRealpathWorkspace(entry);
    if (!out.includes(real)) out.push(real);
    if (out.length > MAX_WORKSPACES) throw new ProfileStoreError(`工作区数量超过上限 ${MAX_WORKSPACES}`, { code: 'workspace-invalid' });
  }
  return out;
}

function normalizePermissionPolicy(policy) {
  if (policy === null || policy === undefined) return { mode: 'ask' };
  const mode = policy && typeof policy === 'object' && !Array.isArray(policy) ? policy.mode : policy;
  if (!PERMISSION_POLICY_MODES.includes(mode)) {
    throw new ProfileStoreError(`permission_policy.mode 必须是 ${PERMISSION_POLICY_MODES.join('|')} 之一（无自动批准形态）：${JSON.stringify(mode)}`, { code: 'invalid-permission-policy' });
  }
  return { mode };
}

function normalizeHealth(health) {
  if (health === null || health === undefined) return { status: 'unknown', last_checked_at: null, detail: '' };
  if (!health || typeof health !== 'object' || Array.isArray(health)) {
    throw new ProfileStoreError('health 必须是对象', { code: 'invalid-health' });
  }
  const status = health.status ?? 'unknown';
  if (!PROFILE_HEALTH_STATUSES.includes(status)) {
    throw new ProfileStoreError(`health.status 必须是 ${PROFILE_HEALTH_STATUSES.join('|')} 之一：${JSON.stringify(status)}`, { code: 'invalid-health' });
  }
  const checkedAt = health.last_checked_at ?? null;
  if (checkedAt !== null && !Number.isFinite(checkedAt)) {
    throw new ProfileStoreError('health.last_checked_at 必须是时间戳或 null', { code: 'invalid-health' });
  }
  return { status, last_checked_at: checkedAt, detail: cleanText(health.detail, 200) ?? '' };
}

function normalizeExecutableRef(ref) {
  if (!ref || typeof ref !== 'object' || Array.isArray(ref)) {
    throw new ProfileStoreError('executable_ref 必须是 { command, resolved_path }', { code: 'invalid-executable-ref' });
  }
  // V12-06 本地注册白名单字符门禁：NUL/换行/控制字符/引号在 cmd-shell 解释与日志输出
  // 中都是注入面——注册阶段一律【拒绝】（不是静默清洗）。企业 wrapper 走本机显式登记
  // （绝对路径 + identify 位置疑点检查），不在字符层面放行。
  // eslint-disable-next-line no-control-regex
  const UNSAFE_REF_CHARS = /[\u0000-\u001f\u007f"]/;
  if (typeof ref.command !== 'string' || UNSAFE_REF_CHARS.test(ref.command) || !ref.command.trim()) {
    throw new ProfileStoreError('executable_ref.command 为空或含非法字符（控制字符/引号/换行）', { code: 'invalid-executable-ref' });
  }
  if (ref.resolved_path != null && (typeof ref.resolved_path !== 'string' || UNSAFE_REF_CHARS.test(ref.resolved_path))) {
    throw new ProfileStoreError('executable_ref.resolved_path 含非法字符（控制字符/引号/换行）', { code: 'invalid-executable-ref' });
  }
  const command = cleanText(ref.command, MAX_PATH_CHARS);
  if (!command) throw new ProfileStoreError('executable_ref.command 必须是非空字符串', { code: 'invalid-executable-ref' });
  const resolvedPath = cleanText(ref.resolved_path, MAX_PATH_CHARS);
  return { command, resolved_path: resolvedPath };
}

/** 构造新 profile 记录（字段集 = §7.2 AgentProfile + 本机来源记录）。 */
function buildProfile({ spec, now }) {
  const agentKey = resolveAgentKey(spec.agent_key);
  if (!agentKey) {
    // unknown 一律拒绝：绝不静默回退/伪装为 claude-code（T12）
    throw new ProfileStoreError(`未知 agent_key：${JSON.stringify(spec.agent_key)}（须先登记进目录 catalog-entries）`, { code: 'unknown-agent-key' });
  }
  const entry = getCatalogEntry(agentKey);
  if (entry.lifecycle === 'deprecated') {
    // 停服产品不推荐新安装（§6 历史兼容登记：识别旧名称并给出状态）
    throw new ProfileStoreError(`agent_key ${agentKey} 已停服（lifecycle=deprecated），不推荐新安装；如需保留历史请在既有 profile 上操作`, { code: 'agent-deprecated' });
  }
  const displayName = cleanText(spec.display_name, MAX_TEXT_CHARS) ?? entry.display_name;
  const region = spec.region ?? 'unknown';
  if (!PROFILE_REGIONS.includes(region)) {
    throw new ProfileStoreError(`region 必须是 ${PROFILE_REGIONS.join('|')} 之一：${JSON.stringify(region)}`, { code: 'invalid-region' });
  }
  return {
    profile_id: crypto.randomUUID(),
    agent_key: agentKey,
    display_name: displayName,
    revision: 1,
    executable_ref: normalizeExecutableRef(spec.executable_ref ?? { command: spec.command, resolved_path: spec.resolved_path }),
    adapter_version: cleanText(spec.adapter_version, 64),
    region,
    workspace_allowlist: normalizeWorkspaceAllowlist(spec.workspace_allowlist),
    permission_policy: normalizePermissionPolicy(spec.permission_policy),
    health: normalizeHealth(spec.health),
    // 来源提示只记录、不参与运行身份（§7.1 installer_identity ≠ runtime）
    installer_identity: spec.installer_identity && typeof spec.installer_identity === 'object' ? spec.installer_identity : null,
    self_report: spec.self_report && typeof spec.self_report === 'object' ? spec.self_report : null,
    status: 'active',
    deleted_at: null,
    created_at: now,
    updated_at: now,
  };
}

/** 幂等匹配键：同一安装（同一 agent_key + 同一启动命令/真实路径）重复登记 = 更新同一 profile（§9）。 */
function sameInstall(profile, spec) {
  if (profile.agent_key !== spec.agent_key) return false;
  if (profile.deleted_at !== null) return false;
  const ref = normalizeExecutableRef(spec.executable_ref ?? { command: spec.command, resolved_path: spec.resolved_path });
  if (profile.executable_ref.command !== ref.command) return false;
  const a = profile.executable_ref.resolved_path ?? null;
  const b = ref.resolved_path ?? null;
  return a === b;
}

function looksLikeProfile(p) {
  return Boolean(p && typeof p === 'object'
    && typeof p.profile_id === 'string' && p.profile_id
    && typeof p.agent_key === 'string'
    && Number.isInteger(p.revision));
}

export class ProfileStore {
  /** @param {object} opts dir=持久化目录（bridge dataDir）；now=时间源（测试注入） */
  constructor({ dir, now = Date.now } = {}) {
    this.dir = path.resolve(String(dir || ''));
    this._now = now;
    this._recoveredFromBackup = false;
  }

  /* ---------------- 存储与恢复 ---------------- */

  _mainFile() { return path.join(this.dir, PROFILE_FILE_NAME); }
  _backupFile() { return path.join(this.dir, PROFILE_BACKUP_NAME); }

  _parseState(text, source) {
    let state;
    try {
      state = JSON.parse(text);
    } catch (err) {
      throw new ProfileStoreError(`${source} 内容损坏（半写或外部破坏）：${err?.message || err}`, { code: 'profiles-store-corrupt' });
    }
    if (!state || typeof state !== 'object' || state.schema_version !== PROFILES_SCHEMA_VERSION || !Array.isArray(state.profiles)) {
      throw new ProfileStoreError(`${source} 结构非法（schema_version=${JSON.stringify(state && state.schema_version)}）`, { code: 'profiles-store-corrupt' });
    }
    return state;
  }

  /**
   * 读取存储：主文件损坏 → 回退备份（.bak）；两者都损坏 → 明确报错且不删任何文件
   * （保留现场供人工恢复，绝不静默清空历史——「损坏配置」边界）。
   */
  _readState() {
    let mainText = null;
    try {
      mainText = fs.readFileSync(this._mainFile(), 'utf8');
    } catch (err) {
      if (err?.code !== 'ENOENT') {
        throw new ProfileStoreError(`profiles 存储不可读：${err?.message || err}`, { code: 'profiles-store-unavailable' });
      }
    }
    if (mainText !== null) {
      const state = this._parseState(mainText, PROFILE_FILE_NAME); // 损坏时抛错（由调用方决定是否回退备份）
      return state;
    }
    // 主文件不存在：尝试备份（首次写盘被中断的极端场景）
    try {
      const bakText = fs.readFileSync(this._backupFile(), 'utf8');
      const state = this._parseState(bakText, PROFILE_BACKUP_NAME);
      this._recoveredFromBackup = true;
      return state;
    } catch (err) {
      if (err instanceof ProfileStoreError) throw err;
      return { schema_version: PROFILES_SCHEMA_VERSION, profiles: [] }; // 全新存储
    }
  }

  _readStateWithRecovery() {
    try {
      return this._readState();
    } catch (err) {
      if (err instanceof ProfileStoreError && err.code === 'profiles-store-corrupt') {
        // 主文件损坏 → 回退备份
        try {
          const bakText = fs.readFileSync(this._backupFile(), 'utf8');
          const state = this._parseState(bakText, PROFILE_BACKUP_NAME);
          this._recoveredFromBackup = true;
          return state;
        } catch {
          throw err; // 备份也不可用：维持原始损坏报错（文件未动，人工可恢复）
        }
      }
      throw err;
    }
  }

  /**
   * 原子写：临时文件 → JSON 往返校验 → rename 原子替换 → 刷新备份。
   * 断电窗口只会留下：旧主文件 + 新临时文件（下次写入覆盖），或新主文件 + 旧备份——两者都可恢复。
   */
  _writeState(state) {
    const payload = `${JSON.stringify({ ...state, generated_at: this._now() }, null, 2)}\n`;
    JSON.parse(payload); // 往返校验：写前确认自身产物可解析
    const mainFile = this._mainFile();
    const tmp = `${mainFile}.tmp`;
    try {
      fs.writeFileSync(tmp, payload, 'utf8');
      JSON.parse(fs.readFileSync(tmp, 'utf8')); // 落盘后复读校验
      fs.renameSync(tmp, mainFile); // 同目录 rename：原子替换
      fs.writeFileSync(this._backupFile(), payload, 'utf8'); // 成功后刷新备份
    } catch (err) {
      try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
      throw new ProfileStoreError(`profiles 写入失败：${err?.message || err}`, { code: 'profiles-store-unavailable' });
    }
  }

  /** 所有变更操作共用：加锁 → 读盘 → 变更 → 原子写 → 释放。返回 fn 结果。 */
  _mutate(mutator) {
    fs.mkdirSync(this.dir, { recursive: true });
    const lock = acquireProfilesLock(this.dir);
    try {
      const state = this._readStateWithRecovery();
      const result = mutator(state) ?? null;
      this._writeState(state);
      return result;
    } finally {
      lock.release();
    }
  }

  _read() {
    fs.mkdirSync(this.dir, { recursive: true });
    return this._readStateWithRecovery();
  }

  /** 上次读取是否从备份恢复（doctor/诊断提示用；仅本次进程内的读取有效）。 */
  recoveredFromBackup() {
    return this._recoveredFromBackup;
  }

  /* ---------------- 查询 ---------------- */

  list({ includeDisabled = false, includeDeleted = false } = {}) {
    const { profiles } = this._read();
    return profiles.filter((p) => {
      if (!includeDeleted && p.deleted_at !== null) return false;
      if (!includeDisabled && p.status === 'disabled' && p.deleted_at === null) return false;
      return true;
    }).map((p) => ({ ...p, workspace_allowlist: [...p.workspace_allowlist] }));
  }

  get(profileId) {
    const id = String(profileId || '');
    const { profiles } = this._read();
    const found = profiles.find((p) => p.profile_id === id);
    return found ? { ...found, workspace_allowlist: [...found.workspace_allowlist] } : null;
  }

  /* ---------------- 变更 ---------------- */

  /** 登记/幂等更新。同一安装（agent_key + command + resolved_path）重复执行 → 更新同一 profile。 */
  register(spec) {
    if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
      throw new ProfileStoreError('register 需要 spec 对象', { code: 'invalid-spec' });
    }
    return this._mutate((state) => {
      if (state.profiles.length >= MAX_PROFILES && !state.profiles.some((p) => sameInstall(p, spec))) {
        throw new ProfileStoreError(`profile 数量超过上限 ${MAX_PROFILES}`, { code: 'profiles-limit' });
      }
      const existing = state.profiles.find((p) => sameInstall(p, spec));
      if (existing) {
        // 幂等更新：可变字段取新值；revision 递增；绝不新建重复 profile、不复活已删除记录
        const now = this._now();
        const entry = getCatalogEntry(existing.agent_key);
        existing.display_name = cleanText(spec.display_name, MAX_TEXT_CHARS) ?? existing.display_name ?? entry?.display_name ?? existing.display_name;
        if (spec.region !== undefined) {
          if (!PROFILE_REGIONS.includes(spec.region)) throw new ProfileStoreError(`region 必须是 ${PROFILE_REGIONS.join('|')} 之一`, { code: 'invalid-region' });
          existing.region = spec.region;
        }
        if (spec.adapter_version !== undefined) existing.adapter_version = cleanText(spec.adapter_version, 64);
        if (spec.workspace_allowlist !== undefined) existing.workspace_allowlist = normalizeWorkspaceAllowlist(spec.workspace_allowlist);
        if (spec.permission_policy !== undefined) existing.permission_policy = normalizePermissionPolicy(spec.permission_policy);
        if (spec.health !== undefined) existing.health = normalizeHealth(spec.health);
        if (spec.installer_identity !== undefined) existing.installer_identity = spec.installer_identity && typeof spec.installer_identity === 'object' ? spec.installer_identity : null;
        if (spec.self_report !== undefined) existing.self_report = spec.self_report && typeof spec.self_report === 'object' ? spec.self_report : null;
        existing.status = 'active'; // 重复登记视为重新启用
        existing.updated_at = now;
        existing.revision += 1;
        return { created: false, updated: true, profile: { ...existing, workspace_allowlist: [...existing.workspace_allowlist] } };
      }
      const profile = buildProfile({ spec, now: this._now() });
      state.profiles.push(profile);
      return { created: true, updated: false, profile: { ...profile, workspace_allowlist: [...profile.workspace_allowlist] } };
    });
  }

  /**
   * 白名单字段更新：未列出的字段一律拒绝（不静默丢弃）；agent_key/profile_id/revision/status/
   * created_at 不可经 update 修改（换产品 = 新 profile，不静默复用历史身份，§9）。
   */
  update(profileId, patch) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      throw new ProfileStoreError('update 需要 patch 对象', { code: 'invalid-patch' });
    }
    const IMMUTABLE = ['profile_id', 'agent_key', 'revision', 'status', 'created_at', 'deleted_at'];
    for (const key of Object.keys(patch)) {
      if (IMMUTABLE.includes(key)) {
        throw new ProfileStoreError(`字段 ${key} 不可直接修改（变更语义请用对应方法或新建 profile）`, { code: 'immutable-field' });
      }
      if (!['display_name', 'region', 'adapter_version', 'workspace_allowlist', 'permission_policy', 'health', 'installer_identity', 'self_report', 'executable_ref'].includes(key)) {
        throw new ProfileStoreError(`update 不支持字段 ${key}（白名单之外一律拒绝）`, { code: 'unknown-patch-field' });
      }
    }
    const id = String(profileId || '');
    return this._mutate((state) => {
      const profile = state.profiles.find((p) => p.profile_id === id && p.deleted_at === null);
      if (!profile) throw new ProfileStoreError(`profile 不存在或已删除：${id}`, { code: 'profile-not-found' });
      if (patch.display_name !== undefined) {
        const name = cleanText(patch.display_name, MAX_TEXT_CHARS);
        if (!name) throw new ProfileStoreError('display_name 必须是非空字符串', { code: 'invalid-patch' });
        profile.display_name = name;
      }
      if (patch.region !== undefined) {
        if (!PROFILE_REGIONS.includes(patch.region)) throw new ProfileStoreError(`region 必须是 ${PROFILE_REGIONS.join('|')} 之一`, { code: 'invalid-region' });
        profile.region = patch.region;
      }
      if (patch.adapter_version !== undefined) profile.adapter_version = cleanText(patch.adapter_version, 64);
      if (patch.workspace_allowlist !== undefined) profile.workspace_allowlist = normalizeWorkspaceAllowlist(patch.workspace_allowlist);
      if (patch.permission_policy !== undefined) profile.permission_policy = normalizePermissionPolicy(patch.permission_policy);
      if (patch.health !== undefined) profile.health = normalizeHealth(patch.health);
      if (patch.installer_identity !== undefined) profile.installer_identity = patch.installer_identity && typeof patch.installer_identity === 'object' ? patch.installer_identity : null;
      if (patch.self_report !== undefined) profile.self_report = patch.self_report && typeof patch.self_report === 'object' ? patch.self_report : null;
      if (patch.executable_ref !== undefined) profile.executable_ref = normalizeExecutableRef(patch.executable_ref);
      profile.revision += 1;
      profile.updated_at = this._now();
      return { ...profile, workspace_allowlist: [...profile.workspace_allowlist] };
    });
  }

  /** 停用/启用：不删记录、不改 profile_id 与历史来源（§8.1「删除配置默认为停用」）。 */
  setDisabled(profileId, disabled = true) {
    const id = String(profileId || '');
    return this._mutate((state) => {
      const profile = state.profiles.find((p) => p.profile_id === id && p.deleted_at === null);
      if (!profile) throw new ProfileStoreError(`profile 不存在或已删除：${id}`, { code: 'profile-not-found' });
      profile.status = disabled ? 'disabled' : 'active';
      profile.revision += 1;
      profile.updated_at = this._now();
      return { ...profile, workspace_allowlist: [...profile.workspace_allowlist] };
    });
  }

  /**
   * 删除（默认软删除）：status=disabled + deleted_at 时间戳，记录与全部字段保留——
   * 历史 session/命令引用的 profile_id、display_name、agent_key 不被破坏（§8.1/§7.2）。
   * 硬删除受「存在运行任务则禁止」约束（运行任务判定在 V12-11/12 落地），本层刻意不提供。
   */
  remove(profileId) {
    const id = String(profileId || '');
    return this._mutate((state) => {
      const profile = state.profiles.find((p) => p.profile_id === id && p.deleted_at === null);
      if (!profile) throw new ProfileStoreError(`profile 不存在或已删除：${id}`, { code: 'profile-not-found' });
      profile.status = 'disabled';
      profile.deleted_at = this._now();
      profile.revision += 1;
      profile.updated_at = profile.deleted_at;
      return { ...profile, workspace_allowlist: [...profile.workspace_allowlist] };
    });
  }
}
