import crypto from 'node:crypto';

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
  return {
    event_id: `e_${crypto.randomUUID()}`,
    session_id: sessionId,
    seq: sequencer.next(),
    ts: Date.now(),
    agent_type: agentType,
    event_type: eventType,
    payload,
    actions,
    metadata: {
      bridge_version: '0.0.1',
      protocol_version: '0.1',
      ...metadata,
    },
  };
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

export function truncateText(text, maxBytes = 8192, suffix = '…[truncated]') {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  const buf = Buffer.from(text, 'utf8').subarray(0, maxBytes - Buffer.byteLength(suffix, 'utf8'));
  return buf.toString('utf8') + suffix;
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
