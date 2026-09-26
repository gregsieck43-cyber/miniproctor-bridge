import { createEvent, sanitizePreview } from '../lib/events.js';

// 百度 Comate / Zulu（V12-A23）解析器骨架——状态 BLOCKED 待产品决策（MCP 客户端≠外部可控制）。
//
// 官方资料事实（xcx/docs/官方资料/A23-comate-zulu-mcp.md，快照 2026-09-25，来源
// https://comate.baidu.com/docs/IDE功能/MCP/）：Zulu 是 IDE 内置 Agent，作为 **MCP 客户端**
// 消费用户配置的 MCP Server（.comate/mcp.json，stdio/SSE/Streamable HTTP 三种传输）；
// 工具调用由模型自主决策并在 IDE 内弹窗请求用户批准。该文档描述的是「Zulu 能调用工具」，
// 不是「外部程序能新建/读取/停止 Zulu 会话」——方向恰好相反（§6 A23：MCP 客户端能调用
// 工具不证明外部可控制 IDE）。快照未记载任何 headless CLI、外部事件流或取消接口。
// 本机探测（2026-09-26）：`command -v comate` / `comate-cli` / `zulu` 均未安装，
// 无 CLI 往返可取证——详见 docs/release/v1.2/agents/comate.md。
//
// 设计立场（任务卡：「无受控 create/read/stop 通路→BLOCKED 待产品决策」）：
//   - isComateStreamType 刻意恒 false——无官方外部帧格式，不伪造探测器；
//     若照抄 MCP JSON-RPC 形状做探测，会把「Zulu 调用别人的 MCP Server」误当成
//     「外部控制 Zulu」，语义倒置且有误路由风险，禁止；
//   - mapComateRaw 防御式兜底：仅当被显式调用时输出单个 custom 观察事件
//     （脱敏预览），绝不伪造 agent_message / tool_call / confirm_required / session_end；
//   - 能力全 false（catalog 声明与 capabilities.js 无行=generic fail-closed 一致）；
//     integrationMode='manual-report'（当前唯一 conceivable 通道是人工回报，
//     同样未实现、未验证——证据卡如实记载待产品决策）。
//   - agentType 固定 'generic'——AGENT_TYPES 白名单未扩（events.js:34），不擅改公共协议。

export function isComateStreamType(raw) {
  // V12-A23 BLOCKED：官方无外部受控帧格式（Zulu 是 MCP 客户端而非 MCP 服务端），
  // 不猜测帧形状；恒 false 保证未知 JSON 不被打上 Comate 语义（fail-closed，不伪造）。
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
