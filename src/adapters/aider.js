import { createEvent } from '../lib/events.js';

// V12-A09（Aider）——文本型产品适配器（adapter-contract.md §3 接口）。
//
// 官方脚本接口快照（xcx/docs/官方资料/A09-aider-scripting.md，2026-09-25 抓取）给出的唯一
// 编程通道是 CLI 一次性任务：`aider --message "<指令>"`（处理回复后即退出），未提供任何
// 结构化事件流/JSON 协议文档。因此按契约 §3 实现"保守探针 + 兜底映射"：
//   1. isAiderStreamType 恒返回 false——官方未定义帧契约，不得把巧合 JSON 声称为 aider
//      事件，也不得抢占 claude-code/codex 的帧（主方案 §5.2 能力不能由名称推断）；
//   2. aider 会话输出为人类可读文本行，经 generic.js 既有兜底呈现（agent_message、
//      is_final=true）——这就是该产品的真实解析路径，不伪造工具事件；
//   3. mapAiderRaw 仅供契约对拍与官方结构化协议落地后的接线：对象帧一律落 custom 兜底
//      事件（custom_type='aider_raw'），任何畸形输入不抛出（返回数组，可为空）。
// generic.js 不增探测分支：探针无可达帧，增行即死分支（V12-A09 执行报告有说明）。
//
// 卡面安全要求「禁用非用户要求的自动 Git 提交」落在下方启动参数模板（纯函数、无 IO）：
// buildAiderLaunchArgs 恒带 --no-auto-commits / --no-dirty-commits，且绝不携带 --yes
// （自动同意一切确认 = 全权限放行，禁作默认）。后续经 AdapterFactory 的
// launchArgsResolver 挂点接线（V12-11 预留）；args 数组直传 spawn，无 shell、无拼接。

/** aider 一次性任务的安全旗标（卡面 A09：非用户要求的自动 Git 提交一律关闭）。 */
export const AIDER_SCRIPT_FLAGS = Object.freeze(['--no-auto-commits', '--no-dirty-commits']);

/**
 * 构造 aider 一次性任务启动参数：
 *   aider --no-auto-commits --no-dirty-commits --message "<初始提示词>"
 * 官方语义：--message 单条消息处理后退出（一次任务一个受控实例）。
 * --yes（每项确认自动同意）明确排除——headless 下批量放行等于权限扩大。
 * @param {string} prompt 初始提示词（非空字符串）
 * @returns {string[]} spawn 直传参数数组（prompt 逐字保留，不做引号/shell 处理）
 */
export function buildAiderLaunchArgs(prompt) {
  if (typeof prompt !== 'string' || !prompt.trim()) {
    throw new TypeError('aider 初始提示词必须是非空字符串');
  }
  return [...AIDER_SCRIPT_FLAGS, '--message', prompt];
}

export function isAiderStreamType(raw) {
  // 官方未提供结构化帧契约（见文件头注释）——任何输入都不声称是 aider 事件帧。
  return false;
}

export function mapAiderRaw(raw, { sessionId, agentType = 'generic', sequencer }) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
  const frameType = safeFrameType(raw);
  return [createEvent({
    sessionId, agentType, sequencer,
    eventType: 'custom',
    payload: {
      custom_type: 'aider_raw',
      fallback_text: `Aider 未识别帧（官方快照无结构化协议文档）：${frameType || 'unknown'}`,
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
