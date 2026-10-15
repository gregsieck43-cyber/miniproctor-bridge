import http from 'node:http';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {requestParentChatCompletion,prepareNativeParentChat,frameNativeParentChat,getParentChatFailureDiagnostic} from './parent-chat-provider.js';

const LOCAL_FAILURE_CODES = new Map([
  ['parent-chat-text-only','parent-chat-text-only'],['parent-chat-request-invalid','parent-chat-request-invalid'],
  ['dsh-gateway-key-in-body','parent-chat-native-credential-blocked'],['dsh-gateway-tools-disabled','parent-chat-native-tools-disabled'],
  ['dsh-gateway-logs-disabled','parent-chat-native-upload-disabled'],['dsh-gateway-body-limit','parent-chat-native-body-limit'],
  ['dsh-gateway-body-timeout','parent-chat-native-body-timeout'],
]);

const UPSTREAM = 'https://api.deepseek.com/anthropic/v1/messages';
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
    const error = () => { cleanup(); reject(failure('dsh-gateway-body-failed')); };
    const end = () => { cleanup(); resolve(Buffer.concat(chunks)); };
    const data = chunk => {
      bytes += chunk.length;
      if (bytes > maximum) { cleanup(); request.resume(); reject(failure('dsh-gateway-body-limit')); }
      else chunks.push(chunk);
    };
    const timer = setTimeout(() => { cleanup(); request.resume(); reject(failure('dsh-gateway-body-timeout')); }, 5000);
    request.on('data', data); request.once('end', end); request.once('error', error);
  });
}

/** Retain only enough trailing bytes to detect an exact key crossing chunk boundaries. */
function withoutCredential(key, maximum) {
  const secret = Buffer.from(key); let tail = Buffer.alloc(0), bytes = 0;
  return new Transform({
    transform(chunk, _encoding, done) {
      bytes += chunk.length;
      if (bytes > maximum) { done(failure('dsh-gateway-response-limit')); return; }
      const buffer = Buffer.concat([tail, chunk]);
      if (buffer.includes(secret)) { done(failure('dsh-gateway-credential-echo')); return; }
      const safe = Math.max(0, buffer.length - secret.length + 1);
      this.push(buffer.subarray(0, safe)); tail = buffer.subarray(safe); done();
    },
    flush(done) { this.push(tail); done(); },
  });
}

/** A per-task loopback route. The real provider key never leaves this parent process. */
export class DshMessagesGateway extends EventEmitter {
  #providerKey;
  #chatProvider;
  #reportedModel = null;
  #fetchStarted = 0;
  #lastFailure = null;
  #lastRefusal = null;
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

  constructor({ providerKey, chatProvider = null, fetchImpl = globalThis.fetch, maxCalls = 8,
    maxBodyBytes = 2 * 1024 * 1024, requestTimeoutMs = 45000 } = {}) {
    super();
    if (!chatProvider?.configured && (typeof providerKey !== 'string' || providerKey.length < 9)) throw failure('dsh-provider-key-missing');
    if (typeof fetchImpl !== 'function') throw new TypeError('DshMessagesGateway requires fetch');
    this.#chatProvider = chatProvider;
    this.#providerKey = chatProvider?.configured ? null : providerKey;
    this.#fetch = fetchImpl;
    this.#maxCalls = chatProvider?.configured ? 1 : limit(maxCalls, 8, 8);
    this.#maxBodyBytes = limit(maxBodyBytes, 2 * 1024 * 1024, 2 * 1024 * 1024);
    this.#timeoutMs = limit(requestTimeoutMs, 45000, 45000);
  }

