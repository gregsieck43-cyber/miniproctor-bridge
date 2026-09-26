/**
 * log.js：bridge 侧最小结构化日志（TASK-022，零依赖）。
 *
 * 设计目标（方案 §19 / TASK-022 ②"脱敏日志分级/采样/保留"）：
 *  - 分级：debug < info < warn < error；环境变量 MINIPROCTOR_LOG_LEVEL 控制（默认 info，
 *    非法值回退 info）。每次输出时实时读取，支持运行中改环境变量。
 *  - 采样：仅 debug 级按 1/10 概率输出（DEBUG_SAMPLE_RATE）；info/warn/error 全量。
 *  - 单行 JSON：{ ts, level, component, msg, ...fields }，写 stderr
 *    （stdout 保留给协议/结果输出，如 doctor JSON、配对码；日志绝不混入 stdout）。
 *  - 允许的上下文字段：session_id / command_id / request_id / correlation_id /
 *    event_id / fn / path / error_code / http_status / retryable / attempts /
 *    duration_ms 等短标识符与计数。**绝不输出 prompt / 事件正文 / 音频 / token /
 *    私钥 / 签名等凭据材料** —— 内置字段名黑名单滤芯（见 BLOCKED_SUFFIXES）+
 *    字符串截断 + PEM 特征替换三层防御。
 *  - 日志是旁路：任何异常（stderr 不可写等）静默吞掉，绝不阻断核心操作
 *    （TASK-022 边界："日志服务不可用不能阻断核心操作"）。
 *
 * 用法：
 *   import { createLogger } from './log.js';
 *   const log = createLogger('cloud-gateway');
 *   log.warn('invoke failed: xxx', { fn: 'syncReport', error_code: 'UPSTREAM_UNAVAILABLE' });
 *   // → stderr: {"ts":"2026-09-17T…","level":"warn","component":"cloud-gateway",
 *   //            "msg":"invoke failed: xxx","fn":"syncReport","error_code":"UPSTREAM_UNAVAILABLE"}
 *
 * 字段黑名单滤芯（宁可错杀）：字段名规范化（小写、去分隔符）后，若以黑名单词结尾
 * 或整体等于黑名单词，则丢弃该字段并留下 `<原字段名>_redacted: 1` 占位标记
 * （只暴露字段名，不暴露值）。event_id 等关联 ID 不受影响（规范化后不以黑名单词结尾）。
 */

import fs from 'node:fs';
import path from 'node:path';
// V1-018②：值级凭据形态清洗与 events.js 共用同一管线（sk-/ghp_/Bearer/键值赋值），
// 字段黑名单是"按字段名"的第一层，这里是"按值形态"的第二层（双保险）。
import { sanitizeSensitiveText } from './events.js';
// V1-018③：日志文件 ACL 尽力收紧（Windows attrib+icacls / POSIX chmod 600），失败明确可见。
import { applyMinimalPermissions } from '../cloud/device-keys.js';

const LEVELS = Object.freeze({ debug: 10, info: 20, warn: 30, error: 40 });
const DEFAULT_LEVEL = 'info';

/** debug 级采样率（1/10）；info/warn/error 不采样。 */
const DEBUG_SAMPLE_RATE = 0.1;

const MAX_MSG_CHARS = 500;   // msg 截断上限
const MAX_STR_CHARS = 120;   // 上下文字符串值截断上限
const MAX_DEPTH = 4;         // 对象嵌套深度上限
const MAX_ARRAY = 10;        // 数组保留条数上限
const MAX_FIELDS = 16;       // 单条日志字段数上限（防滥用）

/**
 * 字段名黑名单（规范化形态：小写、去掉 _-. 等分隔符）。
 * 命中规则：规范化字段名 === 词 或 以词结尾 → 丢弃。
 * 覆盖：① 内容/正文（prompt/content/text/audio/output/…）；
 *      ② 传输负载（payload/body/data/json/response/result/…）；
 *      ③ 凭据（token/secret/privatekey/signature/authorization/cookie/…）。
 */
const BLOCKED_SUFFIXES = Object.freeze(new Set([
  // 内容与正文（Agent 输入/输出、音频、代码）
  'prompt', 'content', 'text', 'audio', 'audiob64', 'b64', 'base64', 'output',
  'stdout', 'stderr', 'diff', 'snippet', 'source', 'preview', 'transcript',
  // 传输负载与响应体（结构未知，一律不进日志）
  'payload', 'body', 'data', 'json', 'response', 'resp', 'result', 'events',
  'event', 'record', 'doc', 'document',
  // 凭据与密钥材料
  'token', 'tokenhash', 'accesstoken', 'secret', 'secretid', 'secretkey',
  'privatekey', 'privkey', 'pem', 'credential', 'credentials', 'password',
  'passwd', 'authorization', 'auth', 'authsig', 'signature', 'sig', 'cookie',
  'sessionkey', 'apikey', 'key', 'nonce', 'appsecret', 'secretkey',
]));

