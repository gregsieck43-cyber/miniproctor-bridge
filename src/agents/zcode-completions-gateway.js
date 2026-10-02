import http from 'node:http';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const UPSTREAM = 'https://api.deepseek.com/chat/completions';
function failure(code) { return Object.assign(new Error(code), { code }); }
function limit(value, fallback, maximum) {
  return Number.isFinite(value) ? Math.min(maximum, Math.max(1, Math.floor(value))) : fallback;
}

function readBody(request, maximum) {
  return new Promise((resolve, reject) => {
    const chunks = []; let bytes = 0;
    const cleanup = () => {
      clearTimeout(timer); request.off('data', data); request.off('end', end); request.off('error', error);
    };
    const error = () => { cleanup(); reject(failure('zcode-gateway-body-failed')); };
    const end = () => { cleanup(); resolve(Buffer.concat(chunks)); };
    const data = chunk => {
      bytes += chunk.length;
      if (bytes > maximum) { cleanup(); request.resume(); reject(failure('zcode-gateway-body-limit')); }
      else chunks.push(chunk);
    };
    const timer = setTimeout(() => { cleanup(); request.resume(); reject(failure('zcode-gateway-body-timeout')); }, 5000);
    request.on('data', data); request.once('end', end); request.once('error', error);
  });
}

/** Retain only enough trailing bytes to detect an exact key crossing chunk boundaries. */
function withoutCredential(key, maximum) {
  const secret = Buffer.from(key); let tail = Buffer.alloc(0), bytes = 0;
  return new Transform({
    transform(chunk, _encoding, done) {
      bytes += chunk.length;
      if (bytes > maximum) { done(failure('zcode-gateway-response-limit')); return; }
      const buffer = Buffer.concat([tail, chunk]);
      if (buffer.includes(secret)) { done(failure('zcode-gateway-credential-echo')); return; }
      const safe = Math.max(0, buffer.length - secret.length + 1);
      this.push(buffer.subarray(0, safe)); tail = buffer.subarray(safe); done();
    },
    flush(done) { this.push(tail); done(); },
  });
}

/** A per-task loopback route. The real provider key never leaves this parent process. */
export class ZcodeCompletionsGateway extends EventEmitter {
  #providerKey;
  #childKey = crypto.randomBytes(32).toString('hex');
  #server = null;
  #controllers = new Set();
  #tasks = new Set();
  #closing = null;
  #fetch;
  #counts = { contacted: 0, successful: 0, failed: 0, rejected: 0, quota_exceeded: false };
  #maxCalls;
  #maxBodyBytes;
  #timeoutMs;

  constructor({ providerKey, fetchImpl = globalThis.fetch, maxCalls = 8,
    maxBodyBytes = 2 * 1024 * 1024, requestTimeoutMs = 45000 } = {}) {
    super();
    if (typeof providerKey !== 'string' || providerKey.length < 9) throw failure('zcode-provider-key-missing');
    if (typeof fetchImpl !== 'function') throw new TypeError('ZcodeCompletionsGateway requires fetch');
    this.#providerKey = providerKey;
    this.#fetch = fetchImpl;
    this.#maxCalls = limit(maxCalls, 8, 8);
    this.#maxBodyBytes = limit(maxBodyBytes, 2 * 1024 * 1024, 2 * 1024 * 1024);
    this.#timeoutMs = limit(requestTimeoutMs, 45000, 45000);
  }

  get childKey() { return this.#childKey; }
  get baseUrl() {
    const address = this.#server?.address();
    if (!address || typeof address !== 'object') throw failure('zcode-gateway-not-listening');
    return `http://127.0.0.1:${address.port}/v1/chat/completions`;
  }

  async start() {
    if (this.#server || this.#closing) throw failure('zcode-gateway-start-state');
    this.#server = http.createServer((request, response) => {
      const task = this.#serve(request, response);
      this.#tasks.add(task); task.finally(() => this.#tasks.delete(task));
    });
    this.#server.maxHeadersCount = 30;
    this.#server.headersTimeout = 5000;
    this.#server.requestTimeout = 5000;
    await new Promise((resolve, reject) => {
      this.#server.once('error', reject);
      this.#server.listen(0, '127.0.0.1', () => { this.#server.off('error', reject); resolve(); });
    });
    return this.baseUrl;
  }

