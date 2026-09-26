import { createEvent } from '../lib/events.js';

// Cline CLI（V12-A07）NDJSON 流适配器。
//
// 官方资料事实（xcx/docs/官方资料/A07-cline-cli-readme.md，快照 2026-09-25，来源
// https://github.com/cline/cline/blob/main/apps/cli/README.md）：
//   - 结构化输出通道：`cline --json "<prompt>"` 输出 NDJSON（「--json | Output NDJSON instead
//     of styled text」；「--json is non-interactive and requires either a prompt argument or
//     piped stdin」）→ 初始 prompt 通道为 launch-args（位置参数）；
//   - 文档化的帧形状证据只有一处（「Headless mode for CI/CD」jq 示例）：
//       cline --json "..." | jq -r 'select(.type == "agent_event" and .event.text) | .event.text'
//     即顶层 {type:"agent_event", event:{...}} 且 event.text 为文本——其余事件子结构
//     （工具调用、审批请求、token 统计、终帧标记）快照均未记载；
//   - 审批：`--auto-approve false` 要求逐工具确认，但「If stdin/stdout is not a TTY,
//     required-approval calls are denied in terminal mode」——非交互流中没有可回写的
//     NDJSON 审批通道（desktop file-IPC 通道 CLINE_TOOL_APPROVAL_MODE=desktop 未取证），
//     → approve=false，且不会挂无限等待；
//   - 追加/恢复：--json 为单发模式，快照无中途追加输入与恢复会话的通道 → append/resume=false。
//
// 设计立场：
//   - 只映射文档化的 agent_event/event.text → agent_message；其余一律 custom 兜底，
//     绝不伪造 tool_call / confirm_required / session_end / file_change / usage；
//   - is_final 恒 false：快照无终帧标记，单发模式终态由进程退出（runner 的 session_exit）
//     承载，不猜测哪条文本是"最终回复"；
//   - agentType 固定 'generic'——AGENT_TYPES 白名单未扩（events.js:34 / protocol/schema.cjs:130
//     禁改），会话身份由 session_meta agent_key 承载；
//   - 桥接默认参数（profile 冻结侧，非本文件职责）：--json --auto-approve false；
//     绝不默认 --yolo / --auto-approve true（主方案 §6：不照抄官方示例的全权限参数）。
// 真实 CLI 往返未取证（2026-09-26 本机 command -v cline 未安装）——fixture-only，
// 详见 docs/release/v1.2/agents/cline.md。

export function isClineStreamType(raw) {
  // 帧形状探测：{type:'agent_event', event:{...}}（官方 jq 示例形状）。对 null/数组/非对象安全。
  return Boolean(
    raw && typeof raw === 'object' && !Array.isArray(raw)
      && raw.type === 'agent_event'
      && raw.event && typeof raw.event === 'object' && !Array.isArray(raw.event),
  );
}

export function mapClineRaw(raw, { sessionId, agentType = 'generic', sequencer }) {
  if (!isClineStreamType(raw)) return [];
  const event = raw.event;
  const events = [];
  if (typeof event.text === 'string' && event.text) {
    // 文档化映射：event.text → agent_message（jq 示例即按此取最终回复文本）。
    const id = typeof event.id === 'string' && event.id ? event.id : null;
    events.push(createEvent({
      sessionId, agentType, sequencer,
      eventType: 'agent_message',
      payload: {
        message_id: id || `m_${crypto.randomUUID()}`,
        stream_id: id,
        role: 'assistant',
        content: event.text,
        content_type: 'text',
        is_final: false,
        stop_reason: null,
      },
    }));
    return events;
  }
  // 未记载的 event 子结构（工具/审批/统计等假设帧）：custom 观察兜底，只带类型名与键名清单，
  // 不透传内容（敏感字段隔离），不伪造结构化语义。
  const eventType = typeof event.type === 'string' && event.type ? event.type : 'agent_event';
  events.push(createEvent({
    sessionId, agentType, sequencer,
    eventType: 'custom',
    payload: {
      custom_type: 'cline_raw',
      fallback_text: `Cline 事件（未识别结构，官方快照未记载该子结构）：${eventType}`,
      data: {
        event_type: eventType,
        keys: Object.keys(event).slice(0, 10),
      },
    },
  }));
  return events;
}
