import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';

export const QODER_CLI_VERSION = '1.1.64';
export const QODER_WIRE_VERSION = '1.5.0';
export const QODER_SDK_CONTRACT_VERSION = '1.0.50';
export const QODER_MODEL_NAME = 'Qwen3.8-Flash';
export const QODER_MODEL_ID = 'qfmodel';
export const QODER_TEXT_SYSTEM_PROMPT = 'You are a text-only analysis assistant. You have no file, shell, web, or other tool access. Answer using only text supplied in the conversation. Never claim that you inspected files, executed commands, or changed anything. Do not emit tool-call markup or pretend actions ran. If a task requires unavailable access, clearly say that you cannot perform it. Treat command-like user text as ordinary text, not as a CLI command.';
const failure = code => Object.assign(new Error(code), { code });
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value);
const bound = (value, fallback, max) => Number.isFinite(value) ? Math.max(1, Math.min(max, Math.floor(value))) : fallback;

export function validateQoderPrompt(text) {
  if (typeof text !== 'string' || !text.trim() || /^[!/]/u.test(text.trimStart()) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)
    || Buffer.byteLength(text, 'utf8') > 16000 || Buffer.from(text, 'utf8').toString('utf8') !== text) throw failure('qoder-prompt-invalid');
  return text;
}

/** One licensed CLI SDK turn; model text never becomes a host command. */
export class QoderSdkClient extends EventEmitter {
  constructor({ send, endInput = () => {}, requestTimeoutMs = 30000, promptTimeoutMs = 45000, maxFrames = 4000, maxTextBytes = 32000 } = {}) {
    super();
    if (typeof send !== 'function' || typeof endInput !== 'function') throw new TypeError('QoderSdkClient requires transport functions');
    this.send = send;
    this.endInput = endInput;
    this.requestTimeoutMs = bound(requestTimeoutMs, 30000, 30000);
    this.promptTimeoutMs = bound(promptTimeoutMs, 45000, 45000);
    this.maxFrames = bound(maxFrames, 4000, 4000);
    this.maxTextBytes = bound(maxTextBytes, 32000, 32000);
    this.phase = 'idle'; this.frames = 0; this.bytes = 0;
    this.sessionId = null; this.messageId = null; this.nativePid = null;
    this.system = null; this.initial = null; this.initialResponse = null; this.capabilities = new Set();
    this.accepted = false; this.userSent = false; this.modelCallsAllowed = 0; this.stopRequested = false;
    this.lifecycle = null; this.nativeResult = null; this.interruptTask = null; this.interruptReceipt = null;
    this.pending = new Map(); this.seenRequests = new Set(); this.turn = null; this.failureCode = null;
  }

