import http from 'node:http';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { requestParentChatCompletion, getParentChatFailureDiagnostic } from './parent-chat-provider.js';

const ownedGatewayFailures = new WeakSet();
const failure = code => { const error = Object.assign(new Error(code), { code }); ownedGatewayFailures.add(error); return error; };
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const FAILURE_FIELDS = Object.freeze(['failure_code', 'stage', 'fetch_started', 'http_status', 'request_bytes', 'response_bytes', 'finish_reason', 'usage_present', 'transport_failure']);
function failureProjection(error, stage) {
  // Only the shared helper's WeakMap-minted metadata is trusted. Never inspect
  // arbitrary error.diagnostic/message/code/getters supplied by a transport.
  const trusted = getParentChatFailureDiagnostic(error);
  if (trusted) return Object.freeze(Object.fromEntries(FAILURE_FIELDS.filter(key => Object.hasOwn(trusted, key)).map(key => [key, trusted[key]])));
  const code = ownedGatewayFailures.has(error) && ['native-chat-upstream-invalid', 'native-chat-upstream-aborted', 'native-chat-request-invalid'].includes(error.code)
    ? error.code : 'native-chat-upstream-unknown';
  return Object.freeze({ failure_code: code, stage });
}
const fail = (refusalCode = 'native-chat-request-invalid') => { throw Object.assign(failure('native-chat-request-invalid'), { refusalCode }); };
function keys(value, allowed, refusalCode) { if (!object(value) || Object.keys(value).some(key => !allowed.includes(key))) fail(refusalCode); }
const REFUSAL_STAGES = Object.freeze({
  'native-chat-request-fields-invalid': 'request-fields', 'native-chat-input-fields-invalid': 'input-fields',
  'native-chat-content-fields-invalid': 'content-fields', 'native-chat-reasoning-fields-invalid': 'reasoning-fields',
  'native-chat-input-id-null': 'input-id', 'native-chat-input-id-type': 'input-id',
  'native-chat-input-id-length': 'input-id', 'native-chat-input-id-chars': 'input-id',
  'native-chat-request-invalid': 'text-schema', 'native-chat-secret-input': 'secret-input',
});
const DIAGNOSTIC_FIELDS = new Set(['model', 'stream', 'tools', 'tool_choice', 'temperature', 'top_p', 'metadata', 'messages', 'system',
  'max_tokens', 'thinking', 'stop_sequences', 'output_config', 'input', 'instructions', 'max_output_tokens', 'store', 'parallel_tool_calls',
  'reasoning', 'text', 'include', 'prompt_cache_key', 'client_metadata', 'previous_response_id', 'background', 'type', 'role', 'content',
  'id', 'status', 'phase', 'end_turn', 'cache_control', 'effort', 'summary', 'format', 'verbosity', 'service_tier', 'truncation',
  'safety_identifier', 'user', 'stream_options']);
function refusalShape(raw) {
  let unknown = 0, truncated = false;
  const names = value => {
    if (!object(value)) return [];
    const all = Object.keys(value); unknown += all.filter(name => !DIAGNOSTIC_FIELDS.has(name)).length;
    const safe = all.filter(name => DIAGNOSTIC_FIELDS.has(name)); if (safe.length > 40) truncated = true;
    return safe.slice(0, 40);
  };
  const requestFields = names(raw), inputFields = new Set(), contentFields = new Set();
  const input = Array.isArray(raw?.input) ? raw.input : Array.isArray(raw?.messages) ? raw.messages : [];
  if (input.length > 8) truncated = true;
  for (const item of input.slice(0, 8)) {
    for (const name of names(item)) inputFields.add(name);
    const content = Array.isArray(item?.content) ? item.content : [];
    if (content.length > 8) truncated = true;
    for (const part of content.slice(0, 8)) for (const name of names(part)) contentFields.add(name);
  }
  return { request_fields: requestFields.sort(), input_fields: [...inputFields].sort().slice(0, 40),
    content_fields: [...contentFields].sort().slice(0, 40), unknown_field_count: unknown,
    native_declared_tools: Array.isArray(raw?.tools) ? Math.min(raw.tools.length, 129) : null, shape_truncated: truncated };
}
function text(value, kind) {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value) || value.length > 256) fail();
  return value.map(part => {
    keys(part, ['type', 'text', 'cache_control'], 'native-chat-content-fields-invalid');
    if (!kind.includes(part.type) || typeof part.text !== 'string') fail();
    if (part.cache_control !== undefined) { keys(part.cache_control, ['type', 'ttl']); if (part.cache_control.type !== 'ephemeral') fail(); }
    return part.text;
  }).join('');
}

