import { createEvent, sanitizePreview, truncateText } from '../lib/events.js';

// Gemini CLI headless `--output-format stream-json` 解析器（V12-A03）。
// 官方资料：xcx/docs/官方资料/A03-gemini-cli-headless.md（geminicli.com/docs/cli/headless/
// 2026-09-25 快照，Last updated Mar 10, 2026）——stream-json 为 JSONL，事件类型六类：
//   init / message / tool_use / tool_result / error / result；
// 退出码 0=成功、1=一般错误、42=输入错误、53=轮次上限（退出码由 runner/session-manager
// 消费，解析器只见 stdout 帧）。
// 帧内部字段官方快照未给完整 schema（仅 `response`/`stats`/`error` 顶层键与事件类型名），
// 故本解析器对字段读取全部防御式：取不到即落 custom 兜底，绝不抛出、绝不猜控制指令。
// 真实 CLI 帧形取证挂 V03 验证队列；未实测能力（append/resume/approve/fileChanges）一律
// 不声明（见 catalog-entries/gemini-cli.json）。

// 能力口径与帧形认领范围见 isGeminiStreamType 注释。

/**
 * 帧形状探测（generic.js 分发器路由用；契约 §3：对 null/非对象安全）。
 * 认领范围刻意收窄（generic 桶内零回归原则——只接今天落入误标/兜底路径的帧）：
 *   - init/message/tool_result：Gemini 专有帧型，现有 claude/opencode/codex 探测均不认领；
 *   - result：claude（result 字段+usage）、qwen（uuid+usage）同形，仅当携带 Gemini 特有
 *     标记（stats 聚合 或 response 文本字段）时认领；
 *   - tool_use：与 opencode 已实测 tool_use 帧同型（V12-A05 真实 CLI 取证，generic 桶
 *     无 agentType 守卫）——让位既有证据链，不认领（真实帧形取证挂 V03 后再收窄认领）；
 *   - error：与 opencode 结构化 error / codex 扁平 error 冲突——让位，保持既有路由
 *     （mapGeminiRaw 的 error 分支保留完整解析，待 V03 实测帧形后在分发层翻转认领）。
 */
export function isGeminiStreamType(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.type !== 'string') return false;
  if (raw.type === 'init' || raw.type === 'message' || raw.type === 'tool_result') return true;
  if (raw.type === 'result') {
    return (raw.stats !== undefined && raw.usage === undefined) || typeof raw.response === 'string';
  }
  return false;
}

/**
 * 帧翻译（契约 §3：纯函数、零 IO、不抛出；未知帧一律 custom 兜底）。
 * agentType 缺省 'generic'——目录条目 adapter_id 归入 generic（契约 §1 不逐产品新建
 * adapter_id），createEvent 仅接受 AGENT_TYPES 白名单。
 */
