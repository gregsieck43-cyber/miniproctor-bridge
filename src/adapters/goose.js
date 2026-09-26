import { createEvent } from '../lib/events.js';

// V12-A24（Goose）——文本型产品适配器（adapter-contract.md §3 接口）。
//
// 官方快照（xcx/docs/官方资料/A24-goose-readme.md，2026-09-25 抓取）为迁移后官方仓库
// aaif-goose/goose 的 README：桌面/CLI/API 三形态、多 provider、70+ MCP 扩展——但未提供
// CLI 一次性任务的参数形态，也未提供任何结构化事件流文档。因此按契约 §3 实现
// "保守探针 + 兜底映射"：
//   1. isGooseStreamType 恒返回 false——官方未定义帧契约，不得把巧合 JSON 声称为 goose
//      事件，也不得抢占 claude-code/codex 的帧（主方案 §5.2 能力不能由名称推断）；
//   2. goose 会话的文本输出经 generic.js 既有兜底呈现（agent_message、is_final=true）；
//   3. mapGooseRaw 仅供契约对拍与官方协议文档落地后的接线：对象帧一律落 custom 兜底
//      事件（custom_type='goose_raw'），任何畸形输入不抛出（返回数组，可为空）。
// 边界（卡面 A24）：扩展/MCP 权限不由手机增加——本文件不提供任何参数构造接口，启动
// 规格只能来自本机 profile 冻结 spec（adapter-factory.js）；多 provider 仍是同一 goose
// 产品下不同 profile，不按 provider 拆分身份。
// generic.js 不增探测分支：探针无可达帧，增行即死分支（V12-A24 执行报告有说明）。

export function isGooseStreamType(raw) {
  // 官方快照未定义结构化帧契约（见文件头注释）——任何输入都不声称是 goose 事件帧。
  return false;
}

export function mapGooseRaw(raw, { sessionId, agentType = 'generic', sequencer }) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
  const frameType = safeFrameType(raw);
  return [createEvent({
    sessionId, agentType, sequencer,
    eventType: 'custom',
    payload: {
      custom_type: 'goose_raw',
      fallback_text: `Goose 未识别帧（官方快照无结构化协议文档）：${frameType || 'unknown'}`,
      data: { type: frameType || null },
    },
  })];
}

/** 帧属性读取防御：畸形/hostile 帧的 getter 可能抛错，解析器不得连带抛出（契约 §3.3）。 */
function safeFrameType(raw) {
  try {
    return typeof raw.type === 'string' ? raw.type.slice(0, 128) : '';
  } catch {
    return '';
  }
}
