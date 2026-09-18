/**
 * 适配器能力声明（TASK-012，E13 修复）：每个 agent 类型真实声明
 * read/send/approve/stop/create 五项能力，依据 docs/首发范围与能力矩阵.md §2（T002 冻结稿）：
 *   - claude-code：全链路（stream-json 双向 + control_response 审批 + 停止 + 新建）。
 *   - codex / generic：仅「查看输出」解析级；send/approve=false——统一 Claude 输入帧
 *     不适用（E13），session-manager 对不支持的能力拒绝执行，绝不向 stdin 乱发帧。
 *   - stop：runner 进程树终止，跨适配器通用。
 *   - create：进程可拉起；但 create_session 的初始 prompt 经 sendText 注入，
 *     send=false 时 session-manager 会拒绝携带 prompt 的 create（矩阵注记"prompt 注入无效"）。
 *
 * 未实测的真实 CLI 往返统一挂验证队列 V03；能力开关只声明"代码路径是否存在"，
 * 不宣称真实 CLI 已验证（矩阵 🔶→✅ 升级规则见首发范围 §2.4）。
 */
import fs from 'node:fs';
import path from 'node:path';

export const CAPABILITY_KEYS = Object.freeze(['read', 'send', 'approve', 'stop', 'create']);

const FULL_CAPABILITIES = Object.freeze({ read: true, send: true, approve: true, stop: true, create: true });
const READONLY_CAPABILITIES = Object.freeze({ read: true, send: false, approve: false, stop: true, create: true });

export const ADAPTER_CAPABILITIES = Object.freeze({
  'claude-code': FULL_CAPABILITIES,
  codex: READONLY_CAPABILITIES,
  generic: READONLY_CAPABILITIES,
});

/** 按 agent 类型取能力声明；未知类型按最保守的只读处理（fail-closed）。 */
export function capabilitiesFor(agentType) {
  return ADAPTER_CAPABILITIES[agentType] || READONLY_CAPABILITIES;
}

/** child 是否位于 root 内（含 root 本身）；win32 大小写不敏感。 */
export function isPathInside(child, root) {
  if (!child || !root) return false;
  const c = normalizeComparable(child);
  const r = normalizeComparable(root);
  if (!r) return false;
  if (c === r) return true;
  const sep = path.sep;
  return c.startsWith(r.endsWith(sep) ? r : `${r}${sep}`);
}

function normalizeComparable(p) {
  let out = path.normalize(String(p)).replace(/[\\/]+$/, '');
  if (process.platform === 'win32') out = out.toLowerCase();
  return out;
}

function statDir(p) {
  return fs.statSync(p);
}

function realpathOrNull(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

/**
 * 工作区授权判定（TASK-012/D4）：
 *   1) rawCwd 必须是绝对路径（不做 path.resolve 兜底——相对路径直接拒绝）；
 *   2) fs.stat 必须是目录；
 *   3) realpath 前后都做授权根前缀判断（防符号链接逃逸）；
 *  授权根列表本身应为 realpath 规范路径（`workspace add` 时已归一）。
 *
 * @returns {{ ok: true, cwd: string } | { ok: false, reason: string }}
 */
export function authorizeWorkspace({ rawCwd, workspaces = [], stat = statDir, realpath = realpathOrNull }) {
  const cwd = String(rawCwd || '').trim();
  if (!cwd || cwd.length > 500) return { ok: false, reason: 'invalid-cwd' };
  if (!path.isAbsolute(cwd)) return { ok: false, reason: 'cwd-not-absolute' };
  if (!Array.isArray(workspaces) || workspaces.length === 0) {
    return { ok: false, reason: 'no-authorized-workspaces' };
  }

  let st = null;
  try {
    st = stat(cwd);
  } catch {
    return { ok: false, reason: 'cwd-not-found' };
  }
  if (!st || !st.isDirectory()) return { ok: false, reason: 'cwd-not-directory' };

  // 前缀包含判断：realpath 前后各做一次（符号链接可能把前缀内路径映射到根外）。
  const realCwd = realpath(cwd);
  const normalizedRoots = workspaces.map((w) => String(w || '').trim()).filter(Boolean);
  const preOk = normalizedRoots.some((root) => isPathInside(cwd, root));
  const postOk = realCwd ? normalizedRoots.some((root) => isPathInside(realCwd, root)) : false;
  if (!preOk) return { ok: false, reason: 'cwd-outside-workspaces' };
  if (!postOk) return { ok: false, reason: 'cwd-symlink-escape' };
  return { ok: true, cwd: realCwd || cwd };
}
