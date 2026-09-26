import { createEvent } from '../lib/events.js';

// GitHub Copilot CLI（copilot）程序化模式适配器（V12-A06）。
//
// 官方依据（D 级，快照 xcx/docs/官方资料/A06-copilot-cli-about.md，2026-09-25 抓取；
// 2026-09-26 联网核对 docs.github.com 参考页索引，未发现输出格式记载）：
//   - 程序化模式：`copilot -p "<prompt>"` 单次执行后退出（launch-args 初始 prompt）；
//   - 工具授权：--allow-tool / --deny-tool / --allow-all-tools 旗标按本机策略传入；
//     **bridge 侧默认绝不添加 --allow-all-tools**（快照 Security considerations：等同
//     用户本机全部权限；任务卡 A06「不继承全工具放行」）；
//   - 输出：官方快照与参考页**均未记载任何机器可读帧结构**（无 --output-format、
//     无 JSON schema）。审批为交互式提示（非 headless 通道）。
//
// 设计边界（fail-closed，契约 §3.3 / §5.2）：
//   - isCopilotCliStreamType 对一切帧返回 false：无官方帧结构可依据，猜测形状会吞并
//     其他产品的帧（同 adapter_id=generic 的并行产品）或编造接口；
//   - 会话输出按 generic 分发兜底：文本行 → agent_message；JSON 行 → custom 未知事件；
//   - 权限拒绝/账号过期/未购买能力等以文本与退出码呈现（无官方拒绝帧）——由 runner
//     session_exit（exit code + 脱敏 stderr 尾部）承载，适配器不猜测、不伪造审批请求；
//   - 不生成无法送回 CLI 的审批卡：无双向审批协议记载，approve 声明 false；
//   - mapCopilotCliRaw 仅作防御性兜底（直接调用时可用），不主动改写任何语义。

export function isCopilotCliStreamType(raw) {
  // 官方未记载任何机器可读帧结构——fail-closed：不认领任何帧（V12-A06 证据卡）。
  // 若后续官方记载 JSON 输出（或 V03 真实 CLI 取证），在此按官方形状扩入并补 fixture。
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
