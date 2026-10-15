/**
 * CloudGatewayTransport：经微信云开发 HTTP API 触达云函数。
 * 与 HttpPollTransport 同一接口（pushEvents/pullCommands/ackCommand/registerPairing/
 * pairingStatus/reportStatus），relay.kind === 'cloud' 时由 main.js 选用。
 *
 * 安全：凭据只出现在 POST body（不进 URL/查询串）；请求附 ed25519 签名
 * 字段 auth_ts/auth_sig，云端有公钥的绑定强制验签。
 *
 * 统一错误语义（TASK-006/E06 修复）：成功返回 { ok:true, status, data }；
 * 网关异常 / errcode!=0 / 云函数 ok:false 一律抛 TransportError（lib/outbox.js
 * 全桥唯一规范错误），调用方必须 catch——禁止把失败响应当成功消费。
 */
import { randomUUID } from 'node:crypto';
import { invokeCloudFunction } from '../cloud/wechat-auth.js';
import { appendAuthFields } from '../cloud/device-keys.js';
import { canonical } from '../lib/canonical.js';
import { TransportError, isPermanentFailure } from '../lib/outbox.js';
import { createLogger } from '../lib/log.js';

const LOG_FUNCTIONS = new Set(['syncReport', 'pullCommands', 'ackCommand', 'registerPairing', 'checkPairing']);
const LOG_CODES = new Set(['UPSTREAM_UNAVAILABLE', 'INVALID_RESPONSE', 'unauthorized', 'forbidden', 'DB_UNAVAILABLE', 'INTERNAL']);
const PHASES = new Set(['token-fetch', 'invoke-fetch', 'invoke-body']);
const FAILURE_KINDS = new Set(['timeout', 'abort', 'error', 'invalid-response', 'upstream', 'configuration']);

export class CloudGatewayTransport {
  /**
   * @param {object} opts
   * @param {object} opts.config    全量 bridge 配置（需 wechat.appid/secret/envId）
   * @param {string} opts.deviceId
   * @param {string|null} opts.tokenHash
   * @param {string|null} [opts.privateKey] PEM；为空则不附加签名字段（配对前阶段）
   * @param {object} [opts.logger]  结构化 logger（TASK-022 log.js；可注入自定义实现）
   */
  constructor({ config, deviceId, tokenHash = null, privateKey = null, logger = createLogger('cloud-gateway'), fetchImpl, now }) {
    if (!config) throw new TypeError('CloudGatewayTransport requires config');
    this.config = config;
    this.deviceId = deviceId;
    this.tokenHash = tokenHash;
    this.privateKey = privateKey;
    this.logger = logger;
    this._fetchImpl = fetchImpl;
    this._now = now;
  }

  /** 桥接 → 云端业务负载统一加签与身份字段。 */
  _authed(payload) {
    return appendAuthFields(
      { ...payload, device_id: payload.device_id ?? this.deviceId },
      { deviceId: this.deviceId, privateKey: this.privateKey, canonical }
    );
  }

  async pushEvents(events) {
    if (!events?.length) return { ok: true, status: 200, accepted: 0, data: { ok: true, accepted: 0 } };
    return this._invoke('syncReport', this._authed({ token_hash: this.tokenHash, events }));
  }

  async pushProfiles(profiles) {
    if (!profiles?.length) return { ok: true, status: 200, data: { ok: true, profile_projection: { rejected: [] } } };
    return this._invoke('syncReport', this._authed({ token_hash: this.tokenHash, events: [], profiles }));
  }

  async pullCommands() {
    return this._invoke('pullCommands', this._authed({ token_hash: this.tokenHash }));
  }

  /** 命令执行结果上报（TASK-007；云端函数部署待办见部署清单）。 */
  async ackCommand(payload) {
    return this._invoke('ackCommand', this._authed({ token_hash: this.tokenHash, ...payload }));
  }

