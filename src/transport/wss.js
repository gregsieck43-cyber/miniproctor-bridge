/**
 * Optional WSS transport (W5+). Same interface as HttpPollTransport:
 * - pushEvents(events)
 * - pullCommands()
 * - reportStatus(status)
 * The relay side is expected to answer { type:'commands', commands:[...] } to
 * { type:'pull_commands' }. MVP keeps using HTTP polling; this file keeps the
 * protocol seam real.
 */
export class WssTransport {
  constructor({ url, tokenHash = null, timeoutMs = 5000, logger = console }) {
    if (!url) throw new TypeError('WssTransport requires url');
    this.url = url;
    this.tokenHash = tokenHash;
    this.timeoutMs = timeoutMs;
    this.logger = logger;
    this.ws = null;
    this.pending = new Map();
    this.seq = 0;
  }

  async connect() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return this.ws;
    this.ws = new WebSocket(this.url);
    this.ws.addEventListener('message', (event) => {
      let msg = null;
      try { msg = JSON.parse(event.data); } catch { msg = null; }
      if (!msg || !msg.request_id) return;
      const resolve = this.pending.get(msg.request_id);
      if (resolve) {
        this.pending.delete(msg.request_id);
        resolve({ ok: true, status: 200, data: msg });
      }
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('wss-connect-timeout')), this.timeoutMs);
      this.ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      this.ws.addEventListener('error', (err) => { clearTimeout(timer); reject(err); }, { once: true });
    });
    return this.ws;
  }

  _send(obj) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) throw new Error('wss-not-connected');
    this.ws.send(JSON.stringify(obj));
  }

  _request(type, payload = {}) {
    const requestId = `r_${Date.now()}_${++this.seq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`${type}-timeout`));
      }, this.timeoutMs);
      this.pending.set(requestId, (value) => { clearTimeout(timer); resolve(value); });
      try {
        this._send({ type, request_id: requestId, token_hash: this.tokenHash, ...payload });
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(err);
      }
    });
  }

  async pushEvents(events) {
    if (!events?.length) return { ok: true, accepted: 0 };
    return this._request('report', { events });
  }

  async pullCommands() {
    return this._request('pull_commands');
  }

  async reportStatus(status = {}) {
    return this._request('status', status);
  }

  close() {
    this.ws?.close?.();
    this.ws = null;
    for (const resolve of this.pending.values()) resolve({ ok: false, status: 0, data: { error: 'closed' } });
    this.pending.clear();
  }
}
