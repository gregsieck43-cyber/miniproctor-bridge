/**
 * HttpPollTransport：自建中继短轮询（mock 测试 / 自建 relay 形态）。
 *
 * 统一错误语义（TASK-006/E06 修复）：成功返回 { ok:true, status, data }；
 * 网络失败 / HTTP 非 2xx / 非法 JSON / HTTP200+ok:false 一律抛 TransportError
 * （lib/outbox.js 全桥唯一规范错误），调用方必须 catch——禁止把失败响应当成功消费。
 */
import { TransportError, isPermanentFailure } from '../lib/outbox.js';
import { createLogger } from '../lib/log.js';

export class HttpPollTransport {
  constructor({ baseUrl, timeoutMs = 5000, deviceId = 'bridge', tokenHash = null, logger = createLogger('http-poll') }) {
    if (!baseUrl) throw new TypeError('HttpPollTransport requires baseUrl');
    this.baseUrl = String(baseUrl).replace(/\/+$/, '');
    this.timeoutMs = timeoutMs;
    this.deviceId = deviceId;
    this.tokenHash = tokenHash;
    this.logger = logger;
  }

  async pushEvents(events) {
    if (!events?.length) return { ok: true, status: 200, accepted: 0, data: { ok: true, accepted: 0 } };
    return this._post('/report', { device_id: this.deviceId, token_hash: this.tokenHash, events });
  }

  async pullCommands() {
    const qs = new URLSearchParams({ device_id: this.deviceId, token_hash: this.tokenHash || '' }).toString();
    return this._get(`/commands?${qs}`);
  }

  /** 命令执行结果上报（TASK-007；自建 relay 需实现 /ackCommand）。 */
  async ackCommand(payload) {
    return this._post('/ackCommand', { device_id: this.deviceId, token_hash: this.tokenHash, ...payload });
  }

  async registerPairing(offer) {
    return this._post('/register-pairing', {
      pairing_id: offer.pairing_id,
      device_id: offer.device_id,
      device_name: this.deviceId,
      nonce_hash: offer.nonce_hash,
      token_hash: offer.token_hash,
      pairing_code_hash: offer.pairing_code_hash,
      ttl_ms: offer.expires_at - Date.now(),
    });
  }

  async pairingStatus(pairingId) {
    const qs = new URLSearchParams({ pairing_id: pairingId }).toString();
    return this._get(`/pairing-status?${qs}`);
  }

  async reportStatus(status = {}) {
    return this._post('/status', { device_id: this.deviceId, token_hash: this.tokenHash, ...status });
  }

  async _post(path, body) {
    return this._request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  async _get(path) {
    return this._request(path, { method: 'GET' });
  }

  async _request(path, init) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    // 日志/错误消息只带路径不带查询串：pullCommands 的 GET 查询含 token_hash（等价凭据），
    // 绝不进入日志或持久化的 last_error/dead_reason（TASK-022 脱敏红线）。
    const pathForLog = String(path).split('?')[0];
    let res;
    try {
      res = await fetch(`${this.baseUrl}${path}`, { ...init, signal: controller.signal });
    } catch (e) {
      this.logger.warn?.(`[http-poll] ${pathForLog} network failure: ${e.message}`, {
        path: pathForLog, error_code: 'UPSTREAM_UNAVAILABLE', http_status: 0, retryable: true,
      });
      throw new TransportError(`[http-poll] ${pathForLog} network failure: ${e.message}`, {
        code: 'UPSTREAM_UNAVAILABLE', status: 0, data: null, retryable: true,
      });
    } finally {
      clearTimeout(timer);
    }
    const json = await res.json().catch(() => null);
    if (!res.ok || json === null || json.ok === false) {
      const bizCode = json && typeof json === 'object' ? json.error : null;
      const code = bizCode || (!res.ok ? `HTTP_${res.status}` : 'INVALID_RESPONSE');
      const retryable = !isPermanentFailure({ status: res.status, data: json });
      this.logger.warn?.(
        `[http-poll] ${pathForLog} failed: HTTP ${res.status}${bizCode ? ` ${bizCode}` : ' (invalid/empty body)'}`,
        { path: pathForLog, error_code: code, http_status: res.status, retryable },
      );
      throw new TransportError(
        `[http-poll] ${pathForLog} failed: HTTP ${res.status}${bizCode ? ` ${bizCode}` : ' (invalid/empty body)'}`,
        {
          code,
          status: res.status,
          data: json,
          retryable,
        },
      );
    }
    return { ok: true, status: res.status, data: json };
  }
}
