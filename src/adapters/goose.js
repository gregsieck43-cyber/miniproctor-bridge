import { createEvent, sanitizeSensitiveText } from '../lib/events.js';

const STREAM_CHUNK_CHARS = 512;
const pendingBySequencer = new WeakMap();

function flushMessage({ sessionId, agentType, sequencer }, state, isFinal = false) {
  if (!state?.text) return [];
  const content = sanitizeSensitiveText(state.text);
  state.text = '';
  return [createEvent({
    sessionId, agentType, sequencer, eventType: 'agent_message',
    payload: {
      message_id: state.id, stream_id: state.id, role: 'assistant',
      content, content_type: 'text', is_final: isFinal,
    },
  })];
}

// V12-A24：Goose 1.52.0 Windows stream-json 解析器。2026-09-26 README 级调查只
// 建立了保守兜底；2026-09-28 官方固定包、真实模型输出和 bridge profile 验证后增加
// message/complete 帧映射。仅绑定 goose profile 识别，未知帧不透传正文；无 profile
// 的全局探测仍不认领 Goose 帧。产品静态配方强制 chat/no-profile，禁用工具和扩展，
// 手机不能传入额外启动参数。其他模式、其他 OS 均未验证。

// Goose 1.52.0 Windows `run --output-format stream-json` 真机帧：message 为同一 id 的
// 文本片段；complete 带 token 计数。仅绑定 goose profile 时由 generic.js 调用，
// 不参与无 profile 的全局探测，避免与其他产品的同名帧碰撞。
export function isGooseStreamType(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  try {
    if (raw.type === 'message') {
      return raw.message?.role === 'assistant' && Array.isArray(raw.message?.content)
        && raw.message.content.some((item) => item?.type === 'text' && typeof item.text === 'string');
    }
    return raw.type === 'complete' && Number.isSafeInteger(raw.input_tokens)
      && raw.input_tokens >= 0 && Number.isSafeInteger(raw.output_tokens)
      && raw.output_tokens >= 0;
  } catch {
    return false;
  }
}

export function mapGooseRaw(raw, { sessionId, agentType = 'generic', sequencer }) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
  if (isGooseStreamType(raw) && raw.type === 'message') {
    const id = typeof raw.message.id === 'string' && raw.message.id
      ? raw.message.id.slice(0, 128) : `goose_${sequencer.value + 1}`;
    let state = pendingBySequencer.get(sequencer);
    const events = [];
    if (state && state.id !== id) events.push(...flushMessage({ sessionId, agentType, sequencer }, state, true));
    if (!state || state.id !== id) state = { id, text: '' };
    for (const item of raw.message.content) {
      if (item?.type !== 'text' || typeof item.text !== 'string') continue;
      state.text += item.text;
      while (state.text.length >= STREAM_CHUNK_CHARS) {
        const chunk = { id: state.id, text: state.text.slice(0, STREAM_CHUNK_CHARS) };
        state.text = state.text.slice(STREAM_CHUNK_CHARS);
        events.push(...flushMessage({ sessionId, agentType, sequencer }, chunk));
      }
    }
    pendingBySequencer.set(sequencer, state);
    return events;
  }
  if (isGooseStreamType(raw) && raw.type === 'complete') {
    const pending = pendingBySequencer.get(sequencer);
    pendingBySequencer.delete(sequencer);
    return [...flushMessage({ sessionId, agentType, sequencer }, pending, true), createEvent({
      sessionId, agentType, sequencer, eventType: 'session_end',
      payload: {
        reason: 'completed', summary: 'Goose 回合结束',
        usage: { input_tokens: raw.input_tokens, output_tokens: raw.output_tokens },
      },
    })];
  }
  const frameType = safeFrameType(raw);
  return [createEvent({
    sessionId, agentType, sequencer,
    eventType: 'custom',
    payload: {
      custom_type: 'goose_raw',
      fallback_text: `Goose 未识别帧（官方快照无结构化协议文档）：${frameType || 'unknown'}`,
      data: { type: frameType || null },
    },
  })];
}

/** 帧属性读取防御：畸形/hostile 帧的 getter 可能抛错，解析器不得连带抛出（契约 §3.3）。 */
function safeFrameType(raw) {
  try {
    return typeof raw.type === 'string' ? raw.type.slice(0, 128) : '';
  } catch {
    return '';
  }
}
