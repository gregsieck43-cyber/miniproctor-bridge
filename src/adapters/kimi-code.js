import { createEvent, getEventPolicy, redactThinkingEvent, sanitizePreview, truncateText } from '../lib/events.js';

// Kimi Code CLI `--wire` 模式适配器（V12-A16）。
//
// 协议证据：xcx/docs/官方资料/A16a-kimi-cli-wire-mode.md（官方 Wire 文档本地快照，2026-09-25 抓取，
// 协议版本 1.10）：JSON-RPC 2.0 over stdio，每行一条消息。四类帧：
//   - 通知 {"jsonrpc":"2.0","method":"event","params":{type,payload}}     —— Agent 回合事件流
//   - 请求 {"jsonrpc":"2.0","method":"request","id":...,"params":{type,payload}} —— Agent→客户端请求（审批/外部工具/提问）
//   - 响应 {"jsonrpc":"2.0","id":...,"result"|"error"}                     —— 对客户端 initialize/prompt/steer/cancel/replay 的应答
//   官方明确「旧客户端可跳过 initialize 直接发 prompt」——bridge 初始 prompt 走 prompt 请求（stdin 通道）。
//
// 历史 Wire 路径保留给旧格式；2.1.1 的 -p stream-json 已改成 role/content JSONL，
// 产品 profile 用下方独立解析器，避免把旧 Wire fixture 当作新版实测。
// 事件 agent_type 取 'generic'：AGENT_TYPES 枚举冻结为 claude-code/codex/generic（protocol/schema.cjs），
// 新协议形态按契约 §1 归入最接近的现有 adapter_id，事件归属用 catalog agent_key 区分。

const RPC_VERSION = '2.0';

/** Kimi Code 2.1.1 -p --output-format stream-json；只在已绑定 kimi-code profile 下认领。 */
export function isKimiCodeProfileOutput(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  if (raw.role === 'meta') return raw.type === 'system.version' || raw.type === 'session.resume_hint';
  if (raw.role === 'assistant') return typeof raw.content === 'string' || Array.isArray(raw.tool_calls);
  return raw.role === 'tool' && typeof raw.tool_call_id === 'string';
}

export function mapKimiCodeProfileOutput(raw, { sessionId, agentType = 'generic', sequencer } = {}) {
  if (!isKimiCodeProfileOutput(raw)) return [];
  // 2.1.1 的 meta 为 CLI 版本/本机恢复提示；tool 帧可能含完整文件正文，只上行最终答复。
  if (raw.role !== 'assistant' || typeof raw.content !== 'string' || !raw.content) return [];
  try {
    return [createEvent({
      sessionId, agentType, sequencer,
      eventType: 'agent_message',
      payload: {
        message_id: `m_kimi_${sequencer.next()}`,
        stream_id: null,
        role: 'assistant',
        content: truncateText(raw.content, 7000),
        content_type: 'text',
        is_final: !Array.isArray(raw.tool_calls) || raw.tool_calls.length === 0,
      },
    })];
  } catch {
    return [];
  }
}

/** 探测 Kimi Wire JSON-RPC 帧：jsonrpc=2.0 且带 method（请求/通知）或 id（响应）。 */
export function isKimiCodeStreamType(raw) {
  return Boolean(
    raw
    && typeof raw === 'object'
    && raw.jsonrpc === RPC_VERSION
    && (typeof raw.method === 'string' || raw.id !== undefined),
  );
}

export function mapKimiCodeRaw(raw, { sessionId, agentType = 'generic', sequencer }) {
  // 非 Wire 帧（含 null/原始类型）不属于本适配器：返回空数组，不误伤其他探测分支。
  if (!isKimiCodeStreamType(raw)) return [];
  try {
    return mapWireFrame(raw, { sessionId, agentType, sequencer });
  } catch {
    // 单帧隔离（契约 §5）：解析崩溃只影响本帧，兜底为 custom 占位；兜底本身失败则静默丢帧。
    return fallbackEvent({ sessionId, agentType, sequencer }, 'kimi_wire', 'Kimi Wire 帧解析异常，已按未知帧兜底', null);
  }
}

