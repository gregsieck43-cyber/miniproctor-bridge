import { createEvent, sanitizePreview, truncateText } from '../lib/events.js';

const KNOWN_TYPES = new Set([
  'system', 'assistant', 'user', 'result', 'control_request', 'control_cancel_request',
]);

export function isClaudeStreamType(raw) {
  return Boolean(raw && typeof raw === 'object' && KNOWN_TYPES.has(raw.type));
}

export function mapClaudeRaw(raw, { sessionId, agentType = 'claude-code', sequencer }) {
  if (!raw || typeof raw !== 'object') return [];
  const events = [];
  switch (raw.type) {
    case 'system': {
      events.push(createEvent({
        sessionId, agentType, sequencer,
        eventType: 'custom',
        payload: {
          custom_type: 'system',
          system_subtype: raw.subtype || 'unknown',
          fallback_text: raw.subtype === 'init' ? '会话已初始化' : `系统事件：${raw.subtype || 'unknown'}`,
          data: { model: raw.model || null, tools: Array.isArray(raw.tools) ? raw.tools.slice(0, 20) : [] },
        },
      }));
      break;
    }
    case 'assistant': {
      const message = raw.message || {};
      const content = Array.isArray(message.content) ? message.content : [];
      for (const item of content) {
        if (!item || typeof item !== 'object') continue;
        if (item.type === 'text' && typeof item.text === 'string' && item.text) {
          events.push(createEvent({
            sessionId, agentType, sequencer,
            eventType: 'agent_message',
            payload: {
              message_id: message.id || `m_${crypto.randomUUID()}`,
              stream_id: message.id || null,
              role: 'assistant',
              content: item.text,
              content_type: 'text',
              is_final: Boolean(message.stop_reason),
              stop_reason: message.stop_reason || null,
            },
          }));
        } else if (item.type === 'thinking' && typeof item.thinking === 'string' && item.thinking) {
          events.push(createEvent({
            sessionId, agentType, sequencer,
            eventType: 'custom',
            payload: {
              custom_type: 'thinking',
              fallback_text: item.thinking,
              data: { thinking: item.thinking },
            },
            metadata: { sensitive: true },
          }));
        } else if (item.type === 'tool_use') {
          events.push(createEvent({
            sessionId, agentType, sequencer,
            eventType: 'tool_call',
            payload: {
              tool_call_id: item.id || `tc_${crypto.randomUUID()}`,
              tool_name: item.name || 'unknown',
              input_preview: sanitizePreview(item.input, 500),
              input_sensitive: false,
              status: 'running',
            },
          }));
          const fileEvent = fileChangeFromTool(item);
          if (fileEvent) {
            events.push(createEvent({
              sessionId, agentType, sequencer,
              eventType: 'file_change',
              payload: fileEvent,
            }));
          }
        }
      }
      break;
    }
    case 'user': {
      const message = raw.message || {};
      const content = message.content;
      const text = typeof content === 'string' ? content : JSON.stringify(content || {});
      if (text) {
        events.push(createEvent({
          sessionId, agentType, sequencer,
          eventType: 'user_message',
          payload: {
            message_id: `m_${crypto.randomUUID()}`,
            role: 'user',
            content: text,
            content_type: 'text',
          },
        }));
      }
      break;
    }
    case 'control_request': {
      const request = raw.request || {};
      if (request.subtype === 'can_use_tool') {
        events.push(createEvent({
          sessionId, agentType, sequencer,
          eventType: 'confirm_required',
          payload: {
            request_id: raw.request_id || `req_${crypto.randomUUID()}`,
            kind: 'tool_permission',
            title: `是否允许 ${request.tool_name || '工具'}？`,
            detail: sanitizePreview(request.input, 500),
            context: {
              tool_name: request.tool_name || 'unknown',
              input_preview: sanitizePreview(request.input, 500),
              cwd: null,
            },
            timeout_seconds: 120,
          },
          actions: [
            { action_id: 'approve', type: 'approve', label: '允许', style: 'primary' },
            { action_id: 'reject', type: 'reject', label: '拒绝', style: 'danger' },
          ],
        }));
      } else {
        events.push(createEvent({
          sessionId, agentType, sequencer,
          eventType: 'custom',
          payload: {
            custom_type: 'control_request',
            fallback_text: `控制请求：${request.subtype || 'unknown'}`,
            data: { request_id: raw.request_id || null, subtype: request.subtype || null },
          },
        }));
      }
      break;
    }
    case 'control_cancel_request': {
      events.push(createEvent({
        sessionId, agentType, sequencer,
        eventType: 'custom',
        payload: {
          custom_type: 'control_cancel_request',
          fallback_text: '审批请求已取消',
          data: { request_id: raw.request_id || null },
        },
      }));
      break;
    }
    case 'result': {
      const subtype = raw.subtype || 'completed';
      const usage = raw.usage || {};
      events.push(createEvent({
        sessionId, agentType, sequencer,
        eventType: 'session_end',
        payload: {
          reason: subtype === 'success' ? 'completed' : subtype === 'error_max_turns' ? 'timeout' : 'stopped',
          summary: typeof raw.result === 'string' ? raw.result.slice(0, 1000) : `会话结束（${subtype}）`,
          usage: {
            input_tokens: numberOrZero(usage.input_tokens),
            output_tokens: numberOrZero(usage.output_tokens),
            cache_read_input_tokens: numberOrZero(usage.cache_read_input_tokens),
            cache_creation_input_tokens: numberOrZero(usage.cache_creation_input_tokens),
          },
        },
      }));
      break;
    }
    default:
      break;
  }
  return events;
}

function fileChangeFromTool(item) {
  const editTools = new Set(['Edit', 'Write', 'NotebookEdit', 'MultiEdit']);
  if (!editTools.has(item.name) || !item.input || typeof item.input !== 'object') return null;
  const filePath = item.input.file_path || item.input.notebook_path || item.input.path;
  if (!filePath) return null;
  const oldText = typeof item.input.old_string === 'string' ? item.input.old_string : '';
  const newText = typeof item.input.new_string === 'string' ? item.input.new_string : '';
  const NL = String.fromCharCode(10);
  const CR = String.fromCharCode(13);
  const prefix = (text, mark) => {
    const clean = text.split(NL).map((line) => line.endsWith(CR) ? line.slice(0, -1) : line);
    return clean.map((line) => `${mark} ${line}`).join(NL);
  };
  const lines = [`--- ${filePath}`];
  if (oldText) lines.push(prefix(oldText, '-'));
  if (newText) lines.push(prefix(newText, '+'));
  const preview = truncateText(lines.join(NL), 8192);
  return {
    file_path: filePath,
    change_type: item.name === 'Write' ? 'created' : 'modified',
    summary: `${item.name} ${filePath}`,
    diff_preview: preview,
    diff_bytes: Buffer.byteLength(preview, 'utf8'),
    truncated: Buffer.byteLength(preview, 'utf8') >= 8192,
  };
}

function numberOrZero(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}
