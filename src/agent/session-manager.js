import crypto from 'node:crypto';
import path from 'node:path';
import { AgentRunner, sanitizeDiagnosticText } from './runner.js';
import { SessionSequencer, createEvent, sanitizePreview } from '../lib/events.js';
import { EventOutbox } from '../lib/outbox.js';
import { CommandInbox } from '../lib/inbox.js';
import { lineToEvent } from '../adapters/generic.js';
import { capabilitiesFor, authorizeWorkspace } from '../adapters/capabilities.js';
import { appendAuditLine } from '../lib/audit.js';
import { loadUiOverrides } from '../lib/agent-config.js';

// confirm_required / error 必须即时直推，不参与批量缓冲。
// TASK-006 后：直推 = outbox critical 优先级（首包同步发起，失败退避重试），
// 不再有绕过顺序的第二通道（后发先到修复，游标契约见 event-protocol.md §11）。
export const CRITICAL_EVENT_TYPES = Object.freeze(new Set(['confirm_required', 'error']));
// 审批终态回流（TASK-008）：approval_result 同样即时直推——旧卡禁用依赖它尽快可达。
export const CRITICAL_CUSTOM_TYPES = Object.freeze(new Set(['approval_result']));
// 批量缓冲上限：满即 flush，不再等 pushBatchMs。
export const PUSH_BATCH_MAX_EVENTS = 200;
const MAX_BACKOFF_EXPONENT = 10; // 防 2^n 溢出，30s 封顶由 maxBackoffMs 保证

const APPROVAL_RESULT_TEXT = Object.freeze({
  applied: '审批已执行：允许',
  denied: '审批已执行：拒绝',
  failed: '审批执行失败',
  expired: '审批已超时（默认拒绝）',
  cancelled: '审批已撤销',
});

/** 进程退出终态（TASK-012/E13）：code=null 且有 error → failed（非 ended）；
 *  信号终止（stop 触发）与 code=0 → ended；其余 → failed。 */
export function resolveExitStatus(info) {
  if (!info || typeof info !== 'object') return 'failed';
  if (info.error) return 'failed';
  if (info.code === 0) return 'ended';
  if (info.code === null && info.signal) return 'ended';
  return 'failed';
}

function isCriticalEvent(event) {
  return CRITICAL_EVENT_TYPES.has(event?.event_type)
    || CRITICAL_CUSTOM_TYPES.has(event?.payload?.custom_type);
}

/**
 * 撤销感知（TASK-011）：pull/sync 收到 unauthorized 且 reason 表明绑定已被吊销时
 * 返回 true。云端 revoked 墓碑路径的稳定 reason 为 'binding-not-active'
 *（lib-ownership.getActiveBindingByToken），'revoked' 为契约保留字（任务卡 §11.3），
 * 两者都视为"设备授权已撤销"。binding-not-found（token 完全未知）不算撤销——
 * 它也可能是配置错误，按普通传输失败退避，不触发本地身份归档。
 */
export function isRevocationError(err) {
  if (!err) return false;
  const code = String(err.code || '');
  if (code !== 'unauthorized') return false;
  const reason = String(err?.data?.reason || '');
  return /revoked|binding-not-active/.test(reason);
}

export class ManagedSession {
  constructor({
    sessionId,
    agentType = 'generic',
    command,
    args = [],
    cwd,
    correlationId = null,
    // TASK-008：审批 deadline（毫秒）与本机超时动作（config.bridge.permissionTimeoutAction）
    deadlineMs = 10 * 60 * 1000,
    permissionTimeoutAction = 'deny',
  }) {
    this.sessionId = sessionId;
    this.agentType = agentType;
    this.cwd = cwd || process.cwd();
    this.command = command;
    this.correlationId = correlationId; // create_session 命令关联键，随 session_meta 回流（TASK-007）
    // TASK-012：能力声明（adapter 级真实能力；session-manager 据此拒绝不支持的操作）
    this.capabilities = capabilitiesFor(agentType);
    this.sequencer = new SessionSequencer();
    this.runner = new AgentRunner({ command, args, cwd });
    this.status = 'starting';
    this.lastSeq = 0;
    this.exitInfo = null;
    // request_id -> 最近一次 control_request 的原始 input，用于审批回流时回填。
    this.pendingInputs = new Map();
    // TASK-008：每个 pendingInput 独立 deadline 定时器（到期默认 deny，不依赖手机在线）
    this.deadlineMs = Math.max(0, Number(deadlineMs) || 0);
    this.permissionTimeoutAction = permissionTimeoutAction === 'approve' ? 'approve' : 'deny';
    this._deadlineTimers = new Map();
    this._onEvent = null;
    this._sink = null;
    this._onExit = null;
    this._exitHandled = false;
    // 用户/系统显式停止：进程终止应归因为 ended（stopped），非崩溃
    this._stopRequested = false;
    // 最近一次 respondAction 失败原因（供 approval_result / 错误事件归因）
    this.lastResponseError = null;
  }

