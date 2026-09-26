import { createEvent } from '../lib/events.js';

// Qoder 国际版 CLI headless 适配器（V12-A18）。
//
// 官方证据（本地快照，2026-09-25 抓取）：
//   - A18a-qoder-run-in-scripts.md：headless 模式 `qoder -p "<prompt>"`（prompt 走参数或 stdin）；
//     `--output-format` 支持 text（默认，纯文本结果）/ json（含 result 与 Metadata 的单 JSON 对象）/
//     stream-json（逐行 JSON 消息流）；`--input-format stream-json` 可持续发送「Structured Messages」。
//   - A18b-qoder-permissions.md：headless（-p）下任何需要确认的操作（ask）一律自动拒绝；
//     SDK（stdio 协议）有 canUseTool 回调、ACP 有 requestPermission——均为其他集成模式，本卡未实现；
//     --yolo/bypass_permissions 仅限完全受信环境（本适配器不设置任何权限放行参数）。
//
// 诚实边界（不编造接口）：官方快照【没有给出】json/stream-json 的帧 schema（无字段/无示例帧）。
// 因此本适配器：
//   1) 探测函数为「空集」——不认领任何帧，避免与 claude/codex/kimi/codebuddy 探测抢帧或误归因；
//   2) 不实现任何工具事件映射（generic 式文本产品不伪造工具事件）；
//   3) 运行时读取路径 = generic 行流兜底（文本行 → agent_message；未知 JSON → custom raw_json）；
//   4) headless ask 自动拒绝是官方文档化行为——不提供审批回写通道，approve=false。
// stream-json 帧 schema 与 json 单对象结构待 V03 真实 CLI 取证（本机未安装 qoder，
// command -v/where.exe 双确认）后，按实测流补充映射并把能力逐项翻入验证层（adapter-contract.md §2.3）。
//
// 事件 agent_type 取 'generic'：AGENT_TYPES 冻结为 claude-code/codex/generic（protocol/schema.cjs）。

/**
 * 帧探测（契约 §3.1 形状探测）：官方未提供帧 schema，探测集合为空。
 * 保持全输入安全（null/原始类型/任意对象一律 false），不得对未知帧返回 true。
 */
export function isQoderStreamType(_raw) {
  // 官方未提供任何帧形态证据：不依据输入形状做任何认领（参数仅保留契约签名位置）。
  return false;
}

/**
 * 帧翻译（契约 §3.2）：因探测为空集，本函数不会经分发器被调用；
 * 直接调用（测试/后续演进）时一律落入 custom 兜底——不猜测帧语义、不伪造工具事件。
 */
export function mapQoderRaw(raw, { sessionId, agentType = 'generic', sequencer } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
  try {
    return [createEvent({
      sessionId,
      agentType,
      sequencer,
      eventType: 'custom',
      payload: {
        custom_type: 'qoder_raw',
        fallback_text: 'Qoder 帧 schema 官方未提供，按未知 JSON 兜底显示（不伪造结构化事件）',
        data: { keys: Object.keys(raw).slice(0, 10) },
      },
    })];
  } catch {
    return []; // ctx 缺失/非法时静默丢帧（契约：不得抛出）
  }
}

/** 声明层能力（V12-A18；与 catalog-entries/qoder.json 同步，执行门禁另经 capabilities.js 开放视图）。 */
export const QODER_CAPABILITIES = Object.freeze({
  create: false, // 无产品专属拉起路径（无启动预设；AdapterFactory 对 adapter_id=generic 拒绝新会话），待 V03 接通
  read: true, // 文本输出经 generic 行流路径读取（官方 text 为默认输出格式）；结构化帧 schema 未提供，无映射
  stop: true, // runner 进程树终止为 bridge 自有能力（generic 同源）
  append: false, // stream-json 输入官方仅述及存在，消息 schema 未提供——无编码路径，不声明
  resume: false, // --session-id 为 CLI flag，bridge 无恢复重拉代码路径，不声明
  approve: false, // headless ask 一律自动拒绝（官方文档化）；SDK canUseTool / ACP requestPermission 未实现
  fileChanges: false, // 无帧 schema，无 file_change 映射路径
  usage: false, // json 输出含 Metadata 但字段未文档化，无统计路径（无统计不伪造，§8.3）
  integrationMode: 'stdio',
  initialPromptChannel: 'launch-args',
});
