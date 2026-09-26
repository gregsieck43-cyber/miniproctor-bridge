import { createEvent, getEventPolicy, redactThinkingEvent, sanitizePreview, truncateText } from '../lib/events.js';

// 腾讯 CodeBuddy CLI（codebuddy/cbc）headless stream-json 适配器（V12-A17）。
//
// 协议证据：xcx/docs/官方资料/A17-codebuddy-cli-headless.md（官方无头模式文档本地快照，2026-09-25 抓取）：
//   - `codebuddy -p --output-format stream-json`：初始 init 系统消息 → user/assistant 消息列表 →
//     含统计信息的最终 result 系统消息，每条一行 JSON；消息模式「对齐 Anthropic Claude Code v2.1.88」
//     （官方原文），回退 control 协议亦对齐 CC 并带 cbc 扩展（rewind/historyRewound）。
//   - 后台任务事件（官方示例帧）：system / subtype ∈ task_started|task_progress|task_updated|task_notification，
//     携带 task_id/tool_use_id/usage{total_tokens,tool_uses,duration_ms}/summary 等。
//   - stream-json 输入（多轮追加）：每行一个 user 消息对象，可为每轮提供
//     `_meta.codebuddy.ai/conversationRequestId`（小写 32 位 UUIDv7 十六进制），CLI 回显于本轮输出 `_requestId`。
//   - 审批：headless 文档明确 `--permission-prompt-tool` 不支持；需授权操作在 -p 模式必须 -y 否则被阻止。
//     即官方 headless 协议无双向审批回调通道 → approve=false（不伪造）。
//
// 探测边界（诚实登记）：cbc 帧 init/assistant/result 与 Claude stream-json 同形，仅凭帧形状无法区分；
// 本适配器只认领「官方文档化 cbc 专属标记」的帧（_requestId / _meta 会话请求 ID / rewind 扩展应答字段），
// 未带标记的同形帧仍走 claude 映射——真实 CLI 取证（V03）后按实测流修订。probe 不与 claude/codex 抢帧。
//
// 事件 agent_type 取 'generic'：AGENT_TYPES 冻结为 claude-code/codex/generic（protocol/schema.cjs），
// 新协议形态按契约 §1 归入最接近的现有 adapter_id。

const CBC_STREAM_TYPES = new Set([
  'system', 'assistant', 'user', 'result', 'control_request', 'control_cancel_request', 'control_response',
]);
// 官方文档化 cbc 后台任务子类型（A17 快照「后台任务事件」节示例帧）。
const CBC_TASK_SUBTYPES = new Set(['task_started', 'task_progress', 'task_updated', 'task_notification']);

/**
 * 探测：claude 家族形状 + 以下三者其一（均在分发层 generic 桶内生效，claude-code/codex 会话零回归）：
 *   1) 官方文档化 cbc 专属标记：_requestId / _meta.codebuddy.ai/conversationRequestId；
 *   2) cbc 回退扩展应答字段：historyRewound / fileRewindError（rewind 为 cbc 扩展）；
 *   3) 官方后台任务事件子类型：system/task_started|task_progress|task_updated|task_notification
 *      （A17 示例帧形状；generic 桶内认领使其获得结构化渲染与 generic 归属，claude 会话不受影响）。
 */
export function isCodebuddyStreamType(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.type !== 'string' || !CBC_STREAM_TYPES.has(raw.type)) return false;
  if (raw.type === 'system' && CBC_TASK_SUBTYPES.has(raw.subtype)) return true;
  if (typeof raw._requestId === 'string' && raw._requestId) return true;
  if (raw._meta && typeof raw._meta === 'object'
    && typeof raw._meta['codebuddy.ai/conversationRequestId'] === 'string') return true;
  if (raw.type === 'control_response') {
    const body = raw.response && typeof raw.response === 'object' ? raw.response.response : null;
    if (body && typeof body === 'object' && (body.historyRewound !== undefined || body.fileRewindError !== undefined)) return true;
  }
  return false;
}

export function mapCodebuddyRaw(raw, { sessionId, agentType = 'generic', sequencer }) {
  if (!isCodebuddyStreamType(raw)) return [];
  try {
    return mapCbcFrame(raw, { sessionId, agentType, sequencer });
  } catch {
    // 单帧隔离（契约 §5）：解析崩溃只影响本帧。
    return fallbackEvent({ sessionId, agentType, sequencer }, 'cbc_raw', 'CodeBuddy 帧解析异常，已按未知帧兜底', null);
  }
}

