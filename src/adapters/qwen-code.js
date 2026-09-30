import { createEvent, redactThinkingEvent, sanitizePreview, truncateText } from '../lib/events.js';

// Qwen Code headless `--output-format stream-json` 解析器（V12-A15）。
// 官方资料：xcx/docs/官方资料/A15-qwen-code-headless.md（qwenlm.github.io/qwen-code-docs
// 2026-09-25 快照）——stream-json 为 JSONL；本机 0.24.6 实测 init 含 qwen_code_version：
//   {"type":"system","subtype":"session_start",uuid,session_id,...}
//   {"type":"assistant",uuid,session_id,message:{id,role,content:[{type:'text',text}],usage},parent_tool_use_id}
//   {"type":"result",subtype,uuid,session_id,is_error,duration_ms,result,usage}
// 另有 --include-partial-messages 时的 stream_event（message_start/content_block_delta/goal_state 等）。
// 形态与 Claude Code stream-json 高度同源（Qwen Code 输出格式文档即按 Claude 风格给出），
// 但任务卡明确"不能复用 Claude 解析假定兼容"：本适配器独立解析，探测只在 generic 桶生效
// （generic.js agentType==='generic' 守卫），claude-code 会话帧型不受影响。
// 帧内部未文档化字段一律防御式读取，取不到落 custom 兜底；真实 CLI 帧形见 A15 证据卡。

/**
 * 帧形状探测（generic.js 分发器路由用；契约 §3：对 null/非对象安全）。
 * 认领规则（防止吞并 claude-code 会话帧——那些会话不进 generic 桶；generic 桶内未认领的
 * claude 同形帧保持既有 claude 探测路由不变）：
 *   - stream_event：Qwen 专有 partial-message 帧；
 *   - system：旧版 session_start，或 0.24.6 init + qwen_code_version（排除 Claude init）；
 *   - assistant/result：官方示例每帧携带 uuid（或 result.usage），以此为认领标记。
 * 不认领 {type:'error'}：A15 快照未定义 error 流帧型，且与 codex 顶层 error 同形，
 * 保持既有 codex 探测路由（close007 裁决）。
 */
export function isQwenStreamType(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.type !== 'string') return false;
  if (raw.type === 'stream_event') return true;
  if (raw.type === 'system') return raw.subtype === 'session_start'
    || (raw.subtype === 'init' && typeof raw.qwen_code_version === 'string');
  if (raw.type === 'assistant') return raw.uuid !== undefined;
  if (raw.type === 'result') return raw.uuid !== undefined || raw.usage !== undefined;
  return false;
}

/** user/tool_result 与 Claude 同形，仅在 profile 已冻结为 Qwen 时认领。 */
export function isQwenProfileOutput(raw) {
  if (isQwenStreamType(raw)) return true;
  return Boolean(raw && raw.type === 'user' && stringOrNull(raw.uuid)
    && raw.message?.role === 'user' && Array.isArray(raw.message.content)
    && raw.message.content.some((item) => item && (
      isQwenToolResult(item)
      || (item.type === 'text' && typeof item.text === 'string' && item.text)
    )));
}

/**
 * 帧翻译（契约 §3：纯函数、零 IO、不抛出；未知帧一律 custom 兜底）。
 * agentType 缺省 'generic'——目录条目 adapter_id 归入 generic（契约 §1 不逐产品新建
 * adapter_id），createEvent 仅接受 AGENT_TYPES 白名单。
 */
