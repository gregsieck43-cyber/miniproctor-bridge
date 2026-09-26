import crypto from 'node:crypto';
import { createEvent, sanitizePreview } from '../lib/events.js';

// Codex `exec --json` emits JSONL. Event shapes are version-sensitive; this
// adapter is defensive: every branch falls back to `custom` when unknown.
// Schema evidence（V1-005，2026-09-23 实测 codex-cli 0.155.1）：`codex exec --json
// "<positional prompt>"` 真实输出 thread.started / turn.started / item.completed / error
// 帧（两次实测取证，xcx/.tmp/v1-005-roundtrip/），与 isCodexStreamType 分支一致；
// 完整 agent_message 成功帧仍受本机到 chatgpt.com 网络阻塞（与 CLOSE-007 后遗留的
// V03 观察项同因），agent_message 映射保持单测覆盖。0.144.1 冻结线束见 CLOSE-007。
// V12-A02 增补实测（2026-09-26，xcx/.tmp/v12-exec/cli/codex/roundtrip-2-result.json）：
// 0.155.1 复测再次取到 thread.started → item.completed(error 诊断) → turn.started 后流静默，
// chatgpt.com 不可达时 CLI 既不发 turn.failed 也不发顶层 error（"最终事件缺失"实锤——
// 恢复只能靠 bridge 进程树停止，不能等 CLI 错误帧），本机网络恢复后需 V03 补成功往返。

export function isCodexStreamType(raw) {
  if (!raw || typeof raw !== 'object') return false;
  if (typeof raw.type !== 'string') return false;
  if (raw.type === 'event_msg' || raw.type === 'item' || raw.type === 'item.completed') return true;
  // P2-D（CLOSE-007）：顶层 error 帧（流错误 / Reconnecting 通知）必须进入 codex 映射，
  // 否则落入 generic 兜底显示「未知 JSON 事件」，且 fatal 流错误永远不会到达手机端。
  if (raw.type === 'error') return true;
  if (raw.type.startsWith('thread.') || raw.type.startsWith('turn.')) return true;
  return Boolean(raw.item && typeof raw.item === 'object');
}