/** 匹配 PEM/私钥特征的值级保险丝（黑名单漏网时兜底）。 */
const PEM_PATTERN = /-----BEGIN[\w ]*----|PRIVATE KEY-----/;

function normalizeKey(key) {
  return String(key).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function isBlockedKey(key) {
  const norm = normalizeKey(key);
  if (!norm) return true;
  if (BLOCKED_SUFFIXES.has(norm)) return true;
  for (const suffix of BLOCKED_SUFFIXES) {
    if (norm.endsWith(suffix)) return true;
  }
  return false;
}

/** 字符串值：去控制字符（防日志注入/保单行）、替换 PEM 特征、凭据形态清洗、截断。 */
function sanitizeString(value, maxChars = MAX_STR_CHARS) {
  let s = String(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ');
  if (PEM_PATTERN.test(s)) s = '[redacted-pem]';
  // V1-018②：值级凭据形态清洗（sk-/ghp_/Bearer/token=… 等已知形态；URL token 同样命中）
  s = sanitizeSensitiveText(s);
  if (s.length > maxChars) s = `${s.slice(0, maxChars)}…(truncated)`;
  return s;
}

/**
 * 递归净化字段值：原始类型直出（字符串净化截断），对象/数组限深限宽；
 * Error 取 message；命中黑名单的子字段丢弃并留 `<名>_redacted: 1` 标记。
 */
function sanitizeValue(value, depth, seen) {
  if (value === null || value === undefined) return undefined;
  const t = typeof value;
  if (t === 'string') return sanitizeString(value);
  if (t === 'boolean') return value;
  if (t === 'number') return Number.isFinite(value) ? value : sanitizeString(value);
  if (t === 'bigint') return String(value);
  if (t === 'function' || t === 'symbol') return undefined;
  if (value instanceof Error) return sanitizeString(value.message || String(value));
  if (depth >= MAX_DEPTH) return '[depth-limit]';
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const out = [];
      for (const item of value.slice(0, MAX_ARRAY)) {
        const v = sanitizeValue(item, depth + 1, seen);
        if (v !== undefined) out.push(v);
      }
      if (value.length > MAX_ARRAY) out.push(`…(+${value.length - MAX_ARRAY})`);
      return out;
    }
    const out = {};
    let n = 0;
    for (const [k, v] of Object.entries(value)) {
      if (n >= MAX_FIELDS) { out['…(more-fields-dropped)'] = 1; break; }
      if (isBlockedKey(k)) {
        out[`${String(k).slice(0, 40)}_redacted`] = 1; // 只暴露字段名，不暴露值
        n += 1;
        continue;
      }
      const sv = sanitizeValue(v, depth + 1, seen);
      if (sv !== undefined) { out[String(k).slice(0, 60)] = sv; n += 1; }
    }
    return out;
  } finally {
    seen.delete(value);
  }
}

/** 当前生效级别（每次输出实时读取环境变量，非法值回退 info）。 */
export function resolveLogLevel() {
  const raw = (typeof process !== 'undefined' && process.env && process.env.MINIPROCTOR_LOG_LEVEL) || '';
  const level = String(raw).trim().toLowerCase();
  return LEVELS[level] ? level : DEFAULT_LEVEL;
}

function emit(level, component, msg, fields) {
  if (LEVELS[level] < LEVELS[resolveLogLevel()]) return;
  if (level === 'debug' && Math.random() >= DEBUG_SAMPLE_RATE) return;
  try {
    const record = {
      ts: new Date().toISOString(),
      level,
      component,
      msg: sanitizeString(msg, MAX_MSG_CHARS),
    };
    if (fields !== undefined && fields !== null) {
      const clean = sanitizeValue(fields, 0, new Set());
      if (clean && typeof clean === 'object' && !Array.isArray(clean)) Object.assign(record, clean);
      else if (clean !== undefined) record.detail = clean;
    }
    const line = `${JSON.stringify(record)}\n`;
    process.stderr.write(line);
    if (fileSink) writeToSink(line); // V1-018③：可选轮转文件副本（写失败不阻断，见 sink.failed）
  } catch {
    /* 日志是旁路：输出失败绝不阻断主流程 */
  }
}

/**
 * 创建组件级 logger。返回 { debug, info, warn, error }，签名均为 (msg, fields?)。
 * fields 传普通对象（允许 session_id/command_id/request_id/error_code 等标识符
 * 与短计数字段）；传非对象值会被折进 detail 字段。
 * 兼容旧 console 风格调用的注入场景：调用方仍可注入自定义 logger（测试/静音）。
 */
export function createLogger(component) {
  const comp = sanitizeString(component || 'bridge', 40);
  const make = (level) => (msg, fields) => emit(level, comp, msg, fields);
  return { debug: make('debug'), info: make('info'), warn: make('warn'), error: make('error') };
}
