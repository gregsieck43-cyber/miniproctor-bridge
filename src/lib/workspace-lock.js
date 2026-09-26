/**
 * V12-13：写任务工作区互斥锁（WorkspaceLockManager）。
 *
 * 契约来源：主方案 §8.3「同目录、并发、进程与成本」与任务卡 V12-13：
 *   - 默认同一真实工作目录只能有一个写入型任务；锁键 = realpath 规范化后的目录
 *     （normalizeWorkspacePath 统一盘符大小写/正反斜杠/WSL /mnt/x 挂载形态，
 *     再 fs.realpathSync 解析符号链接 → win32 小写统一）——禁止靠字符串前缀判断；
 *   - 锁是桥接器自己的写任务互斥（advisory）：不感知、不清理、不代管用户工作区里的
 *     任何文件——已有脏文件不得被 stash/commit/清理（本模块对工作区零写入）；
 *   - 崩溃恢复：锁文件内容损坏（半写）按宽限期裁决，持有者 pid 已死 → 自动回收；
 *     pid 仍存活（非本进程）→ 保守保留并明确告警（宁可用不了，不可误回收活锁）；
 *   - stop 只释放目标锁：release 按会话 ID + token 比对，只删除自己名下的锁文件；
 *   - 零依赖实现与 lib/instance-lock.js 同模式：O_EXCL 独占创建（Windows/Linux 原子）、
 *     token 防误删、陈旧接管、损坏宽限。
 *
 * 已知边界（如实记录）：
 *   - 锁目录在 bridge dataDir 内，只对同一 dataDir 的本桥会话互斥；外部进程/其他
 *     bridge 安装目录编辑同一工作区不在本锁的防护范围（advisory lock 的固有边界）；
 *   - PID 复用可能让陈旧锁被误判存活（保守方向：保留锁 + 告警人工删除，与
 *     instance-lock 同立场），不会导致双写同时放行。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { normalizeWorkspacePath } from './security.js';

/** 锁目录名（位于 bridge dataDir 下）。 */
export const WORKSPACE_LOCK_DIR_NAME = 'workspace-locks';
/** 锁内容损坏（半写）时的宽限期：新于该值视为「持有者可能正在初始化」，拒绝而非接管。 */
export const WORKSPACE_LOCK_CORRUPT_GRACE_MS = 10 * 1000;

function pidAliveDefault(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM'; // 存在但无权发信号 → 视为存活
  }
}

/**
 * 工作区锁键（§8.3 realpath 统一）：控制字符/引号拒绝 → WSL 挂载形态转换 → 盘符大写 →
 * realpath 解析符号链接 → win32 大小写统一。同一物理目录的任何路径形态得到同一把锁。
 * @returns {{ ok: true, key: string, path: string, wsl_converted: boolean }}
 *          | { ok: false, reason: string }
 */
export function workspaceLockKey(rawCwd, { realpath = (p) => fs.realpathSync(p) } = {}) {
  const norm = normalizeWorkspacePath(rawCwd);
  if (!norm.ok) return { ok: false, reason: norm.reason };
  let real = null;
  try {
    real = realpath(norm.path);
  } catch {
    return { ok: false, reason: 'workspace-not-found' };
  }
  const key = process.platform === 'win32' ? String(real).toLowerCase() : String(real);
  return { ok: true, key, path: real, wsl_converted: norm.wsl_converted };
}

/** 锁文件名：键做 sha256 短摘要——目录名（含中文/空格/特殊字符）不进入文件名层。 */
function lockFileName(key) {
  return `${crypto.createHash('sha256').update(key).digest('hex').slice(0, 24)}.json`;
}

/** 锁文件信息是否结构有效。 */
function looksLikeLock(info) {
  return Boolean(info && typeof info === 'object'
    && Number.isInteger(info.pid) && typeof info.key === 'string' && info.key);
}

export class WorkspaceLockManager {
  /**
   * @param {object} opts
   * @param {string} opts.dir 锁目录（<dataDir>/workspace-locks）；null = 未启用
   * @param {Function} [opts.now] 时间源（测试注入）
   * @param {Function} [opts.pidAlive] 存活探测（测试注入）
   * @param {Function} [opts.realpath] realpath（测试注入）
   * @param {number} [opts.corruptGraceMs] 损坏锁宽限（默认 10s；测试可置 0）
   */
  constructor({
    dir,
    now = Date.now,
    logger = console,
    pidAlive = pidAliveDefault,
    realpath,
    corruptGraceMs = WORKSPACE_LOCK_CORRUPT_GRACE_MS,
  } = {}) {
    this.dir = dir ? path.resolve(String(dir)) : null;
    this._now = now;
    this._logger = logger;
    this._pidAlive = pidAlive;
    this._realpath = realpath;
    this._corruptGraceMs = Math.max(0, Number(corruptGraceMs) || 0);
    // session_id → { key, path, token, info }（本进程持有的锁；release 依据）
    this._bySession = new Map();
    // key → session_id（冲突反馈/去重）
    this._byKey = new Map();
  }