  async #serve(request, response) {
    const refuse = (status, authenticated = true) => {
      if (authenticated) this.#counts.rejected++;
      if (!response.destroyed) { response.writeHead(status); response.end('ZCode local route refused'); }
    };
    if (this.#closing || request.socket.remoteAddress !== '127.0.0.1'
      || request.headers.authorization !== 'Bearer '+this.#childKey) { refuse(401, false); request.resume(); return; }
    if (request.url !== '/v1/chat/completions') { refuse(404); request.resume(); return; }
    if (request.method !== 'POST') { refuse(405); request.resume(); return; }
    let body;
    try {
      body = await readBody(request, this.#maxBodyBytes);
      if (body.includes(Buffer.from(this.#providerKey))) throw failure('zcode-gateway-key-in-body');
      const value = JSON.parse(body);
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw failure('zcode-gateway-json-invalid');
      if (value.model !== 'deepseek-v4-flash' || !Number.isInteger(value.max_tokens)
        || value.max_tokens < 1 || value.max_tokens > 2048) throw failure('zcode-gateway-model-unverified');
      if (value.tools !== undefined && (!Array.isArray(value.tools) || value.tools.length !== 0)) {
        throw failure('zcode-gateway-tools-disabled');
      }
      if (Object.keys(value).some(key => /session.*log|plugin.*package/i.test(key))) {
        throw failure('zcode-gateway-logs-disabled');
      }
    } catch (error) {
      refuse(error.code === 'zcode-gateway-body-limit' ? 413 : error.code === 'zcode-gateway-body-timeout' ? 408 : 400);
      return;
    }
    if (this.#counts.contacted >= this.#maxCalls) { this.#counts.quota_exceeded = true; refuse(429); return; }
    const controller = new AbortController();
    this.#controllers.add(controller);
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    const disconnected = () => { if (!response.writableFinished) controller.abort(); };
    response.once('close', disconnected);
    try {
      this.#counts.contacted++;
      this.emit('request-started', { call: this.#counts.contacted });
      const upstream = await this.#fetch(UPSTREAM, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer '+this.#providerKey },
        body, redirect: 'error', signal: controller.signal,
      });
      response.writeHead(upstream.status, { 'Content-Type': /^text\/event-stream/i.test(upstream.headers.get('content-type') || '')
        ? 'text/event-stream' : 'application/json' });
      await pipeline(Readable.fromWeb(upstream.body), withoutCredential(this.#providerKey, 8 * 1024 * 1024), response);
      if (upstream.status >= 200 && upstream.status < 300) this.#counts.successful++;
      else this.#counts.failed++;
    } catch {
      this.#counts.failed++;
      if (!response.destroyed) {
        if (!response.headersSent) response.writeHead(502);
        response.end('ZCode upstream request failed');
      }
    } finally {
      clearTimeout(timer); response.off('close', disconnected); this.#controllers.delete(controller);
      this.emit('request-ended', { active: this.#controllers.size });
    }
  }

  summary() { return { ...this.#counts, active: this.#controllers.size, closed: Boolean(this.#closing) }; }

  close() {
    if (this.#closing) return this.#closing;
    this.#closing = Promise.resolve().then(async () => {
      for (const controller of this.#controllers) controller.abort();
      if (!this.#server) return;
      const ended = new Promise(resolve => this.#server.close(resolve));
      this.#server.closeAllConnections();
      await Promise.allSettled([...this.#tasks]);
      await ended;
    });
    return this.#closing;
  }
}