  async registerPairing(offer) {
    return this._invoke('registerPairing', this._authed({
      pairing_id: offer.pairing_id,
      device_id: offer.device_id,
      device_name: this.deviceId,
      nonce_hash: offer.nonce_hash,
      token_hash: offer.token_hash,
      pairing_code_hash: offer.pairing_code_hash,
      public_key: offer.public_key || null,
      ttl_ms: offer.expires_at - Date.now(),
    }));
  }

  async pairingStatus(pairingId) {
    return this._invoke('checkPairing', { pairing_id: pairingId });
  }

  /** 云函数版状态上报暂无对应函数，保留接口避免调用方分支。 */
  async reportStatus(status = {}) {
    this.logger.warn?.('[gateway] reportStatus not mapped; ignored');
    return { ok: true, status: 200, accepted: false, data: { ok: true, accepted: false } };
  }

  async _invoke(name, data) {
    const now = this._now || Date.now;
    const startedAt = now();
    const requestId = randomUUID();
    const fn = LOG_FUNCTIONS.has(name) ? name : 'unknown';
    // info is not sampled: the start/failure pair must remain usable for local diagnosis.
    this.logger.info?.('[gateway] request started', { fn, request_id: requestId });
    const fail = (code, status, body, retryable, metadata = {}) => {
      const phase = PHASES.has(metadata.phase) ? metadata.phase : 'invoke-fetch';
      const elapsed = now() - startedAt;
      const diagnostic = {
        request_id: requestId,
        phase,
        elapsed_ms: Number.isFinite(elapsed) ? Math.max(0, Math.round(elapsed)) : 0,
        failure_kind: FAILURE_KINDS.has(metadata.failure_kind) ? metadata.failure_kind : 'error',
        timeout_ms: phase === 'token-fetch' ? 8000 : 10000,
      };
      // Explicit field/value allowlist, even with an injected logger. Business code/data remain
      // on TransportError for existing consumers, but raw response/error text never enters logs.
      this.logger.warn?.('[gateway] request failed', {
        fn, ...diagnostic,
        error_code: LOG_CODES.has(code) ? code : typeof code === 'string' && /^WERR_-?\d+$/.test(code) ? 'WECHAT_API_ERROR' : 'BUSINESS_ERROR',
        http_status: Number.isInteger(status) && status >= 0 && status <= 599 ? status : 0,
        retryable,
      });
      return Object.assign(new TransportError('[gateway] request failed', { code, status, data: body, retryable }), diagnostic);
    };
    let res;
    try {
      res = await invokeCloudFunction(this.config, name, data, {
        ...(this._fetchImpl ? { fetchImpl: this._fetchImpl } : {}),
        now, requestId, startedAt,
      });
    } catch (e) {
      // Existing token/fetch/configuration failure code and retry policy stay unchanged.
      throw fail('UPSTREAM_UNAVAILABLE', 0, null, true, e);
    }
    if (!res || res.ok !== true) {
      const bizCode = res && res.data && typeof res.data === 'object' ? res.data.error : null;
      const errcode = res ? res.errcode : -1;
      const code = bizCode || (errcode ? `WERR_${errcode}` : 'UPSTREAM_UNAVAILABLE');
      const status = res ? res.status : 0;
      const retryable = !isPermanentFailure({ status, data: res ? res.data : null });
      throw fail(code, status, res ? res.data : null, retryable, res || {});
    }
    if (!res.data || typeof res.data !== 'object' || Array.isArray(res.data)) {
      throw fail('INVALID_RESPONSE', res.status, null, true, { phase: 'invoke-body', failure_kind: 'invalid-response' });
    }
    this.logger.debug?.('[gateway] request succeeded', {
      fn, request_id: requestId, http_status: res.status, elapsed_ms: Math.max(0, Math.round(now() - startedAt)),
    });
    return { ok: true, status: res.status, data: res.data };
  }
}
