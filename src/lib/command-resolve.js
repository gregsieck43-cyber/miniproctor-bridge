import { spawnSync } from 'node:child_process';

export const RESOLVE_TIMEOUT_MS = 5000;

// win32 下可被 CreateProcess 直接解释的可执行扩展名（.cmd/.bat 需要 cmd-shell 路径）
const WIN_EXECUTABLE_RE = /\.(exe|com|cmd|bat)$/i;

/**
 * 从 where/which 的多行输出中挑出最合适的候选：
 * Windows 上同目录可能同时存在无扩展名的 shell shim 与真正的 .cmd，
 * （如 Git for Windows 的 `npm` 与 `npm.cmd`），必须优先带可执行扩展名的那行。
 */
export function pickBestCandidate(stdoutText) {
  const lines = String(stdoutText || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length) return null;
  return lines.find((line) => WIN_EXECUTABLE_RE.test(line)) || lines[0];
}

/**
 * 解析裸命令名到可执行文件完整路径：
 * - win32 用 `where`（会按 PATHEXT 补全 .cmd/.exe 等扩展名），返回首个合适候选；
 * - posix 用 `which`（best-effort，失败返回 null）。
 * 含路径分隔符的 command 直接原样返回（调用方按扩展名决定是否走 cmd-shell）。
 */
export function resolveCommandPath(command, { cwd, platform = process.platform, timeoutMs = RESOLVE_TIMEOUT_MS } = {}) {
  if (!command || typeof command !== 'string') return null;
  if (/[/\\]/.test(command)) return command;
  try {
    const probe = platform === 'win32'
      ? spawnSync('where', [command], probeOptions({ cwd, timeoutMs }))
      : spawnSync('which', [command], probeOptions({ timeoutMs }));
    if (probe.status !== 0 || !probe.stdout) return null;
    return pickBestCandidate(probe.stdout);
  } catch {
    return null;
  }
}

function probeOptions({ cwd, timeoutMs }) {
  const options = { encoding: 'utf8', timeout: timeoutMs, windowsHide: true };
  if (cwd) options.cwd = cwd;
  return options;
}

/** 判断路径是否为 cmd 解释执行的批处理 shim（.cmd/.bat）。 */
export function isCmdShimPath(filePath) {
  if (!filePath || typeof filePath !== 'string') return false;
  return /\.cmd$/i.test(filePath) || /\.bat$/i.test(filePath);
}
