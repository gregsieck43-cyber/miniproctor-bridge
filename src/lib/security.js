/**
 * V12-06（桥接部分）：多 Agent 安全校界辅助（security.js，零依赖）。
 *
 * 本模块收敛 bridge 侧四类与任务卡要点一一对应的守卫：
 *   1. workspace 路径统一规范化（盘符大小写 / 正反斜杠 / WSL /mnt/x 挂载形态 / realpath）；
 *   2. 目录授权的【组件级】判定——先对候选与授权根都做 realpath 规范化，再逐段比较，
 *      不做原始字符串 startsWith 前缀判断（前缀无分隔符、盘符大小写、8.3 短名、
 *      符号链接逃逸都在规范化+逐段比较下收敛为同一判定）；
 *   3. spawn 参数安全校验（runner.js 已是数组直传 + 逐 token 引号；本模块补参数字符级
 *      门禁：NUL/换行在 cmd-shell 解释下构成命令边界，注册/冻结 spec 阶段一律拒绝）；
 *   4. 路径脱敏（凭据/绝对路径/prompt 不入日志：错误消息与审计记录里的用户主目录段打码）。
 *
 * 与既有模块的关系（不重复造轮子，只补缺口）：
 *   - adapters/capabilities.js authorizeWorkspace（TASK-012/D4）仍是 create_session 的执行
 *     授权入口（该文件由 V12-09 冻结、并行任务维护）；本模块 resolveAuthorizedWorkspace
 *     提供同语义的组件级实现并供 profile/冻结 spec 侧使用，两实现的关键用例判定一致由
 *     test/agents-security.test.js 交叉锁定；
 *   - log.js / audit.js / events.js 的字段黑名单与凭据形态清洗已存在（TASK-019/022/
 *     V1-018），本模块只补「用户主目录段」这一绝对路径隐私形态。
 */
import fs from 'node:fs';
import path from 'node:path';

/** 路径长度上限（预留长路径余量；正常 workspace 远低于此）。 */
export const MAX_PATH_LENGTH = 2048;