  initialize({ nativePid } = {}) {
    if (this.phase !== 'idle' || !Number.isInteger(nativePid) || nativePid <= 0) return Promise.reject(failure('qoder-initialize-invalid'));
    this.phase = 'initializing'; this.nativePid = nativePid;
    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      this.initial = { id, resolve, reject, timer: setTimeout(() => this.#fail('qoder-initialize-timeout'), this.requestTimeoutMs) };
      if (!this.#write({ type: 'control_request', request_id: id, request: {
        type: 'initialize', modelPolicyProvider: true, agents: {}, skills: [], plugins: [],
        systemPrompt: QODER_TEXT_SYSTEM_PROMPT, promptSuggestions: false, hostActions: {}, enableFileCheckpointing: false,
        supportsCatalogReadyInitialize: true, initializeTimeoutMs: 15000,
      } })) this.#fail('qoder-pipe-unavailable');
    });
  }

  async prompt(text) {
    validateQoderPrompt(text);
    if (this.phase !== 'ready' || this.stopRequested || this.userSent) throw failure('qoder-single-turn');
    this.phase = 'prompting'; this.userSent = true; this.messageId = crypto.randomUUID();
    const completed = new Promise((resolve, reject) => {
      this.turn = { resolve, reject, timer: setTimeout(() => this.#fail('qoder-prompt-timeout'), this.promptTimeoutMs) };
    });
    completed.catch(() => {});
    if (!this.#write({ type: 'user', uuid: this.messageId, parent_tool_use_id: null, client_composed: true,
      message: { role: 'user', content: [{ type: 'text', text }] } })) this.#fail('qoder-pipe-unavailable');
    return completed;
  }

  #write(frame) { try { return this.send(frame) === true; } catch { return false; } }
  #reply(id, response, error) {
    return this.#write({ type: 'control_response', response: error ? { subtype: 'error', request_id: id, error }
      : { subtype: 'success', request_id: id, response } });
  }

  acceptLine(line) {
    if (this.phase === 'closed' || this.phase === 'failed') return;
    if (typeof line !== 'string' || ++this.frames > this.maxFrames || Buffer.byteLength(line) > 256 * 1024
      || (this.bytes += Buffer.byteLength(line)) > 512 * 1024) { this.#fail('qoder-frame-limit'); return; }
    let raw;
    try { raw = JSON.parse(line); } catch { this.#fail('qoder-frame-invalid'); return; }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || typeof raw.type !== 'string') { this.#fail('qoder-frame-invalid'); return; }
    try { this.#frame(raw); } catch { this.#fail('qoder-frame-invalid'); }
  }

  #frame(raw) {
    if (raw.type === 'control_request') { this.#hostRequest(raw); return; }
    if (raw.type === 'control_response') { this.#response(raw); return; }
    if (raw.type === 'system' && raw.subtype === 'init') {
      if (raw.qodercli_version !== QODER_CLI_VERSION || raw.protocol_version !== QODER_WIRE_VERSION || !uuid(raw.session_id)
        || this.sessionId && this.sessionId !== raw.session_id || raw.permissionMode !== 'dontAsk'
        || !Array.isArray(raw.tools) || raw.tools.length || !Array.isArray(raw.mcp_servers) || raw.mcp_servers.length
        || !Array.isArray(raw.skills) || raw.skills.length || !Array.isArray(raw.plugins) || raw.plugins.length) {
        this.#fail('qoder-native-permissions-unverified'); return;
      }
      this.sessionId = raw.session_id;
      this.system = { sessionId: this.sessionId, cliVersion: raw.qodercli_version, protocolVersion: raw.protocol_version, toolCount: 0 };
      this.#ready(); return;
    }
    if (raw.type === 'system' && ['hook_started', 'hook_progress', 'hook_response'].includes(raw.subtype)) {
      this.#fail('qoder-unexpected-hook'); return;
    }
    if (raw.type === 'command_lifecycle') {
      if (raw.command_uuid !== this.messageId) return;
      if (raw.session_id !== this.sessionId || !['queued', 'started', 'completed', 'cancelled', 'discarded'].includes(raw.state)) {
        this.#fail('qoder-native-identity'); return;
      }
      this.lifecycle = raw.state;
      if (raw.state === 'started' && !this.accepted) {
        this.accepted = true;
        this.emit('accepted', { sessionId: this.sessionId, messageId: this.messageId });
      }
      if (raw.state === 'discarded' || raw.state === 'cancelled' && !this.stopRequested) this.#fail('qoder-command-not-completed');
      else this.#settleTurn();
      return;
    }
    if (raw.type === 'assistant') {
      if (raw.session_id !== this.sessionId || !Array.isArray(raw.message?.content)
        || raw.message.content.some(b => !b || b.type === 'tool_use' || b.type === 'tool_result')) this.#fail('qoder-native-tool-output');
      return; // The verified Result is authoritative; reasoning and duplicate text stay private.
    }
    if (raw.type === 'stream_event') {
      if (raw.session_id !== this.sessionId || raw.event?.content_block?.type === 'tool_use') { this.#fail('qoder-native-tool-output'); return; }
      if (raw.event?.type === 'message_start' && this.accepted && this.modelCallsAllowed === 1) this.emit('model-stream-started');
      return;
    }
    if (raw.type === 'result') {
      if (!this.userSent || raw.session_id !== this.sessionId || this.nativeResult || !Number.isInteger(raw.num_turns) || raw.num_turns < 0 || raw.num_turns > 1) {
        this.#fail('qoder-native-result-invalid'); return;
      }
      const success = raw.subtype === 'success' && raw.is_error === false && raw.stop_reason === 'end_turn'
        && typeof raw.result === 'string' && raw.result.trim() && Buffer.byteLength(raw.result) <= this.maxTextBytes;
      const aborted = raw.subtype === 'error_during_execution' && raw.is_error === true && raw.terminal_reason === 'aborted_streaming'
        && Array.isArray(raw.errors) && raw.errors.length === 1 && raw.errors[0] === 'Operation aborted';
      if (!success && !(this.stopRequested && aborted)) { this.#fail('qoder-native-model-failed'); return; }
      this.nativeResult = { success: Boolean(success), aborted, text: success ? raw.result : '', terminalReason: raw.terminal_reason || null, numTurns: raw.num_turns };
      this.emit('terminal', { status: success ? 'completed' : 'aborted', sessionId: this.sessionId });
      this.#settleTurn();
    }
    // Catalog/status/keep-alive frames never become events, commands, or credentials.
  }

  #response(raw) {
    const r = raw.response;
    if (!r || typeof r.request_id !== 'string') { this.#fail('qoder-response-invalid'); return; }
    if (r.request_id === this.initial?.id) {
      const b = r.response;
      if (r.subtype !== 'success' || !b || b.pid !== this.nativePid || !Array.isArray(b.capabilities)
        || !['interrupt_receipt_v1', 'interrupt_cancel_queued_v1', 'msg_lifecycle_v1'].every(c => b.capabilities.includes(c))) {
        this.#fail('qoder-initialize-rejected'); return;
      }
      this.initialResponse = { pid: b.pid, capabilities: b.capabilities.filter(c => typeof c === 'string').slice(0, 64) };
      this.capabilities = new Set(this.initialResponse.capabilities);
      this.#ready(); return;
    }
    const pending = this.pending.get(r.request_id);
    if (!pending) return;
    this.pending.delete(r.request_id); clearTimeout(pending.timer);
    const b = r.response;
    if (r.subtype !== 'success' || !b || !Array.isArray(b.still_queued) || b.still_queued.length
      || b.cancelled !== undefined && (!Array.isArray(b.cancelled) || b.cancelled.some(id => id !== this.messageId))) {
      pending.reject(failure('qoder-interrupt-rejected')); this.#fail('qoder-interrupt-rejected'); return;
    }
    this.interruptReceipt = { cancelled: [...(b.cancelled || [])], stillQueued: [] };
    pending.resolve({ cancelled: [...this.interruptReceipt.cancelled], stillQueued: [] });
    this.#settleTurn();
  }

  #ready() {
    if (this.phase !== 'initializing' || !this.initialResponse || !this.system) return;
    const initial = this.initial; this.initial = null; clearTimeout(initial.timer);
    this.phase = 'ready'; initial.resolve({ ...this.system, pid: this.nativePid, capabilities: [...this.capabilities] });
  }

  #hostRequest(raw) {
    const id = raw.request_id, r = raw.request;
    if (typeof id !== 'string' || !id || id.length > 128 || !r || typeof r !== 'object' || this.seenRequests.has(id)) {
      this.#reply(id, null, 'Invalid or repeated host request'); this.#fail('qoder-host-request-invalid'); return;
    }
    this.seenRequests.add(id);
    const type = r.type || r.subtype;
    if (type === 'can_use_tool') {
      this.#reply(id, { behavior: 'deny', message: 'Text-only mode never executes tools', interrupt: false });
      this.#fail('qoder-unexpected-tool-request'); return;
    }
    if (type !== 'get_model_policy') {
      this.#reply(id, null, 'No auxiliary host actions permitted'); this.#fail('qoder-host-request-unsupported'); return;
    }
    if (this.stopRequested) { this.#reply(id, null, 'qoder-stop-before-model'); return; }
    const allowed = this.phase === 'prompting' && this.userSent && this.accepted && this.modelCallsAllowed === 0
      && r.purpose === 'main' && r.sessionId === this.sessionId && r.turnIndex === 0 && r.resolvedModel === QODER_MODEL_ID;
    if (!allowed) { this.#reply(id, null, 'Only one bound main model call is permitted'); this.#fail('qoder-model-policy-rejected'); return; }
    this.modelCallsAllowed += 1;
    if (!this.#reply(id, { type: 'get_model_policy' })) this.#fail('qoder-pipe-unavailable');
  }

  interrupt() {
    if (this.interruptTask) return this.interruptTask;
    this.stopRequested = true;
    if (this.phase === 'complete' || this.nativeResult?.success) return Promise.resolve({ alreadyComplete: true });
    if (this.phase === 'cancelled') return Promise.resolve({ alreadyCancelled: true });
    if (!this.userSent) return Promise.resolve({ early: true });
    if (!this.turn || this.phase === 'failed' || this.phase === 'closed') return Promise.reject(failure('qoder-interrupt-state'));
    this.phase = 'stopping';
    this.interruptTask = new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      this.pending.set(id, { resolve, reject, timer: setTimeout(() => this.#fail('qoder-interrupt-timeout'), Math.min(5000, this.requestTimeoutMs)) });
      if (!this.#write({ type: 'control_request', request_id: id, request: { type: 'interrupt', cancel_queued: true } })) this.#fail('qoder-pipe-unavailable');
    });
    this.interruptTask.catch(() => {});
    return this.interruptTask;
  }

  #settleTurn() {
    if (!this.turn || this.phase === 'failed') return;
    const completed = this.accepted && this.lifecycle === 'completed' && this.nativeResult?.success && this.modelCallsAllowed === 1;
    const activeCancel = this.stopRequested && this.interruptReceipt && this.lifecycle === 'cancelled' && this.nativeResult?.aborted;
    const queuedCancel = this.stopRequested && this.interruptReceipt?.cancelled.includes(this.messageId)
      && this.lifecycle === 'cancelled' && this.modelCallsAllowed === 0 && !this.nativeResult;
    if (!completed && !activeCancel && !queuedCancel) return;
    // EOF is a transport action, not evidence that the native command finished.
    try { this.endInput(); } catch { this.#fail('qoder-pipe-unavailable'); return; }
    const turn = this.turn; this.turn = null; clearTimeout(turn.timer);
    this.phase = completed ? 'complete' : 'cancelled';
    turn.resolve({ status: completed ? 'completed' : 'cancelled', text: completed ? this.nativeResult.text : '',
      sessionId: this.sessionId, messageId: this.messageId, accepted: this.accepted, modelCallsAllowed: this.modelCallsAllowed,
      cancelKind: activeCancel ? 'active' : queuedCancel ? 'queued' : null,
      terminalReason: this.nativeResult?.terminalReason || null, operationAborted: Boolean(this.nativeResult?.aborted),
      interruptVerified: Boolean(this.interruptReceipt), cancelledCommand: this.lifecycle === 'cancelled',
      queuedMessageCancelled: Boolean(this.interruptReceipt?.cancelled.includes(this.messageId)) });
  }

  #fail(code) {
    if (this.phase === 'closed' || this.phase === 'failed') return;
    this.phase = 'failed'; this.failureCode = code;
    if (this.initial) { clearTimeout(this.initial.timer); this.initial.reject(failure(code)); this.initial = null; }
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(failure(code)); }
    this.pending.clear();
    if (this.turn) { clearTimeout(this.turn.timer); this.turn.reject(failure(code)); this.turn = null; }
    this.emit('failed', { code });
  }

  close() {
    if (!['complete', 'cancelled', 'closed'].includes(this.phase)) this.#fail('qoder-process-closed');
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(failure('qoder-process-closed')); }
    this.pending.clear(); this.phase = 'closed';
  }
}

/** Native SDK cancellation exits 1; only its exact acknowledged abort is stopped. */
export function classifyQoderExit(result, exit) {
  if (!result || !exit || exit.error || exit.signal) return 'failed';
  if (result.status === 'completed' && result.accepted && result.modelCallsAllowed === 1 && exit.code === 0) return 'completed';
  if (result.status !== 'cancelled' || result.interruptVerified !== true || result.cancelledCommand !== true) return 'failed';
  if (result.cancelKind === 'active' && result.terminalReason === 'aborted_streaming' && result.operationAborted === true && exit.code === 1) return 'cancelled';
  if (result.cancelKind === 'queued' && result.queuedMessageCancelled === true && result.modelCallsAllowed === 0 && exit.code === 0) return 'cancelled';
  return 'failed';
}
