import path from 'node:path';
import { COMATE_LOCAL_AUTH_HEADER } from './comate-local-auth.js';

const MAX_FRAME_BYTES = 256 * 1024;
const MAX_ELEMENTS = 512;
const MAX_TEXT_BYTES = 1024 * 1024;

/** Decode native SSE; raw reasoning and tool arguments never enter the worker protocol. */
export class ComateFrameProjector {
  constructor(conversationId) {
    this.conversationId = conversationId;
    this.elements = new Map();
    this.terminal = null;
    this.streaming = false;
  }

  accept(raw) {
    if (this.terminal || !raw || typeof raw !== 'object') return [];
    if (raw.type === 'task_done') {
      if (raw.conversationId !== this.conversationId
        || !['completed', 'cancelled', 'failed'].includes(raw.status)) throw new Error('Invalid Comate terminal');
      this.terminal = raw.status;
      return [{ type: 'terminal', status: raw.status, conversation_id: this.conversationId }];
    }
    if (raw.kind !== 'delta-batch') return [];
    if (raw.cid !== this.conversationId || !Array.isArray(raw.chunks)) throw new Error('Invalid Comate conversation stream');
    if (raw.chunks.some((chunk) => ['element-add', 'element-patch'].includes(chunk?.kind)
      && ['TEXT', 'TOOL', 'REASON'].includes((chunk.element || chunk.patch)?.type))) this.streaming = true;
    const frames = [];
    for (const chunk of raw.chunks) {
      if (!['element-add', 'element-patch'].includes(chunk?.kind)) continue;
      const element = chunk.kind === 'element-add' ? chunk.element : chunk.patch;
      if (!element || !['TEXT', 'TOOL'].includes(element.type)) continue;
      const id = element.id || chunk.eid;
      if (typeof id !== 'string' || !id || id.length > 128) throw new Error('Invalid Comate element ID');
      if (!this.elements.has(id) && this.elements.size >= MAX_ELEMENTS) throw new Error('Comate element budget exceeded');
      const previous = this.elements.get(id);
      if (previous?.type && previous.type !== element.type) throw new Error('Comate element type changed');
      if (element.type === 'TEXT') {
        if (typeof element.content !== 'string') continue;
        if (Buffer.byteLength(element.content) > MAX_TEXT_BYTES) throw new Error('Comate text budget exceeded');
        // Native patches contain the complete current text; do not append it a second time.
        const next = { type: 'TEXT', text: element.content, done: element.done === true };
        this.elements.set(id, next);
        if (next.done && (!previous?.done || previous.text !== next.text)) {
          frames.push({ type: 'message', id, text: next.text });
        }
      } else {
        const name = typeof element.name === 'string' ? element.name.slice(0, 100) : previous?.name;
        const state = typeof element.state === 'string' ? element.state : previous?.state;
        this.elements.set(id, { type: 'TOOL', name, state });
        if (name && state && state !== previous?.state) frames.push({ type: 'tool', id, name, state });
      }
    }
    // Bound aggregate retained text as well as individual fields.
    let bytes = 0;
    for (const item of this.elements.values()) bytes += Buffer.byteLength(item.text || '');
    if (bytes > MAX_TEXT_BYTES) throw new Error('Comate text budget exceeded');
    return frames;
  }
}