function mapWireFrame(raw, ctx) {
  if (raw.method === 'event') return mapEventNotification(raw.params, ctx);
  if (raw.method === 'request') return mapAgentRequest(raw, ctx);
  if (raw.id !== undefined) return mapRpcResponse(raw, ctx);
  return fallbackEvent(ctx, 'kimi_wire', `Kimi Wire 消息：${sanitizePreview(raw.method, 80)}`, null);
}

/* ---------------- Agent 事件通知（method=event，无需应答） ---------------- */

function mapEventNotification(params, ctx) {
  const type = params && typeof params === 'object' ? params.type : null;
  const payload = params && typeof params === 'object' && params.payload && typeof params.payload === 'object' ? params.payload : {};
  switch (type) {
    case 'ContentPart':
      return mapContentPart(payload, ctx);
    case 'ToolCall': {
      const fn = payload.function && typeof payload.function === 'object' ? payload.function : {};
      const events = [createEvent({
        ...ctx,
        eventType: 'tool_call',
        payload: {
          tool_call_id: typeof payload.id === 'string' && payload.id ? payload.id : `tc_${crypto.randomUUID()}`,
          tool_name: typeof fn.name === 'string' && fn.name ? fn.name : 'unknown',
          input_preview: argumentsPreview(fn.arguments),
          input_sensitive: false,
          status: 'running',
        },
      })];
      return events;
    }
    case 'ToolResult': {
      const rv = payload.return_value && typeof payload.return_value === 'object' ? payload.return_value : {};
      const events = [createEvent({
        ...ctx,
        eventType: 'tool_result',
        payload: {
          tool_call_id: typeof payload.tool_call_id === 'string' && payload.tool_call_id ? payload.tool_call_id : '',
          tool_name: '',
          status: rv.is_error === true ? 'error' : 'success',
          result_preview: resultPreview(rv),
          result_sensitive: false,
        },
      })];
      // diff 展示块 → file_change（官方 DisplayBlock.diff：path/old_text/new_text）
      const fileEvent = fileChangeFromDiffBlocks(rv.display, ctx);
      if (fileEvent) events.push(fileEvent);
      return events;
    }
    case 'TurnBegin':
      return [createEvent({
        ...ctx,
        eventType: 'custom',
        payload: {
          custom_type: 'turn_begin',
          fallback_text: '回合开始',
          data: { user_input_preview: sanitizePreview(payload.user_input, 200) },
        },
      })];
    case 'TurnEnd':
      // 回合完成 → session_end（与 claude result / codex turn 完成语义一致）。
      return [createEvent({
        ...ctx,
        eventType: 'session_end',
        payload: { reason: 'completed', summary: '回合结束（Wire TurnEnd）', usage: {} },
      })];
    case 'StepBegin':
      return [createEvent({
        ...ctx,
        eventType: 'task_progress',
        payload: {
          task_id: `step_${numberOrZero(payload.n)}`,
          title: 'Kimi 执行中',
          current: numberOrZero(payload.n),
          total: null,
          percent: null,
        },
      })];
    case 'StepRetry':
      return [createEvent({
        ...ctx,
        eventType: 'custom',
        payload: {
          custom_type: 'step_retry',
          fallback_text: `第 ${numberOrZero(payload.n)} 步失败，即将重试（第 ${numberOrZero(payload.next_attempt)}/${numberOrZero(payload.max_attempts)} 次，等待 ${numberOrZero(payload.wait_s)}s）`,
          data: { step: numberOrZero(payload.n), error_type: sanitizePreview(payload.error_type, 120) },
        },
      })];
    case 'StatusUpdate': {
      // token_usage（input_other/output/input_cache_read/input_cache_creation）→ usage 上报路径
      const usage = payload.token_usage && typeof payload.token_usage === 'object' ? payload.token_usage : null;
      return [createEvent({
        ...ctx,
        eventType: 'custom',
        payload: {
          custom_type: 'status_update',
          fallback_text: '状态更新',
          data: {
            context_usage: finiteOrNull(payload.context_usage),
            context_tokens: finiteOrNull(payload.context_tokens),
            max_context_tokens: finiteOrNull(payload.max_context_tokens),
            usage: usage ? {
              input_tokens: numberOrZero(usage.input_other),
              output_tokens: numberOrZero(usage.output),
              cache_read_input_tokens: numberOrZero(usage.input_cache_read),
              cache_creation_input_tokens: numberOrZero(usage.input_cache_creation),
            } : null,
          },
        },
      })];
    }
    case 'ApprovalResponse':
      return [createEvent({
        ...ctx,
        eventType: 'custom',
        payload: {
          custom_type: 'approval_resolved',
          fallback_text: `审批已处理：${sanitizePreview(payload.response, 40)}`,
          data: { request_id: typeof payload.request_id === 'string' ? payload.request_id : null },
        },
      })];
    case 'PlanDisplay':
      return [createEvent({
        ...ctx,
        eventType: 'custom',
        payload: {
          custom_type: 'plan_display',
          fallback_text: '计划已提交，待确认',
          data: { file_path: typeof payload.file_path === 'string' ? payload.file_path : null },
        },
      })];
    case 'SteerInput':
    case 'SubagentEvent':
    case 'BtwBegin':
    case 'BtwEnd':
    case 'HookTriggered':
    case 'HookResolved':
    case 'CompactionBegin':
    case 'CompactionEnd':
    case 'StepInterrupted':
    case 'ToolCallPart':
      return [createEvent({
        ...ctx,
        eventType: 'custom',
        payload: { custom_type: `kimi_${type}`, fallback_text: `Kimi 事件：${type}`, data: null },
      })];
    default:
      return fallbackEvent(ctx, 'kimi_wire', `Kimi 未知事件：${sanitizePreview(type, 80)}`, null);
  }
}