function mapCbcFrame(raw, ctx) {
  switch (raw.type) {
    case 'system':
      return mapSystem(raw, ctx);
    case 'assistant':
      return mapAssistant(raw, ctx);
    case 'user': {
      const message = raw.message || {};
      const content = message.content;
      const text = typeof content === 'string' ? content : sanitizePreview(content || {});
      if (!text) return [];
      return [createEvent({
        ...ctx,
        eventType: 'user_message',
        payload: { message_id: raw.uuid || `m_${crypto.randomUUID()}`, role: 'user', content: text, content_type: 'text' },
      })];
    }
    case 'result': {
      // 最终 result 系统消息（含统计信息，官方文档）→ session_end。
      const usage = raw.usage && typeof raw.usage === 'object' ? raw.usage : {};
      const subtype = raw.subtype || 'success';
      return [createEvent({
        ...ctx,
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
      })];
    }
    case 'control_response': {
      const body = raw.response && typeof raw.response === 'object' ? raw.response : {};
      const inner = body.response && typeof body.response === 'object' ? body.response : {};
      return [createEvent({
        ...ctx,
        eventType: 'custom',
        payload: {
          custom_type: 'control_response',
          fallback_text: body.subtype === 'success'
            ? `控制应答成功（request_id=${sanitizePreview(body.request_id, 64)}）`
            : `控制应答失败：${sanitizePreview(inner.error || body.subtype || 'unknown', 200)}`,
          data: {
            request_id: body.request_id ?? null,
            subtype: body.subtype ?? null,
            can_rewind: inner.canRewind === true,
            history_rewound: inner.historyRewound === true,
            // 部分成功标志（cbc 扩展）：canRewind=true 但文件回退失败、历史已回退
            file_rewind_error: typeof inner.fileRewindError === 'string' ? inner.fileRewindError : null,
            error: typeof inner.error === 'string' ? inner.error : null,
          },
        },
      })];
    }
    case 'control_request':
    case 'control_cancel_request':
      return [createEvent({
        ...ctx,
        eventType: 'custom',
        payload: {
          custom_type: `cbc_${raw.type}`,
          fallback_text: `CodeBuddy 控制消息：${sanitizePreview(raw.request?.subtype || 'unknown', 80)}`,
          data: { request_id: raw.request_id ?? null },
        },
      })];
    default:
      return fallbackEvent(ctx, 'cbc_raw', `CodeBuddy 事件：${sanitizePreview(raw.type, 80)}`, null);
  }
}

function mapSystem(raw, ctx) {
  const subtype = raw.subtype || 'unknown';
  if (subtype === 'init') {
    return [createEvent({
      ...ctx,
      eventType: 'custom',
      payload: {
        custom_type: 'system',
        system_subtype: 'init',
        fallback_text: '会话已初始化',
        data: { model: raw.model || null, tools: Array.isArray(raw.tools) ? raw.tools.slice(0, 20) : [] },
      },
    })];
  }
  // 后台任务事件（官方文档示例帧；task_id 贯穿 started→progress→updated→notification）
  if (subtype === 'task_started' || subtype === 'task_progress') {
    const usage = raw.usage && typeof raw.usage === 'object' ? raw.usage : {};
    return [createEvent({
      ...ctx,
      eventType: 'task_progress',
      payload: {
        task_id: typeof raw.task_id === 'string' && raw.task_id ? raw.task_id : `task_${crypto.randomUUID()}`,
        title: `后台任务：${typeof raw.description === 'string' && raw.description ? raw.description : (raw.task_type || '进行中')}`,
        current: numberOrZero(usage.tool_uses),
        total: null,
        percent: null,
      },
    })];
  }
  if (subtype === 'task_updated') {
    const patch = raw.patch && typeof raw.patch === 'object' ? raw.patch : {};
    return [createEvent({
      ...ctx,
      eventType: 'custom',
      payload: {
        custom_type: 'task_status',
        fallback_text: `后台任务状态：${sanitizePreview(patch.status || 'unknown', 40)}`,
        data: { task_id: raw.task_id ?? null, status: patch.status ?? null },
      },
    })];
  }
  if (subtype === 'task_notification') {
    const summary = typeof raw.summary === 'string' && raw.summary ? raw.summary : `后台任务${raw.status || '结束'}`;
    return [createEvent({
      ...ctx,
      eventType: 'custom',
      payload: {
        custom_type: 'task_notification',
        fallback_text: sanitizePreview(summary, 300),
        data: { task_id: raw.task_id ?? null, status: raw.status ?? null },
      },
    })];
  }
  return [createEvent({
    ...ctx,
    eventType: 'custom',
    payload: {
      custom_type: 'system',
      system_subtype: subtype,
      fallback_text: `系统事件：${subtype}`,
      data: null,
    },
  })];
}