/** 路径中一律禁止的字符：控制字符（含 NUL/换行——cmd-shell 与文件系统注入面）与双引号。 */
// eslint-disable-next-line no-control-regex
const PATH_UNSAFE_ALWAYS = /[\u0000-\u001f\u007f"]/;
/** win32 文件名非法字符（盘符冒号除外，整串层面只查这些）。 */
const PATH_UNSAFE_WIN32 = /[<>|*?]/;

/**
 * WSL 挂载形态识别：/mnt/<drive>/... → Windows 盘符路径（仅 win32 有意义；
 * posix 上 /mnt/c 就是 Linux 路径，原样保留）。
 */
export function fromWslMountPath(rawPath, { platform = process.platform } = {}) {
  const p = String(rawPath || '');
  if (platform !== 'win32') return p;
  const match = p.match(/^\/mnt\/([A-Za-z])(?:\/(.*))?$/);
  if (!match) return p;
  const drive = match[1].toUpperCase();
  const rest = (match[2] || '').replace(/\/+$/, '').replace(/\//g, '\\');
  return rest ? `${drive}:\\${rest}` : `${drive}:\\`;
}

/**
 * workspace 路径统一规范化（不触盘的部分）：
 *   控制字符/引号拒绝 → trim → WSL 挂载形态转换 → 设备命名空间剥离（\\?\ 前缀）→
 *   path.normalize（win32 正斜杠归一）→ 盘符大写统一 → 去尾部冗余分隔符（保留根 'C:\'）。
 * @returns {{ ok: true, path: string, wsl_converted: boolean } | { ok: false, reason: string }}
 */
export function normalizeWorkspacePath(rawPath, { platform = process.platform } = {}) {
  let p = String(rawPath ?? '');
  if (p.length > MAX_PATH_LENGTH) return { ok: false, reason: 'path-too-long' };
  if (PATH_UNSAFE_ALWAYS.test(p)) return { ok: false, reason: 'path-unsafe-chars' };
  if (platform === 'win32' && PATH_UNSAFE_WIN32.test(p)) return { ok: false, reason: 'path-unsafe-chars' };
  p = p.trim();
  if (!p) return { ok: false, reason: 'path-empty' };
  let wslConverted = false;
  const converted = fromWslMountPath(p, { platform });
  if (converted !== p) {
    wslConverted = true;
    p = converted;
  }
  // 扩展长度/设备命名空间：一律拒绝（fail-closed，不做设备级路径授权）。
  // 注：\\?\ 前缀中的 '?' 会被上面的 win32 非法字符门禁先拦截（reason=path-unsafe-chars），
  // 这里兜住其余形态（\\.\ 设备命名空间、posix 参数化调用路径）。
  if (/^\\\\\?\\|^\\\\\.\\/i.test(p)) return { ok: false, reason: 'path-device-namespace' };
  // win32 用宿主 path.normalize（正斜杠归一、冗余分隔符收敛）；posix 参数化调用
  // 不能走宿主 path（会把 / 变 \），手动收敛多斜杠。
  p = platform === 'win32' ? path.normalize(p) : p.replace(/\/{2,}/g, '/');
  if (platform === 'win32') {
    // 盘符大写统一：'c:\x' → 'C:\x'（UNC \\server\share 无盘符，跳过）
    const parsed = path.parse(p);
    if (/^[a-z]:/.test(parsed.root)) p = `${p.slice(0, 1).toUpperCase()}${p.slice(1)}`;
    // 去尾部冗余分隔符，但保留盘符根 'C:\' 本身
    const stripped = p.replace(/[\\/]+$/, '');
    p = /^[A-Za-z]:$/.test(stripped) ? `${stripped}\\` : (stripped || p);
  } else if (p.length > 1) {
    p = p.replace(/\/+$/, '') || '/';
  }
  if (!path.isAbsolute(p)) return { ok: false, reason: 'path-not-absolute' };
  return { ok: true, path: p, wsl_converted: wslConverted };
}

function statIsDirectory(target) {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

function realpathOrNull(target) {
  try {
    return fs.realpathSync(target);
  } catch {
    return null;
  }
}

/**
 * 组件级包含判断：candidate 是否位于 root 内（含 root 本身）。
 * 先规范化（盘符大小写/分隔符），再按分隔符切段逐一比较——不做整串 startsWith，
 * 杜绝 'C:\foo' 授权根被 'C:\foobar' 命中这类前缀误判。
 */
export function isPathContained(candidate, root, { platform = process.platform } = {}) {
  const cand = normalizeWorkspacePath(candidate, { platform });
  const base = normalizeWorkspacePath(root, { platform });
  if (!cand.ok || !base.ok) return false;
  const sep = platform === 'win32' ? /[\\/]+/ : /\/+/;
  const candParts = cand.path.split(sep).filter(Boolean);
  const rootParts = base.path.split(sep).filter(Boolean);
  if (candParts.length < rootParts.length) return false;
  const eq = platform === 'win32'
    ? (a, b) => a.toLowerCase() === b.toLowerCase()
    : (a, b) => a === b;
  for (let i = 0; i < rootParts.length; i += 1) {
    if (!eq(candParts[i], rootParts[i])) return false;
  }
  return true;
}

/**
 * 目录授权判定（组件级，TASK-012/D4 的同语义强化实现）：
 *   1) 原始输入字符门禁（引号/换行/控制字符 → cwd-unsafe-chars，绝不进入比较）；
 *   2) 词法规范化（WSL 挂载/盘符大小写/分隔符）后必须是绝对路径；
 *   3) stat 必须是目录；
 *   4) realpath 前后各做一次组件级包含判断（符号链接/联接点逃逸在 realpath 后必然越出根）；
 *   5) 授权根本身也规范化+realpath（注册时已存 realpath，此处幂等）。
 * @returns {{ ok: true, cwd: string } | { ok: false, reason: string }}
 */
export function resolveAuthorizedWorkspace({ rawCwd, roots = [], stat = statIsDirectory, realpath = realpathOrNull, platform = process.platform } = {}) {
  const raw = String(rawCwd ?? '');
  if (!raw.trim()) return { ok: false, reason: 'invalid-cwd' };
  const lexical = normalizeWorkspacePath(raw, { platform });
  if (!lexical.ok) {
    return { ok: false, reason: lexical.reason === 'path-unsafe-chars' ? 'cwd-unsafe-chars' : 'invalid-cwd' };
  }
  if (!Array.isArray(roots) || roots.length === 0) return { ok: false, reason: 'no-authorized-workspaces' };

  if (!stat(lexical.path)) return { ok: false, reason: 'cwd-not-found' };
  const realCwd = realpath(lexical.path);
  if (!realCwd) return { ok: false, reason: 'cwd-not-found' };

  const canonicalRoots = [];
  for (const root of roots) {
    const norm = normalizeWorkspacePath(root, { platform });
    if (!norm.ok) continue; // 非法根不参与授权（fail-closed：只会缩小授权面）
    const real = realpath(norm.path) || norm.path;
    canonicalRoots.push(real);
  }
  if (canonicalRoots.length === 0) return { ok: false, reason: 'no-authorized-workspaces' };

  // realpath 前后双判（符号链接可能把根内路径映射到根外）
  const preOk = canonicalRoots.some((root) => isPathContained(lexical.path, root, { platform }));
  const postOk = canonicalRoots.some((root) => isPathContained(realCwd, root, { platform }));
  if (!preOk) return { ok: false, reason: 'cwd-outside-workspaces' };
  if (!postOk) return { ok: false, reason: 'cwd-symlink-escape' };
  return { ok: true, cwd: realCwd };
}

/**
 * spawn 参数字符门禁：NUL 会被 CreateProcess 截断、\r\n 在 cmd-shell 解释下构成命令
 * 边界（注入面）——注册/冻结 spec 阶段一律拒绝。引号与 Unicode 允许：引号由
 * runner.js escapeCmdToken 逐 token 转义（cmd /s 规则），Unicode 路径是合法工作区形态。
 * @returns {{ ok: true } | { ok: false, reason: string, index: number }}
 */
export function assertSafeSpawnArgs(args = []) {
  if (!Array.isArray(args)) return { ok: false, reason: 'args-not-array', index: -1 };
  for (let i = 0; i < args.length; i += 1) {
    const value = String(args[i] ?? '');
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u0008\u000a-\u001f\u007f]/.test(value)) {
      return { ok: false, reason: 'arg-unsafe-chars', index: i };
    }
  }
  return { ok: true };
}

/**
 * 路径脱敏（日志/审计/错误消息用）：用户主目录段打码，保留盘符/根与业务末端形态。
 * 例（win32）：C 盘 Users 下用户名段替换为星号——'C:\\Users\\john\\proj\\x' →
 * 'C:\\Users\\***\\proj\\x'；例（posix）：'/home/alice/proj' → '/home/***' 之后接 '/proj'。
 * POSIX 的 /Users（macOS）与 /home 同样覆盖。其余路径原样返回（授权诊断仍可读）。
 */
export function redactHomeSegment(rawPath) {
  const p = String(rawPath ?? '');
  const winMatch = p.match(/^([A-Za-z]:\\+[Uu]sers\\+)([^\\]+)/);
  if (winMatch) return `${winMatch[1]}***${p.slice(winMatch[0].length)}`;
  const posixMatch = p.match(/^(\/(?:home|Users)\/)([^/]+)/);
  if (posixMatch) return `${posixMatch[1]}***${p.slice(posixMatch[0].length)}`;
  return p;
}
