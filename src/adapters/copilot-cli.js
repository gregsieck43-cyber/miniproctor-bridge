import crypto from 'node:crypto';
import { createEvent, sanitizeSensitiveText } from '../lib/events.js';

// GitHub Copilot CLI（copilot）程序化模式适配器（V12-A06）。
//
// 历史依据（D 级，快照 xcx/docs/官方资料/A06-copilot-cli-about.md，2026-09-25 抓取；
// 2026-09-28 的新版 JSONL/BYOK 资料与真实取证见 A06b 和本文件下方产品绑定解析）：
//   - 程序化模式：`copilot -p "<prompt>"` 单次执行后退出（launch-args 初始 prompt）；
//   - 工具授权：--allow-tool / --deny-tool / --allow-all-tools 旗标按本机策略传入；
//     **bridge 侧默认绝不添加 --allow-all-tools**（快照 Security considerations：等同
//     用户本机全部权限；任务卡 A06「不继承全工具放行」）；
//   - 旧快照没有机器可读帧结构；新版 1.0.88 支持 --output-format=json（JSONL）。
//     审批回写仍无 bridge 已验证通道。
//
// 设计边界（fail-closed，契约 §3.3 / §5.2）：
//   - 无产品身份的 isCopilotCliStreamType 仍返回 false，避免同形 JSONL 吞并其他产品；
//     已冻结产品身份的 profile 用下方 1.0.88 专属解析。
//   - 会话输出按 generic 分发兜底：文本行 → agent_message；JSON 行 → custom 未知事件；
//   - 权限拒绝/账号过期/未购买能力等以文本与退出码呈现（无官方拒绝帧）——由 runner
//     session_exit（exit code + 脱敏 stderr 尾部）承载，适配器不猜测、不伪造审批请求；
//   - 不生成无法送回 CLI 的审批卡：无双向审批协议记载，approve 声明 false；
//   - mapCopilotCliRaw 仅作防御性兜底（直接调用时可用），不主动改写任何语义。

export function isCopilotCliStreamType(raw) {
  // 无产品身份的 generic 会话不能按 Copilot 的同形 JSONL 猜测归属；只在绑定 profile 认领。
  void raw;
  return false;
}

export function mapCopilotCliRaw(raw, { sessionId, agentType = 'generic', sequencer }) {
  if (!raw || typeof raw !== 'object') return [];
  // 防御性兜底：一切帧按未识别处理，保留可观测性，不猜测语义、不产生终态/审批事件。
  return [createEvent({
    sessionId, agentType, sequencer,
    eventType: 'custom',
    payload: {
      custom_type: 'copilot_raw',
      fallback_text: 'Copilot CLI 输出（官方未记载帧结构，未解析）',
      data: { type: typeof raw.type === 'string' ? raw.type : null },
    },
  })];
}

// 2026-09-28：1.0.88 的 --output-format=json 经真实 BYOK 往返确认为 JSONL。
// 仅绑定 agent_key=copilot-cli 的 profile 使用；旧无产品身份的 generic 探测仍保持空集。
const PROFILE_META_TYPES = new Set([
  'session.skills_loaded', 'session.info', 'session.mcp_servers_loaded', 'session.tools_updated',
  'user.message', 'assistant.turn_start', 'assistant.turn_end', 'assistant.idle',
  'assistant.message_start', 'assistant.message_delta', 'model.call_start', 'model.call_finished',
]);

export function isCopilotCliProfileOutput(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || typeof raw.type !== 'string') return false;
  if (raw.type === 'assistant.message') {
    return raw.data && typeof raw.data === 'object'
      && (typeof raw.data.content === 'string' || Array.isArray(raw.data.toolRequests));
  }
  if (raw.type === 'result') return Number.isInteger(raw.exitCode) && typeof raw.sessionId === 'string';
  return PROFILE_META_TYPES.has(raw.type) && raw.data && typeof raw.data === 'object';
}

export function mapCopilotCliProfileOutput(raw, { sessionId, agentType = 'generic', sequencer }) {
  if (!isCopilotCliProfileOutput(raw)) return [];
  if (raw.type === 'assistant.message') {
    // 工具请求前的说明不是完成答复；增量帧也不重复上行。
    if (Array.isArray(raw.data.toolRequests) && raw.data.toolRequests.length > 0) return [];
    const content = typeof raw.data.content === 'string' ? raw.data.content : '';
    if (!content) return [];
    return [createEvent({
      sessionId, agentType, sequencer, eventType: 'agent_message',
      payload: {
        message_id: typeof raw.data.messageId === 'string' && raw.data.messageId
          ? raw.data.messageId.slice(0, 128) : `m_${crypto.randomUUID()}`,
        stream_id: typeof raw.data.interactionId === 'string' ? raw.data.interactionId.slice(0, 128) : null,
        role: 'assistant', content: sanitizeSensitiveText(content), content_type: 'text', is_final: true,
      },
    })];
  }
  if (raw.type === 'result') {
    return [createEvent({
      sessionId, agentType, sequencer, eventType: 'session_end',
      payload: {
        reason: raw.exitCode === 0 ? 'completed' : 'failed',
        summary: raw.exitCode === 0 ? 'Copilot CLI 单次任务完成' : 'Copilot CLI 单次任务失败',
        usage: {}, // 1.0.88 result.usage 未提供 token 数；不能把 premiumRequests 冒充 token。
      },
    })];
  }
  return [];
}
