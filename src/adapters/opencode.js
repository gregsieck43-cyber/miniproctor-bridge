import { AGENT_TYPES, createEvent, sanitizePreview } from '../lib/events.js';

// OpenCode 适配器（V12-A05，任务卡 §23.1 + 官方快照 xcx/docs/官方资料/A05-opencode-cli.md）。
//
// 冻结模式：`opencode run --format json "<prompt>"`（stdio / launch-args 初始 prompt）——
// 官方 CLI 文档：`run` 以非交互模式运行，`--format json` 输出「raw JSON events」（JSONL）。
// 不选 local API（serve）：server 有端口占用/认证/多 session 共用生命周期问题（A05 卡
// 风险项「停止不得关闭共用 server 的全部会话」），stdio 单进程模式由 runner 拥有进程树，
// stop 天然只终止本次 spawn；不选 ACP：acp 为交互式双向协议，与 bridge 单向行流模型不匹配。
//
// 帧形状证据（真实 CLI 往返取证 2026-09-25，opencode 1.18.20 / win32，deepseek/deepseek-chat，
// xcx/.tmp/v12-exec/cli/opencode/raw-events-ds.jsonl 与 raw-events-tool.jsonl，已脱敏固化于
// test/fixtures/opencode/）：
//   {"type":"step_start","timestamp":…,"sessionID":"ses_…","part":{…,"type":"step-start"}}
//   {"type":"text",      …,"part":{…,"type":"text","text":"ping","time":{"start":…,"end":…}}}
//   {"type":"tool_use",  …,"part":{"type":"tool","tool":"bash","callID":"call_…",
//        "state":{"status":"completed","input":{…},"output":"…","metadata":{…,"exit":0},…}}}
//   {"type":"step_finish",…,"part":{…,"type":"step-finish","reason":"stop"|"tool-calls",
//        "tokens":{"total":…,"input":…,"output":…,…},"cost":…}}
//   {"type":"error",     …,"sessionID":"ses_…","error":{"name":"APIError",
//        "data":{"message":"…","statusCode":404,"isRetryable":false,…}}}
//
// 能力口径（如实拆分，未实测一律 false；权威执行门禁在 capabilities.js——本卡按简报不修改
// 该文件，运行时 fail-closed 到 generic 底线，开放视图不因本文件而扩大）：
//   create/read/stop=true（run 非交互模式 + JSON 事件流解析 + runner 进程树终止）；
//   usage=true（step_finish 真实携带 tokens/cost，映射入 session_end.usage）；
//   append/resume/approve/fileChanges=false（官方无 execute 单次模式追加通道、
//   --continue/--session 恢复旗标未实测、无审批回写通道证据、无文件变更帧证据）。

// 协议 AGENT_TYPES 白名单（claude-code|codex|generic）不含 opencode：catalog adapter_id 按
// 契约 §1 归入 generic（不逐产品新建分发分支），事件信封 agent_type 一律以 generic 上行。
function normalizeAgentType(agentType) {
  return AGENT_TYPES.includes(agentType) ? agentType : 'generic';
}

// 帧形状探测：仅接受真实观察到的 5 类顶层 type；error 帧要求结构化 error 对象 + sessionID
// （codex 顶层 error 为扁平 {type:'error',message}，靠此区分避免两家分发互抢）。
export function isOpenCodeStreamType(raw) {
  if (!raw || typeof raw !== 'object') return false;
  if (typeof raw.type !== 'string') return false;
  if (raw.type === 'error') {
    return Boolean(raw.error && typeof raw.error === 'object' && typeof raw.sessionID === 'string');
  }
  return ['step_start', 'text', 'tool_use', 'step_finish'].includes(raw.type);
}

