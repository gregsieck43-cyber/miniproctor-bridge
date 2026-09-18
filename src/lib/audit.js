/**
 * 最小本地审计（TASK-012）：JSON Lines 追加写。
 *
 * 用途：工作区授权拒绝等本机安全事件的本地留痕（时间/事件/cwd/原因），
 * 不记录 prompt 内容与 Agent 输出正文（内容级脱敏归 TASK-019）。
 * 写失败只告警不抛错：审计是尽力而为的旁路，绝不阻塞主流程。
 */
import fs from 'node:fs';
import path from 'node:path';

export function appendAuditLine(file, entry = {}) {
  if (!file) return false;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify({ ts: Date.now(), ...entry })}\n`, 'utf8');
    return true;
  } catch (err) {
    console.warn('[audit] write failed:', err?.message || err);
    return false;
  }
}
