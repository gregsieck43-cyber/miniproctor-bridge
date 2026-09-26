import { AGENT_TYPES, createEvent, sanitizePreview } from '../lib/events.js';

// Amp 适配器（V12-A11，任务卡 §23.1 + 官方快照 xcx/docs/官方资料/A11-amp-cli-execute-mode.md）。
//
// 冻结模式：`amp -x "<prompt>"`（execute mode）——官方文档：该模式把 -x 的消息发给 agent、
// 等回合结束、打印最终消息、退出；stdout 为纯文本最终消息（官方示例即纯文本），无 JSON
// 事件流、无流式日志、无工具事件输出。非交互凭据经 AMP_API_KEY 环境变量（sgamp_ 前缀
// access token，本机 profile 引用，不由手机端下发——契约 §4）。
//
// 因此（generic 式文本产品，不伪造工具事件）：
//   - isAmpStreamType 恒 false：官方 execute 模式无 JSON 控制帧证据，不与其他产品的
//     JSON 分发抢帧（generic.js 对 amp 会话按 agentType 分流文本行）；
//   - mapAmpTextLine：单行文本 → agent_message（与 generic 非 JSON 行兜底同语义；
//     行级纯函数无跨行聚合状态，多行最终消息按行成事件，进程退出由 runner 终态承载）；
//   - mapAmpRaw：万一收到 JSON 行（版本漂移/异常），只落 custom 兜底，不伪造工具/审批帧。
//
// 能力口径（如实拆分，未实测一律 false；CLI 本机未安装，真实往返未取证——权威执行门禁
// 在 capabilities.js，本卡按简报不修改该文件，运行时 fail-closed 到 generic 底线）：
//   create/read/stop=true（execute 一次性任务拉起 + stdout 文本解析 + runner 进程树终止，
//   均待装机真实验证）；append=false（execute 无中途追加通道）；resume=false（未实测）；
//   approve=false（execute 无审批回写通道证据）；fileChanges=false（无文件变更输出证据）；
//   usage=false（无 token/费用统计输出证据，无统计不伪造 §8.3）。

function normalizeAgentType(agentType) {
  return AGENT_TYPES.includes(agentType) ? agentType : 'generic';
}

export function isAmpStreamType(raw) {
  // 官方 execute 模式无 JSON 事件流（A11 快照 2026-09-25）；恒 false，
  // 保持与契约 §3.2 的接口形态一致（对 null/非对象安全）。
  return false;
}

/** execute 模式纯文本行 → agent_message；空行/纯空白行不产生事件。 */
export function mapAmpTextLine(line, { sessionId, agentType, sequencer }) {
  const at = normalizeAgentType(agentType);
  const text = String(line ?? '').replace(/\r$/, '').trimEnd();
  if (!text.trim()) return [];
  return [createEvent({
    sessionId, agentType: at, sequencer,
    eventType: 'agent_message',
    payload: {
      message_id: `m_amp_${crypto.randomUUID()}`,
      role: 'assistant',
      content: text,
      content_type: 'text',
      is_final: true,
    },
  })];
}

/** JSON 行兜底：execute 模式官方无 JSON 事件流，未知对象一律 custom，不伪造语义。 */
export function mapAmpRaw(raw, { sessionId, agentType, sequencer }) {
  const at = normalizeAgentType(agentType);
  if (!raw || typeof raw !== 'object') return [];
  return [createEvent({
    sessionId, agentType: at, sequencer,
    eventType: 'custom',
    payload: {
      custom_type: 'amp_raw',
      fallback_text: sanitizePreview('Amp 未识别输出（execute 模式官方为纯文本）：未知 JSON 事件', 200),
      data: { type: typeof raw.type === 'string' ? raw.type : null },
    },
  })];
}

/**
 * 安全启动参数模板（launch-args 初始 prompt 通道；AdapterFactory launchArgsResolver 注入消费）。
 * execute 模式 = `amp -x "<prompt>"`；prompt 数组直传 spawn（契约 §4），无 shell 无拼接。
 * 不进默认：-ox（远程 orb，任务不在本机进程树内，stop 语义失效）、--executor（同因）、
 * --fast、--mcp-config（配置属本机 profile，不由模板固化）。
 * 非交互凭据 AMP_API_KEY 由本机 profile 环境引用，不经手机端下发。
 */
export function buildAmpLaunchArgs(prompt) {
  if (typeof prompt !== 'string' || !prompt.trim()) throw new TypeError('amp 初始 prompt 必须是非空字符串');
  return ['-x', prompt];
}