  _lockDir() {
    fs.mkdirSync(this.dir, { recursive: true });
    return this.dir;
  }

  _lockPath(key) {
    return path.join(this.dir, lockFileName(key));
  }

  /**
   * 为写任务获取工作区锁。
   * @param {object} p
   * @param {string} p.cwd 已授权（realpath 后）的工作目录
   * @param {string} p.sessionId 将要拉起的会话 ID（锁随会话生命周期）
   * @param {string|null} [p.profileId] 来源 profile（冲突反馈用）
   * @param {string|null} [p.agentKey] 来源 agent 键（冲突反馈用）
   * @returns {{ ok: true, key: string, path: string }}
   *          | { ok: false, reason: 'workspace-busy'|'lock-unavailable'|'invalid-cwd', holder? }
   */
  acquire({ cwd, sessionId, profileId = null, agentKey = null } = {}) {
    if (!this.dir || !sessionId) return { ok: false, reason: 'lock-unavailable' };
    if (this._bySession.has(String(sessionId))) {
      // 同会话重复获取：幂等成功（防御，正常流程不发生）
      const held = this._bySession.get(String(sessionId));
      return { ok: true, key: held.key, path: held.path };
    }
    const resolved = workspaceLockKey(cwd, { realpath: this._realpath });
    if (!resolved.ok) return { ok: false, reason: resolved.reason === 'workspace-not-found' ? 'invalid-cwd' : resolved.reason };
    const { key } = resolved;
    const lockPath = this._lockPath(key);
    const token = crypto.randomBytes(8).toString('hex');
    const info = {
      key,
      cwd: resolved.path,
      pid: process.pid,
      token,
      acquired_at: this._now(),
      session_id: String(sessionId),
      profile_id: profileId || null,
      agent_key: agentKey || null,
    };
    for (let attempt = 0; attempt < 3; attempt += 1) {
      let fd;
      try {
        this._lockDir();
        fd = fs.openSync(lockPath, 'wx'); // O_CREAT|O_EXCL：跨平台原子独占创建
      } catch (err) {
        if (err?.code === 'EEXIST') {
          const verdict = this._evaluateExisting(lockPath);
          if (verdict.verdict === 'busy') {
            return {
              ok: false,
              reason: 'workspace-busy',
              holder: verdict.holder,
              key,
              detail: verdict.detail,
            };
          }
          // 陈旧/损坏过期：接管重试
          this._logger.warn?.(`[workspace-lock] ${verdict.detail}（${lockPath}）`);
          try { fs.rmSync(lockPath, { force: true }); } catch { /* 重试时再裁决 */ }
          continue;
        }
        // 权限/磁盘错误：无法建立互斥 → fail-closed（不能假装有锁就放行写任务）
        this._logger.warn?.(`[workspace-lock] 锁不可用：${err?.message || err}（${lockPath}）`);
        return { ok: false, reason: 'lock-unavailable', key };
      }
      try {
        fs.writeFileSync(fd, JSON.stringify(info), 'utf8');
      } finally {
        try { fs.closeSync(fd); } catch { /* ignore */ }
      }
      const held = { key, path: lockPath, token, info: { ...info, token: undefined } };
      this._bySession.set(String(sessionId), held);
      this._byKey.set(key, String(sessionId));
      return { ok: true, key, path: lockPath };
    }
    // 多轮接管竞态全部落败（极端并发）：保守放弃（不假装有锁）
    this._logger.warn?.(`[workspace-lock] 锁竞争：多次接管均失败（${lockPath}）`);
    return { ok: false, reason: 'lock-unavailable', key };
  }

  /** 评估已存在的锁文件：'busy'（活锁，拒绝）| 'takeover'（陈旧/损坏过期，可接管）。 */
  _evaluateExisting(lockPath) {
    let raw = null;
    let info = null;
    try {
      raw = fs.readFileSync(lockPath, 'utf8');
    } catch (err) {
      // 读不到（刚被释放/竞态删除）→ 当作可重试接管
      return { verdict: 'takeover', detail: `lock vanished while evaluating: ${err?.code || err?.message}` };
    }
    try {
      info = JSON.parse(raw);
    } catch {
      info = null;
    }
    if (!looksLikeLock(info)) {
      let age = Infinity;
      try { age = this._now() - fs.statSync(lockPath).mtimeMs; } catch { /* 读不到按过期处理 */ }
      if (age < this._corruptGraceMs) {
        return { verdict: 'busy', holder: null, detail: `lock file unreadable and fresh (${Math.round(age)}ms old) — holder may be starting` };
      }
      return { verdict: 'takeover', detail: 'corrupt lock file (crash leftover during write) — taking over' };
    }
    if (this._pidAlive(info.pid)) {
      return {
        verdict: 'busy',
        holder: {
          agent_key: info.agent_key || null,
          profile_id: info.profile_id || null,
          session_id: info.session_id || null,
          pid: info.pid,
          acquired_at: info.acquired_at || null,
        },
        detail: `workspace held by session=${info.session_id} (agent=${info.agent_key || 'unknown'}, pid=${info.pid})`,
      };
    }
    return { verdict: 'takeover', detail: `stale lock: holder pid=${info.pid} no longer exists — taking over` };
  }

