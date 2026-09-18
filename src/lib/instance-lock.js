/**
 * 单实例锁（CLOSE-010）：同一 dataDir 只允许一个 bridge 实例执行命令循环。
 *
 * 为什么必须：inbox/outbox 的「临时文件+rename」只保证单进程内断电不半写，不提供跨进程
 * 排他。两个 bridge 实例共用一个 dataDir 时会同时轮询同一批命令、各自执行、各自写
 * inbox/outbox——不可逆命令（stop/respond_action）可能被双份执行，执行记录互相覆盖。
 *
 * 零依赖实现（Windows/Linux 均工作）：
 *  1. 锁文件 = O_EXCL 独占创建（fs.openSync 'wx'）：同目录互斥创建在两个平台上都原子；
 *  2. 内容 = { pid, host, started_at, token }，token 用于 release 时确认锁仍属于自己；
 *  3. 启动遇 EEXIST → 读取持有者：
 *     - pid 存活（process.kill(pid,0)，EPERM 视为存活）→ 明确报错退出（双开拒绝）；
 *     - pid 不存在 → 陈旧锁（崩溃残留）→ 接管：删除后重试独占创建；
 *     - 内容损坏：mtime 在宽限期内视为「可能有实例正在写」→ 拒绝；过期 → 崩溃残留 → 接管；
 *     - host 不同（共享目录被另一台机器持有）：无法验证存活 → fail-closed 拒绝，提示人工处理。
 *  4. release：读回 token 比对一致才删除（避免误删接管者的锁）。
 *
 * 已知局限（记录于设计）：PID 复用可能让陈旧锁被误判为存活（保守方向：拒绝启动，
 * 人工删除锁文件即可恢复），不会导致双实例同时执行。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export const LOCK_FILE_NAME = 'bridge.lock';
/** 锁内容损坏（半写）时的宽限期：新于该值视为「持有者可能正在初始化」，拒绝而非接管。 */
export const LOCK_CORRUPT_GRACE_MS = 10 * 1000;

export class InstanceLockError extends Error {
  constructor(message, { code = 'instance-lock-held', holder = null, path = null } = {}) {
    super(message);
    this.name = 'InstanceLockError';
    this.code = code; // 'instance-lock-held' | 'instance-lock-unavailable'
    this.holder = holder;
    this.path = path;
  }
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM：进程存在但无权发信号（其他用户）→ 视为存活；ESRCH/其他：不存在
    return err?.code === 'EPERM';
  }
}

function looksLikeLock(info) {
  return Boolean(info && typeof info === 'object' && Number.isInteger(info.pid));
}

/**
 * 评估已存在的锁文件：'alive'（拒绝）| 'takeover'（陈旧/损坏过期，可接管）。
 * 返回 { verdict, info, detail }。
 */
function evaluateExistingLock(lockPath) {
  let raw = null;
  let info = null;
  try {
    raw = fs.readFileSync(lockPath, 'utf8');
  } catch (err) {
    // 读不到（刚被释放/竞态删除）→ 当作可重试接管
    return { verdict: 'takeover', info: null, detail: `lock vanished while evaluating: ${err?.code || err?.message}` };
  }
  try {
    info = JSON.parse(raw);
  } catch {
    info = null;
  }
  if (!looksLikeLock(info)) {
    let age = Infinity;
    try { age = Date.now() - fs.statSync(lockPath).mtimeMs; } catch { /* 读不到按过期处理 */ }
    if (age < LOCK_CORRUPT_GRACE_MS) {
      return { verdict: 'alive', info: null, detail: `lock file unreadable and fresh (${Math.round(age)}ms old) — another instance may be starting` };
    }
    return { verdict: 'takeover', info: null, detail: 'corrupt lock file (crash leftover during write) — taking over' };
  }
  if (info.host && info.host !== os.hostname()) {
    // 共享目录被其他主机持有：无法跨机验证存活 → fail-closed 拒绝（不自动接管）
    return { verdict: 'alive', info, detail: `lock held by another host (host=${info.host}, pid=${info.pid})` };
  }
  if (pidAlive(info.pid)) {
    return { verdict: 'alive', info, detail: `lock held by running process (pid=${info.pid}, host=${info.host || 'unknown'})` };
  }
  return { verdict: 'takeover', info, detail: `stale lock: pid=${info.pid} no longer exists — taking over` };
}

/**
 * 获取单实例锁。成功返回 { path, info, release() }；被其他实例持有/环境不可用时抛
 * InstanceLockError（code: 'instance-lock-held' | 'instance-lock-unavailable'）。
 * @param {string} dataDir bridge 数据目录（与 device.json/inbox/outbox 同级）
 */
