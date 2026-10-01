import { createEvent } from '../lib/events.js';

// V12-A26（JetBrains Junie CLI）——安全控制尚未通过的保守适配器（adapter-contract.md §3 接口）。
//
// 2026-09-29 官方参数文档与 Windows 26.9.22 (3419.7) 本机 help：
//   - 官方 headless 页仍标 EAP；一次性任务可用位置参数或 --task，输出可选 json-stream；
//   - 非交互运行（一次性提示 / piped 输入 / ACP / Gateway）按设计信任项目并加载项目配置
//     （MCP servers、hooks、agents、skills、guidelines）而不询问——官方明确"只应在受信任
//     项目中非交互运行"；
// 2026-10-01 release3419.7/classic、Nightly3596.1/chat 已取得真实 BYOK 样本，
// 但两种模式都未经审批写文件；Nightly 还将环境 Key 序列化进本轮状态（已精确遮蔽）。
// 详见 docs/audit/2026-10-01/Junie原生补验.md。实际样本不是安全控制/正常 profile
// 验收，当前不接线、不扩大能力；Nightly changes=[] 也不能证明没有文件变化。
// 因此按契约 §3 实现"保守探针 + 兜底映射"：
//   1. isJunieStreamType 恒返回 false——尚无已验安全启动配方与产品帧契约，不把巧合 JSON 声称为 junie
//      事件，也不得抢占 claude-code/codex 的帧（主方案 §5.2 能力不能由名称推断）；
//   2. 既有合成文本 fixture 经 generic.js 兜底呈现；不代表真实 CLI 输出语义；
//   3. mapJunieRaw 仅供契约对拍与官方协议落地后的接线：对象帧一律落 custom 兜底事件
//      （custom_type='junie_raw'），任何畸形输入不抛出（返回数组，可为空）。
// 凭据边界（卡面 A26）：认证 token 只能由受控环境提供，不得写入手机 payload、诊断参数
// 或启动 args——本文件不提供任何携带 token 的参数构造接口；工作区/项目信任核验与 EAP
// 版本锁定属本机 profile 冻结 spec 职责（adapter-factory.js），不在此实现。
// generic.js 不增探测分支：探针无可达帧，增行即死分支（V12-A26 执行报告有说明）。

export function isJunieStreamType(raw) {
  // 产品安全通路尚未通过（见文件头注释）——任何输入都不声称是已接入 Junie 事件帧。
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
      fallback_text: `Junie 未识别帧（未取得真实帧契约）：${frameType || 'unknown'}`,
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
