import { AGENT_TYPES, createEvent, sanitizePreview } from '../lib/events.js';

// Kiro CLI（V12-A13）headless 适配器。
//
// 官方资料事实（xcx/docs/官方资料/A13-kiro-cli-headless.md，快照 2026-09-25，来源
// https://kiro.dev/docs/cli/headless/，页面更新 2026-06-04）：
//   - 调用形态：`kiro-cli chat --no-interactive "<prompt>"`，认证依赖 KIRO_API_KEY 环境变量；
//     「You must provide an initial prompt as an argument」→ 初始 prompt 通道 launch-args；
//   - 追加输入：Limitations 明确「No mid-session user input is possible」→ append 官方不支持；
//   - 工具放行：--trust-all-tools / --trust-tools=<categories> 是【预先放行】而非双向审批
//     通道，headless 下无用户批准交互 → approve=false；桥接默认绝不追加 --trust-all-tools
//     （主方案 §6 A13「不以 trust-all-tools 替代权限设计」），最小放行由用户在 profile
//     显式指定 --trust-tools=<只读类别>；
//   - 输出：快照只记载文本输出（stdout/stderr），未记载任何结构化 / NDJSON / JSON 帧
//     格式——「NDJSON 流式系」三产品中 Kiro 无结构化协议证据。
//
// 设计立场（generic 式文本产品，不伪造工具事件；与 V12-A11/A12 amp/auggie 同模式）：
//   - isKiroCliStreamType 刻意恒 false：官方无结构化帧声明，猜测性探测（如照搬其他产品
//     帧形状）有误路由其他 Agent 帧的风险，禁止；
//   - mapKiroCliTextLine：单行文本 → agent_message（与 generic 非 JSON 行兜底同语义），
//     供 generic.js 对 kiro-cli 会话按 agentType 分流文本行，防未来 JSON 帧探测器抢帧；
//   - mapKiroCliRaw：仅当被显式调用（JSON 对象行落到 kiro 分支）时输出单个 custom 观察
//     事件（脱敏预览），绝不伪造 tool_call / confirm_required / session_end；
//   - agentType 经 normalizeAgentType 归一——AGENT_TYPES 白名单未扩（events.js:34 /
//     protocol/schema.cjs:130 禁改），事件信封取 'generic'，会话身份由 session_meta
//     agent_key 承载；
//   - 能力声明全部 false（真实 CLI 往返未取证；权威执行门禁在 capabilities.js——本卡按
//     简报不修改该文件，AdapterFactory 现阶段 fail-closed 拒绝实例化）。
//
// 甄别记录（2026-09-26 本机探测）：`command -v kiro-cli` 未安装；`command -v kiro` 命中的
// D:\kiro\Kiro\bin\kiro 为 Kiro IDE 0.12.292（`kiro --version` 输出 0.12.292 / commit
// 2177f9488d81a2eb61c2578fe95045b7fa8cc850 / x64；安装目录为 Electron 应用结构），不是
// Kiro CLI，两者不能混用——catalog 已移除 "kiro" 别名防误识别，详见
// docs/release/v1.2/agents/kiro-cli.md。若未来取证到 Kiro CLI 结构化帧，接线路径为
// generic.js 增一行 JSON 帧探测分支（契约 §3 唯一接线点），不预先宣称。

/** 事件信封 agent_type 只允许协议白名单值；未知回落 'generic'（会话身份由 agent_key 承载）。 */
function normalizeAgentType(agentType) {
  return AGENT_TYPES.includes(agentType) ? agentType : 'generic';
}

export function isKiroCliStreamType(raw) {
  // V12-A13 fixture-only：官方快照无结构化帧格式（仅文本输出），不猜测帧形状。
  // 恒 false 保证：任何未知 JSON 都不会被打上 Kiro CLI 语义（fail-closed，不伪造）。
  void raw;
  return false;
}

export function mapKiroCliTextLine(line, { sessionId, agentType, sequencer }) {
  // 单行文本 → agent_message（kiro-cli 会话的文本输出主路径；is_final 与 generic 文本
  // 兜底同语义取 true——每行即一条可见输出，单发模式无中途追加）。
  const at = normalizeAgentType(agentType);
  return [createEvent({
    sessionId, agentType: at, sequencer,
    eventType: 'agent_message',
    payload: {
      message_id: `m_line_${sequencer.next()}`,
      role: 'assistant',
      content: line,
      content_type: 'text',
      is_final: true,
    },
  })];
}

export function mapKiroCliRaw(raw, { sessionId, agentType, sequencer }) {
  // JSON 对象行落到 kiro 分支时的观察兜底：官方未记载 JSON 帧，只观察不解释（不伪造语义）。
  const at = normalizeAgentType(agentType);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
  return [createEvent({
    sessionId, agentType: at, sequencer,
    eventType: 'custom',
    payload: {
      custom_type: 'kiro_cli_observe',
      fallback_text: 'Kiro CLI 未验证帧（官方仅记载文本输出，仅观察不解释）',
      data: { preview: sanitizePreview(raw, 500) },
    },
  })];
}