  start({ transport, onEvent, pushEvent, onExit } = {}) {
    this._onEvent = onEvent || null;
    this._sink = typeof pushEvent === 'function'
      ? pushEvent
      : (event) => { transport?.pushEvents([event]).catch(() => {}); };
    this._onExit = typeof onExit === 'function' ? onExit : null;
    this.runner.on('line', (line, meta) => {
      this.trackControlRequest(line);
      const events = lineToEvent(line, { sessionId: this.sessionId, agentType: this.agentType, sequencer: this.sequencer });
      for (const event of events) {
        // TASK-008：confirm_required 注入 deadline（绝对毫秒，云端 approvals.deadline 同源）
        // 并登记本机定时器——到期默认 deny 真实到达 Agent。
        if (event.event_type === 'confirm_required' && event.payload?.request_id && this.deadlineMs > 0) {
          event.payload.deadline = Date.now() + this.deadlineMs;
          this.armDeadlineTimer(event.payload.request_id);
        }
        // TASK-012：超长行截断标记——不再把 256KB 截断文本映射为完整事件（结构上限）
        if (meta && meta.truncated) {
          this.pushEventNow(this.truncationEvent(meta));
          continue;
        }
        this.pushEventNow(event);
      }
    });
    // TASK-012：stderr 不再静默——按行保留尾部（脱敏后随 session_exit 事件回流诊断）
    this.runner.on('stderr', () => {});
    this.runner.on('stdin-error', (err) => {
      // E13/资源限制：stdin 写入错误 → 会话 failed（非悬挂）
      this.status = 'failed';
      this.pushEventNow(createEvent({
        sessionId: this.sessionId,
        agentType: this.agentType,
        sequencer: this.sequencer,
        eventType: 'error',
        payload: {
          message: `Agent stdin 写入失败，命令可能未送达：${sanitizeDiagnosticText(err?.message || err, 200)}`,
          code: 'stdin-error',
          severity: 'fatal',
          recoverable: false,
        },
      }));
    });
    this.runner.on('exit', (info) => this.handleRunnerExit(info));
    this.runner.start();
    this.status = 'running';
    // P2-E（CLOSE-007）：codex 会话 stdin 启动即 EOF。
    // 依据（2026-09-18 codex-cli 0.144.1 / Windows 实测，探针存 xcx/.tmp/close-007/probes/）：
    //   - stdin 常开 + 无 prompt argv：codex 打印 "Reading prompt from stdin..." 后无限等待
    //     （45s 观察窗零输出零退出，探针强杀）→ create_session 无 prompt 时永久挂起；
    //   - stdin 常开 + prompt 在 argv：codex 仍等待 stdin EOF（`codex exec --help` 明示
    //     "stdin is appended as a <stdin> block"），实测同样零输出挂起——bridge 旧行为下
    //     初始会话 150s 无任何事件（侦察 run1/run2 一致复现）；
    //   - stdin 立即 EOF + prompt 在 argv：正常启动（thread.started → turn.started）；
    //   - stdin 立即 EOF + 无 prompt argv：约 340ms 显式报错退出（"No prompt provided
    //     via stdin."，exit 1），会话以 session_exit(failed) 收场，不悬挂。
    // bridge 对 codex 会话的一切写 stdin 路径（send_text/respond_action/prompt 注入）均被
    // 能力协商拒绝——立即 EOF 不损失任何功能，只消除整类挂起。二选一裁决：选「立即 EOF」
    // 而非「create_session 能力拒绝」——codex 任务提示本就来自 config args（argv 末位），
    // EOF 后真实可用（harness codex 模式验证）。
    // 范围仅 codex：generic 是任意用户 CLI，stdin 契约未知、无实测依据（有的 CLI 合法
    // 等待输入），不随本修复改变行为；claude-code 需要 stdin 双向帧，不适用。
    if (this.agentType === 'codex') {
      try { this.runner.stdin?.end(); } catch { /* stdin 已关闭/不可用则忽略 */ }
    }
    // TASK-029：AGENTS.md `ui` 块 → 白名单化 ui_overrides 随 session_meta 上报。
    // 每次会话启动重读 AGENTS.md（配置变更 = 新 meta 事件携带新 ui_version）；
    // 读取/解析任何失败 fail-open（不携带字段、不产生额外事件、不影响主事件流）。
    const uiOverrides = loadUiOverrides(this.cwd);
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
          title: this.cwd ? processTitle(this.cwd) : '远程会话',
          // TASK-007：create_session 来源的会话携带关联键（命令 correlation_id/_command_id），
          // 手机端可据此把「新建任务」请求与新会话关联（消费方接入属 TASK-016）
          correlation_id: this.correlationId || null,
          // TASK-012：能力协商——前端以此禁用不支持操作的按钮（矩阵 §2）
          capabilities: { ...this.capabilities },
          // TASK-029：Layer 3 声明式 UI（已白名单裁剪，≤4KB；协议 docs/agents-ui-protocol.md v0.2-draft）
          ...(uiOverrides ? { ui_overrides: uiOverrides } : {}),
        },
      },
    });
    this.pushEventNow(metaEvent);
    return this;
  }

  pushEventNow(event) {
    this.lastSeq = event.seq;
    this._onEvent?.(event);
    this._sink(event);
  }

  /** 超长行截断的结构化事件：小体积摘要替代整行内容（TASK-012 资源限制）。 */
  truncationEvent(meta) {
    return createEvent({
      sessionId: this.sessionId,
      agentType: this.agentType,
      sequencer: this.sequencer,
      eventType: 'custom',
      payload: {
        custom_type: 'output_truncated',
        fallback_text: `Agent 输出单行超过 ${Math.round(Number(meta.droppedBytes || 0) / 1024) + 256}KB，已截断`,
        data: {
          truncated: true,
          dropped_bytes: Number(meta.droppedBytes) || 0,
          preview: sanitizePreview(String(meta.preview ?? ''), 200),
        },
      },
    });
  }

  handleRunnerExit(info) {
    if (this._exitHandled) return; // 'error' 与 'exit' 双发时先到者为准
    this._exitHandled = true;
    this.exitInfo = info;
    // 显式停止（stop_session/stopAll）导致的进程终止 → ended；非停止路径按退出规则
    this.status = this._stopRequested && !info?.error ? 'ended' : resolveExitStatus(info);
    this.clearAllDeadlineTimers();
    this.pendingInputs.clear();
    const failed = this.status === 'failed';
    const payload = {
      custom_type: 'session_exit',
      // 区分 turn 完成（adapter result → session_end）与进程终止（session_exit）
      fallback_text: failed ? 'Agent 进程异常退出' : 'Agent 进程已退出',
      data: {
        status: this.status,
        code: info?.code ?? null,
        signal: info?.signal ?? null,
        truncated_lines: this.runner.truncatedLineCount || 0,
      },
    };
    if (info?.error) payload.data.error = sanitizeDiagnosticText(info.error?.message || info.error, 300);
    if (failed && this.runner.stderrTail) {
      payload.data.stderr_tail = sanitizeDiagnosticText(this.runner.stderrTail, 500);
    }
    const event = createEvent({
      sessionId: this.sessionId,
      agentType: this.agentType,
      sequencer: this.sequencer,
      eventType: 'custom',
      payload,
    });
    this.pushEventNow(event);
    this._onExit?.(info, event);
  }

  /** 嗅探 stdout 行：control_request 的原始 input 记入 pendingInputs。 */
  trackControlRequest(line) {
    try {
      const raw = JSON.parse(line);
      if (raw && raw.type === 'control_request' && typeof raw.request_id === 'string') {
        this.pendingInputs.set(raw.request_id, raw.request?.input ?? {});
      }
    } catch {
      // 非 JSON 行（或半行/截断行）忽略
    }
  }

  // ---- TASK-008：deadline 定时器（每 pendingInput 一个）----

  armDeadlineTimer(requestId) {
    if (!(this.deadlineMs > 0)) return;
    this.clearDeadlineTimer(requestId);
    const timer = setTimeout(() => this.fireDeadline(requestId), this.deadlineMs);
    timer.unref?.();
    this._deadlineTimers.set(requestId, timer);
  }

  clearDeadlineTimer(requestId) {
    const timer = this._deadlineTimers.get(requestId);
    if (timer) {
      clearTimeout(timer);
      this._deadlineTimers.delete(requestId);
    }
  }

  clearAllDeadlineTimers() {
    for (const timer of this._deadlineTimers.values()) clearTimeout(timer);
    this._deadlineTimers.clear();
  }

  /** deadline 到期：默认 deny 真实发给 Agent（走 adapter 的 deny 编码）+ 终态事件 + 清 pending。 */
  fireDeadline(requestId) {
    this._deadlineTimers.delete(requestId);
    if (!this.pendingInputs.has(requestId)) return; // 已决议/已撤销/会话已结束
    const action = this.permissionTimeoutAction; // 'deny'（默认）| 'approve'（显式配置才生效）
    const sent = this.respondAction(requestId, action);
    this.emitApprovalResult(requestId, 'expired', {
      timeout_action: action,
      agent_notified: sent === true,
    });
  }

  /** 审批终态回流（TASK-008）：approval_result custom 事件，带 request_id + status + 新 seq。 */
  emitApprovalResult(requestId, status, extra = {}) {
    const event = createEvent({
      sessionId: this.sessionId,
      agentType: this.agentType,
      sequencer: this.sequencer,
      eventType: 'custom',
      payload: {
        custom_type: 'approval_result',
        request_id: String(requestId || ''),
        status,
        fallback_text: APPROVAL_RESULT_TEXT[status] || `审批状态：${status}`,
        ...extra,
      },
    });
    this.pushEventNow(event);
    return event;
  }

  sendText(content) {
    return this.runner.sendJson({ type: 'user', message: { role: 'user', content } });
  }

  /**
   * 审批决议回写 Agent（TASK-008 语义）：
   *   - approve 必须有原始 control_request input 记录——缺失拒绝执行（不默认 {} 放行）；
   *   - deny/cancel 语义不变（deny 无需原始 input）；
   *   - 成功发送后清理 pending 记录与 deadline 定时器。
   * @returns {boolean} 控制帧是否成功写入 stdin；失败原因见 lastResponseError
   */
  respondAction(requestId, decision) {
    this.lastResponseError = null;
    const approve = decision === 'approve';
    if (approve && !this.pendingInputs.has(requestId)) {
      // 缺原始输入 → 拒绝（绝不回填 {} 执行）
      this.lastResponseError = 'approval-input-missing';
      return false;
    }
    const originalInput = approve ? this.pendingInputs.get(requestId) : {};
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
    // control_response 已回流（或写失败），清理 pending 记录与定时器。
    this.pendingInputs.delete(requestId);
    this.clearDeadlineTimer(requestId);
    if (!sent) this.lastResponseError = 'stdin-unavailable';
    return sent;
  }

  async stop() {
    this._stopRequested = true;
    this.clearAllDeadlineTimers();
    this.pendingInputs.clear();
    return this.runner.stop();
  }
}

