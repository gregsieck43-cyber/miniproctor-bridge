import { EventEmitter } from 'node:events';
import path from 'node:path';

// A26: only the fixed Windows Nightly ACP implementation has real Plan evidence.
// This client owns no filesystem/terminal executor and never approves a request.
export const JUNIE_PLAN_VERSION = 'build 3596.1 nightly';
export const JUNIE_PLAN_PROFILE_VERSION = `Junie version: ${JUNIE_PLAN_VERSION}`;
const STOP_REASONS = new Set(['end_turn', 'cancelled', 'refusal', 'max_tokens', 'max_turn_requests']);

function failure(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function hasOption(options, id, value) {
  return Array.isArray(options) && options.some(option => option?.id === id
    && option.type === 'select' && Array.isArray(option.options)
    && option.options.some(choice => choice?.value === value));
}

function readback(options, id, value) {
  return Array.isArray(options) && options.some(option => option?.id === id && option.currentValue === value);
}

/** A single ACP prompt, with verified Plan/off setup and default rejection. */
export class JuniePlanClient extends EventEmitter {
  constructor({ send, requestTimeoutMs = 30000, promptTimeoutMs = 120000,
    maxFrames = 3000, maxTextBytes = 256 * 1024 } = {}) {
    super();
    if (typeof send !== 'function') throw new TypeError('JuniePlanClient requires send');
    this.send = send;
    this.requestTimeoutMs = Math.max(1, Number(requestTimeoutMs) || 30000);
    this.promptTimeoutMs = Math.max(1, Number(promptTimeoutMs) || 120000);
    this.maxFrames = Math.max(1, Number(maxFrames) || 3000);
    this.maxTextBytes = Math.max(1, Number(maxTextBytes) || 256 * 1024);
    this.phase = 'idle';
    this.sessionId = null;
    this.cancelRequested = false;
    this.promptUsed = false;
    this.text = '';
    this.textBytes = 0;
    this.frames = 0;
    this.serial = 0;
    this.pending = new Map();
  }

  async initialize(cwd) {
    if (this.phase !== 'idle' || this.cancelRequested) throw failure('junie-initialize-state');
    if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) throw failure('junie-workspace-invalid');
    this.phase = 'initializing';
    try {
      const initialized = await this.#call('initialize', {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: 'miniproctor-junie-plan', version: '1' },
      });
      if (initialized?.protocolVersion !== 1 || initialized?.agentInfo?.name !== '@jetbrains/junie'
        || initialized.agentInfo.version !== JUNIE_PLAN_VERSION) throw failure('junie-version-unverified');
      const created = await this.#call('session/new', { cwd, mcpServers: [] });
      if (typeof created?.sessionId !== 'string' || !created.sessionId || created.sessionId.length > 128
        || !hasOption(created.configOptions, 'mode', 'plan')
        || !hasOption(created.configOptions, 'brave_mode', 'off')) throw failure('junie-plan-unverified');
      this.sessionId = created.sessionId;
      const safe = await this.#call('session/set_config_option', {
        sessionId: this.sessionId, configId: 'brave_mode', value: 'off',
      });
      if (!readback(safe?.configOptions, 'brave_mode', 'off')) throw failure('junie-plan-unverified');
      const plan = await this.#call('session/set_config_option', {
        sessionId: this.sessionId, configId: 'mode', value: 'plan',
      });
      if (!readback(plan?.configOptions, 'mode', 'plan')
        || !readback(plan?.configOptions, 'brave_mode', 'off')) throw failure('junie-plan-unverified');
      if (this.cancelRequested || this.phase !== 'initializing') throw failure('junie-initialize-state');
      this.phase = 'ready';
      return { sessionId: this.sessionId, version: initialized.agentInfo.version };
    } catch (error) {
      this.#fail(error);
      throw error;
    }
  }

  async prompt(text) {
    if (this.phase !== 'ready' || this.promptUsed || this.cancelRequested) throw failure('junie-single-turn');
    if (typeof text !== 'string' || !text.trim() || Buffer.byteLength(text, 'utf8') > 256 * 1024) {
      throw failure('junie-prompt-invalid');
    }
    this.promptUsed = true;
    this.phase = 'prompting';
    try {
      const result = await this.#call('session/prompt', {
        sessionId: this.sessionId, prompt: [{ type: 'text', text }],
      }, this.promptTimeoutMs);
      if (!STOP_REASONS.has(result?.stopReason)) throw failure('junie-stop-reason-invalid');
      if (result.stopReason === 'end_turn' && !this.text) throw failure('junie-empty-answer');
      this.phase = 'complete';
      return { stopReason: result.stopReason, text: this.text };
    } catch (error) {
      this.#fail(error);
      throw error;
    }
  }

  #call(method, params, timeoutMs = this.requestTimeoutMs) {
    if (this.cancelRequested || this.phase === 'closed' || this.phase === 'failed') {
      return Promise.reject(failure('junie-client-closed'));
    }
    const id = ++this.serial;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.#fail(failure('junie-request-timeout')), timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      if (!this.#write({ jsonrpc: '2.0', id, method, params })) this.#fail(failure('junie-pipe-unavailable'));
    });
  }

  #write(frame) {
    try { return this.send(frame) === true; } catch { return false; }
  }

  acceptLine(line) {
    if (this.phase === 'closed' || this.phase === 'failed') return;
    if (++this.frames > this.maxFrames || typeof line !== 'string'
      || Buffer.byteLength(line, 'utf8') > 256 * 1024) {
      this.#fail(failure('junie-frame-limit'));
      return;
    }
    let frame;
    try { frame = JSON.parse(line); } catch { this.#fail(failure('junie-frame-invalid')); return; }
    if (!frame || typeof frame !== 'object' || Array.isArray(frame) || frame.jsonrpc !== '2.0') {
      this.#fail(failure('junie-frame-invalid'));
      return;
    }
    if (typeof frame.method === 'string' && frame.id !== undefined) {
      this.#rejectHostRequest(frame);
      return;
    }
    if (frame.id !== undefined && this.pending.has(frame.id)) {
      const request = this.pending.get(frame.id);
      this.pending.delete(frame.id);
      clearTimeout(request.timer);
      // Native errors may contain credentials/arguments. Only the fixed code leaves this boundary.
      if (frame.error) request.reject(failure('junie-native-error'));
      else request.resolve(frame.result);
      return;
    }
    if (frame.method !== 'session/update' || !this.sessionId || frame.params?.sessionId !== this.sessionId) return;
    this.#acceptUpdate(frame.params.update);
  }

  #rejectHostRequest(frame) {
    if (frame.method === 'session/request_permission') {
      const option = frame.params?.sessionId === this.sessionId && Array.isArray(frame.params.options)
        ? frame.params.options.find(item => item?.kind === 'reject_once'
          && typeof item.optionId === 'string' && item.optionId.length <= 256) : null;
      const outcome = option ? { outcome: 'selected', optionId: option.optionId } : { outcome: 'cancelled' };
      this.#write({ jsonrpc: '2.0', id: frame.id, result: { outcome } });
      this.emit('update', { type: 'permission_denied', tool_call_id:
        typeof frame.params?.toolCall?.toolCallId === 'string' ? frame.params.toolCall.toolCallId.slice(0, 128) : null });
      return;
    }
    this.#write({ jsonrpc: '2.0', id: frame.id, error: {
      code: -32603, message: 'Miniproctor Plan client does not execute filesystem, terminal or unknown host requests',
    } });
  }

  #acceptUpdate(update) {
    if (!update || typeof update !== 'object') return;
    if (this.phase === 'ready' && update.sessionUpdate === 'config_option_update') {
      if (!readback(update.configOptions, 'mode', 'plan') || !readback(update.configOptions, 'brave_mode', 'off')) {
        this.#fail(failure('junie-plan-unverified'));
      }
      return;
    }
    if (this.phase !== 'prompting') return;
    if (update.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text'
      && typeof update.content.text === 'string') {
      const bytes = Buffer.byteLength(update.content.text, 'utf8');
      if (this.textBytes + bytes > this.maxTextBytes) { this.#fail(failure('junie-output-limit')); return; }
      this.textBytes += bytes;
      this.text += update.content.text;
    } else if ((update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update')
      && typeof update.toolCallId === 'string' && update.toolCallId) {
      this.emit('update', {
        type: 'tool', tool_call_id: update.toolCallId.slice(0, 128),
        title: typeof update.title === 'string' ? update.title.slice(0, 250) : '',
        kind: typeof update.kind === 'string' ? update.kind.slice(0, 50) : '',
        status: typeof update.status === 'string' ? update.status.slice(0, 50) : '',
      });
    }
    // Thoughts, rawInput/content/locations, usage, commands and vendor metadata are not forwarded.
  }

  cancel() {
    this.cancelRequested = true;
    return Boolean(this.sessionId && this.#write({ jsonrpc: '2.0', method: 'session/cancel',
      params: { sessionId: this.sessionId } }));
  }

  #fail(error) {
    this.phase = 'failed';
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
  }

  close() {
    this.#fail(failure('junie-process-closed'));
    this.phase = 'closed';
  }
}
