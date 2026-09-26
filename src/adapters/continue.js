import { createEvent } from '../lib/events.js';

// Continue CLI（cn）headless 模式适配器（V12-A08）。
//
// 官方依据（D 级，快照 xcx/docs/官方资料/A08-continue-cli-headless-mode.md，2026-09-25
// 抓取；2026-09-26 联网核对 docs.continue.dev/cli/headless-mode，与快照一致）：
//   - headless：`cn -p "<prompt>"` 单任务执行后把响应打印到 stdout（launch-args 初始 prompt）；
//   - `--format json`：官方仅记载「Output structured JSON」，**未记载 JSON schema**；
//   - `--silent`：剥离 <think> 标签与多余空白——即缺省输出可能含 <think> 正文；
//   - 工具权限：headless 下需要交互批准（ask 权限）的工具**自动排除**——"there's no one
//     to approve them"；写操作须显式 --allow（如 --allow Write）。bridge 侧默认不添加
//     任何 --allow（按本机策略/用户显式配置），绝不使用 --allow "*"（等同全放行）；
//   - `cn -p --resume`：官方支持 headless 恢复上一会话（replay 历史）。
//
// 设计边界（fail-closed，契约 §3.3 / §5.2 / 任务卡 A08）：
//   - isContinueStreamType 对一切帧返回 false：--format json 的结构无官方 schema，
//     猜测形状会吞并行内其他 generic 产品的帧或编造接口；
//   - 缺省文本输出按 generic 分发兜底 → agent_message；JSON 行按 generic 兜底展示——
//     print 产品的输出即最终答案原文，不做二次"解析"伪装；
//   - headless 权限不足/工具被拒以文本与退出码呈现（无官方拒绝帧）——由 runner
//     session_exit（exit code + 脱敏 stderr 尾部）承载，**显示实际拒绝而非挂起等待**；
//   - 绝不生成审批卡：headless 无审批回传通道（ask 工具直接被排除），approve=false；
//     本适配器从不产生 confirm_required 事件（结构上满足任务卡「不得生成无法送回
//     CLI 的审批卡」）；
//   - 不伪造工具事件（无任何官方工具帧记载）；不伪造用量（usage=false，§8.3）；
//   - <think> 段的过滤属 CLI 侧 --silent 旗标职责，文本行不经本解析器（generic.js
//     分发约束），桥接规格建议携带 --silent（V03 接线时随启动参数模板处理）。

export function isContinueStreamType(raw) {
  // --format json 官方未记载 schema——fail-closed：不认领任何帧（V12-A08 证据卡）。
  // 若后续官方补记 schema（或 V03 真实 CLI 取证），在此按官方形状扩入并补 fixture。
  void raw;
  return false;
}

export function mapContinueRaw(raw, { sessionId, agentType = 'generic', sequencer }) {
  if (!raw || typeof raw !== 'object') return [];
  // 防御性兜底：一切帧按未识别处理，保留可观测性，不猜测语义、不产生终态/审批事件。
  return [createEvent({
    sessionId, agentType, sequencer,
    eventType: 'custom',
    payload: {
      custom_type: 'continue_raw',
      fallback_text: 'Continue 输出（官方未记载 JSON 结构，未解析）',
      data: { type: typeof raw.type === 'string' ? raw.type : null },
    },
  })];
}
