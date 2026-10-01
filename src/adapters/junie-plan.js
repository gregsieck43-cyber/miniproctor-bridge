import { createEvent, sanitizePreview, sanitizeSensitiveText } from '../lib/events.js';

const PROTOCOL = 'miniproctor-junie-acp-plan-v1';
const TYPES = new Set(['started', 'provider', 'update', 'message', 'result', 'error']);
const safe = (text, maximum = 500) => sanitizeSensitiveText(sanitizePreview(text, maximum));

export function isJuniePlanFrame(raw) {
  try { return Boolean(raw && typeof raw === 'object' && !Array.isArray(raw)
    && raw.protocol === PROTOCOL && TYPES.has(raw.type)); } catch { return false; }
}

/** Profile-bound wrapper frames only. Raw ACP, thoughts and unknown native fields are never routed here. */
export function mapJuniePlanFrame(raw, { sessionId, sequencer }) {
  if (!isJuniePlanFrame(raw)) return [];
  const common = { sessionId, agentType: 'generic', sequencer };
  const failed = code => [createEvent({ ...common, eventType: 'error', payload: {
    code: typeof code === 'string' && /^junie-[a-z-]+$/.test(code) ? code : 'junie-native-incomplete',
    message: 'Junie 计划任务未正常完成，请检查电脑端配置和连接', severity: 'fatal', recoverable: false,
  } })];
  try {
    if (raw.type === 'provider') return []; // Bounded lifecycle evidence, not a fabricated milestone.
    if (raw.type === 'started') {
      return [createEvent({ ...common, eventType: 'custom', payload: {
        custom_type: 'junie_plan_started', fallback_text: 'Junie 计划会话已启动',
        data: { native_session_id: typeof raw.native_session_id === 'string' ? raw.native_session_id.slice(0, 128) : null },
      } })];
    }
    if (raw.type === 'message') {
      if (typeof raw.text !== 'string' || !raw.text) return [];
      return [createEvent({ ...common, eventType: 'agent_message', payload: {
        role: 'assistant', content: safe(raw.text, 32000), content_type: 'text', is_final: false,
      } })]; // Only result after native exit proves completion; envelope minimization remains explicit.
    }
    if (raw.type === 'update') {
      const update = raw.update;
      if (update?.type === 'permission_denied') {
        return [createEvent({ ...common, eventType: 'custom', payload: {
          custom_type: 'junie_permission_denied', fallback_text: 'Junie 已按计划模式策略拒绝该操作',
          data: { tool_call_id: typeof update.tool_call_id === 'string' ? update.tool_call_id.slice(0, 128) : null },
        } })];
      }
      if (update?.type !== 'tool' || typeof update.tool_call_id !== 'string' || !update.tool_call_id
        || !['pending', 'in_progress', 'completed', 'failed'].includes(update.status)) return [];
      const tool = { tool_call_id: update.tool_call_id.slice(0, 128), tool_name: safe(update.kind || 'Junie', 100) };
      if (update.status === 'completed' || update.status === 'failed') {
        return [createEvent({ ...common, eventType: 'tool_result', payload: {
          ...tool, status: update.status === 'completed' ? 'success' : 'error',
          result_preview: safe(update.title || (update.status === 'completed' ? '操作已完成' : '操作失败')),
          result_sensitive: true,
        } })];
      }
      return [createEvent({ ...common, eventType: 'tool_call', payload: {
        ...tool, input_preview: safe(update.title || '具体参数保留在电脑端'), input_sensitive: true,
        status: 'running',
      } })];
    }
    if (raw.type === 'error') return failed(raw.code);
    if (raw.type === 'result') {
      if (raw.status === 'completed' && raw.native_stop?.exited === true && raw.native_stop.code === 0) {
        return [createEvent({ ...common, eventType: 'session_end', payload: {
          reason: 'completed', summary: 'Junie 单轮计划任务已完成', usage: {},
        } })];
      }
      if (raw.status === 'cancelled' && raw.native_stop?.exited === true) {
        return [createEvent({ ...common, eventType: 'session_end', payload: {
          reason: 'stopped', summary: 'Junie 计划任务已停止', usage: {},
        } })];
      }
      return failed(raw.error_code);
    }
  } catch { return []; }
  return [];
}
