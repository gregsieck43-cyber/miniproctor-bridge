/**
 * EndpointTransport：直连云函数 HTTP 访问服务 URL（无需 AppSecret）。
 *
 * 面向公开运营形态：用户 bridge 只持有自己的 device 私钥与 token_hash，
 * 每个 POST 都带 ed25519 签名字段（auth_ts/auth_sig），云端 syncReport/pullCommands
 * 持 bindings.public_key 强制验签。AppSecret 永不离开小程序开发者本人。
 *
 * URL 形态（CloudBase HTTP 访问服务）：
 *   https://<envId>.service.tcloudbase.com/<functionName>
 * 返回：云函数 return 值即 HTTP body（无 resp_data 包装）。
 * 接口形状与 CloudGatewayTransport 完全一致：{ ok, status, data }。
 */
import { appendAuthFields } from '../cloud/device-keys.js';
import { canonical } from '../lib/canonical.js';

export class EndpointTransport {
  /**
   * @param {object} opts
   * @param {object} opts.config bridge 配置（用 config.relay.endpoints 基础 URL）
   * @param {string} opts.deviceId
   * @param {string|null} opts.tokenHash
   * @param {string|null} [opts.privateKey] PEM；配对前为 null（registerPairing 阶段无绑定无验签，云端按无公钥放行）
   * @param {number} [opts.timeoutMs]
   */
  constructor({ config, deviceId, tokenHash = null, privateKey = null, logger = console, fetchImpl, now }) {
    if (!config) throw new TypeError('EndpointTransport requires config');
    const base = (config.relay && config.relay.endpoints && config.relay.endpoints.baseUrl) || '';
    if (!base) throw new TypeError('relay.endpoints.baseUrl required (e.g. https://<env>.service.tcloudbase.com)');
    this.baseUrl = base.replace(/\/+$/, '');
    this.deviceId = deviceId;
    this.tokenHash = tokenHash;
    this.privateKey = privateKey;
    this.logger = logger;
    this.timeoutMs = (config.relay && config.relay.timeoutMs) || 10000;
    this._fetchImpl = fetchImpl;
    this._now = now;
  }

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
    this.logger.warn?.('[endpoint] reportStatus 未映射云函数，已忽略', Object.keys(status));
    return { ok: true, accepted: false };
  }

  async _invoke(name, data) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await (this._fetchImpl || fetch)(`${this.baseUrl}/${name}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(data),
        signal: controller.signal,
      });
      const json = await res.json().catch(() => null);
      const ok = res.ok && (json === null || json.ok !== false);
      return { ok, status: res.status, data: json };
    } catch (e) {
      this.logger.warn?.(`[endpoint] ${name} failed: ${e.message}`);
      return { ok: false, status: 0, data: null };
    } finally {
      clearTimeout(timer);
    }
  }
}
