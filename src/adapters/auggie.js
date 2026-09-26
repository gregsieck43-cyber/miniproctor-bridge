import { AGENT_TYPES, createEvent, sanitizePreview } from '../lib/events.js';

// Auggie 适配器（V12-A12，任务卡 §23.1 + 官方快照 xcx/docs/官方资料/A12-auggie-readme.md）。
//
// 冻结模式：`auggie --print "<instruction>"`（print 模式）——官方 README：--print「run once
// and print to stdout (great for CI)」，可叠加 --quiet 只返回最终输出；需 `auggie login`
// 本机认证（凭据留本机，不经手机端——A12 卡「账号/索引授权保留在本机」）。
// 官方 README 未提供 JSON 事件流、审批回写或会话恢复的 CLI 通道；ACP 存在差异且本机未装
// CLI 无法比较取证（A12 卡「比较 print 与 ACP 的真实能力并固定模式」），故冻结 print 模式
// 并如实按文本产品实现。
//
// 因此（generic 式文本产品，不伪造工具事件）：
//   - isAuggieStreamType 恒 false：官方 print 模式无 JSON 控制帧证据，不与其他产品的
//     JSON 分发抢帧（generic.js 对 auggie 会话按 agentType 分流文本行）；
//   - mapAuggieTextLine：单行文本 → agent_message（行级纯函数无跨行聚合状态，
//     进程退出由 runner 终态承载）；
//   - mapAuggieRaw：万一收到 JSON 行（版本漂移/异常），只落 custom 兜底，不伪造工具/审批帧。
//
// 能力口径（如实拆分，未实测一律 false；CLI 本机未安装，真实往返未取证——权威执行门禁
// 在 capabilities.js，本卡按简报不修改该文件，运行时 fail-closed 到 generic 底线）：
//   create/read/stop=true（print 一次性任务拉起 + stdout 文本解析 + runner 进程树终止，
//   均待装机真实验证）；append=false（print 单次运行无中途追加）；resume=false（未实测）；
//   approve=false（无审批回写通道证据）；fileChanges=false（print 无文件变更输出证据）；
//   usage=false（无 token 统计输出证据，无统计不伪造 §8.3）。

function normalizeAgentType(agentType) {
  return AGENT_TYPES.includes(agentType) ? agentType : 'generic';
}

export function isAuggieStreamType(raw) {
  // 官方 print 模式无 JSON 事件流（A12 快照 2026-09-25）；恒 false，
  // 保持与契约 §3.2 的接口形态一致（对 null/非对象安全）。
  return false;
}

/** print 模式纯文本行 → agent_message；空行/纯空白行不产生事件。 */
export function mapAuggieTextLine(line, { sessionId, agentType, sequencer }) {
  const at = normalizeAgentType(agentType);
  const text = String(line ?? '').replace(/\r$/, '').trimEnd();
  if (!text.trim()) return [];
  return [createEvent({
    sessionId, agentType: at, sequencer,
    eventType: 'agent_message',
    payload: {
      message_id: `m_auggie_${crypto.randomUUID()}`,
      role: 'assistant',
      content: text,
      content_type: 'text',
      is_final: true,
    },
  })];
}

/** JSON 行兜底：print 模式官方无 JSON 事件流，未知对象一律 custom，不伪造语义。 */
export function mapAuggieRaw(raw, { sessionId, agentType, sequencer }) {
  const at = normalizeAgentType(agentType);
  if (!raw || typeof raw !== 'object') return [];
  return [createEvent({
    sessionId, agentType: at, sequencer,
    eventType: 'custom',
    payload: {
      custom_type: 'auggie_raw',
      fallback_text: sanitizePreview('Auggie 未识别输出（print 模式官方为纯文本）：未知 JSON 事件', 200),
      data: { type: typeof raw.type === 'string' ? raw.type : null },
    },
  })];
}

/**
 * 安全启动参数模板（launch-args 初始 prompt 通道；AdapterFactory launchArgsResolver 注入消费）。
 * print 模式 = `auggie --print "<instruction>"`；prompt 数组直传 spawn（契约 §4），无 shell 无拼接。
 * 不进默认：--quiet（输出粒度未实测，不预设）、任何自动同意类旗标（官方 README 无此旗标，
 * 不编造）。登录（auggie login）与索引授权均在本机完成，不经手机端。
 */
export function buildAuggieLaunchArgs(prompt) {
  if (typeof prompt !== 'string' || !prompt.trim()) throw new TypeError('auggie 初始 prompt 必须是非空字符串');
  return ['--print', prompt];
}