function mapAssistant(raw, ctx) {
  const message = raw.message || {};
  const content = Array.isArray(message.content) ? message.content : [];
  const events = [];
  for (const item of content) {
    if (!item || typeof item !== 'object') continue;
    if (item.type === 'text' && typeof item.text === 'string' && item.text) {
      events.push(createEvent({
        ...ctx,
        eventType: 'agent_message',
        payload: {
          message_id: message.id || raw.uuid || `m_${crypto.randomUUID()}`,
          stream_id: message.id || null,
          role: 'assistant',
          content: item.text,
          content_type: 'text',
          is_final: false, // 终态由 result 帧（session_end）承载
          stop_reason: message.stop_reason || null,
        },
      }));
    } else if (item.type === 'thinking' && typeof item.thinking === 'string' && item.thinking) {
      // 与 claude-code 同策略：默认不上传思考正文（TASK-019 ②①）。
      if (getEventPolicy().uploadThinking) {
        events.push(createEvent({
          ...ctx,
          eventType: 'custom',
          payload: { custom_type: 'thinking', fallback_text: item.thinking, data: { thinking: item.thinking } },
          metadata: { sensitive: true },
        }));
      } else {
        events.push(redactThinkingEvent({ ...ctx, originalText: item.thinking }));
      }
    } else if (item.type === 'tool_use') {
      events.push(createEvent({
        ...ctx,
        eventType: 'tool_call',
        payload: {
          tool_call_id: item.id || `tc_${crypto.randomUUID()}`,
          tool_name: item.name || 'unknown',
          // input 缺失/畸形时预览留空（防御式，不因 sanitizePreview(undefined) 抛错丢整帧）
          input_preview: item.input && typeof item.input === 'object' ? sanitizePreview(item.input, 500) : '',
          input_sensitive: false,
          status: 'running',
        },
      }));
      const fileEvent = fileChangeFromTool(item, ctx);
      if (fileEvent) events.push(fileEvent);
    }
  }
  return events;
}

/** 编辑类 tool_use → file_change（消息模式官方声明对齐 CC；真实 CLI 发帧待 V03 取证）。 */
function fileChangeFromTool(item, ctx) {
  const editTools = new Set(['Edit', 'Write', 'NotebookEdit', 'MultiEdit']);
  if (!editTools.has(item.name) || !item.input || typeof item.input !== 'object') return null;
  const filePath = item.input.file_path || item.input.notebook_path || item.input.path;
  if (!filePath) return null;
  const oldText = typeof item.input.old_string === 'string' ? item.input.old_string : '';
  const newText = typeof item.input.new_string === 'string' ? item.input.new_string : '';
  const NL = String.fromCharCode(10);
  const CR = String.fromCharCode(13);
  const prefix = (text, mark) => text
    .split(NL)
    .map((line) => (line.endsWith(CR) ? line.slice(0, -1) : line))
    .map((line) => `${mark} ${line}`)
    .join(NL);
  const lines = [`--- ${filePath}`];
  if (oldText) lines.push(prefix(oldText, '-'));
  if (newText) lines.push(prefix(newText, '+'));
  const preview = truncateText(lines.join(NL), 6144);
  const bytes = Buffer.byteLength(preview, 'utf8');
  return createEvent({
    ...ctx,
    eventType: 'file_change',
    payload: {
      file_path: filePath,
      change_type: item.name === 'Write' ? 'created' : 'modified',
      summary: `${item.name} ${filePath}`,
      diff_preview: preview,
      diff_bytes: bytes,
      truncated: bytes >= 6144,
    },
  });
}

/**
 * stream-json 输入帧编码（append 代码路径）：多轮对话对同一进程持续发送 user 消息。
 * conversationRequestId 可省略（CLI 自动生成）；提供时必须为小写无连字符 32 位 UUIDv7 十六进制（官方约束）。
 */
export function buildCodebuddyUserFrame({ text, conversationRequestId } = {}) {
  const frame = {
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text: String(text ?? '') }] },
  };
  if (conversationRequestId) {
    frame._meta = { 'codebuddy.ai/conversationRequestId': String(conversationRequestId) };
  }
  return `${JSON.stringify(frame)}\n`;
}

/** 声明层能力（V12-A17；与 catalog-entries/codebuddy.json 同步，执行门禁另经 capabilities.js 开放视图）。 */
export const CODEBUDDY_CAPABILITIES = Object.freeze({
  create: false, // 无产品专属拉起路径（无启动预设；AdapterFactory 对 adapter_id=generic 拒绝新会话），待 V03 接通
  read: true, // stream-json 帧解析器已实现（官方文档示例帧 fixture 对拍）
  stop: true, // runner 进程树终止为 bridge 自有能力（generic 同源）
  append: true, // stream-json 输入多轮 user 帧编码器已实现（官方文档化多轮通道；session-manager 接线待 V03）
  resume: false, // --resume/--continue 为 CLI flag，bridge 无恢复重拉代码路径，不声明
  approve: false, // 官方 headless 无双向审批回调（--permission-prompt-tool 明确不支持）
  fileChanges: true, // 编辑类 tool_use → file_change（官方声明消息模式对齐 CC v2.1.88）
  usage: true, // result 统计 + task_progress.usage 官方示例帧映射已实现
  integrationMode: 'stdio',
  initialPromptChannel: 'launch-args',
});

/* ---------------- 内部工具 ---------------- */

function fallbackEvent(ctx, customType, text, data) {
  try {
    return [createEvent({
      ...ctx,
      eventType: 'custom',
      payload: { custom_type: customType, fallback_text: text, data },
    })];
  } catch {
    return []; // ctx 缺失/非法时静默丢帧（契约：不得抛出）
  }
}

function numberOrZero(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}