export async function* decodeComateSse(body) {
  const reader = body?.getReader?.();
  if (!reader) throw new Error('Comate response is not a readable stream');
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let pending = '';
  let lines = [];
  let frameBytes = 0;
  const line = (text) => {
    frameBytes += Buffer.byteLength(text);
    if (frameBytes > MAX_FRAME_BYTES) throw new Error('Comate SSE frame budget exceeded');
    if (text.startsWith('data:')) lines.push(text.slice(5).replace(/^ /, ''));
    if (text !== '') return null;
    const data = lines.join('\n');
    lines = [];
    frameBytes = 0;
    return data ? JSON.parse(data) : null;
  };
  try {
    for (;;) {
      const { value, done } = await reader.read();
      pending += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let at;
      while ((at = pending.indexOf('\n')) >= 0) {
        const raw = line(pending.slice(0, at).replace(/\r$/, ''));
        pending = pending.slice(at + 1);
        if (raw !== null) yield raw;
      }
      if (Buffer.byteLength(pending) + frameBytes > MAX_FRAME_BYTES) throw new Error('Comate SSE frame budget exceeded');
      if (done) {
        if (pending || lines.length) throw new Error('Incomplete Comate SSE frame');
        break;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** One conversation in one authenticated native instance. Catalog activation is separate. */
export class ComateSessionApi {
  constructor({ origin, localAuth, license, conversationId, cwd, prompt, onFrame = () => {}, stopTimeoutMs = 15000 }) {
    const url = new URL(origin);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port
      || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new TypeError('Comate requires a loopback origin');
    if (!/^[0-9a-f]{64}$/.test(localAuth || '') || typeof license !== 'string' || !license
      || !/^[A-Za-z0-9_-]{1,128}$/.test(conversationId || '') || !path.isAbsolute(cwd || '')
      || typeof prompt !== 'string' || !prompt || prompt.length > 4000) throw new TypeError('Invalid Comate session configuration');
    this.origin = url.origin;
    this.localAuth = localAuth;
    this.license = license;
    this.conversationId = conversationId;
    this.cwd = cwd;
    this.prompt = prompt;
    this.onFrame = onFrame;
    this.stopTimeoutMs = stopTimeoutMs;
    this.projector = new ComateFrameProjector(conversationId);
    this.stopRequested = false;
    this.started = false;
    this.cancelPromise = null;
    this.done = null;
    this._streamReady = new Promise((resolve) => { this._resolveReady = resolve; });
    this._terminal = new Promise((resolve) => { this._resolveTerminal = resolve; });
  }

  request(route, options = {}) {
    return fetch(this.origin + route, { ...options, headers: {
      'content-type': 'application/json', [COMATE_LOCAL_AUTH_HEADER]: this.localAuth,
    } });
  }

  run() {
    if (this.done) throw new Error('Comate conversation already started');
    this.done = this._run();
    return this.done;
  }

  async _run() {
    if (this.stopRequested) {
      this._resolveReady(false);
      this._resolveTerminal('not-started');
      return { status: 'not-started' };
    }
    this.started = true;
    try {
      const response = await this.request('/api/v1/conversations/init', {
        method: 'POST', body: JSON.stringify({
          conversationId: this.conversationId, cwd: this.cwd, license: this.license,
          mode: 'Ask', query: this.prompt, activateRules: [], activateCommands: [], activateSkills: [], activateSubagents: [],
        }),
      });
      if (response.status !== 200 || !response.headers.get('content-type')?.includes('text/event-stream')) {
        await response.body?.cancel();
        throw new Error(`Comate create rejected (${response.status})`);
      }
      for await (const raw of decodeComateSse(response.body)) {
        const before = this.projector.streaming;
        const frames = this.projector.accept(raw);
        if (!before && this.projector.streaming) {
          this._resolveReady(true);
          this.onFrame({ type: 'started', conversation_id: this.conversationId });
        }
        for (const frame of frames) this.onFrame(frame);
        if (this.projector.terminal) break;
      }
      if (!this.projector.terminal) throw new Error('Comate stream ended without a native terminal');
      this._resolveReady(false); // A turn may finish without emitting a delta batch.
      this._resolveTerminal(this.projector.terminal);
      return { status: this.projector.terminal };
    } catch (err) {
      this._resolveReady(false);
      this._resolveTerminal('failed');
      throw err;
    }
  }

  stop() {
    this.stopRequested = true;
    if (!this.started) return Promise.resolve({ confirmed: true, reason: 'not-started', native_cancelled: false });
    if (!this.cancelPromise) this.cancelPromise = this._stop();
    return this.cancelPromise;
  }

  async _stop() {
    let timer;
    const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve({ confirmed: false, reason: 'native-cancel-timeout', native_cancelled: false }), this.stopTimeoutMs); });
    const cancel = async () => {
      const ready = await this._streamReady;
      if (!ready || this.projector.terminal) return { confirmed: false, reason: 'already-terminal', native_cancelled: false };
      const response = await this.request(`/api/v1/conversations/${this.conversationId}/cancel`, {
        method: 'POST', signal: AbortSignal.timeout(this.stopTimeoutMs), body: '{}',
      });
      if (response.status !== 200 || (await response.json()).code !== 0) throw new Error('Comate cancel rejected');
      const terminal = await this._terminal;
      if (terminal !== 'cancelled') return { confirmed: false, reason: 'native-terminal-not-cancelled', native_cancelled: false };
      const history = await this.request(`/api/v1/conversations/${this.conversationId}/history`, { signal: AbortSignal.timeout(this.stopTimeoutMs) });
      if (history.status !== 200 || (await history.json()).status !== 'cancelled') throw new Error('Comate cancelled history not confirmed');
      return { confirmed: true, reason: 'native-cancelled', native_cancelled: true };
    };
    try { return await Promise.race([cancel(), timeout]); }
    catch { return { confirmed: false, reason: 'native-cancel-failed', native_cancelled: false }; }
    finally { clearTimeout(timer); }
  }
}