export function mapGeminiRaw(raw, ctx) {
  const { sessionId, agentType = 'generic', sequencer } = ctx || {};
  if (!raw || typeof raw !== 'object') return [];
  const events = [];
  switch (raw.type) {
    case 'init': {
      events.push(createEvent({
        sessionId, agentType, sequencer,
        eventType: 'custom',
        payload: {
          custom_type: 'system',
          system_subtype: 'init',
          fallback_text: 'Gemini 会话已初始化',
          data: {
            session_id: stringOrNull(raw.session_id ?? raw.sessionId),
            model: stringOrNull(raw.model),
          },
        },
      }));
      break;
    }
    case 'message': {
      const text = extractText(raw);
      if (text) {
        events.push(createEvent({
          sessionId, agentType, sequencer,
          eventType: raw.role === 'user' ? 'user_message' : 'agent_message',
          payload: {
            message_id: stringOrNull(raw.id) || `m_${crypto.randomUUID()}`,
            stream_id: stringOrNull(raw.id),
            role: raw.role === 'user' ? 'user' : 'assistant',
            content: text,
            content_type: 'text',
            // 官方快照未定义分片结束标记：默认非终帧，最终回复以 result.response 为准
            //（session_end.summary）。CLI 未来显式携带 is_final 时如实透出。
            is_final: raw.is_final === true,
            stop_reason: stringOrNull(raw.stop_reason),
          },
        }));
      } else {
        events.push(geminiFallback(raw, 'message', { sessionId, agentType, sequencer }));
      }
      break;
    }
    case 'tool_use': {
      events.push(createEvent({
        sessionId, agentType, sequencer,
        eventType: 'tool_call',
        payload: {
          tool_call_id: stringOrNull(raw.id ?? raw.call_id) || `tc_${crypto.randomUUID()}`,
          tool_name: stringOrNull(raw.name ?? raw.tool_name ?? raw.tool) || 'unknown',
          input_preview: sanitizePreview(firstDefined(raw.args, raw.arguments, raw.input, raw.parameters, {}), 500),
          input_sensitive: false,
          status: 'running',
        },
      }));
      break;
    }
    case 'tool_result': {
      const failed = raw.is_error === true || raw.error !== undefined;
      events.push(createEvent({
        sessionId, agentType, sequencer,
        eventType: 'tool_result',
        payload: {
          tool_call_id: stringOrNull(raw.id ?? raw.call_id ?? raw.tool_call_id),
          tool_name: stringOrNull(raw.name ?? raw.tool_name) || 'unknown',
          status: failed ? 'error' : 'success',
          result_preview: sanitizePreview(firstDefined(raw.output, raw.result, raw.content, ''), 500),
          result_sensitive: false,
        },
      }));
      break;
    }
    case 'error': {
      // 官方语义：error = 非致命警告 + 系统错误；只有帧显式 fatal 标记才升级 fatal，
      // 避免 gemini 警告帧把会话状态打成 failed（schema error_fatal 仅认 severity=fatal）。
      // 路由现状：探测层因与 opencode/codex error 帧同型而让位（见 isGeminiStreamType），
      // 本分支当前仅可达于直接调用/单测与 V03 实测后的分发翻转。
      const fatal = raw.fatal === true;
      events.push(createEvent({
        sessionId, agentType, sequencer,
        eventType: 'error',
        payload: {
          error_code: stringOrNull(raw.code) || 'GEMINI_ERROR',
          severity: fatal ? 'fatal' : 'warning',
          message: truncateText(String(firstDefined(raw.message, raw.error?.message, 'Gemini 错误')), 1000),
          recoverable: !fatal,
        },
      }));
      break;
    }
    case 'result': {
      // 官方：result = 最终结果 + 聚合统计；response 为模型最终回答，error 存在表示请求失败
      //（对应非零退出的"已有部分结果"场景：仍发 session_end 让手机端拿到终态与已有回复）。
      const failed = raw.error !== undefined && raw.error !== null;
      events.push(createEvent({
        sessionId, agentType, sequencer,
        eventType: 'session_end',
        payload: {
          reason: failed ? 'error' : 'completed',
          summary: typeof raw.response === 'string' && raw.response
            ? truncateText(raw.response, 1000)
            : `Gemini 会话结束${failed ? '（出错）' : ''}`,
          usage: usageFromStats(raw.stats),
        },
      }));
      break;
    }
    default:
      events.push(geminiFallback(raw, String(raw.type), { sessionId, agentType, sequencer }));
      break;
  }
  return events;
}

/** 未知/畸形帧兜底：custom 事件 + 一句话说明，不透传大字段（契约 §3.3）。 */
function geminiFallback(raw, typeLabel, { sessionId, agentType, sequencer }) {
  return createEvent({
    sessionId, agentType, sequencer,
    eventType: 'custom',
    payload: {
      custom_type: 'gemini_raw',
      fallback_text: `Gemini 事件：${typeLabel || 'unknown'}`,
      data: { type: typeLabel || null },
    },
  });
}

function stringOrNull(value) {
  return typeof value === 'string' && value ? value : null;
}

function firstDefined(...values) {
  for (const v of values) {
    if (v !== undefined && v !== null) return v;
  }
  return values[values.length - 1];
}

/** 从 message 帧提取文本：text / content（字符串或块数组）/ message.content（Claude 兼容形态）。 */
function extractText(raw) {
  const direct = raw.text ?? raw.content ?? raw.message?.content ?? raw.delta;
  if (typeof direct === 'string' && direct) return direct;
  if (Array.isArray(direct)) {
    const parts = direct
      .filter((item) => item && typeof item === 'object')
      .map((item) => firstDefined(item.text, item.content, null))
      .filter((t) => typeof t === 'string' && t);
    if (parts.length) return parts.join('');
  }
  return null;
}

/** result.stats 聚合用量（官方仅描述"token 用量与 API 延迟"，内部字段待 V03 实测；无统计不伪造，取不到为 0）。 */
function usageFromStats(stats) {
  const s = stats && typeof stats === 'object' ? stats : {};
  return {
    input_tokens: numberOrZero(s.input_tokens),
    output_tokens: numberOrZero(s.output_tokens),
  };
}

function numberOrZero(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}
