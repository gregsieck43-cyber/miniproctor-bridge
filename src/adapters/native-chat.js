import { createEvent } from '../lib/events.js';
const PROTOCOL = 'miniproctor-native-chat-v1';
const VERSIONS = Object.freeze({ 'claude-code': '2.1.286 (Claude Code)', codex: 'codex-cli 0.155.1' });
const id = value => typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,128}$/u.test(value);
export function isNativeChatFrame(raw, agent = raw?.agent) {
  return Boolean(raw && raw.protocol === PROTOCOL && Object.hasOwn(VERSIONS, agent) && raw.agent === agent && ['native', 'provider', 'result', 'error'].includes(raw.type));
}
export function nativeChatSessionRef(frame) {
  if (!isNativeChatFrame(frame) || frame.type !== 'native') return null;
  const raw = frame.raw;
  const value = frame.agent === 'claude-code' && raw?.type === 'system' && raw.subtype === 'init' ? raw.session_id
    : frame.agent === 'codex' && raw?.result?.thread ? raw.result.thread.id : null;
  return id(value) ? value : null;
}
function closedProof(raw, nativeExitCode = 0) {
  const stop = raw.native_stop, gateway = raw.gateway, identity = raw.native_identity;
  return isNativeChatFrame(raw) && raw.type === 'result' && raw.error_code === null && raw.native_version === VERSIONS[raw.agent]
    && raw.provider === 'commandcode' && raw.model === 'deepseek/deepseek-v4.1-flash'
    && (raw.agent === 'claude-code' ? id(identity?.sessionId) : id(identity?.threadId) && id(identity?.turnId))
    && stop?.exited === true && stop.code === nativeExitCode && stop.signal === null && stop.forced === false
    && stop.tree_verified === true && stop.reason === 'native-shutdown' && stop.remaining_owned_instances === 0
    && Array.isArray(stop.owned_instances) && stop.owned_instances.length > 0 && stop.owned_instances.length === stop.owned_processes
    && stop.owned_instances.every(row => Number.isSafeInteger(row.pid) && row.pid > 0 && Number.isSafeInteger(row.parent) && row.parent >= 0
      && typeof row.birth === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{7}Z$/u.test(row.birth) && Number.isFinite(Date.parse(row.birth)))
    && gateway?.closed === true && gateway.active === 0 && Number.isSafeInteger(gateway.contacted) && gateway.contacted >= 0 && gateway.contacted <= 1
    && raw.runtime?.provider_key_matches === 0;
}
export function isNativeChatStopResultFrame(raw) {
  const diagnostic = raw?.native_diagnostic;
  // A parent-derived enum plus the exact observed raw result category, never a
  // general exit1/error exception. closedProof still enforces version/runtime/IO.
  const streamingInterrupt = raw?.agent === 'claude-code' && raw.native_terminal === 'failed'
    && diagnostic?.native_cancel_kind === 'matched-interrupt-aborted-streaming'
    && diagnostic.result_subtype === 'error_during_execution' && diagnostic.result_is_error === true
    && diagnostic.terminal_before_result === 'interrupt-accepted' && diagnostic.terminal_after_result === 'failed'
    && diagnostic.interrupt_accepted_before_result === true && diagnostic.terminal_reason === 'aborted_streaming'
    && diagnostic.stop_reason === null && diagnostic.api_error_status === null;
  return closedProof(raw, streamingInterrupt ? 1 : 0) && raw.status === 'cancelled' && raw.text === null
    && (streamingInterrupt || (raw.agent === 'codex' ? raw.native_terminal === 'interrupted' : raw.native_terminal === 'interrupt-accepted'))
    && raw.cancellation?.controller_requested === true && raw.cancellation.native_accepted === true
    && raw.cancellation.provider_was_active === true && raw.cancellation.upstream_aborted === true
    && raw.gateway.contacted === 1 && raw.gateway.successful === 0 && raw.gateway.rejected === 0
    && raw.gateway.aborted === 1 && raw.gateway.failed === 1;
}
function completedProof(raw) {
  return closedProof(raw) && raw.status === 'completed' && raw.native_terminal === 'completed'
    && raw.cancellation?.controller_requested === false && raw.gateway.contacted === 1 && raw.gateway.successful === 1
    && raw.gateway.failed === 0 && raw.gateway.rejected === 0 && raw.gateway.aborted === 0
    && typeof raw.text === 'string' && Boolean(raw.text.trim()) && Buffer.byteLength(raw.text) <= 128 * 1024;
}
function usage(raw) {
  if (raw.usage === null || raw.usage === undefined) return {};
  const value = raw.usage;
  if (!['prompt_tokens', 'completion_tokens', 'total_tokens'].every(key => Number.isSafeInteger(value[key]) && value[key] >= 0)) return {};
  return { input_tokens: value.prompt_tokens, output_tokens: value.completion_tokens };
}
export function mapNativeChatFrame(raw, { sessionId, sequencer, deferSessionEnd = false } = {}) {
  if (!isNativeChatFrame(raw)) return [];
  const event = (eventType, payload) => eventType === 'session_end' && deferSessionEnd === true
    ? { event_type: 'session_end', payload }
    : createEvent({ sessionId, sequencer, agentType: raw.agent, eventType, payload });
  if (raw.type === 'native') {
    const ref = nativeChatSessionRef(raw);
    if (!ref) return [];
    return [event('custom', { custom_type: 'native_chat_started', fallback_text: '官方 CLI 父网关会话已启动',
      data: { agent_key: raw.agent, native_session_id: ref, native_version: VERSIONS[raw.agent] } })];
  }
  if (raw.type === 'provider') {
    const data = { state: raw.state, active: raw.active, provider: raw.provider || 'commandcode', model: raw.model || null };
    if (raw.state === 'refused') {
      // These are fixed codes / bounded schema-name projections from the trusted
      // parent gateway, not native request values, headers or error messages.
      Object.assign(data, { refusal_code: raw.refusal_code, stage: raw.stage, request_fields: raw.request_fields,
        input_fields: raw.input_fields, content_fields: raw.content_fields, unknown_field_count: raw.unknown_field_count,
        native_declared_tools: raw.native_declared_tools, shape_truncated: raw.shape_truncated });
    }
    return [event('custom', { custom_type: 'native_chat_provider',
      fallback_text: raw.state === 'refused' ? '父网关拒绝原生请求（安全策略）' : raw.state === 'active' ? '父网关上游请求进行中' : '父网关上游请求已结算', data })];
  }
  if (raw.type === 'error') return [event('error', { code: 'native-chat-worker-failed', message: '官方 CLI 父网关未取得完整结果', severity: 'fatal', recoverable: false })];
  const completed = completedProof(raw), stopped = isNativeChatStopResultFrame(raw), events = [];
  if (completed) events.push(event('agent_message', { message_id: 'native-chat-final', role: 'assistant', content: raw.text, content_type: 'text', is_final: true }));
  if (!completed && !stopped) events.push(event('error', { code: 'native-chat-proof-incomplete', message: '官方 CLI 原生结果、取消或归属关闭证据不完整', severity: 'fatal', recoverable: false }));
  events.push(event('session_end', { reason: completed ? 'completed' : stopped ? 'stopped' : 'error', summary: completed ? raw.text.slice(0, 1000) : stopped ? '官方 CLI 已接受控制器取消并关闭' : '父网关验证失败', usage: usage(raw) }));
  return events;
}
