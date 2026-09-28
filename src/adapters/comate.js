import { createEvent, sanitizePreview } from '../lib/events.js';

// 百度 Comate / Zulu（V12-A23）解析器骨架——状态 BLOCKED，local-api 未接线。
//
// 2026-09-25 的 MCP 快照只描述 Zulu→外部工具方向，不能据此解析为外部控制帧。
// 后续官方 @comate/comatecli 2.0.0 的 serve HTTP/SSE 在本机 Ask 模式已取证
// create/read/stop；但正式安全启动仍受 License argv 暴露、Agent 写文件审批旁路、
// bridge local-api 生命周期/取消接口未实现所阻。见 docs/release/v1.2/agents/comate.md。
//
// 设计立场（安全与正式接线未达标，故能力全关）：
//   - isComateStreamType 刻意恒 false——真实 local-api SSE 帧尚未实现映射，不伪造探测器；
//     若照抄 MCP JSON-RPC 形状做探测，会把「Zulu 调用别人的 MCP Server」误当成
//     「外部控制 Zulu」，语义倒置且有误路由风险，禁止；
//   - mapComateRaw 防御式兜底：仅当被显式调用时输出单个 custom 观察事件
//     （脱敏预览），绝不伪造 agent_message / tool_call / confirm_required / session_end；
//   - 能力全 false（catalog 声明与 capabilities.js 无行=generic fail-closed 一致）；
//     integrationMode='local-api' 只记录候选集成形态，不表示 bridge 已接入。
//   - agentType 固定 'generic'——AGENT_TYPES 白名单未扩（events.js:34），不擅改公共协议。

export function isComateStreamType(raw) {
  // V12-A23 BLOCKED：真实 local-api 帧尚未接线；旧 MCP JSON-RPC 是反向工具调用，
  // 恒 false 保证未知 JSON 不被打上 Comate 语义（fail-closed，不伪造）。
  void raw;
  return false;
}

export function mapComateRaw(raw, { sessionId, agentType = 'generic', sequencer }) {
  // 防御式观察兜底：null/非对象 → 空数组（不抛出）；对象 → 单个 custom 观察事件。
  // 该函数当前无生产接线点（探测恒 false），仅供测试与未来受控通道取证后复用。
  if (!raw || typeof raw !== 'object') return [];
  return [createEvent({
    sessionId, agentType, sequencer,
    eventType: 'custom',
    payload: {
      custom_type: 'comate_observe',
      fallback_text: 'Comate 未验证帧（无受控通路 BLOCKED，仅观察不解释）',
      data: { preview: sanitizePreview(raw, 500) },
    },
  })];
}