function processTitle(cwd) {
  try {
    return path.basename(cwd);
  } catch {
    return '远程会话';
  }
}

export class SessionManager {
  /**
   * @param {object} opts
   * @param {number} [opts.drainDeadlineMs] 退出排空期限（默认 10s）；期限后未确认项留在磁盘/内存，重启恢复重发
   * @param {string|null} [opts.outboxDir] 持久 outbox 目录（<dataDir>/outbox）；缺省=内存模式（测试）
   * @param {string|null} [opts.inboxDir]  持久 inbox 目录（<dataDir>/inbox）；缺省=内存模式（测试）
   * @param {EventOutbox} [opts.outbox] 直接注入 outbox 实例（优先于 outboxDir，避免同目录双实例）
   * @param {CommandInbox} [opts.inbox] 直接注入 inbox 实例（优先于 inboxDir）
   * @param {number} [opts.permissionTimeoutMs] 审批 deadline（默认 10min；TASK-008）
   * @param {string} [opts.permissionTimeoutAction] 超时动作 'deny'（默认）| 'approve'
   * @param {string[]} [opts.workspaces] 授权工作区根（realpath 规范路径；TASK-012/D4）
   * @param {number} [opts.maxSessions] 并发会话上限（远程 create_session；TASK-012）
   * @param {string|null} [opts.auditFile] 本机审计日志文件（JSON Lines；TASK-012）
   * @param {Function} [opts.onSessionEnded] 会话退出回调（sessionId, exitInfo）——daemon 空闲退出判定用
   * @param {Function} [opts.onRevoked] 授权撤销回调（TASK-011）——main.js 归档 device.json 用
   */
  constructor({
    transport,
    pollIntervalMs = 3000,
    pushBatchMs = 0,
    maxBackoffMs = 30000,
    onEvent,
    defaultSpec,
    outboxDir = null,
    inboxDir = null,
    outbox = null,
    inbox = null,
    drainDeadlineMs = 10 * 1000,
    permissionTimeoutMs = 10 * 60 * 1000,
    permissionTimeoutAction = 'deny',
    workspaces = [],
    maxSessions = 8,
    auditFile = null,
    onSessionEnded = null,
    onRevoked = null,
  } = {}) {
    this.transport = transport;
    this.pollIntervalMs = pollIntervalMs;
    // >0 启用批量缓冲推送；0/undefined 保持旧的逐条即时推送行为。
    this.pushBatchMs = Math.max(0, Number(pushBatchMs) || 0);
    this.maxBackoffMs = Math.max(pollIntervalMs || 3000, Number(maxBackoffMs) || 30000);
    this.onEvent = onEvent;
    // create_session 命令的启动规格（command/args 来自本机 config，手机端只提供 cwd+prompt）
    this.defaultSpec = defaultSpec || null;
    this.permissionTimeoutMs = Math.max(0, Number(permissionTimeoutMs) || 0);
    this.permissionTimeoutAction = permissionTimeoutAction === 'approve' ? 'approve' : 'deny';
    this.workspaces = Array.isArray(workspaces) ? workspaces.map((w) => String(w)) : [];
    this.maxSessions = Math.max(1, Number(maxSessions) || 8);
    this.auditFile = auditFile;
    this.onSessionEnded = onSessionEnded;
    this.onRevoked = typeof onRevoked === 'function' ? onRevoked : null;
    this.sessions = new Map();
    this.timer = null;
    this.pollingEnabled = false;
    // CLOSE-010：持久化不可用（磁盘满/权限）时的 fail-closed 状态（观测用）
    this.durabilityDegraded = false;
    this.pollFailStreak = 0;
    this.eventBuffer = [];
    this.pushTimer = null;
    this.flushInFlight = false;
    // TASK-006/007：持久（或内存）outbox/inbox。所有上行（事件/ACK）先入 outbox
    // 再发送：transport 失败（TransportError）不再静默丢事件，统一退避重试。
    this.outbox = outbox || new EventOutbox({ dir: outboxDir, transport });
    this.inbox = inbox || new CommandInbox({ dir: inboxDir });
    this.drainDeadlineMs = Math.max(0, Number(drainDeadlineMs) || 0);
    // CLOSE-010：持久 inbox 场景下的重启恢复——「结果已持久化但 ACK 未入队」（崩溃于
    // markResult 与 enqueueAck 之间的窗口）的记录重新入队 ACK。幂等：markAckEnqueued
    // 落盘成功后不会重复入队。内存模式（inbox.dir=null）无恢复对象，跳过。
    if (this.inbox.dir) {
      try {
        this.recoverPendingAcks();
      } catch (err) {
        console.warn('[session-manager] pending-ack recovery failed:', err?.message || err);
      }
    }
  }

