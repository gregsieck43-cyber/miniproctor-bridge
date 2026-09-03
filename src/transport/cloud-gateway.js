/**
 * CloudGatewayTransport：经微信云开发 HTTP API 触达云函数。
 * 与 HttpPollTransport 同一接口（pushEvents/pullCommands/registerPairing/
 * pairingStatus/reportStatus），relay.kind === 'cloud' 时由 main.js 选用。
 *
 * 安全：凭据只出现在 POST body（不进 URL/查询串）；请求附 ed25519 签名
 * 字段 auth_ts/auth_sig，云端有公钥的绑定强制验签。
 */
import { invokeCloudFunction } from '../cloud/wechat-auth.js';
import { appendAuthFields } from '../cloud/device-keys.js';
import { canonical } from '../lib/canonical.js';

export class CloudGatewayTransport {
  /**
   * @param {object} opts
   * @param {object} opts.config    全量 bridge 配置（需 wechat.appid/secret/envId）
   * @param {string} opts.deviceId
   * @param {string|null} opts.tokenHash
   * @param {string|null} [opts.privateKey] PEM；为空则不附加签名字段（配对前阶段）
   */
  constructor({ config, deviceId, tokenHash = null, privateKey = null, logger = console, fetchImpl, now }) {
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
    if (!events?.length) return { ok: true, accepted: 0 };
    return this._invoke('syncReport', this._authed({ token_hash: this.tokenHash, events }));
  }

  async pullCommands() {
    return this._invoke('pullCommands', this._authed({ token_hash: this.tokenHash }));
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
    this.logger.warn?.('[gateway] reportStatus 未映射云函数，已忽略', Object.keys(status));
    return { ok: true, accepted: false };
  }

  async _invoke(name, data) {
    try {
      const res = await invokeCloudFunction(this.config, name, data, {
        ...(this._fetchImpl ? { fetchImpl: this._fetchImpl } : {}),
        ...(this._now ? { now: this._now } : {}),
      });
      return res;
    } catch (e) {
      this.logger.warn?.(`[gateway] ${name} failed: ${e.message}`);
      return { ok: false, status: 0, data: null };
    }
  }
}
