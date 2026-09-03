import { createEvent } from '../lib/events.js';
import { isClaudeStreamType, mapClaudeRaw } from './claude-code.js';
import { isCodexStreamType, mapCodexRaw } from './codex.js';

export function lineToEvent(line, { sessionId, agentType = 'generic', sequencer }) {
  if (!line) return [];
  let raw = null;
  try { raw = JSON.parse(line); } catch { raw = null; }
  if (isClaudeStreamType(raw)) {
    return mapClaudeRaw(raw, { sessionId, agentType: 'claude-code', sequencer });
  }
  if (isCodexStreamType(raw)) {
    return mapCodexRaw(raw, { sessionId, agentType: 'codex', sequencer });
  }
  if (raw && raw.type) {
    return [createEvent({
      sessionId, agentType, sequencer,
      eventType: 'custom',
      payload: {
        custom_type: 'raw_json',
        fallback_text: `未知 JSON 事件：${raw.type}`,
        data: { type: raw.type },
      },
    })];
  }
  return [createEvent({
    sessionId, agentType, sequencer,
    eventType: 'agent_message',
    payload: {
      message_id: `m_line_${sequencer.next()}`,
      role: 'assistant',
      content: line,
      content_type: 'text',
      is_final: true,
    },
  })];
}