  /**
   * 重启恢复（CLOSE-010）：扫描 inbox 中「结果信封完整但 ACK 未入队」的 done 记录，
   * 从信封重建 ACK 重新入队 outbox。返回恢复条数（测试/运维可见）。
   */
  recoverPendingAcks() {
    let recovered = 0;
    for (const record of this.inbox.pendingAckRecords()) {
      try {
        if (this.enqueueRecordedAck(record, this.baseAckPayloadFromCommand(record.command || {}))) {
          recovered += 1;
        }
      } catch (err) {
        console.warn(`[session-manager] recover ack enqueue failed for ${record.command_id}: ${err?.message || err}`);
      }
    }
    if (recovered > 0) {
      console.log(`[session-manager] recovered ${recovered} persisted result(s) without ack → re-enqueued for delivery`);
    }
    return recovered;
  }

  startSession(spec) {
    const sessionId = spec.sessionId || `s_${crypto.randomUUID()}`;
    if (this.sessions.has(sessionId)) throw new Error(`duplicate session_id: ${sessionId}`);
    const session = new ManagedSession({
      ...spec,
      sessionId,
      deadlineMs: this.permissionTimeoutMs,
      permissionTimeoutAction: this.permissionTimeoutAction,
    });
    this.sessions.set(sessionId, session);
    session.start({
      transport: this.transport,
      onEvent: (event) => this.onEvent?.(sessionId, event),
      pushEvent: (event) => this.enqueueEvent(event),
      // TASK-012：会话退出即时清理（map 移除 + onSessionEnded 回调供 daemon 空闲判定）
      onExit: () => {
        this.sessions.delete(sessionId);
        this.onSessionEnded?.(sessionId, session.exitInfo);
      },
    });
    return session;
  }

