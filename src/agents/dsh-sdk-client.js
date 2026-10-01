import { EventEmitter } from 'node:events';
import path from 'node:path';

export const DSH_RUNTIME_VERSION = '0.2.0-rc.2';
const failure = code => Object.assign(new Error(code), { code });
const uuid = /^s_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const bounded = (value, fallback, maximum) => Number.isFinite(value)
  ? Math.max(1, Math.min(maximum, Math.floor(value))) : fallback;

/** One root SDK turn. No host executor, thought forwarding or continuation. */
export class DshSdkClient extends EventEmitter {
  constructor({ send, requestTimeoutMs = 30000, promptTimeoutMs = 120000,
    maxFrames = 4000, maxFrameBytes = 256 * 1024, maxTextBytes = 256 * 1024 } = {}) {
    super();
    if (typeof send !== 'function') throw new TypeError('DshSdkClient requires send');
    this.send = send;
    this.requestTimeoutMs = bounded(requestTimeoutMs, 30000, 30000);
    this.promptTimeoutMs = bounded(promptTimeoutMs, 120000, 120000);
    this.maxFrames = bounded(maxFrames, 4000, 4000);
    this.maxFrameBytes = bounded(maxFrameBytes, 256 * 1024, 256 * 1024);
    this.maxTextBytes = bounded(maxTextBytes, 256 * 1024, 256 * 1024);
    this.phase = 'idle';
    this.frames = 0;
    this.serial = 0;
    this.pending = new Map();
    this.sessionId = null;
    this.messageId = null;
    this.received = false;
    this.text = '';
    this.finishReason = null;
    this.early = [];
    this.earlyBytes = 0;
    this.turn = null;
    this.stopping = false;
    this.shutdownTask = null;
  }