function mapContentPart(payload, ctx) {
  if (payload.type === 'text') {
    const text = typeof payload.text === 'string' ? payload.text : sanitizePreview(payload.text, 500);
    if (!text) return [];
    return [createEvent({
      ...ctx,
      eventType: 'agent_message',
      payload: {
        message_id: `m_${crypto.randomUUID()}`,
        stream_id: null,
        role: 'assistant',
        content: text,
        content_type: 'text',
        is_final: false, // 终态由 TurnEnd（session_end）承载
      },
    })];
  }
  if (payload.type === 'think') {
    // thinking 与 claude-code 同策略：默认不上传正文，降级为脱敏占位（TASK-019 ②①）。
    const think = typeof payload.think === 'string' ? payload.think : '';
    if (!think) return [];
    if (getEventPolicy().uploadThinking) {
      return [createEvent({
        ...ctx,
        eventType: 'custom',
        payload: { custom_type: 'thinking', fallback_text: think, data: { thinking: think } },
        metadata: { sensitive: true },
      })];
    }
    return [redactThinkingEvent({ ...ctx, originalText: think })];
  }
  // 图片/音频/视频 URL 等媒体部件：不透传 URL 与数据，只记类型占位。
  return [createEvent({
    ...ctx,
    eventType: 'custom',
    payload: { custom_type: 'kimi_content_part', fallback_text: `Kimi 媒体内容（${sanitizePreview(payload.type, 40)}），正文未上传`, data: null },
  })];
}

/* ---------------- Agent→客户端请求（method=request，需应答） ---------------- */

