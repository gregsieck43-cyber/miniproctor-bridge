import { createEvent } from '../lib/events.js';

// V12-A26（JetBrains Junie CLI）——文本型产品适配器（adapter-contract.md §3 接口）。
//
// 官方 headless 快照（xcx/docs/官方资料/A26-junie-headless.md，2026-09-25 抓取）：
//   - CLI 官方标 EAP；一次性任务 = `junie --auth="$JUNIE_API_KEY" "<提示词>"`（位置参数）；
//   - 非交互运行（一次性提示 / piped 输入 / ACP / Gateway）按设计信任项目并加载项目配置
//     （MCP servers、hooks、agents、skills、guidelines）而不询问——官方明确"只应在受信任
//     项目中非交互运行"（快照 §Project trust）；
//   - 未提供任何结构化事件流文档。
// 因此按契约 §3 实现"保守探针 + 兜底映射"：
//   1. isJunieStreamType 恒返回 false——官方未定义帧契约，不得把巧合 JSON 声称为 junie
//      事件，也不得抢占 claude-code/codex 的帧（主方案 §5.2 能力不能由名称推断）；
//   2. junie 会话的文本输出经 generic.js 既有兜底呈现（agent_message、is_final=true）；
//   3. mapJunieRaw 仅供契约对拍与官方协议落地后的接线：对象帧一律落 custom 兜底事件
//      （custom_type='junie_raw'），任何畸形输入不抛出（返回数组，可为空）。
// 凭据边界（卡面 A26）：认证 token 只能由受控环境提供，不得写入手机 payload、诊断参数
// 或启动 args——本文件不提供任何携带 token 的参数构造接口；工作区/项目信任核验与 EAP
// 版本锁定属本机 profile 冻结 spec 职责（adapter-factory.js），不在此实现。
// generic.js 不增探测分支：探针无可达帧，增行即死分支（V12-A26 执行报告有说明）。

export function isJunieStreamType(raw) {
  // 官方快照未定义结构化帧契约（见文件头注释）——任何输入都不声称是 junie 事件帧。
  return false;
}

export function mapJunieRaw(raw, { sessionId, agentType = 'generic', sequencer }) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
  const frameType = safeFrameType(raw);
  return [createEvent({
    sessionId, agentType, sequencer,
    eventType: 'custom',
    payload: {
      custom_type: 'junie_raw',
      fallback_text: `Junie 未识别帧（官方快照无结构化协议文档）：${frameType || 'unknown'}`,
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
