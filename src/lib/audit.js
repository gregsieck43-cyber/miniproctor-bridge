/**
 * 最小本地审计（TASK-012）：JSON Lines 追加写。
 *
 * 用途：工作区授权拒绝等本机安全事件的本地留痕（时间/事件/cwd/原因），
 * 不记录 prompt 内容与 Agent 输出正文（内容级脱敏归 TASK-019）。
 * 写失败只告警不抛错：审计是尽力而为的旁路，绝不阻塞主流程。
 *
 * V1-018②：写入前对字符串值做凭据形态清洗（与 events.js sanitizeSensitiveText
 * 同一管线：sk-/ghp_/Bearer/键值赋值形态），并截断超长值——审计文件是本机长期
 * 留痕，绝不成为 Secret 的长期副本（不能识别全部秘密，见 data-retention.md §6）。
 *
 * V1-019③：大小轮转（保留上限）——audit.log 超过 AUDIT_MAX_BYTES 轮转为
 * audit.log.1（旧轮转件依次后移，超出 AUDIT_MAX_ROTATED_FILES 的最旧件删除）。
 * 本机审计磁盘占用上界 = maxBytes × (maxFiles + 1)。
 */
import fs from 'node:fs';
import path from 'node:path';
import { sanitizeSensitiveText } from './events.js';

/** 单文件轮转阈值（默认 2MB）。 */
export const AUDIT_MAX_BYTES = 2 * 1024 * 1024;
/** 轮转保留份数（audit.log.1 ~ audit.log.N；总盘额上界 = maxBytes × (N+1)）。 */
export const AUDIT_MAX_ROTATED_FILES = 3;
const AUDIT_VALUE_MAX_CHARS = 500;

/** 递归清洗审计条目：字符串值凭据形态清洗 + 截断；对象限深、数组限宽。 */
function scrubAuditValue(value, depth = 0) {
  if (typeof value === 'string') {
    const out = sanitizeSensitiveText(value);
    return out.length > AUDIT_VALUE_MAX_CHARS ? `${out.slice(0, AUDIT_VALUE_MAX_CHARS)}…` : out;
  }
  if (value === null || value === undefined || typeof value !== 'object') return value;
  if (depth >= 3) return '[depth-limit]';
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => scrubAuditValue(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) out[k] = scrubAuditValue(v, depth + 1);
  return out;
}

/**
 * 按大小轮转审计文件（append 前调用；main.js clean 可主动触发）。
 * @returns {number} 1=执行了轮转；0=未达阈值或轮转失败（失败只告警，不阻塞写入）
 */
export function rotateAuditIfNeeded(file, { maxBytes = AUDIT_MAX_BYTES, maxFiles = AUDIT_MAX_ROTATED_FILES } = {}) {
  if (!file) return 0;
  try {
    if (!fs.existsSync(file) || fs.statSync(file).size < maxBytes) return 0;
  } catch {
    return 0;
  }
  try {
    fs.rmSync(`${file}.${maxFiles}`, { force: true }); // 最旧件让位
    for (let i = maxFiles - 1; i >= 1; i -= 1) {
      try { fs.renameSync(i === 1 ? file : `${file}.${i - 1}`, `${file}.${i}`); } catch { /* 缺件跳过 */ }
    }
    return 1;
  } catch (err) {
    console.warn('[audit] rotate failed:', err?.message || err);
    return 0;
  }
}

export function appendAuditLine(file, entry = {}) {
  if (!file) return false;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    rotateAuditIfNeeded(file);
    fs.appendFileSync(file, `${JSON.stringify({ ts: Date.now(), ...scrubAuditValue(entry) })}\n`, 'utf8');
    return true;
  } catch (err) {
    console.warn('[audit] write failed:', err?.message || err);
    return false;
  }
}