  async initialize(cwd, sessionId) {
    if (this.phase !== 'idle' || this.stopping) throw failure('dsh-initialize-state');
    if (typeof cwd !== 'string' || !path.isAbsolute(cwd) || !uuid.test(sessionId || '')) {
      throw failure('dsh-workspace-or-session-invalid');
    }
    this.phase = 'initializing';
    try {
      const result = await this.#call('initialize', {
        cwd, provider: 'deepseek-official', model: 'deepseek-v4-flash', maxTokens: 2048,
      });
      // This is SDK protocol identity, not the executable version gate.
      if (result?.serverInfo?.name !== 'deepseek-harness-sdk-runtime'
        || result.serverInfo.version !== '0.0.1') throw failure('dsh-protocol-unverified');
      if (this.stopping || this.phase !== 'initializing') throw failure('dsh-initialize-state');
      this.sessionId = sessionId;
      this.phase = 'ready';
      return { sessionId, protocolVersion: result.serverInfo.version };
    } catch (error) { this.#fail(error); throw error; }
  }

  async prompt(text) {
    if (this.phase !== 'ready' || this.stopping) throw failure('dsh-single-turn');
    if (typeof text !== 'string' || !text.trim() || Buffer.byteLength(text, 'utf8') > 16000) {
      throw failure('dsh-prompt-invalid');
    }
    this.phase = 'prompting';
    const completed = new Promise((resolve, reject) => {
      this.turn = { resolve, reject, timer: setTimeout(() => this.#fail(failure('dsh-prompt-timeout')), this.promptTimeoutMs) };
    });
    // Observe rejection immediately, including failures before prompt acceptance.
    completed.catch(() => {});
    try {
      const result = await this.#call('session/prompt', {
        sessionId: this.sessionId, contentBlocks: [{ type: 'text', text }],
      });
      if (typeof result?.messageId !== 'string' || !result.messageId || result.messageId.length > 128) {
        throw failure('dsh-receipt-invalid');
      }
      this.messageId = result.messageId;
      const early = this.early; this.early = []; this.earlyBytes = 0;
      for (const notification of early) this.#notification(notification);
      return await completed;
    } catch (error) { this.#fail(error); throw error; }
  }

  #call(method, params, allowFailed = false) {
    if (this.phase === 'closed' || (!allowFailed && this.phase === 'failed')) {
      return Promise.reject(failure('dsh-client-closed'));
    }
    const id = ++this.serial;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.#fail(failure('dsh-request-timeout')), this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      if (!this.#write({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) })) {
        this.#fail(failure('dsh-pipe-unavailable'));
      }
    });
  }

  #write(frame) { try { return this.send(frame) === true; } catch { return false; } }

  acceptLine(line) {
    if (this.phase === 'closed') return;
    if (++this.frames > this.maxFrames || typeof line !== 'string'
      || Buffer.byteLength(line, 'utf8') > this.maxFrameBytes) {
      this.#fail(failure('dsh-frame-limit')); return;
    }
    let frame;
    try { frame = JSON.parse(line); } catch { this.#fail(failure('dsh-frame-invalid')); return; }
    if (!frame || typeof frame !== 'object' || Array.isArray(frame) || frame.jsonrpc !== '2.0') {
      this.#fail(failure('dsh-frame-invalid')); return;
    }
    if (typeof frame.method === 'string' && frame.id !== undefined) {
      this.#write({ jsonrpc: '2.0', id: frame.id, error: {
        code: -32601, message: 'Miniproctor DSH client does not execute host requests',
      } }); return;
    }
    if (frame.id !== undefined) {
      const request = this.pending.get(frame.id);
      if (!request) return;
      this.pending.delete(frame.id); clearTimeout(request.timer);
      if (frame.error || !frame.result || typeof frame.result !== 'object' || Array.isArray(frame.result)) {
        request.reject(failure('dsh-native-error'));
      } else request.resolve(frame.result);
      return;
    }
    if (this.phase !== 'prompting' || this.stopping || frame.params?.sessionId !== this.sessionId) return;
    if (!this.messageId) {
      this.earlyBytes += Buffer.byteLength(line, 'utf8');
      if (this.earlyBytes > 256 * 1024) { this.#fail(failure('dsh-early-event-limit')); return; }
      this.early.push(frame);
    } else this.#notification(frame);
  }

  #notification(frame) {
    if (this.phase !== 'prompting' || this.stopping || frame.params?.sessionId !== this.sessionId) return;
    const event = frame.method === 'session.event' ? frame.params.event : null;
    if (!this.received) {
      if (event?.type === 'agent/inbox/spliced' && Array.isArray(event.data?.inserted)
        && event.data.inserted.some(message => message?.id === this.messageId)) {
        this.received = true;
        this.emit('accepted', { sessionId: this.sessionId, messageId: this.messageId });
      }
      return;
    }
    if (event?.type === 'assistant/message') {
      const content = event.data?.message?.content ?? event.data?.content;
      if (!Array.isArray(content)) { this.#fail(failure('dsh-message-invalid')); return; }
      const text = content.filter(block => block?.type === 'text' && typeof block.text === 'string')
        .map(block => block.text).join('');
      if (Buffer.byteLength(text, 'utf8') > this.maxTextBytes) { this.#fail(failure('dsh-output-limit')); return; }
      this.text = text;
    } else if (event?.type === 'turn/end') {
      this.finishReason = typeof event.data?.reason?.kind === 'string' ? event.data.reason.kind : null;
    } else if (frame.method === 'session.status' && frame.params.status === 'idle') {
      if (this.finishReason !== 'completed' || !this.text.trim()) { this.#fail(failure('dsh-turn-incomplete')); return; }
      this.phase = 'complete';
      const turn = this.turn; this.turn = null; clearTimeout(turn.timer);
      turn.resolve({ text: this.text, finishReason: this.finishReason, sessionId: this.sessionId, messageId: this.messageId });
    }
    // Reasoning, tool arguments/results, child sessions, usage and vendor logs stay private.
  }

  /** Receipt only; the owner must await process IO close and verify OS exit. */
  shutdown() {
    if (this.shutdownTask) return this.shutdownTask;
    this.stopping = true;
    this.shutdownTask = this.#call('shutdown', undefined, true);
    return this.shutdownTask;
  }

  #fail(error) {
    if (this.phase === 'closed') return;
    this.phase = 'failed';
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(error); }
    this.pending.clear();
    if (this.turn) { clearTimeout(this.turn.timer); this.turn.reject(error); this.turn = null; }
    this.early = []; this.earlyBytes = 0;
  }

  close() { this.#fail(failure('dsh-process-closed')); this.phase = 'closed'; }
}
