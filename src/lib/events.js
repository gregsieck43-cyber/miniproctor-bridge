import crypto from 'node:crypto';
import fs from 'node:fs';

// P3-H（CLOSE-007）：bridge_version 从 package.json 读取真实版本（发行包为扁平结构，
// package.json 与 src/ 同在解压根目录，运行时读取可靠；make-release.cjs 亦以它命名
// 发行 zip）。读取失败降级为 '0.0.0'——可观测的缺位优于硬编码漂移（旧值 '0.0.1' 与
// 实际 0.5.0 脱节，排障时误导版本判断）。
const BRIDGE_VERSION = (() => {
  try {
    const pkg = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
    return typeof pkg?.version === 'string' && pkg.version ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

// 常量来源：本文件的枚举与限额常量与 xcx/protocol/schema.cjs（TASK-028 协议单一事实源）同源对齐，
// 由 xcx/tests/protocol.test.cjs 对拍门禁强制一致（bridge 发行包自包含，故运行时保持字面常量+来源注释）。
// 修改任一侧前先看 protocol/README.md 的变更流程。
export const EVENT_TYPES = Object.freeze([
  'user_message',
  'agent_message',
  'tool_call',
  'tool_result',
  'file_change',
  'task_progress',
  'step_done',
  'confirm_required',
  'error',
  'session_end',
  'custom',
]);

export const AGENT_TYPES = Object.freeze(['claude-code', 'codex', 'generic']);

export class SessionSequencer {
  constructor(start = 0) {
    this.current = start;
  }

  next() {
    this.current += 1;
    return this.current;
  }

  get value() {
    return this.current;
  }
}

export function createEvent({
  sessionId,
  agentType = 'generic',
  eventType,
  payload = {},
  actions = [],
  metadata = {},
  sequencer,
  ts,
}) {
  if (!sessionId || typeof sessionId !== 'string') {
    throw new TypeError('event requires sessionId');
  }
  if (!EVENT_TYPES.includes(eventType)) {
    throw new TypeError(`unknown event_type: ${eventType}`);
  }
  if (!AGENT_TYPES.includes(agentType)) {
    throw new TypeError(`unknown agent_type: ${agentType}`);
  }
  if (!sequencer) {
    throw new TypeError('event requires a SessionSequencer');
  }
  // TASK-019 ②④：时间戳超窗（±1 天）修正——ts 来自本机时钟；调用方显式传入的 ts
  // （或被拨快的系统时钟）超出窗口时按服务器接收时间策略修正为当前时间并打标记。
  const now = Date.now();
  let eventTs = typeof ts === 'number' && Number.isFinite(ts) && ts > 0 ? ts : now;
  let tsCorrected = false;
  if (Math.abs(eventTs - now) > EVENT_TS_WINDOW_MS) {
    eventTs = now;
    tsCorrected = true;
  }
  const meta = {
    bridge_version: BRIDGE_VERSION,
    protocol_version: '0.1',
    ...metadata,
  };
  // TASK-019 ②③：敏感模式二次清洗——标记 sensitive 仍要上行的事件（如显式开启的
  // thinking 透传），先对 payload 文本做凭据形态清洗再序列化（不能识别全部秘密，
  // 见 docs/隐私与数据清单.md §3 的如实表述）。
  const safePayload = meta.sensitive ? scrubPayloadStrings(payload) : payload;
  const event = {
    event_id: `e_${crypto.randomUUID()}`,
    session_id: sessionId,
    seq: sequencer.next(),
    ts: eventTs,
    agent_type: agentType,
    event_type: eventType,
    payload: safePayload,
    actions,
    metadata: meta,
  };
  if (tsCorrected) event.metadata.ts_corrected = true;
  // TASK-019 ②②：构造即收敛——单事件信封 >7.5KB 时就地截断（outbox/云函数 8KB 之上
  // 留出安全余量），头部字段保真，正文打 truncated/original_bytes 标记。
  return minimizeEventSize(event);
}

export function validateEvent(event) {
  const problems = [];
  if (!event || typeof event !== 'object') problems.push('not an object');
  if (!event?.event_id) problems.push('missing event_id');
  if (!event?.session_id) problems.push('missing session_id');
  if (!Number.isInteger(event?.seq) || event.seq < 1) problems.push('invalid seq');
  if (!EVENT_TYPES.includes(event?.event_type)) problems.push('invalid event_type');
  if (!AGENT_TYPES.includes(event?.agent_type)) problems.push('invalid agent_type');
  if (!event?.payload || typeof event.payload !== 'object') problems.push('invalid payload');
  return { valid: problems.length === 0, problems };
}

/* ------------------------------------------------------------------ *
 * TASK-019 ②：内容最小化（默认不上传敏感正文 / 信封截断 / 敏感清洗 / ts 窗口）
 * ------------------------------------------------------------------ */

/** 单事件信封序列化目标上限：7.5KB（protocol EVENT_ENVELOPE_TARGET_BYTES），低于云端单事件 8KB 硬上限（syncReport MAX_EVENT_BYTES = protocol EVENT_ENVELOPE_MAX_BYTES）。 */
export const MAX_EVENT_ENVELOPE_BYTES = 7.5 * 1024;
/** 事件时间戳合理窗：±1 天（protocol TS_WINDOW_MS，与云函数 lib-validate DEFAULT_TS_WINDOW_MS 同值）。 */
export const EVENT_TS_WINDOW_MS = 24 * 60 * 60 * 1000;
/** thinking/sensitive 类事件默认不上传正文（TASK-019 ②①，落实《隐私与数据清单》"默认不上传"）。 */
export const DEFAULT_UPLOAD_THINKING = false;

// 事件策略（模块级）：main.js 启动时用 config.bridge.uploadThinking 调 setEventPolicy 覆盖；
// 默认 false = thinking 降级为脱敏占位事件，显式 true 才透传正文。
const eventPolicy = { uploadThinking: DEFAULT_UPLOAD_THINKING };

export function setEventPolicy(patch = {}) {
  if ('uploadThinking' in patch) eventPolicy.uploadThinking = patch.uploadThinking === true;
}

export function getEventPolicy() {
  return { ...eventPolicy };
}

// 敏感模式二次清洗：与 src/agent/runner.js 的 CREDENTIAL_PATTERNS / sanitizeDiagnosticText
// （TASK-012）同源；复制为独立小函数以避免 lib → agent 反向依赖（runner 依赖 child_process 等）。
// 与 runner 版的差异：不折叠空白、不截断——这里清洗的是 payload 正文（保留换行语义），
// 长度控制由信封截断（minimizeEventSize）统一负责。
const CREDENTIAL_PATTERNS = [
  [/sk-[A-Za-z0-9_-]{6,}/g, 'sk-***'],
  [/gh[pousr]_[A-Za-z0-9]{6,}/g, 'gh_***'],
  [/Bearer\s+[A-Za-z0-9._~+/=-]{6,}/gi, 'Bearer ***'],
  [/(\b(?:api[_-]?key|token|secret|password|passwd|authorization)\b\s*[=:：]\s*)("[^"]*"|'[^']*'|\S+)/gi, '$1***'],
];

/** 对单个文本做凭据形态清洗（只替换值，不保留原文；不能识别全部秘密，见隐私清单 §3）。 */
export function sanitizeSensitiveText(text) {
  if (typeof text !== 'string' || !text) return text;
  let out = text;
  for (const [pattern, replacement] of CREDENTIAL_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

/** 递归清洗对象/数组内所有字符串叶子的凭据形态内容（metadata.sensitive 事件专用）。 */
function scrubPayloadStrings(value, seen = new Set()) {
  if (typeof value === 'string') return sanitizeSensitiveText(value);
  if (!value || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => scrubPayloadStrings(item, seen));
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = scrubPayloadStrings(v, seen);
    return out;
  } finally {
    seen.delete(value);
  }
}

/** 按码点截断 UTF-8 字符串到字节预算内（中文/emoji 不劈半，绝不产生坏码点）。 */
export function truncateByCodePoints(text, maxBytes) {
  if (typeof text !== 'string' || !(maxBytes > 0)) return '';
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  let out = '';
  let bytes = 0;
  for (const ch of text) { // for..of 按 Unicode 码点迭代（代理对不拆分）
    const b = Buffer.byteLength(ch, 'utf8');
    if (bytes + b > maxBytes) break;
    out += ch;
    bytes += b;
  }
  return out;
}

function jsonBytes(value) {
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8');
  } catch {
    return Number.POSITIVE_INFINITY; // 不可序列化 → 视为超限，交给兜底分支
  }
}

/**
 * 信封体积收敛（TASK-019 ②②）：事件序列化后超过 maxBytes 时，按"最大字符串叶子优先"
 * 逐个收缩 payload 文本（按码点截断，头部字段保真），并打 truncated/original_bytes 标记。
 * 收缩仍不达标（极端结构/大量小字段）时兜底为纯标记占位 payload。
 * @returns {object} 原对象就地修改后返回（调用方持有的引用即最小化后的事件）
 */
export function minimizeEventSize(event, maxBytes = MAX_EVENT_ENVELOPE_BYTES) {
  if (!event || typeof event !== 'object') return event;
  const originalBytes = jsonBytes(event);
  if (Number.isFinite(originalBytes) && originalBytes <= maxBytes) return event;

  // 预留标记字段与 JSON 转义放大的余量，保证最终（含标记）不超预算
  const budget = Math.max(256, maxBytes - 160);
  const suffix = '…[truncated]';
  const suffixBytes = Buffer.byteLength(suffix, 'utf8');

  const collectLeaves = (node, out) => {
    if (typeof node === 'string') out.push(node);
    else if (Array.isArray(node)) node.forEach((item) => collectLeaves(item, out));
    else if (node && typeof node === 'object') Object.values(node).forEach((v) => collectLeaves(v, out));
  };

  for (let round = 0; round < 64; round += 1) {
    const total = jsonBytes(event);
    if (Number.isFinite(total) && total <= budget) break;
    // 每轮收缩当前最大的一段文本（含 metadata 中可能的大字段）
    const leaves = [];
    collectLeaves(event.payload, leaves);
    collectLeaves(event.metadata, leaves);
    if (!leaves.length) break;
    leaves.sort((a, b) => Buffer.byteLength(b, 'utf8') - Buffer.byteLength(a, 'utf8'));
    const target = leaves[0];
    const targetBytes = Buffer.byteLength(target, 'utf8');
    const excess = total - budget;
    const keep = Math.max(0, targetBytes - excess - suffixBytes - 16);
    // 就地替换字符串叶子：通过父对象引用替换（collectLeaves 收集时同步记录宿主）
    replaceLeaf(event, target, truncateByCodePoints(target, keep) + suffix);
  }

  if (jsonBytes(event) > maxBytes) {
    // 兜底：仍超限（如海量小字段/不可序列化结构）→ 只保留标记性占位正文
    event.payload = { truncated: true, original_bytes: originalBytes };
  }
  event.metadata = {
    ...(event.metadata || {}),
    truncated: true,
    original_bytes: Number.isFinite(originalBytes) ? originalBytes : -1,
  };
  return event;
}

/** 在 event.payload/metadata 树中找到 === target 的字符串叶子并用宿主对象就地替换。 */
function replaceLeaf(node, target, replacement) {
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i += 1) {
      if (node[i] === target) { node[i] = replacement; return true; }
      if (replaceLeaf(node[i], target, replacement)) return true;
    }
    return false;
  }
  if (node && typeof node === 'object') {
    for (const key of Object.keys(node)) {
      if (node[key] === target) { node[key] = replacement; return true; }
      if (replaceLeaf(node[key], target, replacement)) return true;
    }
  }
  return false;
}

/**
 * thinking/sensitive 事件的脱敏占位（TASK-019 ②①）：不发思考正文，只保留类型与
 * 体量信息（redacted/original_bytes），手机端可见"思考已省略"而不是空白。
 */
export function redactThinkingEvent({ sessionId, agentType, sequencer, originalText = '' }) {
  return createEvent({
    sessionId,
    agentType,
    sequencer,
    eventType: 'custom',
    payload: {
      custom_type: 'thinking',
      fallback_text: '思考内容已按隐私策略省略（默认不上传）',
      redacted: true,
      original_bytes: Buffer.byteLength(String(originalText), 'utf8'),
    },
    metadata: { sensitive: true, redacted: true },
  });
}

/**
 * 按字节预算截断文本（TASK-019：改为按码点截断——中文/emoji 不劈半，不产生 U+FFFD）。
 * 用于 file_change diff 预览等固定上限字段；事件信封整体截断见 minimizeEventSize。
 */
export function truncateText(text, maxBytes = 8192, suffix = '…[truncated]') {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  return `${truncateByCodePoints(text, maxBytes - Buffer.byteLength(suffix, 'utf8'))}${suffix}`;
}

export function sanitizePreview(value, maxChars = 500) {
  let text;
  if (typeof value === 'string') text = value;
  else {
    try {
      text = JSON.stringify(value);
    } catch {
      text = String(value);
    }
  }
  if (text.length > maxChars) return `${text.slice(0, maxChars)}…`;
  return text;
}
