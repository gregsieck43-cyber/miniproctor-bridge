/**
 * EndpointTransport：直连云函数 HTTP 访问服务 URL（无需 AppSecret）。
 *
 * 面向公开运营形态：用户 bridge 只持有自己的 device 私钥与 token_hash，
 * 每个 POST 都带 ed25519 签名字段（auth_ts/auth_sig），云端 syncReport/pullCommands
 * 持 bindings.public_key 强制验签。AppSecret 永不离开小程序开发者本人。
 *
 * URL 形态（CloudBase HTTP 访问服务默认域名）：
 *   https://<envId>-<suffix>.<region>.app.tcloudbase.com/<functionName>
 * 注意：不是 <envId>.service.tcloudbase.com——2026-08 经微信渠道开通的环境没有该旧格式域名。
 * 返回：云函数 return 值即 HTTP body（无 resp_data 包装；云端已做网关事件解包）。
 *
 * 统一错误语义（TASK-006/E06 修复）：成功返回 { ok:true, status, data }；
 * 网络失败 / HTTP 非 2xx / 非法 JSON / null body / HTTP200+ok:false 一律
 * **抛 TransportError**（定义于 lib/outbox.js，全桥唯一规范错误），调用方必须
 * catch 处理——禁止把失败响应当成功消费。
 */
import { appendAuthFields } from '../cloud/device-keys.js';
import { canonical } from '../lib/canonical.js';
import { TransportError, isPermanentFailure } from '../lib/outbox.js';
import { readJsonBodyCapped, RESPONSE_BODY_MAX_BYTES } from './body-limits.js';

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
    if (!base) throw new TypeError('relay.endpoints.baseUrl required (e.g. https://<env>-<suffix>.<region>.app.tcloudbase.com)');
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

  // reportStatus 已移除（TASK-017/E18）：此前是"未映射云函数、恒返回伪成功"的空实现。
  // 心跳职责由 pullCommands 承担（每次成功鉴权的 pull 刷新 binding.last_seen_at，
  // 空闲时轮询退避封顶 30s < 60s 在线阈值），无需独立状态上报调用点。

  async _invoke(name, data) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    // V1-014：计时器在 body 读取完成后才清理（外层 finally）——超时信号覆盖
    // 「连接 → headers → body → 解析」全程（R12：此前 body 等待期无期限可永久挂起）。
    try {
      let res;
      try {
        res = await (this._fetchImpl || fetch)(`${this.baseUrl}/${name}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(data),
          signal: controller.signal,
        });
      } catch (e) {
        throw new TransportError(`[endpoint] ${name} network failure: ${e.message}`, {
          code: 'UPSTREAM_UNAVAILABLE', status: 0, data: null, retryable: true,
        });
      }
      let json;
      try {
        json = await readJsonBodyCapped(res, RESPONSE_BODY_MAX_BYTES, { signal: controller.signal });
      } catch (e) {
        if (e && e.code === 'response-too-large') {
          throw new TransportError(`[endpoint] ${name} ${e.message}`, {
            code: 'RESPONSE_TOO_LARGE', status: res.status, data: null, retryable: true,
          });
        }
        // body 阶段超时（AbortError）或流读取失败：按网络失败归类可重试
        throw new TransportError(`[endpoint] ${name} body read failure: ${e.message}`, {
          code: 'UPSTREAM_UNAVAILABLE', status: 0, data: null, retryable: true,
        });
      }
      if (!res.ok || json === null || json.ok === false) {
        // 任何空/非法响应一律视失败：ok:false 业务失败保留 data 供逐事件分类
        const bizCode = json && typeof json === 'object' ? json.error : null;
        const retryable = !isPermanentFailure({ status: res.status, data: json });
        throw new TransportError(
          `[endpoint] ${name} failed: HTTP ${res.status}${bizCode ? ` ${bizCode}` : ' (invalid/empty body)'}`,
          {
            code: bizCode || (!res.ok ? `HTTP_${res.status}` : 'INVALID_RESPONSE'),
            status: res.status,
            data: json,
            retryable,
          },
        );
      }
      return { ok: true, status: res.status, data: json };
    } finally {
      clearTimeout(timer);
    }
  }
}