export function acquireInstanceLock(dataDir, { logger = console } = {}) {
  const dir = path.resolve(String(dataDir));
  let lockPath;
  try {
    fs.mkdirSync(dir, { recursive: true });
    lockPath = path.join(dir, LOCK_FILE_NAME);
  } catch (err) {
    throw new InstanceLockError(`instance lock unavailable: cannot create data dir ${dir}: ${err?.message || err}`, { code: 'instance-lock-unavailable', path: dir });
  }
  const token = crypto.randomBytes(8).toString('hex');
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let fd;
    try {
      fd = fs.openSync(lockPath, 'wx'); // O_CREAT|O_EXCL：跨平台原子独占创建
    } catch (err) {
      if (err?.code === 'EEXIST') {
        const verdict = evaluateExistingLock(lockPath);
        if (verdict.verdict === 'alive') {
          throw new InstanceLockError(
            `拒绝启动：同一数据目录已有 bridge 实例（${verdict.detail}）。dataDir=${dir}；确认旧实例已停止或人工删除 ${LOCK_FILE_NAME} 后重试`,
            { code: 'instance-lock-held', holder: verdict.info, path: lockPath },
          );
        }
        logger.warn?.(`[instance-lock] ${verdict.detail} (${lockPath})`);
        try { fs.rmSync(lockPath, { force: true }); } catch { /* 接管重试时再裁决 */ }
        continue;
      }
      // 权限/磁盘等错误：无法建立排他锁 → fail-closed，拒绝启动（宁可不起也不双开）
      throw new InstanceLockError(`instance lock unavailable: ${err?.message || err} (${lockPath})`, { code: 'instance-lock-unavailable', path: lockPath });
    }
    const info = { pid: process.pid, host: os.hostname(), started_at: Date.now(), token };
    try {
      fs.writeFileSync(fd, JSON.stringify(info), 'utf8');
    } finally {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
    return {
      path: lockPath,
      info: { ...info, token: undefined },
      release() {
        try {
          const cur = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
          if (cur && cur.token && cur.token !== token) {
            logger.warn?.('[instance-lock] lock token mismatch on release — lock was taken over, not deleting');
            return { ok: false, reason: 'token-mismatch' };
          }
        } catch {
          return { ok: true, reason: 'already-gone' }; // 已被清理：幂等成功
        }
        try {
          fs.rmSync(lockPath, { force: true });
          return { ok: true };
        } catch (err) {
          logger.warn?.(`[instance-lock] release failed: ${err?.message || err}（残留锁将由下次启动的陈旧检测接管）`);
          return { ok: false, reason: 'rm-failed' };
        }
      },
    };
  }
  // 多轮接管竞态全部落败（极端并发）：保守放弃，由下一次启动重试
  throw new InstanceLockError(`instance lock contention: could not acquire after repeated takeover attempts (${lockPath})`, { code: 'instance-lock-unavailable', path: lockPath });
}

/**
 * 只读检查锁状态（doctor/运维用，不修改任何文件）。
 * status: 'free' | 'held' | 'stale' | 'corrupt' | 'remote-host' | 'unavailable'
 */
export function inspectInstanceLock(dataDir) {
  const dir = path.resolve(String(dataDir));
  const lockPath = path.join(dir, LOCK_FILE_NAME);
  let raw = null;
  try {
    raw = fs.readFileSync(lockPath, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') return { status: 'free', detail: `无实例锁（${lockPath}）`, path: lockPath };
    return { status: 'unavailable', detail: `锁文件不可读：${err?.message || err}`, path: lockPath };
  }
  let info = null;
  try { info = JSON.parse(raw); } catch { info = null; }
  if (!looksLikeLock(info)) {
    return { status: 'corrupt', detail: '锁文件内容损坏（半写或外部破坏）；确认无实例运行后删除即可', path: lockPath };
  }
  if (info.host && info.host !== os.hostname()) {
    return { status: 'remote-host', detail: `锁由其他主机持有（host=${info.host}, pid=${info.pid}），需人工确认`, path: lockPath, holder: info };
  }
  if (pidAlive(info.pid)) {
    return { status: 'held', detail: `已有 bridge 实例运行（pid=${info.pid}，started_at=${info.started_at ? new Date(info.started_at).toISOString() : 'unknown'}）`, path: lockPath, holder: info };
  }
  return { status: 'stale', detail: `陈旧锁（pid=${info.pid} 进程已不存在），下次 run 将自动接管`, path: lockPath, holder: info };
}
