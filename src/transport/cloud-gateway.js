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
import { invokeCloudFunction } from '../cloud/wechat-auth.js';
import { appendAuthFields } from '../cloud/device-keys.js';
import { canonical } from '../lib/canonical.js';
import { TransportError, isPermanentFailure } from '../lib/outbox.js';
import { createLogger } from '../lib/log.js';

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
    this.logger.warn?.('[gateway] reportStatus 未映射云函数，已忽略', { status_keys: Object.keys(status) });
    return { ok: true, status: 200, accepted: false, data: { ok: true, accepted: false } };
  }

  async _invoke(name, data) {
    const startedAt = this._now ? this._now() : Date.now();
    this.logger.debug?.(`[gateway] invoke ${name} start`, { fn: name });
    let res;
    try {
      res = await invokeCloudFunction(this.config, name, data, {
        ...(this._fetchImpl ? { fetchImpl: this._fetchImpl } : {}),
        ...(this._now ? { now: this._now } : {}),
      });
    } catch (e) {
      // token 获取失败 / 网络异常 / 配置缺失：一律归一为可重试的规范错误
      this.logger.warn?.(`[gateway] ${name} failure: ${e.message}`, {
        fn: name, error_code: 'UPSTREAM_UNAVAILABLE', http_status: 0, retryable: true,
      });
      throw new TransportError(`[gateway] ${name} failure: ${e.message}`, {
        code: 'UPSTREAM_UNAVAILABLE', status: 0, data: null, retryable: true,
      });
    }
    if (!res || res.ok !== true) {
      const bizCode = res && res.data && typeof res.data === 'object' ? res.data.error : null;
      const errcode = res ? res.errcode : -1;
      const code = bizCode || (errcode ? `WERR_${errcode}` : 'UPSTREAM_UNAVAILABLE');
      const status = res ? res.status : 0;
      const retryable = isPermanentFailure({ status: res ? res.status : 0, data: res ? res.data : null }) ? false : true;
      this.logger.warn?.(`[gateway] ${name} failed: errcode=${errcode}${bizCode ? ` ${bizCode}` : ''}`, {
        fn: name, error_code: code, http_status: status, retryable,
      });
      throw new TransportError(`[gateway] ${name} failed: errcode=${errcode}${bizCode ? ` ${bizCode}` : ''}`, {
        code, status, data: res ? res.data : null, retryable,
      });
    }
    this.logger.debug?.(`[gateway] ${name} ok`, {
      fn: name, http_status: res.status, duration_ms: (this._now ? this._now() : Date.now()) - startedAt,
    });
    return { ok: true, status: res.status, data: res.data };
  }
}