function mapAgentRequest(raw, ctx) {
  const params = raw.params && typeof raw.params === 'object' ? raw.params : {};
  const payload = params.payload && typeof params.payload === 'object' ? params.payload : {};
  if (params.type === 'ApprovalRequest') {
    // 应答格式（官方 Wire 1.6+）：{"jsonrpc":"2.0","id":<本请求 id>,"result":{"request_id":<payload.id>,"response":"approve|reject"}}
    // confirm_required.request_id 用 JSON-RPC 传输 id（session-manager pendingInputs 寻址键）；
    // payload.id（审批业务 id）经 context.approval_id 透传给应答编码器。
    return [createEvent({
      ...ctx,
      eventType: 'confirm_required',
      payload: {
        request_id: typeof raw.id === 'string' || typeof raw.id === 'number' ? String(raw.id) : `req_${crypto.randomUUID()}`,
        kind: 'tool_permission',
        title: `是否允许 ${typeof payload.sender === 'string' && payload.sender ? payload.sender : '工具'}？`,
        detail: sanitizePreview(payload.description || payload.action || '', 500),
        context: {
          tool_name: typeof payload.sender === 'string' && payload.sender ? payload.sender : 'unknown',
          input_preview: sanitizePreview(payload.action || '', 200),
          approval_id: typeof payload.id === 'string' ? payload.id : null,
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
  // 结构化提问（supports_question 未声明时官方不发送）：bridge 无应答通道，兜底显示不挂起。
  if (params.type === 'QuestionRequest') {
    const questions = Array.isArray(payload.questions) ? payload.questions : [];
    return [createEvent({
      ...ctx,
      eventType: 'custom',
      payload: {
        custom_type: 'question_request',
        fallback_text: `Kimi 提问（${questions.length} 项）：${sanitizePreview(questions.map((q) => q && q.question).filter(Boolean).join('；'), 300)}`,
        data: null,
      },
    })];
  }
  if (params.type === 'ToolCallRequest') {
    return [createEvent({
      ...ctx,
      eventType: 'custom',
      payload: {
        custom_type: 'external_tool_request',
        fallback_text: `Kimi 外部工具调用：${sanitizePreview(payload.name, 80)}`,
        data: { tool_call_id: typeof payload.id === 'string' ? payload.id : null },
      },
    })];
  }
  if (params.type === 'HookRequest') {
    return [createEvent({
      ...ctx,
      eventType: 'custom',
      payload: { custom_type: 'hook_request', fallback_text: `Kimi 钩子请求：${sanitizePreview(payload.event, 80)}`, data: null },
    })];
  }
  return fallbackEvent(ctx, 'kimi_wire', `Kimi 未知请求：${sanitizePreview(params.type, 80)}`, null);
}

/* ---------------- RPC 响应（对 initialize/prompt/steer/cancel/replay 的应答） ---------------- */

function mapRpcResponse(raw, ctx) {
  if (raw.error && typeof raw.error === 'object') {
    // JSON-RPC 错误应答（如 -32001 LLM is not set）：致命语义（对应请求未成功）。
    return [createEvent({
      ...ctx,
      eventType: 'error',
      payload: {
        error_code: `KIMI_RPC_${numberOrZero(raw.error.code)}`,
        severity: 'fatal',
        message: sanitizePreview(raw.error.message || 'Kimi RPC 错误', 1000),
        recoverable: false,
      },
    })];
  }
  const result = raw.result && typeof raw.result === 'object' ? raw.result : {};
  if (result.protocol_version || result.server) {
    const server = result.server && typeof result.server === 'object' ? result.server : {};
    return [createEvent({
      ...ctx,
      eventType: 'custom',
      payload: {
        custom_type: 'initialized',
        fallback_text: 'Kimi Wire 已握手',
        data: {
          protocol_version: sanitizePreview(result.protocol_version, 32),
          server_name: sanitizePreview(server.name, 80),
          server_version: sanitizePreview(server.version, 32),
        },
      },
    })];
  }
  if (typeof result.status === 'string') {
    // prompt → finished|cancelled|max_steps_reached；steer → steered；cancel/replay 另有计数。
    return [createEvent({
      ...ctx,
      eventType: 'custom',
      payload: {
        custom_type: 'turn_result',
        fallback_text: `Kimi 回合结果：${result.status}`,
        data: { status: result.status, steps: finiteOrNull(result.steps) },
      },
    })];
  }
  if (Number.isFinite(result.events) || Number.isFinite(result.requests)) {
    return [createEvent({
      ...ctx,
      eventType: 'custom',
      payload: {
        custom_type: 'replay_result',
        fallback_text: `Kimi 历史回放完成（事件 ${numberOrZero(result.events)}，请求 ${numberOrZero(result.requests)}）`,
        data: { events: numberOrZero(result.events), requests: numberOrZero(result.requests) },
      },
    })];
  }
  return fallbackEvent(ctx, 'kimi_rpc_result', 'Kimi RPC 应答（未识别结构）', null);
}

/* ---------------- 客户端→Agent 编码（append/approve 代码路径） ---------------- */

/**
 * 初始/追加输入帧：Wire `prompt` 请求（官方支持跳过 initialize 直接发 prompt）。
 * 会话进行中的追加注入用 buildKimiSteerFrame（steer 不新开回合）。
 */
export function buildKimiPromptFrame({ requestId, userInput }) {
  return `${JSON.stringify({ jsonrpc: RPC_VERSION, method: 'prompt', id: String(requestId), params: { user_input: String(userInput ?? '') } })}\n`;
}

export function buildKimiSteerFrame({ requestId, userInput }) {
  return `${JSON.stringify({ jsonrpc: RPC_VERSION, method: 'steer', id: String(requestId), params: { user_input: String(userInput ?? '') } })}\n`;
}

/**
 * 审批应答帧：decision ∈ approve|reject|cancel（cancel 按契约 §6 映射 deny 语义=reject）。
 * deny 语义可附 feedback（官方 Wire 1.6+ 可选字段）。
 */
export function buildKimiApprovalResponse({ requestId, approvalId, decision, feedback } = {}) {
  const response = decision === 'approve' ? 'approve' : 'reject';
  const result = { request_id: String(approvalId ?? ''), response };
  if (response === 'reject' && typeof feedback === 'string' && feedback) result.feedback = feedback.slice(0, 500);
  return `${JSON.stringify({ jsonrpc: RPC_VERSION, id: String(requestId ?? ''), result })}\n`;
}

/** 声明层能力（V12-A16；与 catalog-entries/kimi-code.json 同步，执行门禁另经 capabilities.js 开放视图）。 */
export const KIMI_CODE_CAPABILITIES = Object.freeze({
  create: true,
  read: true,
  stop: true,
  append: false, // 2.1.1 print 模式无中途追加输入通路；旧 Wire 编码器不用于此 profile
  resume: false,
  approve: false, // print 模式默认 auto；由静态只读 Agent 文件移除变更工具
  fileChanges: false,
  usage: false, // 2.1.1 stream-json 本轮未见用量帧
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

/** ToolCall.function.arguments 为 JSON 字符串：先解析再预览，失败退回原文预览。 */
function argumentsPreview(raw) {
  if (typeof raw !== 'string' || !raw) return '';
  try {
    return sanitizePreview(JSON.parse(raw), 500);
  } catch {
    return sanitizePreview(raw, 500);
  }
}

function resultPreview(rv) {
  const output = rv.output;
  const text = typeof output === 'string' ? output : sanitizePreview(output, 500);
  const message = typeof rv.message === 'string' ? rv.message : '';
  const merged = text || message ? (message && text ? `${message}：${text}` : (text || message)) : '';
  return sanitizePreview(merged, 500);
}

/** ToolResult/ApprovalRequest 的 display 块中 diff 类型 → file_change 事件。 */
function fileChangeFromDiffBlocks(display, ctx) {
  if (!Array.isArray(display)) return null;
  const block = display.find((item) => item && typeof item === 'object' && item.type === 'diff');
  if (!block || typeof block.path !== 'string' || !block.path) return null;
  const oldText = typeof block.old_text === 'string' ? block.old_text : '';
  const newText = typeof block.new_text === 'string' ? block.new_text : '';
  const NL = String.fromCharCode(10);
  const CR = String.fromCharCode(13);
  const prefix = (text, mark) => text
    .split(NL)
    .map((line) => (line.endsWith(CR) ? line.slice(0, -1) : line))
    .map((line) => `${mark} ${line}`)
    .join(NL);
  const lines = [`--- ${block.path}`];
  if (oldText) lines.push(prefix(oldText, '-'));
  if (newText) lines.push(prefix(newText, '+'));
  // 与 claude-code 同口径：diff 预览上限 6KB（信封 7.5KB 收敛预算内，TASK-019 ②②）。
  const preview = truncateText(lines.join(NL), 6144);
  const bytes = Buffer.byteLength(preview, 'utf8');
  return createEvent({
    ...ctx,
    eventType: 'file_change',
    payload: {
      file_path: block.path,
      change_type: !oldText && newText ? 'created' : newText ? 'modified' : 'deleted',
      summary: `diff ${block.path}`,
      diff_preview: preview,
      diff_bytes: bytes,
      truncated: bytes >= 6144,
    },
  });
}

function numberOrZero(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function finiteOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
