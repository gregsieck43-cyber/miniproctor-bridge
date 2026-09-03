import crypto from 'node:crypto';
import path from 'node:path';
import { AgentRunner } from './runner.js';
import { SessionSequencer, createEvent } from '../lib/events.js';
import { lineToEvent } from '../adapters/generic.js';

// confirm_required / error 必须即时直推，不参与批量缓冲。
export const CRITICAL_EVENT_TYPES = Object.freeze(new Set(['confirm_required', 'error']));
// 批量缓冲上限：满即 flush，不再等 pushBatchMs。
export const PUSH_BATCH_MAX_EVENTS = 200;
const MAX_BACKOFF_EXPONENT = 10; // 防 2^n 溢出，30s 封顶由 maxBackoffMs 保证

export class ManagedSession {
  constructor({ sessionId, agentType = 'generic', command, args = [], cwd }) {
    this.sessionId = sessionId;
    this.agentType = agentType;
    this.cwd = cwd || process.cwd();
    this.command = command;
    this.sequencer = new SessionSequencer();
    this.runner = new AgentRunner({ command, args, cwd });
    this.status = 'starting';
    this.lastSeq = 0;
    this.exitInfo = null;
    // request_id -> 最近一次 control_request 的原始 input，用于审批回流时回填。
    this.pendingInputs = new Map();
  }

  start({ transport, onEvent, pushEvent } = {}) {
    const sink = typeof pushEvent === 'function'
      ? pushEvent
      : (event) => { transport?.pushEvents([event]).catch(() => {}); };
    this.runner.on('line', (line) => {
      this.trackControlRequest(line);
      const events = lineToEvent(line, { sessionId: this.sessionId, agentType: this.agentType, sequencer: this.sequencer });
      for (const event of events) {
        this.lastSeq = event.seq;
        onEvent?.(event);
        sink(event);
      }
    });
    this.runner.on('stderr', () => {});
    this.runner.on('exit', (info) => {
      this.exitInfo = info;
      this.status = info.code === 0 || info.code === null ? 'ended' : 'error';
    });
    this.runner.start();
    this.status = 'running';
    const metaEvent = createEvent({
      sessionId: this.sessionId,
      agentType: this.agentType,
      sequencer: this.sequencer,
      eventType: 'custom',
      payload: {
        custom_type: 'session_meta',
        fallback_text: '会话已初始化',
        data: {
          cwd: this.cwd || null,
          command: this.command,
          title: this.cwd ? path.basename(this.cwd) : '远程会话',
        },
      },
    });
    this.lastSeq = metaEvent.seq;
    onEvent?.(metaEvent);
    sink(metaEvent);
    return this;
  }

  /** 嗅探 stdout 行：control_request 的原始 input 记入 pendingInputs。 */
  trackControlRequest(line) {
    try {
      const raw = JSON.parse(line);
      if (raw && raw.type === 'control_request' && typeof raw.request_id === 'string') {
        this.pendingInputs.set(raw.request_id, raw.request?.input ?? {});
      }
    } catch {
      // 非 JSON 行（或半行）忽略
    }
  }

  sendText(content) {
    return this.runner.sendJson({ type: 'user', message: { role: 'user', content } });
  }

  respondAction(requestId, decision) {
    const approve = decision === 'approve';
    // approve 回填原始入参（无记录时退 {}）；deny 语义不变。
    const originalInput = approve && this.pendingInputs.has(requestId)
      ? this.pendingInputs.get(requestId)
      : {};
    const sent = this.runner.sendJson({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: requestId,
        response: approve
          ? { behavior: 'allow', updatedInput: originalInput ?? {} }
          : { behavior: 'deny', message: '用户拒绝了本次操作。' },
      },
    });
    // control_response 已回流，清理对应 pending 记录。
    this.pendingInputs.delete(requestId);
    return sent;
  }

  async stop() {
    this.pendingInputs.clear();
    return this.runner.stop();
  }
}

export class SessionManager {
  constructor({ transport, pollIntervalMs = 3000, pushBatchMs = 0, maxBackoffMs = 30000, onEvent } = {}) {
    this.transport = transport;
    this.pollIntervalMs = pollIntervalMs;
    // >0 启用批量缓冲推送；0/undefined 保持旧的逐条即时推送行为。
    this.pushBatchMs = Math.max(0, Number(pushBatchMs) || 0);
    this.maxBackoffMs = Math.max(pollIntervalMs || 3000, Number(maxBackoffMs) || 30000);
    this.onEvent = onEvent;
    this.sessions = new Map();
    this.timer = null;
    this.pollingEnabled = false;
    this.pollFailStreak = 0;
    this.eventBuffer = [];
    this.pushTimer = null;
    this.flushInFlight = false;
  }

