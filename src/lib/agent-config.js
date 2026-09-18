import fs from 'node:fs';
import path from 'node:path';

/**
 * 去注释：仅剥离引号之外的 `#` 起始内容（TASK-029）。
 * 朴素 replace(/#.*$/,'') 会把 `color: "#6366F1"` 这类带引号的颜色值截断成 `color: "`，
 * 导致 ui 块颜色声明永远无法到达渲染器；引号内 `#` 一律保留。
 */
function stripComment(raw) {
  let quote = null;
  let out = '';
  for (const ch of String(raw)) {
    if (quote) {
      out += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      out += ch;
      continue;
    }
    if (ch === '#') break;
    out += ch;
  }
  return out;
}

/**
 * Minimal YAML-subset parser for the `miniproctor:` and `ui:` blocks in
 * AGENTS.md. Deliberately small: it parses nested maps, sequences and scalar
 * lists, which is all the template needs.
 */
export function parseAgentConfig(text) {
  const lines = String(text || '').split(/\r?\n/);
  const root = {};
  const stack = [{ indent: -1, value: root, isList: false }];
  let current = root;

  const setValue = (key, value) => {
    if (Array.isArray(current)) current.push({ [key]: value });
    else current[key] = value;
  };

  for (let raw of lines) {
    const noComment = stripComment(raw);
    if (!noComment.trim()) continue;
    const indent = noComment.search(/\S/);
    const line = noComment.trim();
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop();
    current = stack[stack.length - 1].value;

    if (line.startsWith('- ')) {
      const body = line.slice(2).trim();
      const colon = body.indexOf(':');
      if (colon > 0) {
        const key = body.slice(0, colon).trim();
        const valueText = body.slice(colon + 1).trim();
        const item = {};
        current.push(item);
        // TASK-029：多行列表项（`- key: value` + 后续更深缩进的键）必须合并进同一 item。
        // 旧实现只在 valueText 为空时压栈，导致 custom_events 的 render/color 被拆成
        // 独立数组元素，声明整条失效（官方模板即此形态）。
        stack.push({ indent, value: item, isList: false });
        current = item;
        if (valueText !== '') item[key] = parseScalar(valueText);
      } else {
        current.push(parseScalar(body));
      }
      continue;
    }

    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const key = line.slice(0, colon).trim();
    const valueText = line.slice(colon + 1).trim();
    if (valueText === '') {
      const nextLine = lines.slice(lines.indexOf(raw) + 1).map((l) => stripComment(l)).find((l) => l.trim());
      const isList = Boolean(nextLine && nextLine.trim().startsWith('- '));
      const child = isList ? [] : {};
      setValue(key, child);
      stack.push({ indent, value: child, isList });
      current = child;
    } else if (valueText.startsWith('[') && valueText.endsWith(']')) {
      const inner = valueText.slice(1, -1).split(',').map((s) => parseScalar(s.trim())).filter((s) => s !== '');
      setValue(key, inner);
    } else {
      setValue(key, parseScalar(valueText));
    }
  }
  return root;
}

export function loadAgentConfig(cwd = process.cwd()) {
  const file = resolveAgentsFile(cwd);
  if (!fs.existsSync(file)) return { ok: false, source: null, miniproctor: null, ui: null };
  const parsed = parseAgentConfig(fs.readFileSync(file, 'utf8'));
  return {
    ok: true,
    source: file,
    miniproctor: parsed.miniproctor || null,
    ui: parsed.ui || null,
  };
}

/** 优先精确 AGENTS.md；Linux 大小写敏感文件系统上回退不区分大小写匹配并告警。 */
function resolveAgentsFile(cwd) {
  const direct = path.join(cwd, 'AGENTS.md');
  if (fs.existsSync(direct)) return direct;
  try {
    const hit = fs.readdirSync(cwd).find((name) => name.toLowerCase() === 'agents.md');
    if (hit) {
      console.warn(`[agent-config] AGENTS.md 未精确命中，使用大小写不敏感匹配：${hit}`);
      return path.join(cwd, hit);
    }
  } catch { /* 目录不可读则按原路径返回 */ }
  return direct;
}

