import { createHash } from 'node:crypto';
import { createEvent, sanitizePreview, truncateText } from '../lib/events.js';

// Cursor CLI（agent / 历史 binary 别名 cursor-agent）非交互 print 模式适配器（V12-A04）。
//
// 帧结构证据（官方文档，D 级）：
//   - 快照 xcx/docs/官方资料/A04-cursor-cli-overview.md：print 模式 `agent -p "<prompt>"`，
//     `--output-format text` 为官方示例（text 为 print 缺省输出，最终答案纯文本）；
//   - 官方 Using Headless CLI 页（2026-09-25 联网核对，与快照同源站点）记载 stream-json
//     事件形状：{"type":"system","subtype":"init","model":...}、assistant 帧分「流式增量
//     （timestamp_ms 存在、无 model_call_id）」与「缓冲 flush（model_call_id 存在）」、
//     {"type":"tool_call","subtype":"started|completed", ...tool_call.writeToolCall/
//     readToolCall(args.path/result.success...)}、{"type":"result","duration_ms":...}，
//     以及 --output-format json 单对象含 .result 字段。
//   - 2026-09-28 Windows 官方 CLI 2026.09.26-dd393fe 真实输出复核：result 带
//     subtype=success、usage{inputTokens,outputTokens,cacheReadTokens,cacheWriteTokens}；
//     最终 assistant 帧无 timestamp_ms/model_call_id。已绑定 profile 按 agentKey 解析。
//   - 2026-09-30 官方输出格式及真实工具帧确认顶层 call_id 对应同一次工具调用。
//
// 设计边界：
//   - 只映射官方记载的帧形状；未记载字段一律落 custom 兜底，不猜测语义（§5.2）；
//   - print 模式为一次性任务：无中途追加输入通道（append=false），无审批回传协议
//     （approve=false，绝不生成无法送回 CLI 的审批卡）；
//   - 文本输出行不经本解析器（generic.js 文本兜底 → agent_message），本模块只处理
//     JSON 帧；不伪造工具事件——tool_call 事件仅来自官方 tool_call 帧。

export function isCursorCliStreamType(raw) {
  if (!raw || typeof raw !== 'object') return false;
  // tool_call：cursor stream-json 顶层类型（官方 Headless 文档）；claude-code/codex
  // 均不产生该顶层类型（claude 的工具调用在 assistant.content[].type='tool_use'）。
  if (raw.type === 'tool_call') return true;
  // assistant：仅认领携带 cursor 官方标记（timestamp_ms / model_call_id）的帧——
  // claude-code 的 assistant 帧无这两个字段，据此避免吞并 claude 帧。
  if (raw.type === 'assistant') {
    return Number.isFinite(raw.timestamp_ms)
      || Object.prototype.hasOwnProperty.call(raw, 'model_call_id');
  }
  return false;
}

/** 已绑定 profile 的产品身份由冻结 agentKey 给出，可接收同族 result/最终 assistant。 */
export function isCursorCliProfileOutput(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  return ['system', 'user', 'thinking', 'assistant', 'tool_call', 'result'].includes(raw.type);
}

function safeTokenCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function mapUsage(rawUsage) {
  if (!rawUsage || typeof rawUsage !== 'object') return {};
  const out = {};
  const fields = [
    ['inputTokens', 'input_tokens'], ['outputTokens', 'output_tokens'],
    ['cacheReadTokens', 'cache_read_input_tokens'],
    ['cacheWriteTokens', 'cache_creation_input_tokens'],
  ];
  for (const [source, target] of fields) {
    const n = safeTokenCount(rawUsage[source]);
    if (n !== null) out[target] = n;
  }
  return out;
}