  /** 单事件入口：critical/approval_result 直推；批量关闭走旧路径；否则进 buffer。 */
  enqueueEvent(event) {
    if (!this.transport) return false;
    if (isCriticalEvent(event)) return this.sendEventsNow([event]);
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

  /**
   * 即时发送：事件先落 outbox（失败可重试，E06 修复），首包在本次调用栈内同步发起
   * （保持 critical 事件「即时直推」语义），传输失败由 outbox 退避重试。
   */
  sendEventsNow(events) {
    if (!events?.length || !this.transport) return false;
    const critical = events.some(isCriticalEvent);
    try {
      this.outbox.enqueueMany(events, { priority: critical ? 'critical' : 'normal' });
    } catch (err) {
      console.warn('[session-manager] outbox enqueue failed:', err?.message || err);
      return false;
    }
    void this.outbox.flush();
    return true;
  }

  /** 冲刷当前缓冲区一批（≤200 条）入 outbox 并尽力发送；失败项由 outbox 退避重试。 */
  async flushEvents() {
    if (!this.transport || this.flushInFlight) return false;
    const batch = this.eventBuffer.splice(0, PUSH_BATCH_MAX_EVENTS);
    if (!batch.length) return false;
    this.flushInFlight = true;
    try {
      let enqueued = 0;
      try {
        enqueued = this.outbox.enqueueMany(batch, { priority: 'normal' });
      } catch (err) {
        console.warn('[session-manager] outbox enqueue failed:', err?.message || err);
      }
      if (enqueued < batch.length) {
        // 入队失败（磁盘异常/积压上限）的尾部回塞队首；已入队部分由 outbox 负责送达
        this.eventBuffer.unshift(...batch.slice(enqueued));
      }
      if (enqueued > 0) await this.outbox.flush();
      return enqueued > 0;
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
    let res = null;
    try {
      res = await this.transport.pullCommands();
      this.pollFailStreak = 0; // 成功归零
    } catch (err) {
      // E06/T07：transport 失败（网络/非2xx/非法响应/ok:false）已统一抛 TransportError；
      // 轮询失败只退避，绝不把失败当成功、也绝不清空任何待发数据。
      this.pollFailStreak += 1;
      if (isRevocationError(err)) {
        // TASK-011 撤销感知：binding-not-active/revoked → 停止轮询循环（不再 schedule），
        // 触发 onRevoked（main.js 归档 device.json）；outbox 存量项由下一次 flush 命中
        // unauthorized（永久失败码）自动 dead-letter——撤销后不再重试上报。
        this.handleRevoked(err);
        return;
      }
    }
    const commands = (res && res.data && res.data.commands) || [];
    for (const command of commands) {
      // CLOSE-010：fail-closed（持久化失败）或撤销发生后，本批剩余命令不再处理——
      // 不得在结果不可记录的状态下继续执行下一条（可能不可逆的）命令。
      if (!this.pollingEnabled) break;
      try {
        await this.handlePulledCommand(command);
      } catch (err) {
        console.warn('[session-manager] command handling failed:', err?.message || err);
      }
    }
    // 顺带驱动一次 outbox 排空（退避由 next_attempt_at 把关，不会形成重试风暴）
    void this.outbox.flush();
    if (this.pollingEnabled) this.schedulePollTick();
  }

  /** 授权撤销处理：停止轮询 + 明确日志 + onRevoked 回调（进程继续存活，由用户决定退出）。 */
  handleRevoked(err) {
    this.pollingEnabled = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    console.warn(`[revoked] 设备授权已撤销（reason=${err?.data?.reason || 'revoked'}），停止命令轮询；`);
    console.warn('[revoked] 本地未确认事件将按永久失败进 dead-letter（撤销后不再上报）；本机 Agent 会话不受影响，如需终止请手动停止。');
    // 主动驱动一次排空：存量 pending 立即走 unauthorized（永久失败码）→ dead-letter，
    // 而不是等 pump 下一轮（后台 pump 仍会兜底驱动，双驱动幂等）。
    void this.outbox.flush();
    try {
      this.onRevoked?.(err);
    } catch (hookErr) {
      console.error('[revoked] onRevoked 回调失败:', hookErr?.message || hookErr);
    }
  }

  /**
   * 拉取到的单条命令：inbox 去重 → 执行 → 完整结果信封持久化 → ACK 回流。
   * pull=租约（leased）而非终态；完成即 ack（失败也 ack），ack 发送失败不阻塞执行
   * （ack 走 outbox 退避重试）。
   *
   * CLOSE-010 fail-closed 链条（每个持久化边界都可崩溃/重启，行为可预期）：
   *   - claim / markExecuting 落盘失败（磁盘满/权限）→ 命令确定未执行：如实 ack failed
   *     + 停止命令轮询（结果不可记录就不执行，respond_action/stop 等不可逆命令安全）；
   *   - markResult 落盘失败 → 执行可能已发生：ack unknown（绝不虚构成功）+ 停止命令轮询；
   *   - enqueueAck 失败 → 结果已持久化（无 ack 标记）：重启 recoverPendingAcks 重新入队，
   *     云端租约重派时 skip-done 从信封重放，双路径兜底不静默丢失；
   *   - markResult 成功后任意时点崩溃 → 重派从结果信封原样重建 ACK（R07：两次 ACK 一致）。
   */
  async handlePulledCommand(command) {
    const commandId = String(command?.command_id || '');
    if (!commandId) return false;
    const base = this.baseAckPayloadFromCommand(command);
    let claim;
    try {
      claim = this.inbox.claim(command);
    } catch (err) {
      return this.abortNotExecuted(base, 'inbox-claim-persist-failed', err);
    }
    if (claim.action === 'skip-done') {
      // 租约重派撞上已执行命令：从持久化结果信封重建 ACK（幂等再 ack，帮助服务端收敛）
      return this.replayRecordedResult(claim.record, base, command);
    }
    if (claim.action === 'recover-unknown') {
      // 崩溃恢复：执行中中断的命令结果未知，如实上报（不盲目重放，不可逆命令安全边界）
      this.enqueueRecordedAck(claim.record, base);
      void this.outbox.flush();
      return false;
    }

    // 执行前门禁：executing 态（及其后的结果）必须先确认可落盘——落盘失败则不执行
    try {
      const marked = this.inbox.markExecuting(commandId);
      if (!marked) {
        return this.abortNotExecuted(base, 'inbox-record-missing', new Error('inbox record vanished before executing'));
      }
    } catch (err) {
      return this.abortNotExecuted(base, 'inbox-executing-persist-failed', err);
    }

    let result = 'failed';
    let error = '';
    let resultSessionId = null;
    try {
      const outcome = await this.executeCommand(command);
      if (outcome && typeof outcome === 'object') {
        result = outcome.ok === false ? 'failed' : 'succeeded';
        if (outcome.error) error = String(outcome.error);
        resultSessionId = outcome.session_id || command.session_id || null; // create_session 回填；其余为目标会话
      } else {
        result = outcome === true ? 'succeeded' : 'failed';
        if (result === 'failed') error = `command rejected by bridge (type=${command?.command_type || 'unknown'})`;
        resultSessionId = command.session_id || null;
      }
    } catch (err) {
      result = 'failed';
      error = `bridge execution error: ${err?.message || err}`;
    }

    // 完整结果信封一次落盘（含 result_session_id/correlation/request_id/完成时间）
    const envelope = {
      result,
      error: error || null,
      result_session_id: resultSessionId,
      command_type: command?.command_type ?? null,
      correlation_id: command?.correlation_id ?? null,
      request_id: command?.payload?.request_id ?? null,
    };
    try {
      this.inbox.markResult(commandId, envelope);
    } catch (err) {
      return this.resultPersistFailed(base, envelope, err);
    }
    this.enqueueRecordedAck(this.inbox.get(commandId), base);
    void this.outbox.flush();
    return result === 'succeeded';
  }

  /** 从云端命令构建 ACK 基础字段（command_id/session/correlation/lease/attempts）。 */
  baseAckPayloadFromCommand(command) {
    return {
      command_id: String(command?.command_id || ''),
      ...(command?.session_id ? { session_id: command.session_id } : {}),
      ...(command?.correlation_id ? { correlation_id: command.correlation_id } : {}),
      ...(command?.lease_id ? { lease_id: command.lease_id } : {}),
      ...(Number.isInteger(command?.attempts) ? { attempts: command.attempts } : {}),
    };
  }

  /**
   * 从持久化结果信封构建并入队 ACK（CLOSE-010：重复 ACK 从同一信封重建，不丢字段）。
   * 入队成功即落 ack_enqueued 标记（恢复扫描据此跳过）；入队抛错 → fail-closed 告警
   * （结果已持久化，重启恢复/云端重派双路径兜底）。
   * overrides: { result?, error?, session_id? } 供旧记录补偿路径显式指定。
   */
  enqueueRecordedAck(record, base, overrides = {}) {
    if (!record) return false;
    const result = overrides.result !== undefined ? overrides.result : (record.result || 'unknown');
    const errorText = overrides.error !== undefined ? overrides.error : record.error;
    const sessionId = overrides.session_id !== undefined ? overrides.session_id : record.result_session_id;
    const payload = {
      ...base,
      result,
      ...(errorText ? { error: errorText } : {}),
      ...(sessionId ? { session_id: sessionId } : {}),
    };
    try {
      if (!this.outbox.enqueueAck(payload)) return false;
      this.inbox.markAckEnqueued(record.command_id);
      return true;
    } catch (err) {
      this.handleDurabilityLoss('ack-enqueue', err, record.command_id);
      return false;
    }
  }

  /** 租约重派撞已执行命令：信封记录原样重放；旧 schema 记录走「结果不完整」路径。 */
  replayRecordedResult(record, base, command) {
    if (record.envelope_version == null) {
      return this.replayLegacyRecord(record, base, command);
    }
    this.enqueueRecordedAck(record, base);
    void this.outbox.flush();
    return false;
  }

  /**
   * 旧 schema 记录（无结果信封）重派：按「结果不完整」处理——不重新执行、不虚构成功 sid。
   *  - create_session：受控补偿——进程存活且能按关联键定位本命令创建的会话 → 用真实
   *    sid 补 ACK（该 sid 来自本进程实际创建的会话，非虚构）；否则明确 unknown 失败
   *    （绝不重执行——避免 create_session 二次执行拉起第二个进程，A07）。
   *  - 普通命令：明确 error 状态（unknown + 归档原记录内容于 error，可追溯）。
   */
  replayLegacyRecord(record, base, command) {
    const commandType = String(command?.command_type || record.command?.command_type || '');
    if (commandType === 'create_session') {
      const correlationKey = record.correlation_id
        || command?.correlation_id
        || command?.command_id
        || record.command?.correlation_id
        || record.command?.command_id
        || null;
      const liveSid = correlationKey ? this.findSessionIdByCorrelation(correlationKey) : null;
      if (liveSid) {
        this.enqueueRecordedAck(record, base, { result: record.result || 'unknown', error: null, session_id: liveSid });
      } else {
        this.enqueueRecordedAck(record, base, {
          result: 'unknown',
          error: 'result-envelope-incomplete: legacy create_session record has no result_session_id and no live session matches; refusing to re-execute or fabricate a session_id',
        });
      }
    } else {
      this.enqueueRecordedAck(record, base, {
        result: 'unknown',
        error: `result-envelope-incomplete: legacy record lacks full result envelope (recorded result=${record.result || 'n/a'}${record.error ? `, error=${record.error}` : ''}); not re-executed`,
      });
    }
    void this.outbox.flush();
    return false;
  }

  /** 受控补偿定位：按 create_session 关联键（correlation_id/command_id）在存活会话中找本命令创建的会话。 */
  findSessionIdByCorrelation(correlationId) {
    for (const [sid, session] of this.sessions) {
      if (session.correlationId === correlationId) return sid;
    }
    return null;
  }

  /**
   * fail-closed 中止（执行动作发生前的落盘失败）：命令确定未执行 → 如实 ack failed
   * + 停止命令轮询。ACK 入队再失败则只保留日志（无本地记录可依赖，云端按租约重派收敛）。
   */
  abortNotExecuted(base, reason, err) {
    this.handleDurabilityLoss(reason, err, base.command_id);
    try {
      this.outbox.enqueueAck({
        ...base,
        result: 'failed',
        error: `${reason}: ${String(err?.message || err).slice(0, 300)}; command not executed (fail-closed)`,
      });
      void this.outbox.flush();
    } catch (ackErr) {
      this.handleDurabilityLoss('ack-enqueue', ackErr, base.command_id);
    }
    return false;
  }

  /**
   * fail-closed：结果信封落盘失败（磁盘满/权限错误）。执行可能已发生（respond_action/
   * stop 等不可逆）——绝不虚构成功、绝不当作干净成功继续下一条：
   *  ① ACK 如实上报 unknown（云端 unknown 为显式终态；approval 停留 decision_queued 呈现未知，不猜测）；
   *  ② 日志保留完整结果信封取证（磁盘不可用时的最后痕迹）；
   *  ③ 停止命令轮询；磁盘残留 executing 记录在重启后走 recover-unknown，语义一致。
   */
  resultPersistFailed(base, envelope, err) {
    this.handleDurabilityLoss('result-persist', err, base.command_id);
    try {
      console.error(`[fail-closed] 未持久化的结果信封（取证）: ${JSON.stringify({ command_id: base.command_id, ...envelope })}`);
    } catch { /* 信封含不可序列化字段时降级为摘要 */ }
    try {
      this.outbox.enqueueAck({
        ...base,
        result: 'unknown',
        error: `result-persist-failed: ${String(err?.message || err).slice(0, 200)}; outcome not durably recorded (fail-closed, treated as unknown)`,
      });
      void this.outbox.flush();
    } catch (ackErr) {
      this.handleDurabilityLoss('ack-enqueue', ackErr, base.command_id);
    }
    return false;
  }

  /** 持久化不可用（磁盘满/权限）：停止命令轮询（进程保持存活），等待人工恢复磁盘后重启。 */
  handleDurabilityLoss(reason, err, commandId = null) {
    this.durabilityDegraded = true;
    console.error(`[fail-closed] 本地持久化失败（${reason}${commandId ? `, command_id=${commandId}` : ''}）: ${err?.message || err}`);
    console.error('[fail-closed] 已停止命令轮询：磁盘/权限恢复前不再执行任何命令（防止不可逆命令在结果不可记录状态下执行）；已持久化的结果将在重启后恢复 ACK。');
    this.pollingEnabled = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  async executeCommand(command) {
    const type = command?.command_type;
    // E08 修复（TASK-003）：显式 session_id 在本机不存在 → 拒绝执行并回传错误事件，
    // 删除"回退唯一会话"兜底（否则停止/发消息会误落到错误任务）。
    // 兼容保留：未携带 session_id 的历史命令（旧云端/旧手机版本）在本机仅一个会话时
    // 仍路由到它；TASK-007 命令契约（强制 client_request_id+session 语义）落地后移除。
    const sid = typeof command?.session_id === 'string' ? command.session_id : '';
    let session = sid ? (this.sessions.get(sid) || null) : null;
    if (!session && !sid && this.sessions.size === 1) {
      session = this.sessions.values().next().value;
    }
    if (!session && type !== 'create_session') {
      if (sid) {
        console.warn(`[session-manager] 拒绝命令 ${type || 'unknown'}：未知 session_id=${sid}`);
        this.emitUnknownSessionEvent(sid, type);
      }
      return false;
    }
    switch (type) {
      case 'send_text':
        if (!session.capabilities.send) return this.rejectCapability(session, command, 'send');
        return session.sendText(command.payload?.content || '');
      case 'respond_action':
        if (!session.capabilities.approve) return this.rejectCapability(session, command, 'approve');
        return this.forwardDecision(session, command);
      case 'stop_session':
        if (!session.capabilities.stop) return this.rejectCapability(session, command, 'stop');
        await session.stop();
        return true;
      case 'ping':
        // 心跳探测：本机在线即成功（无需会话）
        return true;
      case 'create_session':
        return this.createSessionFromCommand(command.payload || {}, command);
      default:
        return false;
    }
  }

  /** 能力不支持的命令：错误事件回流 + 拒绝执行（E13：绝不向 stdin 乱发 Claude 帧）。 */
  rejectCapability(session, command, capability) {
    console.warn(`[session-manager] 拒绝命令 ${command?.command_type || 'unknown'}：会话 ${session.sessionId} 能力不支持（${capability}，agent=${session.agentType}）`);
    this.emitSessionError(session, {
      message: `该 Agent（${session.agentType}）不支持「${capability}」操作，命令未执行`,
      code: 'capability-unsupported',
      capability,
      command_type: command?.command_type || null,
      severity: 'warning',
      recoverable: false,
    });
    return false;
  }

  /**
   * 会话级错误事件回流：onEvent 观察者（日志/测试）+ enqueueEvent（outbox 送达）双通道，
   * 与 ManagedSession.pushEventNow 的可见性对齐。
   */
  emitSessionError(session, payload) {
    try {
      const event = createEvent({
        sessionId: session.sessionId,
        agentType: session.agentType,
        sequencer: session.sequencer,
        eventType: 'error',
        payload,
      });
      this.onEvent?.(session.sessionId, event);
      this.enqueueEvent(event);
    } catch {
      // 事件构造/入队失败不影响拒绝语义
    }
  }

  /**
   * 审批决议转发（TASK-008）：approve/deny/cancel 三语义。
   *   approve/deny → control_response 帧 + approval_result(applied|denied)；
   *   失败（缺原始 input / stdin 不可用）→ approval_result(failed) + 错误事件；
   *   cancel → 本机同步取消（deny 帧尽力送达避免 Agent 悬挂）+ approval_result(cancelled)。
   */
  forwardDecision(session, command) {
    const requestId = String(command.payload?.request_id || '');
    if (!requestId) return false;
    const raw = String(command.payload?.decision || '').trim().toLowerCase();
    const decision = raw === 'reject' ? 'deny' : raw; // 旧云端/旧手机别名兼容
    if (decision !== 'approve' && decision !== 'deny' && decision !== 'cancel') {
      // 非法 decision：拒绝而非降级执行
      session.lastResponseError = 'invalid-decision';
      session.emitApprovalResult(requestId, 'failed', { reason: 'invalid-decision' });
      return false;
    }
    if (decision === 'cancel') {
      const sent = session.respondAction(requestId, 'deny');
      session.emitApprovalResult(requestId, 'cancelled', { agent_notified: sent === true });
      return true;
    }
    const sent = session.respondAction(requestId, decision);
    if (sent) {
      session.emitApprovalResult(requestId, decision === 'approve' ? 'applied' : 'denied');
      return true;
    }
    session.emitApprovalResult(requestId, 'failed', { reason: session.lastResponseError || 'send-failed' });
    this.emitSessionError(session, {
      message: `审批决议未送达 Agent（request_id=${requestId}）：${session.lastResponseError || 'send-failed'}`,
      code: 'approval-response-failed',
      request_id: requestId,
      severity: 'fatal',
      recoverable: false,
    });
    return false;
  }

  /** 未知 session_id 拒绝时的错误事件回流（手机端可见，不中断轮询循环）。 */
  emitUnknownSessionEvent(sessionId, commandType) {
    this.emitSessionError({ sessionId, agentType: 'generic', sequencer: new SessionSequencer() }, {
      message: `会话不存在，命令 ${commandType || 'unknown'} 未执行`,
      code: 'unknown-session',
    });
  }

  /**
   * create_session：手机端新建任务——在本机配置的 agent 命令上，以指定工作区 cwd
   * 拉起新会话并注入初始提示。
   * TASK-012/D4 工作区授权边界：绝对路径 → stat 目录 → realpath 前后授权根前缀判断
   * （防符号链接逃逸）；拒绝时零进程拉起 + 最小审计（时间/cwd/原因，不含 prompt）。
   * CLI 本地 `run` 不受限（用户本机操作即授权）。
   * 返回 { ok, session_id?, error? }：session_id 供 ack 回填（手机端经 result_session_id
   * 获知新会话）；correlation_id 随 session_meta 事件回流。
   */
  createSessionFromCommand(payload = {}, command = {}) {
    if (!this.defaultSpec) return { ok: false, error: 'no-agent-spec' };
    const rawCwd = typeof payload.cwd === 'string' ? payload.cwd.trim() : '';
    const prompt = typeof payload.prompt === 'string' ? payload.prompt.trim() : '';
    const agentType = this.defaultSpec.agentType || 'generic';
    const caps = capabilitiesFor(agentType);
    // 能力前置检查（零进程拒绝）：create 本身 + 初始 prompt 注入依赖 send
    if (!caps.create) return { ok: false, error: 'capability-unsupported', capability: 'create' };
    if (prompt && !caps.send) {
      return { ok: false, error: 'capability-unsupported', capability: 'send', reason: 'prompt-inject-unsupported' };
    }
    // D4 工作区授权（TASK-012）：拒绝时零进程 + 审计行
    const authz = authorizeWorkspace({ rawCwd, workspaces: this.workspaces });
    if (!authz.ok) {
      appendAuditLine(this.auditFile, {
        event: 'workspace-denied',
        cwd: rawCwd.slice(0, 500),
        reason: authz.reason,
        command_id: command?.command_id || null,
      });
      return { ok: false, error: authz.reason };
    }
    // 并发会话上限（结束会话已即时移除，这里只计活跃会话）
    if (this.sessions.size >= this.maxSessions) {
      appendAuditLine(this.auditFile, {
        event: 'session-limit-rejected',
        cwd: authz.cwd,
        reason: `active=${this.sessions.size},max=${this.maxSessions}`,
        command_id: command?.command_id || null,
      });
      return { ok: false, error: 'session-limit' };
    }
    const sessionId = `s_${crypto.randomUUID()}`;
    const correlationId = String(command.correlation_id || command.command_id || '');
    const session = this.startSession({
      sessionId,
      agentType,
      command: this.defaultSpec.command,
      args: this.defaultSpec.args || [],
      cwd: authz.cwd,
      correlationId,
    });
    let promptOk = true;
    if (prompt) promptOk = session.sendText(prompt) !== false;
    return promptOk
      ? { ok: true, session_id: sessionId }
      : { ok: false, error: 'prompt-inject-failed', session_id: sessionId };
  }

  async stopAll() {
    this.pollingEnabled = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.pushTimer) clearTimeout(this.pushTimer);
    this.pushTimer = null;
    await this.flushEvents(); // 进程退出/停止前把缓冲冲进 outbox 并尽力发送
    const results = [];
    for (const session of this.sessions.values()) results.push(await session.stop());
    await this.flushEvents(); // 停止过程产生的尾部事件（session_exit 等）同样入 outbox
    // 退出排空：等在途完成并持续排空至期限；未确认项留在磁盘/内存，重启后恢复重发
    await this.outbox.flush({ deadlineMs: this.drainDeadlineMs });
    return results;
  }
}
