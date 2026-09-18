import fs from 'node:fs';
import path from 'node:path';

export const RESOLVE_TIMEOUT_MS = 5000;

// win32 下可被 CreateProcess 直接解释的可执行扩展名（.cmd/.bat 需要 cmd-shell 路径）
const WIN_EXECUTABLE_RE = /\.(exe|com|cmd|bat)$/i;

// PATHEXT 未设置或为空时，按 cmd.exe 的默认可执行扩展名顺序兜底
const DEFAULT_PATHEXT = ['.COM', '.EXE', '.BAT', '.CMD'];

function statIsFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    // 不存在、无权限或含 Windows 非法文件字符（* ? | 等）一律视为未命中，不抛出
    return false;
  }
}

/**
 * 拆分 PATH/PATHEXT 类环境变量（win32 分号分隔，posix PATH 冒号分隔）。
 * 兼容 Windows 安装器常写入的脏项：引号包裹目录去引号；尾部反斜杠剥掉
 * （盘符根 "C:\" 还原，避免 join 出 "C:xxx" 盘相对路径）；空项跳过——
 * 需要搜索当前目录时由调用方显式传入 cwd（win32 分支支持），不做隐式等价。
 */
function splitPathList(raw, separator) {
  return String(raw || '')
    .split(separator)
    .map((item) => {
      let p = item.trim();
      if (p.length >= 2 && p.startsWith('"') && p.endsWith('"')) p = p.slice(1, -1).trim();
      p = p.replace(/\\+$/, '');
      if (/^[A-Za-z]:$/.test(p)) p += '\\';
      return p;
    })
    .filter(Boolean);
}

/** 归一化 PATHEXT 列表：补前导点；整体为空时回退默认列表。 */
function pathextList(raw) {
  const exts = String(raw || '')
    .split(';')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => (item.startsWith('.') ? item : `.${item}`));
  return exts.length ? exts : DEFAULT_PATHEXT;
}

/**
 * 从候选路径中挑出最合适的一个：
 * Windows 上同目录可能同时存在无扩展名的 shell shim 与真正的 .cmd
 * （如 Git for Windows 的 `npm` 与 `npm.cmd`），必须优先带可执行扩展名的候选；
 * 同类候选保持传入顺序（PATH 顺序 × PATHEXT 顺序，由调用方按此枚举）。
 * 兼容旧签名：传入多行文本时按行拆分（历史 where 输出用例仍可运行）。
 */
export function pickBestCandidate(candidates) {
  const list = (Array.isArray(candidates) ? candidates : String(candidates || '').split(/\r?\n/))
    .map((item) => String(item || '').trim())
    .filter(Boolean);
  if (!list.length) return null;
  return list.find((item) => WIN_EXECUTABLE_RE.test(item)) || list[0];
}

/**
 * 解析裸命令名到可执行文件完整路径。
 * 不再解析本地化 `where`/`which` 的文本输出：中文 Windows 上 where 按 ANSI 代码页
 * （如 GBK）输出，而子进程管道按 UTF-8 解码会把中文路径变成乱码。改为纯 fs 探测，
 * 全程只构造与比较 Unicode 字符串，不做任何字节解码，中文/空格路径天然无损：
 * - win32：先探测 cwd（与 where.exe/cmd.exe 的当前目录优先语义一致，runner 依赖
 *   该语义解析 cwd 内的 shim），再按 PATH × PATHEXT 逐目录探测文件存在性；
 * - posix：按 PATH 逐目录探测 X_OK（与 execvp 语义一致；不探测 cwd），不再依赖外部 which。
 * 含路径分隔符的 command 直接原样返回（调用方按扩展名决定是否走 cmd-shell）。
 * timeoutMs 仅为兼容既有调用方签名保留：进程内同步 fs 探测不再有子进程超时语义。
 */
export function resolveCommandPath(command, { cwd, platform = process.platform, timeoutMs = RESOLVE_TIMEOUT_MS } = {}) {
  if (!command || typeof command !== 'string') return null;
  if (/[/\\]/.test(command)) return command;
  try {
    return platform === 'win32' ? resolveWin32(command, cwd) : resolvePosix(command);
  } catch {
    return null;
  }
}

function resolveWin32(name, cwd) {
  const exts = pathextList(process.env.PATHEXT);
  const dirs = cwd ? [cwd, ...splitPathList(process.env.PATH, ';')] : splitPathList(process.env.PATH, ';');
  const candidates = [];
  for (const dir of dirs) {
    const base = path.join(dir, name);
    if (statIsFile(base)) candidates.push(base);
    for (const ext of exts) {
      const withExt = `${base}${ext}`;
      if (statIsFile(withExt)) candidates.push(withExt);
    }
  }
  const winner = pickBestCandidate(candidates);
  if (!winner) return null;
  // NTFS 大小写不敏感：stat 命中的大小写可能来自 PATHEXT（如 .CMD）而非磁盘真实名。
  // 与 where 的 FindFirstFile 行为对齐，把文件名段还原为磁盘真实大小写，
  // 保证返回路径与真实路径逐字节一致（目录段保持 PATH/cwd 原样）。
  return joinRealFilename(path.dirname(winner), path.basename(winner));
}

/** 把文件名段还原为磁盘上的真实大小写；目录不可读时退回探测用名。 */
function joinRealFilename(dir, fileName) {
  try {
    const real = fs.readdirSync(dir).find((entry) => entry.toLowerCase() === fileName.toLowerCase());
    if (real) return path.join(dir, real);
  } catch {
    // 竞态删除等情况：探测时存在、此刻不可读，退回探测用名
  }
  return path.join(dir, fileName);
}

function resolvePosix(name) {
  for (const dir of splitPathList(process.env.PATH, ':')) {
    const full = path.join(dir, name);
    try {
      fs.accessSync(full, fs.constants.X_OK);
      if (statIsFile(full)) return full;
    } catch {
      // 无执行权限或不可见，继续下一目录
    }
  }
  return null;
}

/** 判断路径是否为 cmd 解释执行的批处理 shim（.cmd/.bat）。 */
export function isCmdShimPath(filePath) {
  if (!filePath || typeof filePath !== 'string') return false;
  return /\.cmd$/i.test(filePath) || /\.bat$/i.test(filePath);
}