/** Protocol interoperability only. No authentication/account/model-entitlement API. */
export function translateNativeChatRequest(format, raw, { model } = {}) {
  const common = ['model', 'stream', 'tools', 'tool_choice', 'temperature', 'top_p', 'metadata'];
  keys(raw, [...common, ...(format === 'messages'
    ? ['messages', 'system', 'max_tokens', 'thinking', 'stop_sequences', 'output_config']
    : format === 'responses' ? ['input', 'instructions', 'max_output_tokens', 'store', 'parallel_tool_calls', 'reasoning', 'text', 'include', 'prompt_cache_key', 'client_metadata', 'previous_response_id', 'background'] : [])], 'native-chat-request-fields-invalid');
  if (!['messages', 'responses'].includes(format) || raw.model !== model
    || raw.stream !== undefined && typeof raw.stream !== 'boolean'
    || raw.tools !== undefined && (!Array.isArray(raw.tools) || raw.tools.length > 128 || raw.tools.some(tool => !object(tool)) || Buffer.byteLength(JSON.stringify(raw.tools)) > 256 * 1024)
    || raw.tool_choice !== undefined && !['none', 'auto'].includes(raw.tool_choice)
      && !(format === 'messages' && object(raw.tool_choice) && ['none', 'auto'].includes(raw.tool_choice.type) && Object.keys(raw.tool_choice).length === 1)) fail();
  const requestedBudget = format === 'messages' ? raw.max_tokens : raw.max_output_tokens;
  if (requestedBudget !== undefined && (!Number.isSafeInteger(requestedBudget) || requestedBudget < 1)) fail();
  // The parent is the execution boundary: omitted/unbounded native defaults may
  // never increase the effective single upstream request above 512 output tokens.
  const budget = requestedBudget === undefined ? 512 : Math.min(512, requestedBudget);
  // Features that cannot be represented losslessly as plain chat text are rejected.
  if (raw.thinking !== undefined && (!object(raw.thinking) || raw.thinking.type !== 'disabled' || Object.keys(raw.thinking).length !== 1)
    || raw.stop_sequences !== undefined && (!Array.isArray(raw.stop_sequences) || raw.stop_sequences.length)
    || raw.previous_response_id != null || raw.background === true || raw.store === true
    || raw.parallel_tool_calls !== undefined && typeof raw.parallel_tool_calls !== 'boolean'
    || raw.include !== undefined && (!Array.isArray(raw.include) || raw.include.some(value => value !== 'reasoning.encrypted_content') || raw.include.length > 1)) fail();
  if (raw.output_config !== undefined) {
    keys(raw.output_config, ['effort']);
    if (raw.output_config.effort !== undefined && !['low', 'medium', 'high', 'xhigh', 'max'].includes(raw.output_config.effort)) fail();
  }
  if (raw.reasoning !== undefined) { keys(raw.reasoning, ['effort', 'summary'], 'native-chat-reasoning-fields-invalid'); if (raw.reasoning.effort && raw.reasoning.effort !== 'none' || raw.reasoning.summary != null && raw.reasoning.summary !== 'none') fail(); }
  if (raw.text !== undefined) { keys(raw.text, ['format', 'verbosity']); if (raw.text.format) { keys(raw.text.format, ['type']); if (raw.text.format.type !== 'text') fail(); } }
  const messages = [];
  const system = format === 'messages' ? raw.system : raw.instructions;
  if (system != null) messages.push({ role: 'system', content: text(system, ['text']) });
  const input = format === 'messages' ? raw.messages : raw.input;
  if (typeof input === 'string' && format === 'responses') messages.push({ role: 'user', content: input });
  else {
    if (!Array.isArray(input) || !input.length || input.length > 256) fail();
    for (const item of input) {
      keys(item, format === 'responses' ? ['type', 'role', 'content', 'id'] : ['type', 'role', 'content'], 'native-chat-input-fields-invalid');
      if (item.type !== undefined && item.type !== 'message' || !['system', 'developer', 'user', 'assistant'].includes(item.role)) fail();
      // The official native Responses stream may attach an opaque message ID.
      // It is local metadata, bounded here, never forwarded to ChatCompletions.
      if (format === 'responses' && Object.hasOwn(item, 'id')) {
        if (item.id === null) fail('native-chat-input-id-null');
        if (typeof item.id !== 'string') fail('native-chat-input-id-type');
        if (item.id.length < 1 || item.id.length > 128) fail('native-chat-input-id-length');
        if (!/^[A-Za-z0-9_.:-]+$/u.test(item.id)) fail('native-chat-input-id-chars');
      }
      if (format === 'messages' && !['user', 'assistant'].includes(item.role)) fail();
      messages.push({ role: item.role === 'developer' ? 'system' : item.role, content: text(item.content, format === 'messages' ? ['text'] : ['input_text', 'output_text']) });
    }
  }
  if (!messages.some(message => message.role === 'user' && message.content.trim()) || Buffer.byteLength(JSON.stringify(messages)) > 1024 * 1024) fail();
  const out = { messages, max_tokens: budget };
  Object.defineProperty(out, 'audit', { value: Object.freeze({ native_declared_tools: raw.tools?.length || 0,
    requested_max_output_tokens: requestedBudget ?? null, effective_max_output_tokens: budget, upstream_tools: 0,
    native_effort_hint: raw.output_config?.effort ?? null, encrypted_reasoning_requested: raw.include?.includes('reasoning.encrypted_content') === true }) });
  // Sampling parameters are supported by ChatCompletions, not silently discarded.
  for (const name of ['temperature', 'top_p']) if (raw[name] !== undefined) {
    if (!Number.isFinite(raw[name]) || raw[name] < 0 || raw[name] > (name === 'top_p' ? 1 : 2)) fail();
    out[name] = raw[name];
  }
  return out;
}