  /**
   * 释放指定会话名下的锁（stop/退出只释放目标锁）：读回 token 比对一致才删除，
   * 不误删接管者的锁；未持有 → 幂等成功。
   * @returns {{ ok: boolean, reason?: string }}
   */
  release(sessionId) {
    const sid = String(sessionId || '');
    const held = this._bySession.get(sid);
    if (!held) return { ok: true, reason: 'not-held' };
    this._bySession.delete(sid);
    if (this._byKey.get(held.key) === sid) this._byKey.delete(held.key);
    let cur = null;
    try {
      cur = JSON.parse(fs.readFileSync(held.path, 'utf8'));
    } catch {
      return { ok: true, reason: 'already-gone' }; // 已被清理：幂等成功
    }
    if (cur && cur.token && cur.token !== held.token) {
      this._logger.warn?.(`[workspace-lock] release token mismatch (session=${sid}) — lock was taken over, not deleting`);
      return { ok: false, reason: 'token-mismatch' };
    }
    try {
      fs.rmSync(held.path, { force: true });
      return { ok: true };
    } catch (err) {
      this._logger.warn?.(`[workspace-lock] release failed: ${err?.message || err}（残留锁由 reconcile/陈旧检测回收）`);
      return { ok: false, reason: 'rm-failed' };
    }
  }

  /**
   * 释放本 manager（本进程会话）名下全部锁——stopAll/关停兜底；
   * 只触碰自己名下的锁文件，绝不清扫目录里他人锁。
   */
  releaseAll() {
    const released = [];
    for (const sid of [...this._bySession.keys()]) {
      const r = this.release(sid);
      if (r.ok) released.push(sid);
    }
    return released;
  }

  /**
   * 崩溃恢复（bridge 启动时调用一次）：扫描锁目录，回收确定无主的锁。
   *   - 内容损坏（超过宽限）→ 回收（advisory 锁，无会话能跨进程认领）；
   *   - 持有者 pid 已死 → 回收（崩溃残留；不抢活锁——活锁持有者 pid 必存活）；
   *   - 持有者 pid 仍存活且非本进程 → 保守保留 + 告警（可能是 PID 复用或另一安装，
   *     不自动裁决；人工删除锁文件即恢复）。
   * @returns {{ total, reclaimed, kept }}
   */
  reconcile() {
    let total = 0;
    let reclaimed = 0;
    let kept = 0;
    if (!this.dir || !fs.existsSync(this.dir)) return { total, reclaimed, kept };
    let files = [];
    try {
      files = fs.readdirSync(this.dir).filter((f) => f.endsWith('.json'));
    } catch {
      return { total, reclaimed, kept };
    }
    for (const file of files) {
      const lockPath = path.join(this.dir, file);
      total += 1;
      let info = null;
      try {
        info = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
      } catch {
        info = null;
      }
      if (!looksLikeLock(info)) {
        let age = Infinity;
        try { age = this._now() - fs.statSync(lockPath).mtimeMs; } catch { /* 读不到按过期 */ }
        if (age < this._corruptGraceMs) {
          kept += 1; // 宽限期内：可能有持有者正在初始化，不动
          continue;
        }
        try { fs.rmSync(lockPath, { force: true }); reclaimed += 1; } catch { kept += 1; }
        this._logger.warn?.(`[workspace-lock] reconcile：损坏锁已回收（${file}）`);
        continue;
      }
      if (info.pid === process.pid || !this._pidAlive(info.pid)) {
        try { fs.rmSync(lockPath, { force: true }); reclaimed += 1; } catch { kept += 1; }
        this._logger.warn?.(`[workspace-lock] reconcile：崩溃残留锁已回收（session=${info.session_id}, cwd=${info.cwd}）`);
        continue;
      }
      kept += 1;
      this._logger.warn?.(`[workspace-lock] reconcile：锁持有者 pid=${info.pid} 仍存活，保守保留（session=${info.session_id}, cwd=${info.cwd}）；确认无活动任务后人工删除 ${lockPath} 即恢复`);
    }
    return { total, reclaimed, kept };
  }

  /** 只读观测：当前本进程持有的锁（doctor/测试用）。 */
  list() {
    return [...this._bySession.entries()].map(([sid, held]) => ({
      session_id: sid,
      key: held.key,
      path: held.path,
      agent_key: held.info.agent_key,
      profile_id: held.info.profile_id,
      acquired_at: held.info.acquired_at,
    }));
  }

  /** 查询某 cwd 是否已被本进程会话持有（测试/观测用；锁文件层的他持状态以 acquire 结果为准）。 */
  heldBy(cwd) {
    const resolved = workspaceLockKey(cwd, { realpath: this._realpath });
    if (!resolved.ok) return null;
    const sid = this._byKey.get(resolved.key);
    return sid ? { session_id: sid } : null;
  }
}