export function mapCodexRaw(raw, { sessionId, agentType = 'codex', sequencer }) {
  if (!raw || typeof raw !== 'object') return [];
  const payload = raw.payload || {};
  const item = raw.item || payload.item || payload;
  const itemType = item.type || payload.type || raw.type;
  const events = [];

  if (itemType === 'agent_message' || itemType === 'assistant_message') {
    const message = item.message || item;
    const role = message.role || 'assistant';
    // V12-A02 加固：官方 noninteractive 文档示例的成功帧是扁平形态
    // {"type":"item.completed","item":{"id":"item_3","type":"agent_message","text":"…"}}
    // ——text 直接在 item 上，没有 message.content。旧实现只认 message.content（数组或字符串），
    // 对官方扁平形态一行都不产出（text 字段从未进入提取链）。现三形态并认：content 数组 /
    // content 字符串 / item 级 text（空数组等边缘形态不回退到伪造空事件）。
    const flatText = typeof message.text === 'string' ? message.text : null;
    const content = Array.isArray(message.content) && message.content.length
      ? message.content
      : typeof message.content === 'string'
        ? [{ type: 'output_text', text: message.content }]
        : (flatText !== null ? [{ type: 'output_text', text: flatText }] : []);
    for (const part of content) {
      if (!part || typeof part !== 'object') continue;
      const text = part.text || part.content || part.output_text;
      if (text) {
        events.push(createEvent({
          sessionId, agentType, sequencer,
          eventType: role === 'user' ? 'user_message' : 'agent_message',
          payload: {
            message_id: item.id || `m_${crypto.randomUUID()}`,
            stream_id: item.id || null,
            role,
            content: String(text),
            content_type: 'text',
            // V12-A02：官方成功帧经 item.completed 容器到达且不带 status 字段——item.completed
            // 即最终形态（turn.completed 随后收尾），补入 is_final 判定。
            is_final: Boolean(item.status === 'completed' || item.completed || raw.type === 'item.completed'),
          },
        }));
      }
    }
    return events;
  }

  if (itemType === 'user_message') {
    const message = item.message || item;
    // V12-A02：畸形帧隔离（契约 §3.3 不得抛出）——无 content 的 user_message 旧实现会因
    // sanitizePreview(undefined) 抛 TypeError，补缺省守卫。
    const text = typeof message.content === 'string' ? message.content : sanitizePreview(message.content ?? '');
    if (text) {
      events.push(createEvent({
        sessionId, agentType, sequencer,
        eventType: 'user_message',
        payload: { message_id: item.id || `m_${crypto.randomUUID()}`, role: 'user', content: text, content_type: 'text' },
      }));
    }
    return events;
  }

  if (itemType === 'command_execution' || itemType === 'local_shell_call') {
    events.push(createEvent({
      sessionId, agentType, sequencer,
      eventType: 'tool_call',
      payload: {
        tool_call_id: item.call_id || item.id || `tc_${crypto.randomUUID()}`,
        tool_name: item.name || 'Bash',
        input_preview: sanitizePreview(item.command || item.input || item.arguments || {}, 500),
        input_sensitive: false,
        status: item.status || 'running',
      },
    }));
    return events;
  }

  if (itemType === 'reasoning' || itemType === 'reasoning_text') {
    const text = item.text || item.summary || item.content;
    if (text) {
      events.push(createEvent({
        sessionId, agentType, sequencer,
        eventType: 'custom',
        payload: { custom_type: 'thinking', fallback_text: String(text).slice(0, 1000), data: { thinking: text } },
        metadata: { sensitive: true },
      }));
    }
    return events;
  }

  if (itemType === 'turn_status' || itemType === 'turn_delta') {
    events.push(createEvent({
      sessionId, agentType, sequencer,
      eventType: 'task_progress',
      payload: {
        task_id: item.turn_id || item.id || `task_${crypto.randomUUID()}`,
        title: 'Codex 执行中',
        current: numberOrZero(item.step) || numberOrZero(item.completed_steps),
        total: numberOrZero(item.total_steps),
        percent: clampPercent(item.percent),
      },
    }));
    return events;
  }

  if (raw.type === 'thread.started') {
    events.push(createEvent({
      sessionId, agentType, sequencer,
      eventType: 'custom',
      payload: { custom_type: 'system', system_subtype: 'thread_started', fallback_text: 'Codex 会话已启动', data: { thread_id: raw.thread_id || null } },
    }));
    return events;
  }

  if (raw.type === 'turn.started') {
    events.push(createEvent({
      sessionId, agentType, sequencer,
      eventType: 'task_progress',
      payload: { task_id: `turn_${crypto.randomUUID()}`, title: 'Codex 执行中', current: 0, total: null, percent: null },
    }));
    return events;
  }

  // P1-C（CLOSE-007）：item 容器（item.completed/item/event_msg）内的 {type:'error'}
  // 是【非致命诊断】——codex-cli 0.144.1 实测会在 turn 正常进行中发出「model metadata
  // 回退」「skills context budget 超限」等诊断帧，turn 继续执行。旧映射把它们当
  // fatal error 事件，手机端把诊断信息当致命错误展示。判定以 item 容器为准：
  // 顶层 {"type":"error"} 流错误不走这里（见下方 fatal 分支）。
  if ((raw.type === 'item.completed' || raw.type === 'item' || raw.type === 'event_msg')
    && item && item.type === 'error' && (raw.item || payload.item)) {
    const message = String(item.message || 'Codex 诊断信息');
    events.push(createEvent({
      sessionId, agentType, sequencer,
      eventType: 'custom',
      payload: {
        custom_type: 'diagnostic',
        fallback_text: `Codex 诊断：${message}`,
        data: { item_id: item.id || null, message },
      },
    }));
    return events;
  }

  // P2-D（CLOSE-007）：重连通知帧 {"type":"error","message":"Reconnecting... 1/5 (…)"}
  // ——顶层 error 形态但语义非致命（CLI 正在自动重试）。必须先于 fatal 分支拦截，
  // 否则手机端要么误报致命错误、要么显示「未知 JSON 事件」。
  const reconnectMatch = raw.type === 'error'
    ? /^Reconnecting\.{2,}\s*(\d+)\s*\/\s*(\d+)/.exec(String(raw.message || ''))
    : null;
  if (reconnectMatch) {
    events.push(createEvent({
      sessionId, agentType, sequencer,
      eventType: 'custom',
      payload: {
        custom_type: 'reconnecting',
        fallback_text: `Codex 网络波动，正在自动重连（${reconnectMatch[1]}/${reconnectMatch[2]}）`,
        data: { message: String(raw.message), attempt: Number(reconnectMatch[1]), total: Number(reconnectMatch[2]) },
      },
    }));
    return events;
  }

  // V12-A02 加固：turn.completed 是官方事件流的成功终帧（noninteractive 文档 JSONL 示例末行，
  // 携带 usage）。旧映射未覆盖——成功终态落入底部 codex_raw 兜底只显示"Codex 事件：turn.completed"，
  // 解析层永远等不到 session_end（只能靠进程退出 session_exit 收尾，丢失 turn 级结束语义）。
  // 按协议 §3.10 映射为 session_end(completed)。usage 暂不透传：codex 声明层 usage=false
  // （capabilities.js 冻结范围，本卡不得擅改），无统计不伪造（§8.3）；V03 回收时随声明层一并翻入。
  if (raw.type === 'turn.completed') {
    events.push(createEvent({
      sessionId, agentType, sequencer,
      eventType: 'session_end',
      payload: {
        reason: 'completed',
        summary: sanitizePreview(item.summary || item.result || raw.result || 'Codex 回合完成', 1000),
        usage: {},
      },
    }));
    return events;
  }

  // 顶层流错误 / turn.failed 收尾：致命语义保留（会话失败或结束）。
  // V12-A02 加固：session_end 协议 payload 为 {reason, summary, usage}（§3.10）——旧 turn.failed
  // 分支发的是 error 事件字段（error_code/severity/message/recoverable），手机端 session_end 渲染
  // 拿不到 reason/summary。现补齐协议字段；error_code/severity/message/recoverable 为旧字段，
  // close007 回归钉定（payload.severity === 'fatal'），保留兼容、不弱化旧断言。
  if (raw.type === 'turn.failed' || raw.type === 'error') {
    const message = raw.message || raw.error?.message || item?.message || 'Codex 错误';
    const safeMessage = String(message).slice(0, 1000);
    if (raw.type === 'turn.failed') {
      events.push(createEvent({
        sessionId, agentType, sequencer,
        eventType: 'session_end',
        payload: {
          reason: 'error',
          summary: safeMessage,
          usage: {},
          error_code: 'CODEX_TURN_FAILED',
          severity: 'fatal',
          message: safeMessage,
          recoverable: false,
        },
      }));
    } else {
      events.push(createEvent({
        sessionId, agentType, sequencer,
        eventType: 'error',
        payload: {
          error_code: 'CODEX_TURN_FAILED',
          severity: 'fatal',
          message: safeMessage,
          recoverable: false,
        },
      }));
    }
    return events;
  }

  if (raw.type === 'result' || itemType === 'turn_complete' || itemType === 'session_end') {
    events.push(createEvent({
      sessionId, agentType, sequencer,
      eventType: 'session_end',
      payload: {
        reason: raw.subtype === 'error' || item.status === 'error' ? 'error' : 'completed',
        summary: sanitizePreview(item.result || raw.result || item.summary || '会话结束', 1000),
        usage: {},
      },
    }));
    return events;
  }

  events.push(createEvent({
    sessionId, agentType, sequencer,
    eventType: 'custom',
    payload: {
      custom_type: 'codex_raw',
      fallback_text: `Codex 事件：${itemType}`,
      data: { type: itemType, id: item.id || raw.id || null },
    },
  }));
  return events;
}

function numberOrZero(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function clampPercent(value) {
  const n = numberOrZero(value);
  if (n <= 0) return null;
  return Math.min(100, Math.max(0, Math.round(n)));
}
