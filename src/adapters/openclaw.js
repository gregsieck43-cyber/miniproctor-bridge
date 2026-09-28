import crypto from 'node:crypto';
import { createEvent, sanitizePreview, sanitizeSensitiveText } from '../lib/events.js';

/** 2026.9.6 的 --json 实际是多行 pretty JSON；只在 stdout 管道关闭后交给信封解析器。 */
export class OpenclawOutputAccumulator {
  constructor({ maxBytes = 1024 * 1024 } = {}) {
    this.maxBytes = maxBytes;
    this.lines = [];
    this.bytes = 0;
    this.truncated = false;
  }

  consume(line) {
    if (this.truncated) return;
    const next = String(line) + '\n';
    const bytes = Buffer.byteLength(next, 'utf8');
    if (this.bytes + bytes > this.maxBytes) {
      this.truncated = true;
      this.lines = [];
      return;
    }
    this.lines.push(next);
    this.bytes += bytes;
  }

  finish({ stopped = false } = {}) {
    if (stopped || this.truncated || this.lines.length === 0) return null;
    try {
      const raw = JSON.parse(this.lines.join(''));
      return isOpenclawStreamType(raw) ? JSON.stringify(raw) : null;
    } catch {
      return null;
    }
  }
}

// OpenClaw（V12-A27）解析器——纯函数零 IO，只做帧翻译（adapter-contract.md §3）。
//
// 官方资料：xcx/docs/官方资料/A27-openclaw-cli-agent.md（docs.openclaw.ai/cli/agent，快照 2026-09-25）。
// 受控本地任务通路（合规形态）：`openclaw agent exec --json "<任务>"`——
//   - agent exec 不连接 Gateway、一次性嵌入执行（官方推荐 CI/coding automation 入口）；
//   - --json 在 stdout 输出稳定 JSON 信封：
//     { ok, status ∈ ok|error|timeout, final, payloads[{text}], usage{input,output,total},
//       toolSummary{calls,tools,totalToolTimeMs}, model, provider, sessionId,
//       error{message,kind}|error{type}, runId?, origin? }
//   - 成功 exit 0、错误 exit 1、超时 exit 2；SIGINT/SIGTERM 保留信号退出状态。
//
// 投递与停止边界（V12-A27 任务卡）：
//   - 外部消息投递（--deliver/--reply-channel/--reply-to 等）只存在于 gateway 模式 `openclaw agent`
//     命令——本适配器不使用、也不映射任何投递语义，本地任务输出默认只进 stdout 由 bridge 解析；
//   - 停止由 runner 只终止本次 spawn 的进程树（contract §4），绝不调用 `openclaw gateway stop`
//     （那会关闭其他 gateway 会话），也不终止用户独立启动的 OpenClaw 进程。
//
// 不伪造（§5.2/§8.3）：toolSummary 是聚合计数（调用次数/工具名列表），不据此编造 tool_call 事件；
// costUsd 不映射（无人民币成本口径不伪造）；usage 按官方 {input,output,total} 如实映射为
// session_end.usage {input_tokens,output_tokens}（协议 §3.10 形状）。

export function isOpenclawStreamType(raw) {
  // agent exec --json 稳定信封的判别：布尔 ok + (status|error|final|payloads) 之一。
  // claude-code / codex 帧顶层是 type 字段、无布尔 ok，不会命中本探测。
  return Boolean(
    raw && typeof raw === 'object'
    && typeof raw.ok === 'boolean'
    && (typeof raw.status === 'string'
      || raw.error !== undefined
      || typeof raw.final === 'string'
      || Array.isArray(raw.payloads)),
  );
}

export function mapOpenclawRaw(raw, { sessionId, agentType = 'generic', sequencer }) {
  if (!isOpenclawStreamType(raw)) return [];

  // 失败/超时信封（ok:false，或防御性处理 ok:true 但 status 异常）→ fatal error 事件：
  // 会话进入 failed 终态（协议 §430 状态机 error(fatal) → failed），进程退出证据由
  // runner 以 session_exit 回流（contract §4），适配器不伪造成功终态。
  if (raw.ok !== true || raw.status === 'error' || raw.status === 'timeout') {
    const isTimeout = raw.status === 'timeout';
    const err = raw.error && typeof raw.error === 'object' ? raw.error : {};
    const message = typeof err.message === 'string' && err.message ? err.message : (isTimeout ? 'OpenClaw 运行超时' : 'OpenClaw 运行失败');
    const code = isTimeout
      ? 'OPENCLAW_TIMEOUT'
      : (typeof err.kind === 'string' && err.kind
        ? `OPENCLAW_${err.kind.toUpperCase()}`
        : (typeof err.type === 'string' && err.type ? err.type.toUpperCase() : 'OPENCLAW_ERROR'));
    return [createEvent({
      sessionId, agentType, sequencer,
      eventType: 'error',
      payload: {
        error_code: code,
        severity: 'fatal',
        message: sanitizeSensitiveText(String(message)).slice(0, 1000),
        recoverable: false,
      },
      metadata: {
        // gateway 归属信息（origin/runId）只作诊断透传，不代表本进程控制 gateway 会话。
        openclaw_status: typeof raw.status === 'string' ? raw.status : null,
        openclaw_run_id: typeof raw.runId === 'string' ? raw.runId.slice(0, 128) : null,
        openclaw_origin: typeof raw.origin === 'string' ? raw.origin : null,
      },
    })];
  }

  // 成功信封 → 最终回复 agent_message(is_final) + session_end(completed)。
  const finalText = extractFinal(raw);
  const events = [];
  if (finalText) {
    events.push(createEvent({
      sessionId, agentType, sequencer,
      eventType: 'agent_message',
      payload: {
        message_id: `m_${crypto.randomUUID()}`,
        stream_id: firstString(raw.sessionId),
        role: 'assistant',
        content: finalText,
        content_type: 'text',
        is_final: true,
      },
    }));
  }
  events.push(createEvent({
    sessionId, agentType, sequencer,
    eventType: 'session_end',
    payload: {
      reason: 'completed',
      summary: sanitizePreview(finalText || 'OpenClaw 运行完成', 1000),
      usage: usageFromEnvelope(raw.usage),
    },
  }));
  return events;
}

/** 最终文本：官方 `final` 字段优先，缺失时合并 payloads[].text（两者均为官方记载字段）。 */
function extractFinal(raw) {
  if (typeof raw.final === 'string' && raw.final) return raw.final;
  if (Array.isArray(raw.payloads)) {
    const parts = raw.payloads
      .map((p) => (p && typeof p === 'object' && typeof p.text === 'string' ? p.text : null))
      .filter(Boolean);
    if (parts.length) return parts.join('\n');
  }
  return null;
}

/** 官方 usage {input,output,total} → 协议 session_end.usage {input_tokens,output_tokens}；无统计不伪造。 */
function usageFromEnvelope(usage) {
  if (!usage || typeof usage !== 'object') return {};
  const input = Number(usage.input);
  const output = Number(usage.output);
  const out = {};
  if (Number.isFinite(input)) out.input_tokens = input;
  if (Number.isFinite(output)) out.output_tokens = output;
  return out;
}

function firstString(...values) {
  for (const v of values) {
    if (typeof v === 'string' && v) return v;
  }
  return null;
}