function validateCompletion(value, provider) {
  if (!object(value) || provider.containsSecret(value) || value.model !== provider.model
    || typeof value.id !== 'string' || !value.id || value.id.length > 256
    || typeof value.text !== 'string' || !value.text.trim() || Buffer.byteLength(value.text) > 128 * 1024
    || !['stop', 'length'].includes(value.finish_reason)) throw failure('native-chat-upstream-invalid');
  if (value.usage !== null) {
    keys(value.usage, ['prompt_tokens', 'completion_tokens', 'total_tokens']);
    if (!['prompt_tokens', 'completion_tokens', 'total_tokens'].every(key => Number.isSafeInteger(value.usage[key]) && value.usage[key] >= 0)
      || value.usage.total_tokens !== value.usage.prompt_tokens + value.usage.completion_tokens) throw failure('native-chat-upstream-invalid');
  }
}
function usage(format, value) {
  if (value === null) return null;
  return format === 'messages' ? { input_tokens: value.prompt_tokens, output_tokens: value.completion_tokens }
    : { input_tokens: value.prompt_tokens, output_tokens: value.completion_tokens, total_tokens: value.total_tokens };
}
function nativeReply(format, result) {
  if (format === 'messages') return { id: result.id, type: 'message', role: 'assistant', model: result.model,
    content: [{ type: 'text', text: result.text }], stop_reason: result.finish_reason === 'length' ? 'max_tokens' : 'end_turn', stop_sequence: null, usage: usage(format, result.usage) };
  return { id: result.id, object: 'response', status: result.finish_reason === 'length' ? 'incomplete' : 'completed', model: result.model,
    output: [{ id: 'msg_' + crypto.createHash('sha256').update(result.id).digest('hex').slice(0, 24), type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: result.text, annotations: [] }] }],
    incomplete_details: result.finish_reason === 'length' ? { reason: 'max_output_tokens' } : null, usage: usage(format, result.usage) };
}
function sse(format, reply) {
  const frames = [];
  const add = (event, value) => frames.push(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`);
  if (format === 'messages') {
    add('message_start', { type: 'message_start', message: { ...reply, content: [], stop_reason: null, usage: reply.usage } });
    add('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    add('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: reply.content[0].text } });
    add('content_block_stop', { type: 'content_block_stop', index: 0 });
    add('message_delta', { type: 'message_delta', delta: { stop_reason: reply.stop_reason, stop_sequence: null }, usage: reply.usage });
    add('message_stop', { type: 'message_stop' });
  } else {
    let seq = 0; const item = reply.output[0], part = item.content[0];
    const event = (type, value) => add(type, { type, sequence_number: seq++, ...value });
    event('response.created', { response: { ...reply, status: 'in_progress', output: [], usage: null } });
    event('response.output_item.added', { output_index: 0, item: { ...item, status: 'in_progress', content: [] } });
    event('response.content_part.added', { output_index: 0, item_id: item.id, content_index: 0, part: { ...part, text: '' } });
    event('response.output_text.delta', { output_index: 0, item_id: item.id, content_index: 0, delta: part.text });
    event('response.output_text.done', { output_index: 0, item_id: item.id, content_index: 0, text: part.text });
    event('response.content_part.done', { output_index: 0, item_id: item.id, content_index: 0, part });
    event('response.output_item.done', { output_index: 0, item });
    event(reply.status === 'completed' ? 'response.completed' : 'response.incomplete', { response: reply });
  }
  return frames.join('');
}

/** A single-use, authenticated loopback endpoint owned by the trusted Node worker. */
export class NativeChatGateway extends EventEmitter {
  #provider; #request; #server; #controllers = new Set(); #tasks = new Set(); #reading = new Set(); #closing = null; #refusalEvents = 0;
  constructor({ format, provider, request } = {}) {
    super();
    if (!['messages', 'responses'].includes(format) || !provider?.configured || provider.apiFormat !== 'chat-completions' || typeof provider.containsSecret !== 'function') throw failure('native-chat-provider-required');
    this.format = format; this.#provider = provider; this.#request = request;
    this.childKey = crypto.randomBytes(32).toString('hex'); this.url = null;
    this.counts = { contacted: 0, successful: 0, failed: 0, rejected: 0, aborted: 0, active: 0, closed: false, usage: null,
      refusals_suppressed: 0, last_refusal_code: null, last_failure: null };
  }
  summary() { return { ...this.counts, usage: this.counts.usage && { ...this.counts.usage }, last_failure: this.counts.last_failure && { ...this.counts.last_failure } }; }
  async start() {
    if (this.#server || this.counts.closed) throw failure('native-chat-gateway-closed');
    this.#server = http.createServer((req, res) => { const task = this.#handle(req, res); this.#tasks.add(task); task.finally(() => this.#tasks.delete(task)).catch(() => {}); });
    this.#server.requestTimeout = 5000; this.#server.headersTimeout = 5000; this.#server.maxHeadersCount = 40;
    await new Promise((resolve, reject) => { this.#server.once('error', reject); this.#server.listen(0, '127.0.0.1', resolve); });
    this.url = `http://127.0.0.1:${this.#server.address().port}/v1/${this.format}`; return this.url;
  }
  async #handle(req, res) {
    const error = (status, code) => { if (!res.destroyed && !res.writableEnded) { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify({ error: { type: 'invalid_request_error', message: code } })); } };
    const reject = (status, code, raw = null, refusalCode = code) => {
      this.counts.rejected++; this.counts.last_refusal_code = refusalCode;
      error(status, code); req.resume();
      if (this.#refusalEvents >= 8) { this.counts.refusals_suppressed++; return; }
      this.#refusalEvents++;
      this.emit('request-refused', { refusal_code: refusalCode, stage: REFUSAL_STAGES[refusalCode] || 'admission', ...refusalShape(raw) });
    };
    const host = new URL(this.url).host;
    const hosts = req.rawHeaders.filter((_, index) => index % 2 === 0).filter(name => name.toLowerCase() === 'host');
    const auth = req.headers.authorization === `Bearer ${this.childKey}` || req.headers['x-api-key'] === this.childKey;
    if (this.counts.closed) return reject(503, 'gateway-closed');
    if (!auth || req.headers.host !== host || hosts.length !== 1) return reject(403, 'gateway-access-denied');
    const nativeRoute = `/v1/${this.format}`;
    if (req.method !== 'POST' || req.url !== nativeRoute && !(this.format === 'messages' && req.url === nativeRoute + '?beta=true')) return reject(404, 'gateway-route-denied');
    if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'] || '') || req.headers['content-encoding']) return reject(400, 'gateway-content-invalid');
    let raw, body; const buffers = []; let bytes = 0;
    let bodyTimer;
    this.#reading.add(req);
    try {
      bodyTimer = setTimeout(() => req.destroy(), 3000);
      for await (const chunk of req) { bytes += chunk.length; if (bytes > 1024 * 1024) { reject(413, 'gateway-body-too-large'); return; } buffers.push(chunk); }
      raw = JSON.parse(Buffer.concat(buffers).toString('utf8')); body = translateNativeChatRequest(this.format, raw, { model: this.#provider.model });
      if (this.#provider.containsSecret(raw)) throw failure('native-chat-secret-input');
    } catch (error) {
      const refusalCode = Object.hasOwn(REFUSAL_STAGES, error?.refusalCode) ? error.refusalCode
        : error?.code === 'native-chat-secret-input' ? 'native-chat-secret-input' : 'gateway-request-invalid';
      return reject(400, 'gateway-request-invalid', raw, refusalCode);
    }
    finally { clearTimeout(bodyTimer); this.#reading.delete(req); }
    if (this.counts.closed) return reject(503, 'gateway-closed');
    if (this.counts.contacted >= 1) return reject(429, 'gateway-single-call-limit');
    Object.assign(this.counts, body.audit);
    const controller = new AbortController(); this.#controllers.add(controller);
    const disconnected = () => { if (!res.writableEnded) controller.abort(failure('native-chat-client-disconnected')); };
    res.on('close', disconnected);
    this.counts.contacted++; this.counts.active++;
    let failureStage = 'parent-request';
    try {
      const pending = (this.#request || requestParentChatCompletion)(this.#provider, { ...body, signal: controller.signal, timeoutMs: 45000 });
      // The helper has invoked fetch before its first await. Do not report upstream
      // active before starting it (an import/validation delay is not provider in-flight).
      this.emit('request-started', { call: this.counts.contacted, active: this.counts.active });
      const result = await pending;
      if (controller.signal.aborted || this.counts.closed) throw failure('native-chat-upstream-aborted');
      failureStage = 'native-response-validation';
      validateCompletion(result, this.#provider);
      failureStage = 'native-response-encoding';
      const reply = nativeReply(this.format, result), output = raw.stream ? sse(this.format, reply) : JSON.stringify(reply);
      failureStage = 'native-response-secret-check';
      if (this.#provider.containsSecret(output) || output.includes(this.childKey)) throw failure('native-chat-upstream-invalid');
      failureStage = 'native-response-write';
      res.writeHead(200, { 'content-type': raw.stream ? 'text/event-stream' : 'application/json', 'cache-control': 'no-store' }); res.end(output);
      failureStage = 'native-completion-notify';
      this.counts.successful++; this.counts.usage = result.usage; this.emit('completion', { id: result.id, model: result.model, text: result.text, finish_reason: result.finish_reason, usage: result.usage });
    } catch (caught) {
      this.counts.last_failure = failureProjection(caught, failureStage);
      this.counts.failed++; if (controller.signal.aborted) this.counts.aborted++;
      error(controller.signal.aborted ? 499 : 502, controller.signal.aborted ? 'gateway-request-aborted' : 'gateway-upstream-invalid');
    } finally {
      res.removeListener('close', disconnected); this.#controllers.delete(controller); this.counts.active--; this.emit('request-ended', { active: this.counts.active });
    }
  }
  close() {
    if (this.#closing) return this.#closing;
    this.counts.closed = true;
    this.#closing = (async () => {
      for (const request of this.#reading) request.destroy();
      for (const controller of this.#controllers) controller.abort(failure('native-chat-controller-stop'));
      await Promise.allSettled([...this.#tasks]);
      if (this.#server) await new Promise(resolve => {
        const deadline = setTimeout(() => this.#server.closeAllConnections(), 100);
        this.#server.close(() => { clearTimeout(deadline); resolve(); }); this.#server.closeIdleConnections();
      });
    })(); return this.#closing;
  }
}
