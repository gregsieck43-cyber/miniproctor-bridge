import { createEvent, sanitizePreview } from '../lib/events.js';

// Codex `exec --json` emits JSONL. Event shapes are version-sensitive; this
// adapter is defensive: every branch falls back to `custom` when unknown.
// TODO(W5): run `codex exec --json` against a local repo to freeze schema v1.

export function isCodexStreamType(raw) {
  if (!raw || typeof raw !== 'object') return false;
  if (typeof raw.type !== 'string') return false;
  if (raw.type === 'event_msg' || raw.type === 'item' || raw.type === 'item.completed') return true;
  if (raw.type.startsWith('thread.') || raw.type.startsWith('turn.')) return true;
  return Boolean(raw.item && typeof raw.item === 'object');
}

export function mapCodexRaw(raw, { sessionId, agentType = 'codex', sequencer }) {
  if (!raw || typeof raw !== 'object') return [];
  const payload = raw.payload || {};
  const item = raw.item || payload.item || payload;
  const itemType = item.type || payload.type || raw.type;
  const events = [];

  if (itemType === 'agent_message' || itemType === 'assistant_message') {
    const message = item.message || item;
    const role = message.role || 'assistant';
    const content = Array.isArray(message.content) ? message.content : [{ type: 'output_text', text: message.content }];
    for (const part of content) {
      if (!part || typeof part !== 'object') continue;
      const text = part.text || part.content || part.output_text;
      if (text) {
        events.push(createEvent({
          sessionId, agentType, sequencer,
          eventType: role === 'user' ? 'user_message' : 'agent_message',
          payload: {
            message_id: item.id || `m_${crypto.randomUUID()}`,
            stream_id: item.id || null,
            role,
            content: String(text),
            content_type: 'text',
            is_final: Boolean(item.status === 'completed' || item.completed),
          },
        }));
      }
    }
    return events;
  }

  if (itemType === 'user_message') {
    const message = item.message || item;
    const text = typeof message.content === 'string' ? message.content : sanitizePreview(message.content);
    if (text) {
      events.push(createEvent({
        sessionId, agentType, sequencer,
        eventType: 'user_message',
        payload: { message_id: item.id || `m_${crypto.randomUUID()}`, role: 'user', content: text, content_type: 'text' },
      }));
    }
    return events;
  }

  if (itemType === 'command_execution' || itemType === 'local_shell_call') {
    events.push(createEvent({
      sessionId, agentType, sequencer,
      eventType: 'tool_call',
      payload: {
        tool_call_id: item.call_id || item.id || `tc_${crypto.randomUUID()}`,
        tool_name: item.name || 'Bash',
        input_preview: sanitizePreview(item.command || item.input || item.arguments || {}, 500),
        input_sensitive: false,
        status: item.status || 'running',
      },
    }));
    return events;
  }

  if (itemType === 'reasoning' || itemType === 'reasoning_text') {
    const text = item.text || item.summary || item.content;
    if (text) {
      events.push(createEvent({
        sessionId, agentType, sequencer,
        eventType: 'custom',
        payload: { custom_type: 'thinking', fallback_text: String(text).slice(0, 1000), data: { thinking: text } },
        metadata: { sensitive: true },
      }));
    }
    return events;
  }

  if (itemType === 'turn_status' || itemType === 'turn_delta') {
    events.push(createEvent({
      sessionId, agentType, sequencer,
      eventType: 'task_progress',
      payload: {
        task_id: item.turn_id || item.id || `task_${crypto.randomUUID()}`,
        title: 'Codex 执行中',
        current: numberOrZero(item.step) || numberOrZero(item.completed_steps),
        total: numberOrZero(item.total_steps),
        percent: clampPercent(item.percent),
      },
    }));
    return events;
  }

  if (raw.type === 'thread.started') {
    events.push(createEvent({
      sessionId, agentType, sequencer,
      eventType: 'custom',
      payload: { custom_type: 'system', system_subtype: 'thread_started', fallback_text: 'Codex 会话已启动', data: { thread_id: raw.thread_id || null } },
    }));
    return events;
  }

  if (raw.type === 'turn.started') {
    events.push(createEvent({
      sessionId, agentType, sequencer,
      eventType: 'task_progress',
      payload: { task_id: `turn_${crypto.randomUUID()}`, title: 'Codex 执行中', current: 0, total: null, percent: null },
    }));
    return events;
  }

  if (raw.type === 'turn.failed' || raw.type === 'error' || itemType === 'error') {
    const message = raw.message || raw.error?.message || item?.message || 'Codex 错误';
    events.push(createEvent({
      sessionId, agentType, sequencer,
      eventType: raw.type === 'turn.failed' ? 'session_end' : 'error',
      payload: {
        error_code: 'CODEX_TURN_FAILED',
        severity: 'fatal',
        message: String(message).slice(0, 1000),
        recoverable: false,
      },
    }));
    return events;
  }

  if (raw.type === 'result' || itemType === 'turn_complete' || itemType === 'session_end') {
    events.push(createEvent({
      sessionId, agentType, sequencer,
      eventType: 'session_end',
      payload: {
        reason: raw.subtype === 'error' || item.status === 'error' ? 'error' : 'completed',
        summary: sanitizePreview(item.result || raw.result || item.summary || '会话结束', 1000),
        usage: {},
      },
    }));
    return events;
  }

  events.push(createEvent({
    sessionId, agentType, sequencer,
    eventType: 'custom',
    payload: {
      custom_type: 'codex_raw',
      fallback_text: `Codex 事件：${itemType}`,
      data: { type: itemType, id: item.id || raw.id || null },
    },
  }));
  return events;
}

function numberOrZero(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function clampPercent(value) {
  const n = numberOrZero(value);
  if (n <= 0) return null;
  return Math.min(100, Math.max(0, Math.round(n)));
}
