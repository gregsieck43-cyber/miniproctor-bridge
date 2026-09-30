import { createEvent, sanitizeSensitiveText } from '../lib/events.js';

export function isComateLocalApiFrame(raw) {
  return Boolean(raw && typeof raw === 'object' && raw.protocol === 'comate-local-api-v1' && typeof raw.type === 'string');
}

export function mapComateLocalApiFrame(raw, { sessionId, sequencer }) {
  if (!isComateLocalApiFrame(raw)) return [];
  const common = { sessionId, agentType: 'generic', sequencer };
  const safe = (text) => sanitizeSensitiveText(String(text || ''));
  if (raw.type === 'ready' || raw.type === 'stop_result') return [];
  if (raw.type === 'started') return [createEvent({ ...common, eventType: 'task_progress',
    payload: { task_id: 'comate_run', title: 'Comate 正在运行', current: 0, total: null, percent: null },
  })];
  if (raw.type === 'message' && typeof raw.text === 'string' && raw.text) return [createEvent({
    ...common, eventType: 'agent_message', payload: { message_id: safe(raw.id).slice(0, 128),
      role: 'assistant', content: safe(raw.text), content_type: 'text', is_final: false },
  })];
  if (raw.type === 'tool' && typeof raw.id === 'string') {
    const terminal = ['executed', 'failed', 'cancelled', 'rejected'].includes(raw.state);
    return [createEvent({ ...common, eventType: terminal ? 'tool_result' : 'tool_call', payload: {
      tool_call_id: safe(raw.id).slice(0, 128), tool_name: safe(raw.name).slice(0, 100),
      status: terminal ? raw.state === 'executed' ? 'success' : 'error' : 'running',
      ...(terminal ? { result_preview: raw.state === 'executed' ? '操作已完成' : '操作未完成', result_sensitive: true }
        : { input_preview: '具体参数保留在本机 Comate', input_sensitive: true }),
    } })];
  }
  const verifiedStop = raw.type === 'stopped' && ((raw.native_cancelled === true && raw.reason === 'native-cancelled')
    || (raw.native_cancelled === false && raw.reason === 'not-started'));
  if (raw.type === 'stopped' && !verifiedStop) return [];
  if (raw.type === 'finished' || verifiedStop) return [createEvent({
    ...common, eventType: 'session_end', payload: { reason: raw.type === 'finished' ? 'completed' : 'stopped',
      summary: raw.type === 'finished' ? 'Comate 回合完成' : 'Comate 已停止', usage: {} },
  })];
  if (raw.type === 'error') return [createEvent({ ...common, eventType: 'error', payload: {
    code: 'comate-native-failed', message: 'Comate 本机控制链路失败', severity: 'fatal', recoverable: false,
  } })];
  return [];
}