  startSession(spec) {
    const sessionId = spec.sessionId || `s_${crypto.randomUUID()}`;
    if (this.sessions.has(sessionId)) throw new Error(`duplicate session_id: ${sessionId}`);
    const session = new ManagedSession({ ...spec, sessionId });
    this.sessions.set(sessionId, session);
    session.start({
      transport: this.transport,
      onEvent: (event) => this.onEvent?.(sessionId, event),
      pushEvent: (event) => this.enqueueEvent(event),
    });
    return session;
  }

  /** 单事件入口：critical 直推；批量关闭走旧路径；否则进 buffer。 */
  enqueueEvent(event) {
    if (!this.transport) return false;
    if (CRITICAL_EVENT_TYPES.has(event?.event_type)) return this.sendEventsNow([event]);
    if (this.pushBatchMs <= 0) return this.sendEventsNow([event]);
    this.eventBuffer.push(event);
    if (this.eventBuffer.length >= PUSH_BATCH_MAX_EVENTS) {
      void this.flushEvents();
      return true;
    }
    if (!this.pushTimer) {
      this.pushTimer = setTimeout(() => { this.pushTimer = null; void this.flushEvents(); }, this.pushBatchMs);
      this.pushTimer.unref?.();
    }
    return true;
  }

  sendEventsNow(events) {
    if (!events?.length) return false;
    this.transport.pushEvents(events).catch(() => {});
    return true;
  }

  /** 冲刷当前缓冲区一批（≤200 条）；失败则原样塞回队首等待下次。 */
  async flushEvents() {
    if (!this.transport || this.flushInFlight) return false;
    const batch = this.eventBuffer.splice(0, PUSH_BATCH_MAX_EVENTS);
    if (!batch.length) return false;
    this.flushInFlight = true;
    try {
      await this.transport.pushEvents(batch);
      return true;
    } catch {
      this.eventBuffer.unshift(...batch);
      return false;
    } finally {
      this.flushInFlight = false;
    }
  }

  startPolling() {
    if (this.timer) return;
    this.pollingEnabled = true;
    this.schedulePollTick();
  }

  /** 下一次轮询延迟：连续失败指数退避 min(base*2^n, max)，成功归零。 */
  nextPollDelay() {
    const base = Math.max(50, this.pollIntervalMs || 3000);
    if (this.pollFailStreak <= 0) return base;
    const backoff = base * (2 ** Math.min(this.pollFailStreak, MAX_BACKOFF_EXPONENT));
    return Math.min(backoff, this.maxBackoffMs);
  }

  schedulePollTick() {
    this.timer = setTimeout(() => { this.pollTick(); }, this.nextPollDelay());
    this.timer.unref?.();
  }

  async pollTick() {
    try {
      const res = await this.transport.pullCommands();
      for (const command of res?.data?.commands || []) {
        await this.executeCommand(command);
      }
      this.pollFailStreak = 0; // 成功归零
    } catch (err) {
      this.pollFailStreak += 1; // 失败进入退避路径
      // best effort polling; real transport errors surface in caller logs
    }
    if (this.pollingEnabled) this.schedulePollTick();
  }

  async executeCommand(command) {
    let session = this.sessions.get(command?.session_id);
    if (!session && this.sessions.size === 1) session = this.sessions.values().next().value;
    if (!session) return false;
    switch (command.command_type) {
      case 'send_text':
        return session.sendText(command.payload?.content || '');
      case 'respond_action':
        return session.respondAction(command.payload?.request_id, command.payload?.decision);
      case 'stop_session':
        await session.stop();
        return true;
      default:
        return false;
    }
  }

  async stopAll() {
    this.pollingEnabled = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.pushTimer) clearTimeout(this.pushTimer);
    this.pushTimer = null;
    await this.flushEvents(); // 进程退出/停止前冲掉剩余缓冲
    const results = [];
    for (const session of this.sessions.values()) results.push(await session.stop());
    return results;
  }
}
