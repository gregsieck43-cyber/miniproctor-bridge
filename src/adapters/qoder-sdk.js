import { createEvent, sanitizePreview, sanitizeSensitiveText } from '../lib/events.js';
const protocol = 'miniproctor-qoder-sdk-v1';
const types = new Set(['started', 'provider', 'message', 'result', 'error']);
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value);
export const isQoderSdkFrame = raw => Boolean(raw && typeof raw === 'object' && !Array.isArray(raw) && raw.protocol === protocol && types.has(raw.type));
export const isQoderSdkStartedFrame = raw => isQoderSdkFrame(raw) && raw.type === 'started' && uuid(raw.native_session_id)
  && raw.native_version === '1.1.64' && raw.native_protocol === '1.5.0';

export function mapQoderSdkFrame(raw, { sessionId, sequencer }) {
  if (!isQoderSdkFrame(raw)) return [];
  const common = { sessionId, agentType: 'generic', sequencer };
  const failed = code => [createEvent({ ...common, eventType: 'error', payload: {
    code: /^qoder-[a-z-]{1,64}$/u.test(code || '') ? code : 'qoder-native-incomplete',
    message: 'Qoder 文本任务未正常完成，请检查电脑端版本、登录和连接', severity: 'fatal', recoverable: false,
  } })];
  if (raw.type === 'provider') return [];
  if (raw.type === 'started') return isQoderSdkStartedFrame(raw) ? [createEvent({ ...common, eventType: 'custom', payload: {
    custom_type: 'qoder_sdk_started', fallback_text: 'Qoder 文本会话已接收任务（不执行文件或命令）',
    data: { native_session_id: raw.native_session_id, native_cli_version: raw.native_version, native_protocol: raw.native_protocol },
  } })] : failed('qoder-native-identity');
  if (raw.type === 'message') return typeof raw.text === 'string' && raw.text ? [createEvent({ ...common, eventType: 'agent_message', payload: {
    role: 'assistant', content: sanitizeSensitiveText(sanitizePreview(raw.text, 32000)), content_type: 'text', is_final: false,
  } })] : [];
  if (raw.type === 'error') return failed(raw.code);
  const closed = !raw.error_code && raw.auth_files_unchanged === true && raw.tool_count === 0 && raw.native_stop?.exited === true
    && raw.native_stop.tree_verified === true && raw.native_stop.remaining_owned_instances === 0 && raw.native_stop.forced !== true && !raw.native_stop.signal;
  const identity = uuid(raw.native_session_id), accepted = raw.native_admission === 'accepted';
  if (closed && identity && accepted && raw.status === 'completed' && raw.native_stop.code === 0 && raw.model_calls_allowed === 1) {
    return [createEvent({ ...common, eventType: 'session_end', payload: { reason: 'completed', summary: 'Qoder 单轮文本任务已完成', usage: {} } })];
  }
  const cancelled = raw.cancellation;
  const active = identity && accepted && raw.native_stop?.code === 1 && [0, 1].includes(raw.model_calls_allowed)
    && cancelled?.verified === true && cancelled.command_cancelled === true && cancelled.kind === 'active'
    && cancelled.terminal_reason === 'aborted_streaming' && cancelled.operation_aborted === true;
  const beforePrompt = raw.native_session_id === null && raw.native_admission === 'not-accepted' && raw.model_calls_allowed === 0 && cancelled?.kind === 'before-prompt'
    && (raw.native_stop?.code === null && raw.native_stop.owned_processes === 0 && raw.native_stop.reason === 'not-started' || raw.native_stop?.code === 0);
  const queued = raw.native_session_id === null && raw.native_admission === 'not-accepted' && raw.model_calls_allowed === 0 && raw.native_stop?.code === 0
    && cancelled?.verified === true && cancelled.command_cancelled === true && cancelled.kind === 'queued';
  if (closed && raw.status === 'cancelled' && (active || beforePrompt || queued)) return [createEvent({ ...common, eventType: 'session_end', payload: {
    reason: 'stopped', summary: 'Qoder 任务已停止', usage: {},
  } })];
  return failed(raw.error_code);
}