export function mapCursorCliRaw(raw, { sessionId, agentType = 'generic', sequencer }) {
  if (!raw || typeof raw !== 'object') return [];
  const events = [];

  // 不把用户提示词及模型内部思考上行到手机端。
  if (raw.type === 'user' || raw.type === 'thinking') return [];

  // system init：官方记载 {"type":"system","subtype":"init","model":...}。
  // 注意：该形状与 claude-code/gemini-cli 同构，generic.js 分发中仅在 generic 会话
  // 认领（claude/codex 专属会话不受影响）；文案保持产品中立。
  if (raw.type === 'system' && raw.subtype === 'init') {
    events.push(createEvent({
      sessionId, agentType, sequencer,
      eventType: 'custom',
      payload: {
        custom_type: 'system',
        system_subtype: 'init',
        fallback_text: '会话已初始化',
        data: { model: typeof raw.model === 'string' ? raw.model : null },
      },
    }));
    return events;
  }

  // assistant 帧（流式增量 timestamp_ms / 缓冲 flush model_call_id）：
  // 提取 message.content[] 中的 text 片段。官方文档示例按 .message.content[0].text 取流。
  if (raw.type === 'assistant') {
    const message = raw.message && typeof raw.message === 'object' ? raw.message : {};
    const content = Array.isArray(message.content) ? message.content : [];
    const isFlush = Object.prototype.hasOwnProperty.call(raw, 'model_call_id');
    for (const item of content) {
      // 官方示例只消费 text 字段；无 type 字段记载——凡携带字符串 text 的片段均展示，
      // 其余片段（未知形状）不猜测。is_final 不标 true：flush 语义含「工具调用前缓冲」，
      // 无法区分终段，turn 终态统一由 result 帧/进程退出（session_exit）产生。
      if (item && typeof item === 'object' && typeof item.text === 'string' && item.text) {
        events.push(createEvent({
          sessionId, agentType, sequencer,
          eventType: 'agent_message',
          payload: {
            message_id: typeof raw.model_call_id === 'string' ? raw.model_call_id : `m_cursor_${sequencer.next()}`,
            stream_id: typeof raw.model_call_id === 'string' ? raw.model_call_id : null,
            role: 'assistant',
            content: item.text,
            content_type: 'text',
            is_final: false,
            stop_reason: null,
          },
        }));
      }
    }
    if (events.length === 0 && isFlush) {
      // 无文本的 flush 帧不静默——落入 custom 兜底保留可观测性。
      events.push(createEvent({
        sessionId, agentType, sequencer,
        eventType: 'custom',
        payload: {
          custom_type: 'cursor_raw',
          fallback_text: 'Cursor 输出片段（无文本内容）',
          data: { model_call_id: raw.model_call_id ?? null },
        },
      }));
    }
    return events;
  }

  // tool_call 帧：官方记载 subtype started/completed，工具负载在 raw.tool_call 下的
  // writeToolCall / readToolCall（args.path、result.success{linesCreated,fileSize,totalLines}）。
  if (raw.type === 'tool_call') {
    const call = raw.tool_call && typeof raw.tool_call === 'object' ? raw.tool_call : {};
    const writeCall = call.writeToolCall && typeof call.writeToolCall === 'object' ? call.writeToolCall : null;
    const readCall = call.readToolCall && typeof call.readToolCall === 'object' ? call.readToolCall : null;
    const specific = writeCall || readCall;
    const subtype = raw.subtype || call.subtype;
    if (!specific || (subtype !== 'started' && subtype !== 'completed')) {
      // 未记载的 tool_call 形态（新工具类别/新 subtype）→ custom 兜底，不猜测。
      events.push(createEvent({
        sessionId, agentType, sequencer,
        eventType: 'custom',
        payload: {
          custom_type: 'cursor_raw',
          fallback_text: `Cursor 工具事件（未识别形态）：${subtype || 'unknown'}`,
          data: { subtype: subtype ?? null, keys: Object.keys(call).slice(0, 10) },
        },
      }));
      return events;
    }
    const args = specific.args && typeof specific.args === 'object' ? specific.args : {};
    const filePath = typeof args.path === 'string' ? args.path : null;
    events.push(createEvent({
      sessionId, agentType, sequencer,
      eventType: 'tool_call',
      payload: {
        // 官方及真实帧的 call_id 关联 started/completed；实测 ID 含换行，
        // 哈希后保持稳定且有界。缺少 ID 时逐事件生成，不按路径猜测关联。
        tool_call_id: typeof raw.call_id === 'string' && raw.call_id.trim()
          ? `tc_cursor_${createHash('sha256').update(raw.call_id).digest('hex')}`
          : `tc_cursor_${sequencer.next()}`,
        tool_name: writeCall ? 'Write Tool' : 'Read Tool',
        input_preview: sanitizePreview({ path: filePath }, 500),
        input_sensitive: false,
        status: subtype === 'started' ? 'running' : 'completed',
      },
    }));
    return events;
  }

  // result 帧：实测 success/error 子类型及 token 用量；未知或无用量时保持空对象。
  if (raw.type === 'result') {
    const durationMs = Number.isFinite(raw.duration_ms) ? raw.duration_ms : null;
    events.push(createEvent({
      sessionId, agentType, sequencer,
      eventType: 'session_end',
      payload: {
        reason: raw.is_error === true || raw.subtype === 'error' ? 'error' : 'completed',
        summary: typeof raw.result === 'string' && raw.result
          ? truncateText(raw.result, 1000)
          : durationMs != null ? `任务完成（耗时 ${Math.round(durationMs)}ms）` : '任务完成',
        usage: mapUsage(raw.usage),
      },
    }));
    return events;
  }

  // 未知/畸形帧兜底（契约 §3.3）：单帧隔离，不抛出。
  events.push(createEvent({
    sessionId, agentType, sequencer,
    eventType: 'custom',
    payload: {
      custom_type: 'cursor_raw',
      fallback_text: `Cursor 事件：${typeof raw.type === 'string' ? raw.type : '未知名'}`,
      data: { type: raw.type ?? null },
    },
  }));
  return events;
}