  containsSecret(value) {
    return this.#chatProvider?.containsSecret(value) || Boolean(this.#providerKey && String(value).includes(this.#providerKey));
  }
  redact(value) { return this.#chatProvider ? this.#chatProvider.redact(value) : String(value).split(this.#providerKey).join('[REDACTED_PROVIDER_KEY]'); }
  get childKey() { return this.#childKey; }
  get baseUrl() {
    const address = this.#server?.address();
    if (!address || typeof address !== 'object') throw failure('dsh-gateway-not-listening');
    return `http://127.0.0.1:${address.port}/v1/messages`;
  }

  async start() {
    if (this.#server || this.#closing) throw failure('dsh-gateway-start-state');
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
    let nativeRequestBytes = null;
    const refuse = (status, authenticated = true, failureCode = 'parent-chat-native-route-refused') => {
      if (authenticated) this.#counts.rejected++;
      if(authenticated && this.#chatProvider?.configured)this.#lastRefusal=Object.freeze({failure_code:failureCode,stage:'native-admission',
        fetch_started:false,http_status:status,request_bytes:nativeRequestBytes,response_bytes:0,finish_reason:null,usage_present:false});
      if (!response.destroyed) { response.writeHead(status); response.end('DSH local route refused'); }
    };
    if (this.#closing || request.socket.remoteAddress !== '127.0.0.1'
      || request.headers['x-api-key'] !== this.#childKey) { refuse(401, false); request.resume(); return; }
    if (request.url !== '/v1/messages') { refuse(404); request.resume(); return; }
    if (request.method !== 'POST') { refuse(405); request.resume(); return; }
    let body, value, chatOptions;
    try {
      body = await readBody(request, this.#maxBodyBytes);nativeRequestBytes=body.length;
      if (this.containsSecret(body)) throw failure('dsh-gateway-key-in-body');
      value = JSON.parse(body);
      if (this.containsSecret(value) || body.includes(Buffer.from(this.#childKey)) || JSON.stringify(value).includes(this.#childKey)) throw failure('dsh-gateway-key-in-body');
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw failure('dsh-gateway-json-invalid');
      if (value.tools !== undefined && (!Array.isArray(value.tools) || value.tools.length !== 0)) {
        throw failure('dsh-gateway-tools-disabled');
      }
      if (Object.keys(value).some(key => /session.*log|plugin.*package/i.test(key))) {
        throw failure('dsh-gateway-logs-disabled');
      }
      if (this.#chatProvider?.configured) chatOptions = prepareNativeParentChat(value, {messagesFormat:true});
    } catch (error) {
      refuse(error.code === 'dsh-gateway-body-limit' ? 413 : error.code === 'dsh-gateway-body-timeout' ? 408 : 400,
        true,LOCAL_FAILURE_CODES.get(error.code)||'parent-chat-native-request-invalid');
      return;
    }
    if (this.#counts.contacted >= this.#maxCalls) { this.#counts.quota_exceeded = true; refuse(429,true,'parent-chat-native-call-quota'); return; }
    const controller = new AbortController();
    this.#controllers.add(controller);
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    const disconnected = () => { if (!response.writableFinished) controller.abort(); };
    response.once('close', disconnected);
    try {
      this.#counts.contacted++;
      this.emit('request-started', { call: this.#counts.contacted });
      if (chatOptions) {
        const result = await requestParentChatCompletion(this.#chatProvider, {...chatOptions,thinking:{type:'disabled'},fetchImpl:this.#fetch,signal:controller.signal,timeoutMs:this.#timeoutMs,
          onDiagnostic:diagnostic=>{if(diagnostic.stage==='fetch-started' && diagnostic.failure_code===null)this.#fetchStarted++;}});
        if (controller.signal.aborted || response.destroyed) throw failure('dsh-gateway-aborted');
        this.#reportedModel = result.model;
        const framed = frameNativeParentChat(result, {messagesFormat:true,stream:value.stream === true});
        response.writeHead(200, {'Content-Type':framed.contentType}); response.end(framed.body);
        this.#counts.successful++; return;
      }
      const upstream = await this.#fetch(UPSTREAM, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': this.#providerKey, 'anthropic-version': '2023-06-01' },
        body, redirect: 'error', signal: controller.signal,
      });
      response.writeHead(upstream.status, { 'Content-Type': /^text\/event-stream/i.test(upstream.headers.get('content-type') || '')
        ? 'text/event-stream' : 'application/json' });
      await pipeline(Readable.fromWeb(upstream.body), withoutCredential(this.#providerKey, 8 * 1024 * 1024), response);
      if (upstream.status >= 200 && upstream.status < 300) this.#counts.successful++;
      else this.#counts.failed++;
    } catch (error) {
      this.#counts.failed++;
      if(this.#chatProvider?.configured)this.#lastFailure=getParentChatFailureDiagnostic(error)||Object.freeze({
        failure_code:'parent-chat-native-response-failed',stage:'native-response',fetch_started:this.#fetchStarted>0,
        http_status:null,request_bytes:null,response_bytes:0,finish_reason:null,usage_present:false});
      if (!response.destroyed) {
        if (!response.headersSent) response.writeHead(502);
        response.end('DSH upstream request failed');
      }
    } finally {
      clearTimeout(timer); response.off('close', disconnected); this.#controllers.delete(controller);
      this.emit('request-ended', { active: this.#controllers.size });
    }
  }

  summary() { return { ...this.#counts, active: this.#controllers.size, closed: Boolean(this.#closing),
    ...(this.#chatProvider?.configured ? {provider:'commandcode',upstream_model:this.#chatProvider.model,native_model:'deepseek-v4-flash',reported_upstream_model:this.#reportedModel,response_mode:'parent-buffered',
      fetch_started:this.#fetchStarted,last_failure:this.#lastFailure,last_refusal:this.#lastRefusal} : {}) }; }

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
