/**
 * V1-014：HTTP 响应 body 的统一受限读取。
 *
 * 缺陷背景（R12）：endpoint/http-poll 的超时计时器在响应 headers 到达即清理，
 * body 等待期（res.json()）无任何期限——恶意/故障服务器可以 headers 立即返回、
 * body 永不完成，调用方永久挂起。本模块提供：
 *   1) 超时信号覆盖 body 等待期：AbortSignal 在 body 读取完成前保持有效，
 *      超时即以 AbortError 竞速中断（流式与非流式 Response 都覆盖）；
 *   2) 字节上限：默认 1 MiB，超限以 response-too-large 错误拒绝（真实云函数
 *      响应最大约 50 条命令/批 ≈ 数十 KB，1 MiB 为宽裕上界）；
 *   3) JSON 解析失败归一为 null（调用方按 INVALID_RESPONSE 处理，与既有语义一致）。
 *
 * 用法：调用方在 AbortController 计时器清理【之前】await 本函数（timer 的
 * clearTimeout 移到外层 finally），保证「连接 → headers → body → 解析」全程受期限约束。
 */

/** 响应 body 字节上限（默认）。 */
export const RESPONSE_BODY_MAX_BYTES = 1024 * 1024;

function abortError() {
  const err = new Error('The operation was aborted');
  err.name = 'AbortError';
  return err;
}

function tooLargeError(detail) {
  const err = new Error(`response body exceeds limit: ${detail}`);
  err.code = 'response-too-large';
  return err;
}

/** signal 已中止或中止时 reject 的 Promise（finally 移除监听，无泄漏）。 */
function abortRace(signal) {
  return new Promise((_, reject) => {
    const onAbort = () => reject(abortError());
    if (signal && signal.aborted) return onAbort();
    if (!signal || typeof signal.addEventListener !== 'function') return; // 永不 settle，race 由 json 侧胜出
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * 读取并解析响应 body 为 JSON（受限）。
 * @param {Response|object} res fetch Response（或测试桩 Response 形态）
 * @param {number} [maxBytes] 字节上限，默认 RESPONSE_BODY_MAX_BYTES
 * @param {{signal?: AbortSignal}} [opts] 超时信号（body 等待期必须被覆盖）
 * @returns {Promise<object|null>} 解析结果；非法 JSON → null
 * @throws {Error} code='response-too-large'：超限；name='AbortError'：body 期间超时/中止；
 *                 其他：流读取失败（调用方按网络失败归类）
 */
export async function readJsonBodyCapped(res, maxBytes = RESPONSE_BODY_MAX_BYTES, { signal } = {}) {
  const lenHeader = Number((res.headers && typeof res.headers.get === 'function' && res.headers.get('content-length')) || 0);
  if (Number.isFinite(lenHeader) && lenHeader > 0 && lenHeader > maxBytes) {
    throw tooLargeError(`content-length ${lenHeader} > ${maxBytes} bytes`);
  }
  // 流式路径（真实 undici/fetch Response）：逐 chunk 累计，超上限即取消并拒绝。
  if (res.body && typeof res.body.getReader === 'function') {
    const reader = res.body.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
      let done = false;
      let chunk = null;
      try {
        ({ done, value: chunk } = await reader.read());
      } catch (err) {
        if (signal && signal.aborted) throw abortError();
        throw err;
      }
      if (done) break;
      total += chunk ? chunk.length : 0;
      if (total > maxBytes) {
        try { await reader.cancel(); } catch { /* 取消失败忽略 */ }
        throw tooLargeError(`> ${maxBytes} bytes`);
      }
      chunks.push(Buffer.from(chunk));
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      return null;
    }
  }
  // 非流式（测试桩/旧运行时）：json() 与超时信号竞速——body 阶段的超时不再永久挂起。
  if (signal) {
    let onAbort = null;
    try {
      return await Promise.race([
        res.json().catch(() => null),
        new Promise((_, reject) => {
          onAbort = () => reject(abortError());
          if (signal && signal.aborted) return onAbort();
          if (!signal || typeof signal.addEventListener !== 'function') return;
          signal.addEventListener('abort', onAbort, { once: true });
        }),
      ]);
    } finally {
      if (onAbort && signal && typeof signal.removeEventListener === 'function') {
        signal.removeEventListener('abort', onAbort);
      }
    }
  }
  return res.json().catch(() => null);
}
