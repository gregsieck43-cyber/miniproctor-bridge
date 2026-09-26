import { createEvent } from '../lib/events.js';

// V12-A09（Aider）——文本型产品适配器（adapter-contract.md §3 接口）。
//
// 官方脚本接口快照（xcx/docs/官方资料/A09-aider-scripting.md，2026-09-25 抓取）给出的唯一
// 编程通道是 CLI 一次性任务：`aider --message "<指令>"`（处理回复后即退出），未提供任何
// 结构化事件流/JSON 协议文档。因此按契约 §3 实现"保守探针 + 兜底映射"：
//   1. isAiderStreamType 恒返回 false——官方未定义帧契约，不得把巧合 JSON 声称为 aider
//      事件，也不得抢占 claude-code/codex 的帧（主方案 §5.2 能力不能由名称推断）；
//   2. aider 会话输出为人类可读文本行；已绑定的会话只在进程成功退出后从完整
//      输出提取最终答复，不把启动横幅、思考段或 token 诊断冒充最终回复；
//   3. mapAiderRaw 仅供契约对拍与官方结构化协议落地后的接线：对象帧一律落 custom 兜底
//      事件（custom_type='aider_raw'），任何畸形输入不抛出（返回数组，可为空）。
// generic.js 不做按帧形探测，只按已冻结的产品身份路由纯文本。
//
// 卡面安全要求「禁用非用户要求的自动 Git 提交」落在下方启动参数模板（纯函数、无 IO）：
// buildAiderLaunchArgs 恒带 --no-auto-commits / --no-dirty-commits，且绝不携带 --yes
// （自动同意一切确认 = 全权限放行，禁作默认）。product-runtime.js 将这些静态
// 旗标交给 AdapterFactory；args 数组直传 spawn，无 shell、无拼接。

/** aider 一次性任务的安全旗标（卡面 A09：非用户要求的自动 Git 提交一律关闭）。 */
export const AIDER_SCRIPT_FLAGS = Object.freeze([
  '--no-auto-commits', '--no-dirty-commits', '--no-gitignore',
  '--no-auto-lint', '--no-auto-test', '--no-auto-accept-architect',
  '--no-suggest-shell-commands', '--no-check-update', '--no-show-release-notes',
  '--no-pretty', '--no-stream', '--no-analytics',
]);

/**
 * 构造 aider 一次性任务启动参数：
 *   aider <AIDER_SCRIPT_FLAGS> --message "<初始提示词>"
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

/** Aider 0.86.2 `--message --no-stream` 的有界 stdout 聚合器。未知输出不会生成假回复。 */
export class AiderOutputAccumulator {
  constructor({ maxChars = 64 * 1024 } = {}) {
    this.maxChars = maxChars;
    this.phase = 'preamble';
    this.lines = [];
    this.length = 0;
    this.truncated = false;
  }

  consume(line) {
    if (typeof line !== 'string' || this.phase === 'done') return;
    const value = line.replace(/\r$/, '').trimEnd();
    if (/^Tokens:\s+[\d.,k]+\s+sent\b/i.test(value)) {
      this.phase = 'done';
      return;
    }
    if (/^\s*►\s*\*{0,2}THINKING\*{0,2}\s*$/i.test(value)) {
      this.phase = 'thinking';
      this.lines = [];
      this.length = 0;
      return;
    }
    if (/^\s*►\s*\*{0,2}ANSWER\*{0,2}\s*$/i.test(value)) {
      this.phase = 'answer';
      this.lines = [];
      this.length = 0;
      return;
    }
    if (/^-{8,}$/.test(value.trim())) {
      if (this.phase === 'preamble') this.phase = 'body';
      return;
    }
    if (this.phase !== 'answer' && this.phase !== 'body') return;
    if (!value.trim() && this.lines.length === 0) return;
    const available = this.maxChars - this.length;
    if (available <= 0) { this.truncated = true; return; }
    const piece = value.slice(0, available);
    this.lines.push(piece);
    this.length += piece.length + 1;
    if (piece.length < value.length) this.truncated = true;
  }

  finish({ success = false } = {}) {
    if (!success || (this.phase !== 'answer' && this.phase !== 'done')) return null;
    const content = this.lines.join('\n').trim();
    return content ? { content, truncated: this.truncated } : null;
  }
}

/** 帧属性读取防御：畸形/hostile 帧的 getter 可能抛错，解析器不得连带抛出（契约 §3.3）。 */
function safeFrameType(raw) {
  try {
    return typeof raw.type === 'string' ? raw.type.slice(0, 128) : '';
  } catch {
    return '';
  }
}
