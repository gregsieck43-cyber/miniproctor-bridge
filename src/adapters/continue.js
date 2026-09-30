import { createEvent, sanitizeSensitiveText, truncateText } from '../lib/events.js';

// Continue CLI（cn）headless 模式适配器（V12-A08）。官方仅定义 `-p`、
// `--format json`、权限行为，未公布 JSON schema；1.5.47 Windows 真机输出及安全
// 配方证据见 docs/release/v1.2/agents/continue.md。无 profile 的全局流不识别任何
// Continue 帧；绑定 continue profile 后在成功退出/管道排空后读取完整 JSON 答复。
// `--exclude '*'` 禁全部工具：固定版 `--readonly` 仍放行 Bash/MCP，不能作安全门。
// 无审批回传与工具事件协议，故不生成 confirm_required/tool_call/usage。

export function isContinueStreamType(raw) {
  // --format json 官方未记载 schema——fail-closed：不认领任何帧（V12-A08 证据卡）。
  // 若后续官方补记 schema（或 V03 真实 CLI 取证），在此按官方形状扩入并补 fixture。
  void raw;
  return false;
}

// Continue CLI 1.5.47 Windows `--exclude '*' --silent -p --format json`：非 JSON
// 回复包装为 {response,status,note}；合法模型 JSON 原样输出，包括 pretty JSON 换行。
// 只在已绑定 continue profile 时识别；无 profile
// 全局探测仍保持上面的 false，避免与其他产品的 JSON 帧碰撞。
export function isContinueHeadlessOutput(raw) {
  return raw !== null && raw !== undefined;
}

export function mapContinueHeadlessOutput(raw, { sessionId, agentType = 'generic', sequencer, line } = {}) {
  if (!isContinueHeadlessOutput(raw)) return [];
  const safeContent = sanitizeSensitiveText(truncateText(continueContent(raw, line), 6000));
  if (!safeContent) return [];
  return [createEvent({
    sessionId, agentType, sequencer, eventType: 'agent_message',
    payload: {
      message_id: `continue_${sequencer.value + 1}`,
      role: 'assistant', content: safeContent, content_type: 'text', is_final: true,
    },
  })];
}

function continueContent(raw, line) {
  let content = typeof raw === 'string' ? raw : String(line || '');
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const keys = Object.keys(raw);
    if (typeof raw.response === 'string' && keys.every((key) => ['response', 'status', 'note'].includes(key))) {
      content = raw.response;
    } else if (typeof raw.reply === 'string' && keys.length === 1) {
      content = raw.reply;
    }
  }
  return content;
}

// 有界整帧读取：不猜测部分 JSON、多个 JSON 或 CLI 诊断文本的含义。
export class ContinueOutputAccumulator {
  constructor({ maxBytes = 1024 * 1024 } = {}) {
    this.maxBytes = maxBytes;
    this.lines = [];
    this.bytes = 0;
    this.truncated = false;
  }

  consume(line) {
    if (this.truncated) return;
    const next = String(line) + '\n';
    const bytes = Buffer.byteLength(next, 'utf8');
    if (this.bytes + bytes > this.maxBytes) {
      this.truncated = true;
      this.lines = [];
      return;
    }
    this.lines.push(next);
    this.bytes += bytes;
  }

  finish({ success = false } = {}) {
    if (!success || this.truncated || !this.lines.length) return null;
    const line = this.lines.join('').trim();
    try {
      const raw = JSON.parse(line);
      if (!isContinueHeadlessOutput(raw)) return null;
      const content = continueContent(raw, line);
      const safe = sanitizeSensitiveText(truncateText(content, 6000));
      return safe ? { content: safe, truncated: content.length > 6000 } : null;
    } catch {
      return null;
    }
  }
}

export function mapContinueRaw(raw, { sessionId, agentType = 'generic', sequencer }) {
  if (!raw || typeof raw !== 'object') return [];
  // 防御性兜底：一切帧按未识别处理，保留可观测性，不猜测语义、不产生终态/审批事件。
  return [createEvent({
    sessionId, agentType, sequencer,
    eventType: 'custom',
    payload: {
      custom_type: 'continue_raw',
      fallback_text: 'Continue 输出（官方未记载 JSON 结构，未解析）',
      data: { type: typeof raw.type === 'string' ? raw.type : null },
    },
  })];
}
