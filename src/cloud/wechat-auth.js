/**
 * 微信凭据与云函数网关调用（零依赖，Node 内置 fetch）。
 *
 * access_token：POST cgi-bin/stable_token（比旧 token 接口更稳，
 * 多实例不会互相踢）。进程内缓存、按 expires_in 提前 5 分钟刷新；
 * 调用方遇 40001/42001 时 invalidate 后重试一次由本模块内部完成。
 */
import { randomUUID } from 'node:crypto';

const STABLE_TOKEN_URL = 'https://api.weixin.qq.com/cgi-bin/stable_token';
const TCB_INVOKE_URL = 'https://api.weixin.qq.com/tcb/invokecloudfunction';

let tokenCache = null; // { appid, token, expiresAt }

function requestContext({ requestId, startedAt, now }) {
  return {
    // Correlation is local only, never sent in URL/body/headers. Reject caller-controlled text.
    requestId: typeof requestId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(requestId) ? requestId : randomUUID(),
    startedAt: Number.isFinite(startedAt) ? startedAt : now(),
    now,
  };
}

function diagnostic(context, phase, failureKind, timeoutMs) {
  const elapsed = context.now() - context.startedAt;
  return {
    request_id: context.requestId,
    phase,
    elapsed_ms: Number.isFinite(elapsed) ? Math.max(0, Math.round(elapsed)) : 0,
    failure_kind: failureKind,
    timeout_ms: timeoutMs,
  };
}

function requestFailure(context, phase, failureKind, timeoutMs, status = 0, ErrorType = Error) {
  // Never retain raw error, cause, response, URL or credentials: callers may log this error.
  return Object.assign(new ErrorType(`[wechat] ${phase} ${failureKind}`), diagnostic(context, phase, failureKind, timeoutMs), {
    http_status: Number.isInteger(status) && status >= 0 && status <= 599 ? status : 0,
  });
}

/** One fixed deadline covers both headers and body, even for an abort-insensitive Promise. */
async function requestJson(url, body, { fetchImpl, context, phase: initialPhase, bodyPhase, timeoutMs }) {
  const controller = new AbortController();
  let phase = initialPhase;
  let status = 0;
  let timedOut = false;
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(requestFailure(context, phase, 'timeout', timeoutMs, status));
    controller.signal.addEventListener('abort', onAbort, { once: true });
  });
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  try {
    return await Promise.race([
      (async () => {
        const res = await fetchImpl(typeof url === 'function' ? url() : url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        status = res.status;
        phase = bodyPhase;
        return { httpStatus: status, json: await res.json() };
      })(),
      aborted,
    ]);
  } catch (error) {
    const kind = timedOut || error?.name === 'TimeoutError' ? 'timeout'
      : error?.name === 'AbortError' ? 'abort'
        : error?.name === 'SyntaxError' ? 'invalid-response' : 'error';
    throw requestFailure(context, phase, kind, timeoutMs, status);
  } finally {
    clearTimeout(timer);
    controller.signal.removeEventListener('abort', onAbort);
  }
}

export function needsWechatCredentials(config) {
  return !config?.wechat?.appid || config.wechat.appid === 'TEST_APPID' || !config.wechat.secret;
}

/** 读取缓存中的 access_token；缺失或临近过期则重新获取。 */
export async function getAccessToken(config, { fetchImpl = fetch, now = Date.now, requestId, startedAt } = {}) {
  const context = requestContext({ requestId, startedAt, now });
  const appid = config?.wechat?.appid;
  const secret = config?.wechat?.secret;
  if (!appid || !secret) throw requestFailure(context, 'token-fetch', 'configuration', 8000);

  if (tokenCache && tokenCache.appid === appid && tokenCache.expiresAt - 5 * 60_000 > now()) {
    return tokenCache.token;
  }

  const { json } = await requestJson(STABLE_TOKEN_URL, { grant_type: 'client_credential', appid, secret }, {
    fetchImpl, context, phase: 'token-fetch', bodyPhase: 'token-fetch', timeoutMs: 8000,
  });
  if (!json?.access_token || json.errcode) {
    throw requestFailure(context, 'token-fetch', 'upstream', 8000);
  }
  tokenCache = { appid, token: json.access_token, expiresAt: now() + Number(json.expires_in || 7200) * 1000 };
  return tokenCache.token;
}

/** 强制下一次获取重新走网络（40112/40001 后使用）。 */
export function invalidateAccessToken() {
  tokenCache = null;
}

/**
 * 调用云函数：POST tcb/invokecloudfunction。
 * 返回形状与 HttpPollTransport 对齐：{ ok, status, data, errcode?, errmsg? }
 * 其中 data 为云函数返回值（resp 段）。
 */
export async function invokeCloudFunction(config, name, data, { fetchImpl = fetch, now = Date.now, requestId, startedAt } = {}) {
  const context = requestContext({ requestId, startedAt, now });
  const envId = config?.wechat?.envId;
  if (!envId) throw requestFailure(context, 'invoke-fetch', 'configuration', 10000);
  if (!name || typeof name !== 'string') throw requestFailure(context, 'invoke-fetch', 'configuration', 10000, 0, TypeError);

  const callOnce = async (accessToken) => {
    try {
      return await requestJson(
        () => `${TCB_INVOKE_URL}?access_token=${encodeURIComponent(accessToken)}&env=${encodeURIComponent(envId)}&name=${encodeURIComponent(name)}`,
        data,
        { fetchImpl, context, phase: 'invoke-fetch', bodyPhase: 'invoke-body', timeoutMs: 10000 },
      );
    } catch (error) {
      // Preserve the existing body-failure code/status (errcode=-1, headers' HTTP status),
      // but no longer discard its phase or confuse a deadline with malformed JSON.
      if (error.phase !== 'invoke-body') throw error;
      return { httpStatus: error.http_status, json: null, diagnostic: diagnostic(context, 'invoke-body', error.failure_kind, 10000) };
    }
  };

  const tokenOptions = { fetchImpl, now, requestId: context.requestId, startedAt: context.startedAt };
  let result = await callOnce(await getAccessToken(config, tokenOptions));
  // 凭据过期/失效：强制重取一次再重试一次（防平台侧提前失效）
  const expired = result.json && [40001, 42001].includes(Number(result.json.errcode));
  if (expired) {
    invalidateAccessToken();
    result = await callOnce(await getAccessToken(config, tokenOptions));
  }

  const { json } = result;
  const errcode = json ? Number(json.errcode || 0) : -1;
  // 微信 API 契约：resp_data 为云函数返回值的 JSON 字符串（旧文档误作 resp 对象）
  let data0 = null;
  if (json && typeof json.resp_data === 'string') {
    try { data0 = JSON.parse(json.resp_data); } catch { data0 = null; }
  } else if (json && json.resp !== undefined) {
    data0 = json.resp;
  }
  const ok = errcode === 0 && (data0 === null || data0.ok !== false);
  return {
    ok, status: result.httpStatus, data: data0, errcode, errmsg: json?.errmsg,
    ...(!ok ? result.diagnostic || diagnostic(context, 'invoke-body', json ? 'upstream' : 'invalid-response', 10000) : {}),
  };
}
