import { createEvent, sanitizePreview, sanitizeSensitiveText } from '../lib/events.js';

const PROTOCOL = 'openhands-sdk-v1';

function approvalPreview(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const out = {};
  if (typeof input.operation === 'string') out.operation = input.operation.slice(0, 100);
  if (typeof input.command === 'string') out.command = input.command.slice(0, 500);
  if (typeof input.path === 'string') out.path = input.path.slice(0, 500);
  if (input.is_input === true) out.is_input = true;
  if (input.content_hidden === true) out.content_hidden = true;
  return out;
}

export function isOpenhandsSdkFrame(raw) {
  return Boolean(raw && typeof raw === 'object' && raw.protocol === PROTOCOL
    && typeof raw.type === 'string');
}

export function mapOpenhandsSdkFrame(raw, { sessionId, sequencer }) {
  if (!isOpenhandsSdkFrame(raw)) return [];
  const common = { sessionId, agentType: 'generic', sequencer };
  const safe = (value, max = 500) => sanitizeSensitiveText(sanitizePreview(value, max));
  switch (raw.type) {
    case 'started':
      return [createEvent({
        ...common, eventType: 'task_progress',
        payload: { task_id: 'openhands_run', title: 'OpenHands 正在运行', current: 0, total: null, percent: null },
      })];
    case 'message':
      if (typeof raw.text !== 'string' || !raw.text) return [];
      return [createEvent({
        ...common, eventType: 'agent_message',
        payload: {
          message_id: typeof raw.id === 'string' && raw.id ? raw.id : 'openhands_message',
          role: 'assistant', content: safe(raw.text, 16000),
          content_type: 'text', is_final: false, // 仅 finished 帧能证明回合已结束
        },
      })];
    case 'action':
      return [createEvent({
        ...common, eventType: 'tool_call',
        payload: {
          tool_call_id: typeof raw.id === 'string' ? raw.id : 'openhands_action',
          tool_name: safe(raw.tool_name || 'unknown', 100),
          input_preview: '具体参数仅保留在本机 OpenHands SDK',
          input_sensitive: true, status: 'running',
        },
      })];
    case 'observation':
      return [createEvent({
        ...common, eventType: 'tool_result',
        payload: {
          tool_call_id: typeof raw.action_id === 'string' ? raw.action_id : 'openhands_action',
          tool_name: safe(raw.tool_name || 'unknown', 100),
          status: raw.denied === true ? 'error' : 'success',
          result_preview: raw.denied === true ? '操作已拒绝' : '操作已完成',
          result_sensitive: true,
        },
      })];
    case 'control_request': {
      if (typeof raw.request_id !== 'string' || !raw.request_id
        || raw.request?.subtype !== 'can_use_tool') return [];
      const preview = approvalPreview(raw.request.input);
      return [createEvent({
        ...common, eventType: 'confirm_required',
        payload: {
          request_id: raw.request_id,
          kind: 'tool_permission',
          title: `是否允许 ${safe(raw.request.tool_name || '工具', 100)}？`,
          detail: safe(preview, 500),
          context: {
            tool_name: safe(raw.request.tool_name || 'unknown', 100),
            input_preview: safe(preview, 500),
            cwd: null,
          },
          timeout_seconds: 120,
        },
        actions: [
          { action_id: 'approve', type: 'approve', label: '允许', style: 'primary' },
          { action_id: 'reject', type: 'reject', label: '拒绝', style: 'danger' },
        ],
      })];
    }
    case 'finished':
      return [createEvent({
        ...common, eventType: 'session_end',
        payload: { reason: 'completed', summary: 'OpenHands 回合结束', usage: {} },
      })];
    case 'stopped':
      return [createEvent({
        ...common, eventType: 'session_end',
        payload: { reason: 'stopped', summary: 'OpenHands 已停止', usage: {} },
      })];
    case 'error':
      return [createEvent({
        ...common, eventType: 'error',
        payload: {
          code: typeof raw.code === 'string' ? raw.code.slice(0, 100) : 'openhands-error',
          message: safe(raw.message || 'OpenHands 运行失败', 300),
          severity: 'fatal', recoverable: false,
        },
      })];
    default:
      return [createEvent({
        ...common, eventType: 'custom',
        payload: {
          custom_type: 'unrecognized_product_output',
          fallback_text: 'OpenHands SDK 帧类型未识别',
          data: { agent_key: 'openhands', type: raw.type.slice(0, 100) },
        },
      })];
  }
}