export function mapOpenCodeRaw(raw, { sessionId, agentType, sequencer }) {
  const at = normalizeAgentType(agentType);
  if (!raw || typeof raw !== 'object') return [];
  const part = raw.part && typeof raw.part === 'object' ? raw.part : {};

  // text：助手文本段（真实帧 part.time.end 存在表示该段写完；回合终态由 step_finish 承载）。
  if (raw.type === 'text') {
    const text = typeof part.text === 'string' ? part.text : '';
    if (!text) return [];
    return [createEvent({
      sessionId, agentType: at, sequencer,
      eventType: 'agent_message',
      payload: {
        message_id: typeof part.id === 'string' && part.id ? part.id : `m_${crypto.randomUUID()}`,
        stream_id: typeof part.messageID === 'string' ? part.messageID : null,
        role: 'assistant',
        content: text,
        content_type: 'text',
        is_final: Boolean(part.time && typeof part.time === 'object' && part.time.end),
      },
    })];
  }

  // tool_use：工具调用终态聚合帧（含 state.input/output；output 为工具真实产出，
  // 只以 sanitizePreview 预览上报，不透传完整内容——契约 §3.5）。
  if (raw.type === 'tool_use') {
    const state = part.state && typeof part.state === 'object' ? part.state : {};
    return [createEvent({
      sessionId, agentType: at, sequencer,
      eventType: 'tool_call',
      payload: {
        tool_call_id: part.callID || part.id || `tc_${crypto.randomUUID()}`,
        tool_name: typeof part.tool === 'string' && part.tool ? part.tool : 'unknown',
        input_preview: sanitizePreview(state.input ?? {}, 500),
        input_sensitive: false,
        status: typeof state.status === 'string' && state.status ? state.status : 'running',
      },
    })];
  }

  // step_start：回合内步骤开始 → 进度事件（真实帧无步数总数，current/total 不猜）。
  if (raw.type === 'step_start') {
    return [createEvent({
      sessionId, agentType: at, sequencer,
      eventType: 'task_progress',
      payload: {
        task_id: part.messageID || `task_${crypto.randomUUID()}`,
        title: 'OpenCode 执行中',
        current: 0,
        total: null,
        percent: null,
      },
    })];
  }

  // step_finish：reason 已知取值（真实观察）= 'stop'（回合结束）| 'tool-calls'（工具步中间
  // 收尾，回合未完）。'stop' → session_end（completed，携带真实 tokens 计量）；'tool-calls'
  // → 进度事件；其余未知 reason 不猜语义，落 custom 兜底。
  if (raw.type === 'step_finish') {
    if (part.reason === 'stop') {
      const tokens = part.tokens && typeof part.tokens === 'object' ? part.tokens : {};
      const metadata = {};
      if (Number.isFinite(part.cost)) metadata.cost_usd = part.cost;
      return [createEvent({
        sessionId, agentType: at, sequencer,
        eventType: 'session_end',
        payload: {
          reason: 'completed',
          summary: 'OpenCode 回合结束',
          usage: { input_tokens: numberOrZero(tokens.input), output_tokens: numberOrZero(tokens.output) },
        },
        metadata,
      })];
    }
    if (part.reason === 'tool-calls') {
      return [createEvent({
        sessionId, agentType: at, sequencer,
        eventType: 'task_progress',
        payload: {
          task_id: part.messageID || `task_${crypto.randomUUID()}`,
          title: 'OpenCode 工具步骤完成',
          current: 0,
          total: null,
          percent: null,
        },
      })];
    }
    return [customFallback(raw, at, sessionId, sequencer, 'OpenCode 事件：step_finish(未知 reason)')];
  }

  // error：结构化流错误（真实帧 error.data.message 为人类可读原因）。isRetryable=true 时
  // recoverable（OpenCode 自身会重试），否则 fatal。
  if (raw.type === 'error') {
    const err = raw.error && typeof raw.error === 'object' ? raw.error : {};
    const data = err.data && typeof err.data === 'object' ? err.data : {};
    const message = String(data.message || err.name || raw.message || 'OpenCode 错误');
    return [createEvent({
      sessionId, agentType: at, sequencer,
      eventType: 'error',
      payload: {
        error_code: typeof err.name === 'string' && err.name ? `OPENCODE_${err.name.toUpperCase()}` : 'OPENCODE_ERROR',
        severity: 'fatal',
        message: message.slice(0, 1000),
        recoverable: data.isRetryable === true,
      },
    })];
  }

  return [customFallback(raw, at, sessionId, sequencer, `OpenCode 事件：${raw.type}`)];
}

function customFallback(raw, agentType, sessionId, sequencer, fallbackText) {
  return createEvent({
    sessionId, agentType, sequencer,
    eventType: 'custom',
    payload: {
      custom_type: 'opencode_raw',
      fallback_text: sanitizePreview(fallbackText, 200),
      data: { type: typeof raw.type === 'string' ? raw.type : null },
    },
  });
}

function numberOrZero(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * 安全启动参数模板（launch-args 初始 prompt 通道；AdapterFactory launchArgsResolver 注入消费）。
 * 数组直传 spawn，无 shell、无拼接（契约 §4）；位置参数（prompt）恒在末位；
 * 恶名旗标 --auto（官方 help："auto-approve permissions … (dangerous!)"）与 --share 一律不进默认。
 * 模型选择（-m）留给本机 profile/用户配置，不在模板中固定。
 */
export function buildOpenCodeLaunchArgs(prompt) {
  if (typeof prompt !== 'string' || !prompt.trim()) throw new TypeError('opencode 初始 prompt 必须是非空字符串');
  return ['run', '--format', 'json', prompt];
}
