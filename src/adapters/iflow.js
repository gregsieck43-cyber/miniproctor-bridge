import { createEvent, sanitizePreview } from '../lib/events.js';

// iFlow 心流 CLI（V12-A22）解析器骨架——状态 BLOCKED（稳定自动化协议未验证）。
//
// 官方资料事实（xcx/docs/官方资料/A22-iflow-cli-quickstart.md，快照 2026-09-25，来源
// https://docs.iflow.cn/cli/quickstart/）：快照只记载交互式 TUI 用法（`iflow` 启动会话、
// `/init`、`/help`、`!命令`、`/exit` 均为 CLI 内斜杠/前缀命令）与安装/登录方式
// （npm 包 @iflow-ai/iflow-cli、Node 22+、iFlow 账号或 API Key 登录）；
// 未记载任何 headless/非交互模式、输出帧格式、流式 JSON 协议或受控停止接口。
// 本机探测（2026-09-26）：`command -v iflow` / `iflow-cli` 均未安装，
// help/版本/生命周期实验无法进行——详见 docs/release/v1.2/agents/iflow.md。
//
// 设计立场（任务卡：「不用泛 CLI 日志包装充当全控制」）：
//   - isIflowStreamType 刻意恒 false——未核实任何官方帧格式，不伪造探测器；
//     猜测性探测分支（如照搬 gemini-cli 形状）有误路由其他 Agent 帧的风险，禁止；
//   - mapIflowRaw 防御式兜底：仅当被显式调用时输出单个 custom 观察事件
//     （脱敏预览），绝不伪造 agent_message / tool_call / confirm_required /
//     session_end——无法从无协议输出区分最终回复与中间噪声；
//   - 能力全 false（catalog 声明与 capabilities.js 无行=generic fail-closed 一致）；
//     create 在 AdapterFactory 双闸门被拒（openCapabilitiesFor('generic').create=false）。
//   - 协议取证后的接线路径：在 generic.js 增一行探测分支（契约 §3.6 唯一接线点），
//     catalog adapter_id 视帧形态再定，不预先宣称。
//
// agentType 固定 'generic'——AGENT_TYPES 白名单未扩（events.js:34），不擅改公共协议。

export function isIflowStreamType(raw) {
  // V12-A22 BLOCKED：官方未发布稳定自动化帧格式（快照仅 TUI 文档），不猜测帧形状。
  // 恒 false 保证：任何未知 JSON 都不会被打上 iFlow 语义（fail-closed，不伪造）。
  void raw;
  return false;
}

export function mapIflowRaw(raw, { sessionId, agentType = 'generic', sequencer }) {
  // 防御式观察兜底：null/非对象 → 空数组（不抛出）；对象 → 单个 custom 观察事件。
  // 该函数当前无生产接线点（探测恒 false），仅供测试与未来协议取证后复用。
  if (!raw || typeof raw !== 'object') return [];
  return [createEvent({
    sessionId, agentType, sequencer,
    eventType: 'custom',
    payload: {
      custom_type: 'iflow_observe',
      fallback_text: 'iFlow 未验证帧（协议 BLOCKED，仅观察不解释）',
      data: { preview: sanitizePreview(raw, 500) },
    },
  })];
}
