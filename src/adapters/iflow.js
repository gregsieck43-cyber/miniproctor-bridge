import { createEvent, sanitizePreview } from '../lib/events.js';

// iFlow 0.5.19 的 --prompt --stream=false 实测只在 stdout 写最终文本，stderr 写
// <Execution Info> 完成信息。已绑定产品会话由 IflowOutputAccumulator 在成功退出后
// 合并；未知 JSON 帧仍不猜测语义，mapIflowRaw 仅供观察。agentType 保持 generic。

export function isIflowStreamType(raw) {
  // 文本非交互路径已实测；结构化帧格式仍无契约，不猜测帧形状。
  // 恒 false 保证：任何未知 JSON 都不会被打上 iFlow 语义（fail-closed，不伪造）。
  void raw;
  return false;
}

export function mapIflowRaw(raw, { sessionId, agentType = 'generic', sequencer }) {
  // 防御式观察兜底：null/非对象 → 空数组（不抛出）；对象 → 单个 custom 观察事件。
  // 该函数当前无生产接线点（探测恒 false），仅供防御式观察与未来协议取证后复用。
  if (!raw || typeof raw !== 'object') return [];
  return [createEvent({
    sessionId, agentType, sequencer,
    eventType: 'custom',
    payload: {
      custom_type: 'iflow_observe',
      fallback_text: 'iFlow 未验证结构化帧（仅观察不解释）',
      data: { preview: sanitizePreview(raw, 500) },
    },
  })];
}

/** iFlow 0.5.19 非交互 stdout 聚合；完成标记缺失时拒绝把横幅或半截输出当答复。 */
export class IflowOutputAccumulator {
  constructor({ maxChars = 64 * 1024 } = {}) {
    this.maxChars = maxChars;
    this.lines = [];
    this.length = 0;
    this.truncated = false;
  }

  consume(line) {
    if (typeof line !== 'string') return;
    const value = line.replace(/\r$/, '');
    if (!value.trim() && this.lines.length === 0) return;
    const available = this.maxChars - this.length;
    if (available <= 0) { this.truncated = true; return; }
    const piece = value.slice(0, available);
    this.lines.push(piece);
    this.length += piece.length + 1;
    if (piece.length < value.length) this.truncated = true;
  }

  finish({ success = false, stderrTail = '' } = {}) {
    if (!success || typeof stderrTail !== 'string') return null;
    const match = /<Execution Info>\s*([\s\S]*?)\s*<\/Execution Info>/.exec(stderrTail);
    if (!match) return null;
    let info;
    try { info = JSON.parse(match[1]); } catch { return null; }
    if (!Number.isInteger(info?.assistantRounds) || info.assistantRounds < 1) return null;
    const content = this.lines.join('\n').trim();
    return content ? { content, truncated: this.truncated } : null;
  }
}
