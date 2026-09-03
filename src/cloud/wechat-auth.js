/**
 * 微信凭据与云函数网关调用（零依赖，Node 内置 fetch）。
 *
 * access_token：POST cgi-bin/stable_token（比旧 token 接口更稳，
 * 多实例不会互相踢）。进程内缓存、按 expires_in 提前 5 分钟刷新；
 * 调用方遇 40001/42001 时 invalidate 后重试一次由本模块内部完成。
 */
const STABLE_TOKEN_URL = 'https://api.weixin.qq.com/cgi-bin/stable_token';
const TCB_INVOKE_URL = 'https://api.weixin.qq.com/tcb/invokecloudfunction';

let tokenCache = null; // { appid, token, expiresAt }

export function needsWechatCredentials(config) {
  return !config?.wechat?.appid || config.wechat.appid === 'TEST_APPID' || !config.wechat.secret;
}

/** 读取缓存中的 access_token；缺失或临近过期则重新获取。 */
export async function getAccessToken(config, { fetchImpl = fetch, now = Date.now } = {}) {
  const appid = config?.wechat?.appid;
  const secret = config?.wechat?.secret;
  if (!appid || !secret) throw new Error('wechat credentials missing');

  if (tokenCache && tokenCache.appid === appid && tokenCache.expiresAt - 5 * 60_000 > now()) {
    return tokenCache.token;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  let json;
  try {
    const res = await fetchImpl(STABLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ grant_type: 'client_credential', appid, secret }),
      signal: controller.signal,
    });
    json = await res.json();
  } finally {
    clearTimeout(timer);
  }
  if (!json?.access_token || json.errcode) {
    throw new Error(`stable_token failed: ${json?.errcode ?? 'no_token'} ${json?.errmsg ?? ''}`.trim());
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
export async function invokeCloudFunction(config, name, data, { fetchImpl = fetch, now = Date.now } = {}) {
  const envId = config?.wechat?.envId;
  if (!envId) throw new Error('wechat envId missing');
  if (!name || typeof name !== 'string') throw new TypeError('cloud function name required');

  const callOnce = async (accessToken) => {
    const url = `${TCB_INVOKE_URL}?access_token=${encodeURIComponent(accessToken)}&env=${encodeURIComponent(envId)}&name=${encodeURIComponent(name)}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(data),
        signal: controller.signal,
      });
      const json = await res.json().catch(() => null);
      return { httpStatus: res.status, json };
    } finally {
      clearTimeout(timer);
    }
  };

  let result = await callOnce(await getAccessToken(config, { fetchImpl, now }));
  // 凭据过期/失效：强制重取一次再重试一次（防平台侧提前失效）
  const expired = result.json && [40001, 42001].includes(Number(result.json.errcode));
  if (expired) {
    invalidateAccessToken();
    result = await callOnce(await getAccessToken(config, { fetchImpl, now }));
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
  return { ok, status: result.httpStatus, data: data0, errcode, errmsg: json?.errmsg };
}