function parseScalar(text) {
  const s = String(text).trim().replace(/^['"]|['"]$/g, '');
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (/^-?\d+$/.test(s)) return Number(s);
  if (/^-?\d*\.\d+$/.test(s)) return Number(s);
  return s;
}

/* ------------------------------------------------------------------ *
 * TASK-029：AGENTS.md `ui` 块 → 白名单化 ui_overrides（Layer 3 真实通道）。
 * 协议：docs/agents-ui-protocol.md v0.2-draft。要点：
 *   - render 白名单与 miniprogram/components/template-renderer ALLOWED 对齐；
 *   - nested（event_overrides / custom_events[]）→ flat renders 映射（event_type 或 custom id 为键）；
 *   - 逐字段裁剪：未知 render/未知键/非法值一律丢弃（恶意 AGENTS 只能“少声明”，不能多带东西）；
 *   - 总体 ≤4KB：超出按插入序丢尾部条目并打 truncated 标记；
 *   - 纯函数、零依赖、任何输入不抛错：非法输入返回 null（fail-open，不影响主事件流）。
 * ------------------------------------------------------------------ */
export const UI_RENDER_WHITELIST = Object.freeze([
  'progress_bar', 'thinking_stream', 'list', 'table', 'log', 'card_with_diff',
]);
export const UI_OVERRIDES_MAX_BYTES = 4 * 1024;

const UI_KEY_RE = /^[\w.:-]{1,64}$/;
const UI_COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const UI_MAX_RENDERS = 24;
const UI_MAX_LABEL_CHARS = 50;
const UI_MAX_VERSION_CHARS = 32;
const UI_MAX_COLLAPSE_AFTER_SECONDS = 3600;

// 各 render 允许的声明键（白名单之外的键——含 actions/timeout_seconds/default_on_timeout
// 等未接线字段——一律不下发：动作仍由 bridge 适配器生成的 event.actions 承载，
// 声明通道不产生任何新执行路径）。
const UI_RENDER_FIELDS = Object.freeze({
  progress_bar: ['label', 'show_percent', 'color', 'collapse_after'],
  thinking_stream: ['color', 'collapse_after'],
  list: ['color'],
  table: ['color'],
  log: ['color', 'collapse_after'],
  card_with_diff: ['color'],
});

function jsonBytes(value) {
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8');
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

/** 单条声明白名单化：只保留该 render 允许且取值合法的键。 */
function cleanUiSpec(render, raw) {
  const out = { render };
  for (const key of UI_RENDER_FIELDS[render] || []) {
    const v = raw[key];
    if (key === 'color') {
      if (typeof v === 'string' && UI_COLOR_RE.test(v)) out.color = v;
    } else if (key === 'show_percent') {
      if (typeof v === 'boolean') out.show_percent = v;
    } else if (key === 'label') {
      if (typeof v === 'string' && v.trim() !== '') out.label = v.trim().slice(0, UI_MAX_LABEL_CHARS);
    } else if (key === 'collapse_after') {
      const n = Number(v);
      if (Number.isFinite(n) && n >= 0) out.collapse_after = Math.min(UI_MAX_COLLAPSE_AFTER_SECONDS, Math.round(n));
    }
  }
  return out;
}

/**
 * AGENTS.md `ui` 块（parseAgentConfig 产物）→ 规范化 ui_overrides。
 * @returns {{ ui_version: string, renders: object, truncated?: boolean } | null}
 *          无有效条目/输入非法 → null。
 */
export function sanitizeUiOverrides(uiBlock) {
  if (!uiBlock || typeof uiBlock !== 'object' || Array.isArray(uiBlock)) return null;
  const renders = {};
  let trimmed = false; // 条目数上限/字节上限发生裁剪 → truncated 标记（消费方可提示声明不完整）
  const push = (key, spec) => {
    if (typeof key !== 'string' || !UI_KEY_RE.test(key)) return;
    if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return;
    if (typeof spec.render !== 'string' || !UI_RENDER_WHITELIST.includes(spec.render)) return; // 未知 render：整条丢弃
    if (renders[key]) return; // 重复键先到为准
    if (Object.keys(renders).length >= UI_MAX_RENDERS) { trimmed = true; return; } // 条目数封顶
    renders[key] = cleanUiSpec(spec.render, spec);
  };
  const eo = uiBlock.event_overrides;
  if (eo && typeof eo === 'object' && !Array.isArray(eo)) {
    for (const [key, spec] of Object.entries(eo)) push(key, spec);
  }
  const ce = uiBlock.custom_events;
  if (Array.isArray(ce)) {
    for (const item of ce) {
      if (item && typeof item === 'object' && !Array.isArray(item)) push(item.id, item);
    }
  }
  if (Object.keys(renders).length === 0) return null;
  const uiVersion = (typeof uiBlock.version === 'string' || typeof uiBlock.version === 'number')
    ? String(uiBlock.version).slice(0, UI_MAX_VERSION_CHARS)
    : '0';
  let out = { ui_version: uiVersion, renders };
  // 总体 ≤4KB：超出丢尾部条目（保插入序前缀），全部丢光则整块放弃
  if (jsonBytes(out) > UI_OVERRIDES_MAX_BYTES) {
    const keys = Object.keys(renders);
    while (keys.length > 0 && jsonBytes(out) > UI_OVERRIDES_MAX_BYTES) {
      delete renders[keys.pop()];
      out = { ui_version: uiVersion, renders };
    }
    if (keys.length === 0) return null;
    return { ...out, truncated: true };
  }
  return trimmed ? { ...out, truncated: true } : out;
}

/**
 * 读取 cwd 下 AGENTS.md 的 `ui` 块并白名单化（session_meta 上报用）。
 * 任何失败（目录不可读/解析异常）fail-open 返回 null，绝不影响事件流。
 */
export function loadUiOverrides(cwd = process.cwd()) {
  try {
    const cfg = loadAgentConfig(cwd);
    return sanitizeUiOverrides(cfg && cfg.ui);
  } catch {
    return null;
  }
}