export function mapQwenRaw(raw, ctx) {
  const { sessionId, agentType = 'generic', sequencer } = ctx || {};
  if (!raw || typeof raw !== 'object') return [];
  const events = [];
  switch (raw.type) {
    case 'system': {
      events.push(createEvent({
        sessionId, agentType, sequencer,
        eventType: 'custom',
        payload: {
          custom_type: 'system',
          system_subtype: stringOrNull(raw.subtype) || 'unknown',
          fallback_text: raw.subtype === 'session_start' || raw.subtype === 'init'
            ? 'Qwen 会话已初始化' : `系统事件：${raw.subtype || 'unknown'}`,
          data: {
            session_id: stringOrNull(raw.session_id),
            model: stringOrNull(raw.model),
          },
        },
      }));
      break;
    }
    case 'assistant': {
      const message = raw.message && typeof raw.message === 'object' ? raw.message : {};
      const content = Array.isArray(message.content) ? message.content : [];
      if (!content.length) {
        events.push(qwenFallback(raw, 'assistant', { sessionId, agentType, sequencer }));
        break;
      }
      for (const item of content) {
        if (!item || typeof item !== 'object') continue;
        if (item.type === 'text' && typeof item.text === 'string' && item.text) {
          events.push(createEvent({
            sessionId, agentType, sequencer,
            eventType: 'agent_message',
            payload: {
              message_id: stringOrNull(message.id) || `m_${crypto.randomUUID()}`,
              stream_id: stringOrNull(message.id),
              role: 'assistant',
              content: item.text,
              content_type: 'text',
              is_final: Boolean(message.stop_reason),
              stop_reason: stringOrNull(message.stop_reason),
            },
          }));
        } else if (item.type === 'thinking' && typeof item.thinking === 'string' && item.thinking) {
          // thinking 默认不上传正文（TASK-019 ②① 隐私口径与 claude-code 适配器一致）
          events.push(redactThinkingEvent({ sessionId, agentType, sequencer, originalText: item.thinking }));
        } else if (item.type === 'tool_use') {
          events.push(createEvent({
            sessionId, agentType, sequencer,
            eventType: 'tool_call',
            payload: {
              tool_call_id: stringOrNull(item.id) || `tc_${crypto.randomUUID()}`,
              tool_name: stringOrNull(item.name) || 'unknown',
              input_preview: sanitizePreview(item.input ?? {}, 500),
              input_sensitive: false,
              status: 'running',
            },
          }));
        } else {
          events.push(qwenFallback(item, `assistant.content:${item?.type || 'unknown'}`, { sessionId, agentType, sequencer }));
        }
      }
      break;
    }
    case 'stream_event': {
      // partial-message 帧（--include-partial-messages）：message_start/content_block_delta/
      // goal_state 等。官方未定义手机端展示语义，统一 custom 兜底展示，不伪造进度/正文。
      const eventType = stringOrNull(raw.event?.type);
      events.push(createEvent({
        sessionId, agentType, sequencer,
        eventType: 'custom',
        payload: {
          custom_type: 'stream_event',
          fallback_text: `流事件：${eventType || 'unknown'}`,
          data: { event_type: eventType },
        },
      }));
      break;
    }
    case 'user': {
      const content = Array.isArray(raw.message?.content) ? raw.message.content : [];
      for (const item of content) {
        if (!item || typeof item !== 'object') continue;
        if (isQwenToolResult(item)) {
          events.push(createEvent({
            sessionId, agentType, sequencer,
            eventType: 'tool_result',
            payload: {
              tool_call_id: item.tool_use_id,
              tool_name: null,
              status: item.is_error === true ? 'error' : 'success',
              result_preview: sanitizePreview(item.content ?? '', 500),
              result_sensitive: false,
            },
          }));
        } else if (item.type === 'text' && typeof item.text === 'string' && item.text) {
          events.push(createEvent({
            sessionId, agentType, sequencer,
            eventType: 'user_message',
            payload: { message_id: stringOrNull(raw.uuid) || `m_${crypto.randomUUID()}`,
              role: 'user', content: item.text, content_type: 'text' },
          }));
        } else {
          events.push(qwenFallback(item, `user.content:${item.type || 'unknown'}`, { sessionId, agentType, sequencer }));
        }
      }
      if (!events.length) events.push(qwenFallback(raw, 'user', { sessionId, agentType, sequencer }));
      break;
    }
    case 'result': {
      // 官方示例：{subtype:'success', is_error:false, result:"...", usage:{...}}。
      // is_error/subtype 双信号判终态原因；非零退出但已有 result 文本时仍产出终态
      //（session_end），手机端拿到已有回复而不是空白失败。
      const failed = raw.is_error === true;
      events.push(createEvent({
        sessionId, agentType, sequencer,
        eventType: 'session_end',
        payload: {
          reason: failed ? 'error' : raw.subtype === 'success' ? 'completed' : 'stopped',
          summary: typeof raw.result === 'string' && raw.result
            ? truncateText(raw.result, 1000)
            : `Qwen 会话结束（${raw.subtype || 'unknown'}）`,
          usage: usageFromRaw(raw.usage),
        },
      }));
      break;
    }
    default:
      events.push(qwenFallback(raw, String(raw.type), { sessionId, agentType, sequencer }));
      break;
  }
  return events;
}

function qwenFallback(raw, typeLabel, { sessionId, agentType, sequencer }) {
  return createEvent({
    sessionId, agentType, sequencer,
    eventType: 'custom',
    payload: {
      custom_type: 'qwen_raw',
      fallback_text: `Qwen 事件：${typeLabel || 'unknown'}`,
      data: { type: typeLabel || null },
    },
  });
}

function stringOrNull(value) {
  return typeof value === 'string' && value ? value : null;
}

function isQwenToolResult(item) {
  return Boolean(item && item.type === 'tool_result' && stringOrNull(item.tool_use_id)
    && typeof item.is_error === 'boolean'
    && (typeof item.content === 'string' || Array.isArray(item.content)));
}

/** result.usage / message.usage（Claude 风格键名，官方示例给出 usage 对象；无统计取 0 不伪造）。 */
function usageFromRaw(usage) {
  const u = usage && typeof usage === 'object' ? usage : {};
  return {
    input_tokens: numberOrZero(u.input_tokens),
    output_tokens: numberOrZero(u.output_tokens),
  };
}

function numberOrZero(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}
