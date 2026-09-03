export class HttpPollTransport {
  constructor({ baseUrl, timeoutMs = 5000, deviceId = 'bridge', tokenHash = null, logger = console }) {
    if (!baseUrl) throw new TypeError('HttpPollTransport requires baseUrl');
    this.baseUrl = String(baseUrl).replace(/\/+$/, '');
    this.timeoutMs = timeoutMs;
    this.deviceId = deviceId;
    this.tokenHash = tokenHash;
    this.logger = logger;
  }

  async pushEvents(events) {
    if (!events?.length) return { ok: true, accepted: 0 };
    return this._post('/report', { device_id: this.deviceId, token_hash: this.tokenHash, events });
  }

  async pullCommands() {
    const qs = new URLSearchParams({ device_id: this.deviceId, token_hash: this.tokenHash || '' }).toString();
    return this._get(`/commands?${qs}`);
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
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      return { ok: res.ok, status: res.status, data: await res.json().catch(() => null) };
    } finally { clearTimeout(timer); }
  }

  async _get(path) {
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(url, { signal: controller.signal });
      return { ok: res.ok, status: res.status, data: await res.json().catch(() => null) };
    } finally { clearTimeout(timer); }
  }
}
