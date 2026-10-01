/**
 * 适配器能力声明（V1-005 能力拆分 → V12-09 能力契约冻结）。
 *
 * 权威口径：protocol/schema.cjs CAPABILITY_KEYS / INTEGRATION_MODES / INITIAL_PROMPT_CHANNELS
 * （本文件为 bridge 发行包自包含的字面常量镜像，来源注释标注；漂移由 tests/protocol.test.cjs
 * 对拍强制）。规范文档：../agents/adapter-contract.md §2「能力声明与守卫」。
 *
 * 能力形态 = 8 能力布尔 + integrationMode + initialPromptChannel：
 *   - create   可拉起新会话
 *   - read     可解析输出流
 *   - stop     可受控停止（runner 进程树终止，bridge 自有能力）
 *   - append   会话中途追加输入（原 v0.2 `send` 更名——初始输入与追加输入是两个独立能力，
 *              初始输入由 initialPromptChannel 表达；codex exec 官方支持初始 prompt 作
 *              末位位置参数，但中途追加输入无官方通道，append=false）
 *   - resume   恢复既有会话（续接原对话）
 *   - approve  可回写审批决议（control_response 类帧）
 *   - fileChanges 可上报文件变更事件
 *   - usage    可上报 token 用量（无统计不伪造人民币成本，§8.3）
 *   - integrationMode ∈ stdio|acp|local-api|hook|manual-report
 *   - initialPromptChannel ∈ stdin|launch-args|null（null=不接受初始 prompt）
 *
 * 两层视图与守卫（V12-09：未经真实验证的能力不得开放）：
 *   - ADAPTER_CAPABILITIES「声明层」：代码路径是否存在——执行门禁依据（session-manager 据此
 *     零进程拒绝，V1-005 立场不变；能力开关只声明"代码路径是否存在"，不宣称真实 CLI 已验证）。
 *   - VERIFIED_CAPABILITIES「验证层」：真实官方 CLI 的逐项证据；fixture/演示宿主只证明
 *     代码路径，不能开放具体产品能力。generic 的文本观察/受控停止是协议兜底。
 *   - openCapabilitiesFor「开放视图」= 声明 ∩ 验证：对外宣称可用（session_meta capabilities、
 *     UI 能力摘要、云端 capability_snapshot）一律取开放视图；未知/未登记类型 fail-closed
 *     只读文本 + 受控停止（read+stop）。
 */
import fs from 'node:fs';
import path from 'node:path';

export const CAPABILITY_KEYS = Object.freeze(['create', 'read', 'stop', 'append', 'resume', 'approve', 'fileChanges', 'usage']);
export const INTEGRATION_MODES = Object.freeze(['stdio', 'acp', 'local-api', 'hook', 'manual-report']);
export const INITIAL_PROMPT_CHANNELS = Object.freeze(['stdin', 'launch-args']);

/* ---- 声明层（代码路径是否存在；执行门禁依据） ---- */

// claude-code：stream-json 双向（stdin 输入帧 + control_response 审批）+ 停止 + 新建；
// 初始 prompt 经 stdin 输入帧注入（prompt_channel='stdin'，会话启动后 sendText）。
const CLAUDE_CODE_CAPABILITIES = Object.freeze({
  create: true, read: true, stop: true, append: true, resume: false, approve: true,
  fileChanges: true, usage: true,
  integrationMode: 'stdio', initialPromptChannel: 'stdin',
});
// codex：追加输入（append）不可，但 exec 位置参数初始 prompt 官方支持（launch-args 通道）；
// 审批策略回调/文件变更/用量无已实现路径，一律 false。
const CODEX_CAPABILITIES = Object.freeze({
  create: true, read: true, stop: true, append: false, resume: false, approve: false,
  fileChanges: false, usage: false,
  integrationMode: 'stdio', initialPromptChannel: 'launch-args',
});
// generic：行流兜底无定义输入通道——append/初始 prompt 均 false（保守，零进程拒绝）；
// 只读文本 + 受控停止（V12-09：generic 默认能力底线，不含 create——未知规格不得替用户拉新进程）。
const GENERIC_CAPABILITIES = Object.freeze({
  create: false, read: true, stop: true, append: false, resume: false, approve: false,
  fileChanges: false, usage: false,
  integrationMode: 'stdio', initialPromptChannel: null,
});

export const ADAPTER_CAPABILITIES = Object.freeze({
  'claude-code': CLAUDE_CODE_CAPABILITIES,
  codex: CODEX_CAPABILITIES,
  generic: GENERIC_CAPABILITIES,
});

/* ---- 验证层（真实证据；openCapabilitiesFor 依据） ----
 * 证据口径（adapter-contract.md §2.3）：
 *   - Claude 2.1.286 / Codex 0.155.1：既有 DeepSeek 后端真实模型/原生进程停止
 *     已取证（.tools/validation/evidence/*-native-*-20261001.json）；仅开放文本三能力；
 *   - append/approve（claude-code）：演示宿主端到端往返已验证，但真实 CLI 往返（V03）未完成
 *     ——按 V12-09 守卫「未经真实验证的能力不得开放」，不进入开放视图；
 *   - fileChanges 未有真实文件变更证据；Claude 原生 result 已含真实 usage，独立统计
 *     链路未验；Codex usage 声明仍 false，均不进入本轮开放视图；
 *   - resume：无任何实现路径，声明即 false。
 * V03 真实 CLI 往返完成后由对应任务逐项翻入本表（附证据路径），并同步 adapter-contract.md。
 */
const VERIFIED_CAPABILITIES = Object.freeze({
  'claude-code': Object.freeze(['read', 'stop', 'create']),
  codex: Object.freeze(['read', 'stop', 'create']),
  generic: Object.freeze(['read', 'stop']),
});

/** 按 agent 类型取声明层能力；未知类型按最保守的 generic 处理（fail-closed）。 */
export function capabilitiesFor(agentType) {
  return ADAPTER_CAPABILITIES[agentType] || GENERIC_CAPABILITIES;
}

/**
 * 开放视图守卫（V12-09）：未经真实验证的能力不得开放。
 * 返回 = 声明层能力 ∩ 验证层能力（布尔键 + integrationMode + initialPromptChannel 原样透出，
 * create/initialPromptChannel 开放前提是 create+read 已验证且有初始输入通道）。
 * 未知/未登记类型 fail-closed：只读文本 + 受控停止（read+stop，generic 底线）。
 */
export function openCapabilitiesFor(agentType) {
  const declared = capabilitiesFor(agentType);
  const verified = VERIFIED_CAPABILITIES[agentType] || VERIFIED_CAPABILITIES.generic;
  return buildOpenCapabilities(declared, verified);
}

/** 同一守卫用于协议登记和产品目录；输入验证名单须来自对应真实证据。 */
export function buildOpenCapabilities(declared, verified) {
  const out = {};
  for (const key of CAPABILITY_KEYS) out[key] = Boolean(declared[key]) && verified.includes(key);
  out.integrationMode = declared.integrationMode;
  out.create = out.create && out.read && declared.initialPromptChannel !== null;
  out.initialPromptChannel = out.create && out.read ? declared.initialPromptChannel : null;
  return Object.freeze(out);
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
