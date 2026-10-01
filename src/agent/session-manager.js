import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { AgentRunner, sanitizeDiagnosticText } from './runner.js';
import { ComateApiRunner } from '../agents/comate-api-runner.js';
import { SessionSequencer, createEvent, sanitizePreview } from '../lib/events.js';
import { EventOutbox } from '../lib/outbox.js';
import { CommandInbox } from '../lib/inbox.js';
import { lineToEvent } from '../adapters/generic.js';
import { AiderOutputAccumulator, isAiderNativeCommand } from '../adapters/aider.js';
import { IflowOutputAccumulator } from '../adapters/iflow.js';
import { ContinueOutputAccumulator } from '../adapters/continue.js';
import { OpenclawOutputAccumulator } from '../adapters/openclaw.js';
import { capabilitiesFor, openCapabilitiesFor, authorizeWorkspace } from '../adapters/capabilities.js';
import { appendAuditLine } from '../lib/audit.js';
import { loadUiOverrides } from '../lib/agent-config.js';
import { ProfileRouteError } from '../agents/adapter-factory.js';
import { prepareProductLaunch } from '../agents/product-runtime.js';

// 审批、错误和会话终态必须即时持久化，不参与普通输出批量缓冲。
// 即时输出仍经同一持久 outbox；V12-18 优先认领 critical/ACK，同优先级内按入队序。
// 失败退避与逐项确认保持生效，接收游标契约见 event-protocol.md §11。
export const CRITICAL_EVENT_TYPES = Object.freeze(new Set(['confirm_required', 'error', 'session_end']));
// 审批/进程终态与停止证据必须立即落持久队列，不能滞留普通输出内存缓冲。
export const CRITICAL_CUSTOM_TYPES = Object.freeze(new Set(['approval_result', 'session_exit', 'session_stop_result']));
// 批量缓冲上限：满即 flush，不再等 pushBatchMs。
export const PUSH_BATCH_MAX_EVENTS = 200;
// V1-019②：分级队列预算——critical（审批/错误/ACK）在 outbox 普通上限之外的预留容量。
// 预留也耗尽时如实拒绝（返回 false + 告警 + 审计），关键事件不能在无法持久化时假装接纳。
export const CRITICAL_BACKLOG_RESERVE = 500;
// V1-019②：批量缓冲（未落盘内存区）上限——超出丢弃最旧普通事件并计数（transport
// 长时间不可用时不允许 eventBuffer 无界增长耗尽内存）。
export const EVENT_BUFFER_MAX = 2000;
// V1-019①：单会话 output_truncated 事件上限——截断洪峰（失控子进程刷超长行）下
// 截断事件本身也必须有界；超出的截断只计数，随 session_exit.truncation_events_suppressed 汇总。
export const MAX_TRUNCATION_EVENTS = 50;
// 已绑定产品的未知输出保留少量诊断即可；失控 CLI 不得用重复占位事件淹没真云/终态。
export const MAX_UNRECOGNIZED_EVENTS = 20;
const MAX_BACKOFF_EXPONENT = 10; // 防 2^n 溢出，30s 封顶由 maxBackoffMs 保证
const TEXT_OUTPUT_DRAIN_MS = 3000;

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
    productEnv = null,
    cwd,
    correlationId = null,
    // TASK-008：审批 deadline（毫秒）与本机超时动作（config.bridge.permissionTimeoutAction）
    deadlineMs = 10 * 60 * 1000,
    permissionTimeoutAction = 'deny',
    // V12-11：profile 路由元数据（legacy/初始会话为 null；创建时冻结，profile 热改不影响运行中会话）
    profileId = null,
    profileRevision = null,
    agentKey = null,
    adapterVersion = null,
    capabilitySnapshot = null,
    executionCapabilities = null,
  }) {
    this.sessionId = sessionId;
    this.agentType = agentType;
    this.cwd = cwd || process.cwd();
    this.command = command;
    this.correlationId = correlationId; // create_session 命令关联键，随 session_meta 回流（TASK-007）
    // V12-11：profile 路由元数据（冻结快照；ACK/session_meta 回传实际执行者）
    this.profileId = profileId;
    this.profileRevision = profileRevision;
    this.agentKey = agentKey;
    this.aiderOutput = agentKey === 'aider' ? new AiderOutputAccumulator() : null;
    this.iflowOutput = agentKey === 'iflow' ? new IflowOutputAccumulator() : null;
    this.continueOutput = agentKey === 'continue' ? new ContinueOutputAccumulator() : null;
    this.openclawOutput = agentKey === 'openclaw' ? new OpenclawOutputAccumulator() : null;
    this.textOutput = this.aiderOutput || this.iflowOutput || this.continueOutput || this.openclawOutput;
    this.adapterVersion = adapterVersion;
    this.capabilitySnapshot = capabilitySnapshot ? Object.freeze({ ...capabilitySnapshot }) : null;
    // V12-11：Agent 原生会话 ID（claude system/init 的 session_id；codex thread.started 的
    // thread_id）——按 profile 命名空间归档到 launch ledger（见 SessionManager.startSession）。
    this.nativeSessionRef = null;
    // TASK-012：能力声明（adapter 级真实能力；session-manager 据此拒绝不支持的操作）
    this.capabilities = executionCapabilities
      ? Object.freeze({ ...executionCapabilities })
      : capabilitiesFor(agentType);
    this.sequencer = new SessionSequencer();
    const Runner = agentKey === 'comate' ? ComateApiRunner : AgentRunner;
    this.runner = new Runner({ command, args, cwd, env: productEnv });
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
    // V12-11：原生会话 ID 归档回调（SessionManager 注入 → launch ledger profile 命名空间）
    this._onNativeSessionRef = null;
    this._exitHandled = false;
    this._textExitInfo = null;
    this._textDrainTimer = null;
    // 用户/系统显式停止：进程终止应归因为 ended（stopped），非崩溃
    this._stopRequested = false;
    this._hasSessionEnd = false;
    // 最近一次 respondAction 失败原因（供 approval_result / 错误事件归因）
    this.lastResponseError = null;
    // V1-019①：截断事件预算（见 MAX_TRUNCATION_EVENTS）——已发送 / 被抑制计数
    this._truncationEventsSent = 0;
    this._truncationEventsSuppressed = 0;
    this._unrecognizedEventsSent = 0;
    this._unrecognizedEventsSuppressed = 0;
    // V12-11：适配器解析崩溃计数（会话级隔离观测；见 handleAdapterParseError）
    this.adapterParseErrorCount = 0;
  }

  start({ transport, onEvent, pushEvent, onExit } = {}) {
    this._onEvent = onEvent || null;
    this._sink = typeof pushEvent === 'function'
      ? pushEvent
      : (event) => { transport?.pushEvents([event]).catch(() => {}); };
    this._onExit = typeof onExit === 'function' ? onExit : null;
    this.runner.on('line', (line, meta) => {
      // 截断行不是完整产品帧；先记录证据，再拒绝交给任何解析器。
      // Aider 的最终答复按退出时聚合，必须记住这次丢字节，不能把残片标成完整回复。
      if (meta?.truncated) {
        if (this.textOutput) this.textOutput.truncated = true;
        this.emitTruncationWithinBudget(meta);
        return;
      }
      // V12-11：适配器解析崩溃只隔离目标任务（§8.3）——trackLineState/mapLineToEvents 的
      // 任何异常都折为本会话 error 事件 + 计数，绝不外抛（外抛会让 supervisor 连坐全部任务）。
      let events;
      try {
        this.trackLineState(line);
        events = this.mapLineToEvents(line);
      } catch (err) {
        this.handleAdapterParseError(err);
        return;
      }
      for (const event of events) {
        // TASK-008：confirm_required 注入 deadline（绝对毫秒，云端 approvals.deadline 同源）
        // 并登记本机定时器——到期默认 deny 真实到达 Agent。
        if (event.event_type === 'confirm_required' && event.payload?.request_id && this.deadlineMs > 0) {
          event.payload.deadline = Date.now() + this.deadlineMs;
          this.armDeadlineTimer(event.payload.request_id);
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
    this.runner.on('exit', (info) => {
      if ((!this.textOutput && this.agentKey !== 'comate') || info?.error) {
        this.handleRunnerExit(info);
        return;
      }
      this._textExitInfo = info;
      // 子进程 exit 已发生但管道可能还在排空；无 close 时按不完整输出收口。
      this._textDrainTimer = setTimeout(() => {
        if (this.textOutput) this.textOutput.truncated = true;
        this.handleRunnerExit(info);
      }, TEXT_OUTPUT_DRAIN_MS);
    });
    this.runner.on('io-close', (info) => {
      if ((this.textOutput || this.agentKey === 'comate') && !this._exitHandled) this.handleRunnerExit(this._textExitInfo || info);
    });
    this.runner.start();
    this.status = 'running';
    // Codex 和已验证的 profile 产品若只通过 argv 接收初始 prompt、且不支持中途追加，
    // 启动后应立即发 stdin EOF；否则 CLI 可能等待管道结束才处理 argv。Codex 的证据
    // 见 CLOSE-007，OpenCode 1.18.20 的真实探针见 V12-A05 证据卡。未绑定产品的
    // generic 会话以及需要 stdin 双向帧的 Claude 会话保持原行为。
    if (this.agentType === 'codex' || (this.profileId
      && this.agentKey !== 'openhands' // SDK 工具审批需保留 stdin 控制回写
      && this.agentKey !== 'comate' // 同实例原生取消必须保留控制通道
      && this.capabilities.initialPromptChannel === 'launch-args'
      && this.capabilities.append === false)) {
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
          // TASK-012：能力协商——前端以此禁用不支持操作的按钮（矩阵 §2）。
          // V12-09：对外宣称取开放视图（声明 ∩ 验证，未经真实验证的能力不得开放）；
          // profile 执行与展示都取冻结开放能力；本机显式协议会话保留声明层。
          capabilities: this.capabilitySnapshot || openCapabilitiesFor(this.agentType),
          // V12-11：profile 路由来源（创建时冻结；legacy/初始会话为 null——
          // 云端 sessions 投影 v0.3 字段，schema.cjs SESSION_SCHEMA 同名同形）。
          ...(this.profileId ? {
            profile_id: this.profileId,
            profile_revision: this.profileRevision,
            agent_key: this.agentKey,
            ...(this.adapterVersion ? { adapter_version: this.adapterVersion } : {}),
            capability_snapshot: this.capabilitySnapshot || openCapabilitiesFor(this.agentType),
          } : {}),
          // TASK-029：Layer 3 声明式 UI（已白名单裁剪，≤4KB；协议 docs/agents-ui-protocol.md v0.2-draft）
          ...(uiOverrides ? { ui_overrides: uiOverrides } : {}),
        },
      },
    });
    this.pushEventNow(metaEvent);
    return this;
  }

  pushEventNow(event) {
    if (event.event_type === 'custom' && event.payload?.custom_type === 'unrecognized_product_output') {
      if (this._unrecognizedEventsSent >= MAX_UNRECOGNIZED_EVENTS) {
        this._unrecognizedEventsSuppressed += 1;
        this.lastSeq = event.seq; // 序号已分配；尾部真实事件继续单调递增
        return;
      }
      this._unrecognizedEventsSent += 1;
    }
    if (event.event_type === 'session_end') {
      this._hasSessionEnd = true;
      // 原生 Claude stream-json 等待下一条 stdin。只开放单轮文本的 profile
      // 在原生 result 到达后发 EOF，自然退出；本机显式 run/交互通路保留输入。
      if (this.agentKey === 'claude-code'
        && this.capabilities.append === false && this.capabilities.approve === false
        && !this._singleTurnStdinClosed) {
        this._singleTurnStdinClosed = true;
        try { this.runner.stdin?.end(); } catch { /* 已退出的管道无需再次关闭 */ }
      }
    }
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
    if (this._textDrainTimer) clearTimeout(this._textDrainTimer);
    this._textDrainTimer = null;
    this.exitInfo = info;
    // 显式停止（stop_session/stopAll）导致的进程终止 → ended；非停止路径按退出规则
    this.status = this._stopRequested && !info?.error ? 'ended' : resolveExitStatus(info);
    // Comate cannot infer native stopped from a killed/failed host or exit code 0.
    if (this.agentKey === 'comate' && !this._hasSessionEnd) this.status = 'failed';
    this.clearAllDeadlineTimers();
    this.pendingInputs.clear();
    const openclawFrame = this.openclawOutput?.finish({ stopped: this._stopRequested });
    if (this.openclawOutput) {
      if (openclawFrame) {
        try {
          const events = lineToEvent(openclawFrame, {
            sessionId: this.sessionId, agentType: this.agentType,
            agentKey: this.agentKey, sequencer: this.sequencer,
          });
          for (const event of events) this.pushEventNow(event);
        } catch (err) {
          this.handleAdapterParseError(err);
        }
      } else if (info?.code === 0 && !this._stopRequested) {
        this.pushEventNow(createEvent({
          sessionId: this.sessionId, agentType: this.agentType, sequencer: this.sequencer,
          eventType: 'session_end',
          payload: { reason: 'failed', summary: 'OpenClaw 进程已退出，但 JSON 信封缺失或超出缓冲上限', usage: {} },
        }));
      }
    }
    const textFinal = this.openclawOutput ? null : this.textOutput?.finish({
      success: info?.code === 0 && !this._stopRequested,
      stderrTail: this.runner.stderrTail,
    });
    if (textFinal) {
      this.pushEventNow(createEvent({
        sessionId: this.sessionId, agentType: this.agentType, sequencer: this.sequencer,
        eventType: 'agent_message',
        payload: {
          message_id: `m_${this.agentKey}_${crypto.randomUUID()}`,
          role: 'assistant', content: textFinal.content, content_type: 'text', is_final: !textFinal.truncated,
        },
      }));
      this.pushEventNow(createEvent({
        sessionId: this.sessionId, agentType: this.agentType, sequencer: this.sequencer,
        eventType: 'session_end',
        payload: {
          reason: textFinal.truncated ? 'failed' : 'completed',
          summary: textFinal.truncated ? 'Agent 回复超出桥接缓冲上限，已截断' : `${this.agentKey} 单次任务完成`,
          usage: {},
        },
      }));
    } else if (this.textOutput && !this.openclawOutput && info?.code === 0 && !this._stopRequested) {
      this.pushEventNow(createEvent({
        sessionId: this.sessionId, agentType: this.agentType, sequencer: this.sequencer,
        eventType: 'session_end',
        payload: { reason: 'failed', summary: `${this.agentKey} 进程已退出，但没有可识别的最终答复`, usage: {} },
      }));
    }
    // 有些 CLI 在被强停时来不及输出 result。进程已确认结束后补一个 stopped 终态，
    // 让云端会话投影和手机状态收敛；已有原生 session_end 则保持原始终态。
    if (this.agentKey !== 'comate' && this._stopRequested && this.status === 'ended' && !this._hasSessionEnd) {
      this.pushEventNow(createEvent({
        sessionId: this.sessionId, agentType: this.agentType, sequencer: this.sequencer,
        eventType: 'session_end',
        payload: { reason: 'stopped', summary: 'Agent 已按停止命令结束', usage: {} },
      }));
    }
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
        // V1-019①：stderr 截断行数与被预算抑制的截断事件数（截断证据完整可审计）
        stderr_truncated_lines: this.runner.stderrTruncatedLineCount || 0,
        truncation_events_suppressed: this._truncationEventsSuppressed || 0,
        unrecognized_events_suppressed: this._unrecognizedEventsSuppressed || 0,
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

  /**
   * 嗅探 stdout 行（每行只 parse 一次）：
   *   - control_request 的原始 input 记入 pendingInputs（审批回流回填用，TASK-008）；
   *   - Agent 原生会话 ID（V12-11）：claude system/init 的 session_id、codex thread.started
     的 thread_id → nativeSessionRef（≤128 字符），变化时经 _onNativeSessionRef 归档
     到 profile 命名空间（launch ledger）。
   */
  trackLineState(line) {
    try {
      const raw = JSON.parse(line);
      if (!raw || typeof raw !== 'object') return;
      if (this.agentKey === 'comate' && raw.protocol === 'comate-local-api-v1'
        && raw.type === 'started' && typeof raw.conversation_id === 'string') {
        this.setNativeSessionRef(raw.conversation_id);
        return;
      }
      if (raw.type === 'control_request' && typeof raw.request_id === 'string') {
        this.pendingInputs.set(raw.request_id, raw.request?.input ?? {});
        return;
      }
      if (raw.type === 'system' && raw.subtype === 'init' && typeof raw.session_id === 'string' && raw.session_id) {
        this.setNativeSessionRef(raw.session_id);
        return;
      }
      if (raw.type === 'thread.started' && typeof raw.thread_id === 'string' && raw.thread_id) {
        this.setNativeSessionRef(raw.thread_id);
      }
    } catch {
      // 非 JSON 行（或半行/截断行）忽略
    }
  }

  /** 原生会话 ID 登记（截断 128，NATIVE_SESSION_REF 上限）；首次登记时通知归档回调。 */
  setNativeSessionRef(ref) {
    const next = String(ref).slice(0, 128);
    if (this.nativeSessionRef === next) return;
    this.nativeSessionRef = next;
    this._onNativeSessionRef?.(next);
  }

  /** 适配器分发（session ↔ adapters 唯一接线点经 generic.js lineToEvent）。 */
  mapLineToEvents(line) {
    if (this.openclawOutput) {
      this.openclawOutput.consume(line);
      return [];
    }
    if (this.textOutput) {
      this.textOutput.consume(line);
      return [];
    }
    return lineToEvent(line, { sessionId: this.sessionId, agentType: this.agentType, agentKey: this.agentKey, sequencer: this.sequencer });
  }

  emitTruncationWithinBudget(meta) {
    if (this._truncationEventsSent < MAX_TRUNCATION_EVENTS) {
      this._truncationEventsSent += 1;
      this.pushEventNow(this.truncationEvent(meta));
    } else {
      this._truncationEventsSuppressed += 1;
    }
  }

  /**
   * V12-11：单个适配器解析崩溃的会话级隔离（§8.3「解析崩溃只影响其任务」）——
   * 折为本会话 error 事件（脱敏摘要）+ 计数，supervisor/其他 Agent/审批不受影响。
   */
  handleAdapterParseError(err) {
    this.adapterParseErrorCount = (this.adapterParseErrorCount || 0) + 1;
    try {
      this.pushEventNow(createEvent({
        sessionId: this.sessionId,
        agentType: this.agentType,
        sequencer: this.sequencer,
        eventType: 'error',
        payload: {
          message: `适配器解析该输出帧失败（已隔离，不影响其他任务）：${sanitizeDiagnosticText(err?.message || err, 200)}`,
          code: 'adapter-parse-error',
          severity: 'warning',
          recoverable: true,
        },
      }));
    } catch {
      // 事件构造失败也不能外抛——隔离兜底
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
    // OpenHands 在待审批时以 stdin 作为控制通道。先告知受控停止，再关管道，
    // 否则 SDK 会把 EOF 误报成审批通道故障，手机端显示任务失败。
    if (this.agentKey === 'openhands') this.runner.sendJson({ type: 'control_stop' });
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
   * @param {AdapterFactory|null} [opts.adapterFactory] V12-11：profile 路由的冻结 spec 来源；
   *   null = 不支持 profile 路由（携带 agent_profile_id 的 create_session 明确失败，绝不 fallback defaultSpec）
   * @param {SessionLaunchLedger|null} [opts.launchLedger] V12-11：profile 恢复记录（重启对账 + 原生 ID 归档）
   * @param {WorkspaceLockManager|null} [opts.workspaceLocks] V12-13：写任务工作区互斥锁
   *   （同 realpath 只允许一个任务；null = 不加锁，仅建议 CLI 纯本机用法）
   * @param {number} [opts.maxSessionsPerProfile] V12-13：单 profile 并发上限（默认 2，
   *   §8.3「先保守设置并发」；2/4/8 实测挂 T22，实测后可上调）
   */
  constructor({
    transport,
    pollIntervalMs = 3000,
    pushBatchMs = 0,
    maxBackoffMs = 30000,
    onEvent,
    defaultSpec,
    adapterFactory = null,
    launchLedger = null,
    workspaceLocks = null,
    maxSessionsPerProfile = 2,
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
    // create_session 命令的启动规格（command/args 来自本机 config，手机端只提供 cwd+prompt）。
    // V12-11：仅 legacy（不带 profile 字段）命令与 CLI 初始会话使用；profile 路由见 adapterFactory。
    this.defaultSpec = defaultSpec || null;
    // V12-11：profile 路由（N09 修复）。携带 agent_profile_id 的 create_session 按该 profile 的
    // 冻结 spec 执行；工厂缺失时明确拒绝，绝不回退 defaultSpec（§8.2）。
    this.adapterFactory = adapterFactory || null;
    this.launchLedger = launchLedger || null;
    // V12-13：写任务工作区互斥锁（同 realpath 双写拦截；冲突显式反馈 holder 信息）
    this.workspaceLocks = workspaceLocks || null;
    this.permissionTimeoutMs = Math.max(0, Number(permissionTimeoutMs) || 0);
    this.permissionTimeoutAction = permissionTimeoutAction === 'approve' ? 'approve' : 'deny';
    this.workspaces = Array.isArray(workspaces) ? workspaces.map((w) => String(w)) : [];
    this.maxSessions = Math.max(1, Number(maxSessions) || 8);
    // V12-13：每 profile 并发上限（§8.3「总运行上限与每 profile 上限分开」；
    // 默认 2 保守值——产品宣称并发不等于实测值，2/4/8 实测挂 T22）
    this.maxSessionsPerProfile = Math.max(1, Number(maxSessionsPerProfile) || 2);
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
    // V1-019②：队列预算观测（普通缓冲丢弃 / critical 超预算拒绝 / 持久化失败次数）
    this.bufferDropped = 0;
    this.criticalBacklogRejected = 0;
    this.normalBacklogRejected = 0;
    this.durabilityLossCount = 0;
    this._backlogWarned = false;
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
        // V1-015①：崩溃于 executing 的命令在启动即呈现 unknown 并补 ACK（不等云端重派）
        this.recoverCrashedExecutingAcks();
        this.recoverPendingAcks();
      } catch (err) {
        console.warn('[session-manager] pending-ack recovery failed:', err?.message || err);
      }
    }
    // V12-11：重启对账（profile 恢复记录）——上次运行的 profile 会话台账按 pid 存活性收敛；
    // 已死补 closed，仍存活记孤儿（只告警不自动终止；自动清理挂 V15 专项边界测试）。
    if (this.launchLedger) {
      try {
        const recon = this.launchLedger.reconcile();
        if (recon.orphaned > 0) {
          console.warn(`[session-manager] 重启对账：${recon.orphaned}/${recon.total} 个 profile 会话进程在上次运行后仍存活（孤儿已登记，不自动终止；停止需按会话命令或人工处理）`);
        } else if (recon.closed > 0) {
          console.log(`[session-manager] 重启对账：${recon.closed}/${recon.total} 条历史会话记录确认进程已退出（closed）`);
        }
      } catch (err) {
        console.warn('[session-manager] launch-ledger reconcile failed:', err?.message || err);
      }
    }
    // V12-13：工作区锁崩溃恢复——持有者已死/损坏的锁自动回收（不抢活锁：活锁持有者
    // pid 必存活，保守保留并告警人工裁决），保证故障后锁可回收、新任务不被永久卡死。
    if (this.workspaceLocks) {
      try {
        const rec = this.workspaceLocks.reconcile();
        if (rec.reclaimed > 0) {
          console.warn(`[session-manager] 工作区锁对账：回收 ${rec.reclaimed}/${rec.total} 把无主锁（崩溃残留）`);
        }
        if (rec.kept > 0) {
          console.warn(`[session-manager] 工作区锁对账：${rec.kept}/${rec.total} 把锁持有者仍存活，保守保留（详见 workspace-lock 日志）`);
        }
      } catch (err) {
        console.warn('[session-manager] workspace-lock reconcile failed:', err?.message || err);
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

  /**
   * V1-015①：崩溃于 executing 的命令恢复（启动即呈现，不等云端租约重派）。
   * executing 记录 = 上次进程在执行中中断，结果未知：统一升级为 unknown 信封
   * （不丢执行记录、不重执行）并补发如实 ACK。先于 recoverPendingAcks 执行，
   * 两段恢复经 markAckEnqueued 幂等去重（失败记录仍由后一段兜底重入队）。
   */
  recoverCrashedExecutingAcks() {
    let recovered = 0;
    for (const record of this.inbox.executingRecords()) {
      try {
        const claim = this.inbox.claim({ command_id: record.command_id });
        if (claim.action !== 'recover-unknown') continue;
        if (this.enqueueRecordedAck(claim.record, this.baseAckPayloadFromRecord(claim.record))) {
          recovered += 1;
        }
      } catch (err) {
        console.warn(`[session-manager] crash-executing recovery failed for ${record.command_id}: ${err?.message || err}`);
      }
    }
    if (recovered > 0) {
      console.log(`[session-manager] recovered ${recovered} interrupted-executing command(s) as unknown at startup (execution record kept, no re-execution)`);
    }
    return recovered;
  }

  /** 从持久化记录构建 ACK 基础字段（启动恢复场景：无云端命令，只有信封字段）。 */
  baseAckPayloadFromRecord(record) {
    return {
      command_id: String(record?.command_id || ''),
      ...(record?.correlation_id ? { correlation_id: record.correlation_id } : {}),
    };
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
    // V12-11：原生会话 ID 到达 → 归档到 profile 命名空间（launch ledger；仅 profile 会话）
    session._onNativeSessionRef = (ref) => {
      if (session.profileId) this.launchLedger?.recordNativeSessionRef(sessionId, ref);
    };
    session.start({
      transport: this.transport,
      onEvent: (event) => this.onEvent?.(sessionId, event),
      pushEvent: (event) => this.enqueueEvent(event),
      // TASK-012：会话退出即时清理（map 移除 + onSessionEnded 回调供 daemon 空闲判定）
      onExit: () => {
        this.sessions.delete(sessionId);
        // V12-11：profile 会话退出即闭环台账（运行期自洽，重启对账只处理崩溃残留）
        if (session.profileId) this.launchLedger?.recordClosed(sessionId, 'exited');
        // V12-13：会话退出即释放其工作区锁（stop/自然退出都只释放目标会话自己的锁）
        this.workspaceLocks?.release(sessionId);
        this.onSessionEnded?.(sessionId, session.exitInfo);
      },
    });
    return session;
  }

  /** 单事件入口：审批/错误/会话终态及停止证据直推；其余按批量策略处理。 */
  enqueueEvent(event) {
    if (!this.transport) return false;
    if (isCriticalEvent(event)) return this.sendEventsNow([event]);
    if (this.pushBatchMs <= 0) return this.sendEventsNow([event]);
    this._pushBuffered(event);
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
   * V1-019②：批量缓冲（未落盘内存区）上限——超出丢弃最旧普通事件并计数。
   * transport 长时间不可用时 eventBuffer 不允许无界增长（每层内存都有上界）；
   * critical 事件不走此缓冲（直推 outbox，受 CRITICAL_BACKLOG_RESERVE 约束）。
   */
  _pushBuffered(event) {
    this.eventBuffer.push(event);
    if (this.eventBuffer.length > EVENT_BUFFER_MAX) {
      const excess = this.eventBuffer.length - EVENT_BUFFER_MAX;
      this.eventBuffer.splice(0, excess);
      this.bufferDropped += excess;
      if (!this._bufferDropWarned) {
        this._bufferDropWarned = true;
        console.warn(`[session-manager] event buffer overflow (> ${EVENT_BUFFER_MAX})，丢弃最旧普通事件（transport 长时间不可用？）累计 ${this.bufferDropped}`);
      }
    }
  }

  /**
   * V1-019②：分级队列预算闸门——critical 事件在 outbox 普通上限之外有预留容量；
   * 预留也耗尽时如实拒绝（不假装接纳），拒绝可见（计数 + 审计 + 告警，均限次防刷屏）。
   * @returns {boolean} 是否放行
   */
  _queueBudgetAllows(count, critical) {
    let stats = null;
    try { stats = this.outbox.stats(); } catch { return true; } // stats 不可用不误拦（入队自身仍有上限与异常兜底）
    const pending = Number(stats?.pending) || 0;
    const ceiling = (Number(this.outbox.maxItems) || 0) + (critical ? CRITICAL_BACKLOG_RESERVE : 0);
    if (pending + count <= ceiling) {
      if (pending < ceiling / 2) this._backlogWarned = false; // 队列排空后恢复告警资格
      return true;
    }
    if (critical) {
      this.criticalBacklogRejected += count;
      if (!this._backlogWarned) {
        this._backlogWarned = true;
        console.warn(`[session-manager] critical 队列预算耗尽（pending=${pending} ≥ ceiling=${ceiling}）：关键事件如实拒绝接纳（不假装入队）`);
      }
      appendAuditLine(this.auditFile, {
        event: 'critical-event-backlog-rejected',
        count,
        pending,
        ceiling,
      });
    } else {
      this.normalBacklogRejected += count;
      if (!this._backlogWarned) {
        this._backlogWarned = true;
        console.warn(`[session-manager] 普通事件队列积压达上限（pending=${pending} ≥ ceiling=${ceiling}）：停止接纳（安全停收）`);
      }
    }
    return false;
  }

  /**
   * 即时发送：事件先落 outbox（失败可重试，E06 修复），首包在本次调用栈内同步发起
   * （保持 critical 事件「即时直推」语义），传输失败由 outbox 退避重试。
   * V1-019②④：入队前过队列预算闸门；outbox 落盘抛错（磁盘满/权限）= 持久化失败，
   * 事件如实拒绝（返回 false）并进入 fail-closed（停止命令轮询），绝不假装接纳。
   */
  sendEventsNow(events) {
    if (!events?.length || !this.transport) return false;
    const critical = events.some(isCriticalEvent);
    if (!this._queueBudgetAllows(events.length, critical)) return false;
    try {
      this.outbox.enqueueMany(events, { priority: critical ? 'critical' : 'normal' });
    } catch (err) {
      this.handleDurabilityLoss('outbox-enqueue', err);
      return false;
    }
    void this.outbox.flush();
    return true;
  }

  /** 冲刷当前缓冲区一批（≤200 条）入 outbox 并尽力发送；失败项由 outbox 退避重试。
   * V12-18：①入队前先过队列预算闸门（与即时直推路径同守 V1-019② 预算，闸门拒绝时
   * 缓冲原样保留，不再逐条触发 outbox 层丢弃计数/告警刷屏）；②丢失唤醒修复——
   * flushInFlight 期间跳过的调用与已消费的 pushTimer 曾导致洪泛结束后缓冲滞留
   * （实测 1200 条洪泛后 ~1000 条卡在缓冲直到 stopAll），现每次 flush 收尾若仍有
   * 存量则按批量节奏续排（零进展轮次指数退避至 1s，防 outbox 满时热循环重试）。 */
  async flushEvents() {
    if (!this.transport || this.flushInFlight) return false;
    this.flushInFlight = true;
    let enqueued = 0;
    try {
      const batch = this.eventBuffer.splice(0, PUSH_BATCH_MAX_EVENTS);
      if (!batch.length) return false;
      if (!this._queueBudgetAllows(batch.length, false)) {
        // V12-18：批量路径与即时直推路径同守 V1-019② 队列预算闸门——闸门按轮拒绝
        // （限次告警 + normalBacklogRejected 计数），缓冲原样放回；不再逐条触发
        // outbox 层丢弃计数/告警刷屏（此前满载洪泛实测刷出 ~90 万行逐条告警）。
        this.eventBuffer.unshift(...batch);
        return false;
      }
      try {
        enqueued = this.outbox.enqueueMany(batch, { priority: 'normal' });
      } catch (err) {
        // V1-019④：批量路径的落盘失败同样是持久化失败 → fail-closed（未接纳事件留在缓冲）
        this.handleDurabilityLoss('outbox-enqueue', err);
      }
      if (enqueued < batch.length) {
        // 入队失败（磁盘异常/积压上限）的尾部回塞队首；已入队部分由 outbox 负责送达
        this.eventBuffer.unshift(...batch.slice(enqueued));
        // V1-019②：回塞后同样执行缓冲上限（丢最旧并计数）
        if (this.eventBuffer.length > EVENT_BUFFER_MAX) {
          const excess = this.eventBuffer.length - EVENT_BUFFER_MAX;
          this.eventBuffer.splice(0, excess);
          this.bufferDropped += excess;
        }
      }
      if (enqueued > 0) await this.outbox.flush();
      return enqueued > 0;
    } finally {
      this.flushInFlight = false;
      // V12-18 丢失唤醒修复：flushInFlight 期间跳过的调用与已消费的 pushTimer 曾导致
      // 洪泛结束后缓冲滞留到 stopAll（慢网实测 1200 条洪泛后 ~1000 条卡在缓冲）。
      // 每次收尾若仍有存量则续排：有进展立即，零进展（闸门拒绝/入队失败）按批量节奏
      // 指数退避至 1s——outbox 恢复后 ≤1s 内续排缓冲，且不在满载期热循环重试。
      if (this.eventBuffer.length > 0 && !this.pushTimer) {
        const delay = enqueued > 0 ? 0 : Math.min((this._trailDelayMs || this.pushBatchMs || 50) * 2, 1000);
        this._trailDelayMs = delay;
        this.pushTimer = setTimeout(() => { this.pushTimer = null; void this.flushEvents(); }, delay);
        this.pushTimer.unref?.();
      }
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

    // V12-11：执行前先定位目标会话（仅显式 session_id 路由——无 sid 命令如 create/ping
    // 不附着任何既有会话的 profile 元数据），其元数据供 ACK 回传实际执行者；
    // stop 等路径会在执行中把会话移出 map，必须先取。
    const targetSession = typeof command?.session_id === 'string' && command.session_id
      ? (this.sessions.get(command.session_id) || null)
      : null;
    const targetProfile = (targetSession && targetSession.profileId)
      ? {
        agent_profile_id: targetSession.profileId,
        agent_profile_revision: targetSession.profileRevision,
        ...(targetSession.agentKey ? { agent_key: targetSession.agentKey } : {}),
      }
      : null;

    let result = 'failed';
    let error = '';
    let resultSessionId = null;
    let outcome = null;
    try {
      outcome = await this.executeCommand(command);
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

    // V12-11：ACK 回传实际执行的 profile（§14.3 与云端比对，'profile-ack-mismatch'）。
    // 来源优先级：命令结果对象（create_session 直接携带）> 执行前定位到的目标会话元数据。
    const executedProfile = outcome && typeof outcome === 'object' && outcome.agent_profile_id
      ? {
        agent_profile_id: String(outcome.agent_profile_id),
        agent_profile_revision: Number.isInteger(outcome.agent_profile_revision) ? outcome.agent_profile_revision : null,
        ...(outcome.agent_key ? { agent_key: String(outcome.agent_key) } : {}),
      }
      : targetProfile;

    // 完整结果信封一次落盘（含 result_session_id/correlation/request_id/完成时间）
    const envelope = {
      result,
      error: error || null,
      result_session_id: resultSessionId,
      command_type: command?.command_type ?? null,
      correlation_id: command?.correlation_id ?? null,
      request_id: command?.payload?.request_id ?? null,
      // V12-11：实际执行 profile 进信封——租约重放/重启恢复重建的 ACK 携带同一份（R07 一致性）
      ...(executedProfile ? executedProfile : {}),
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
    // V12-11：实际执行 profile 随信封重建（租约重放/重启恢复与首次 ACK 一致，R07）
    const profileFields = record.agent_profile_id
      ? {
        agent_profile_id: record.agent_profile_id,
        ...(Number.isInteger(record.agent_profile_revision) ? { agent_profile_revision: record.agent_profile_revision } : {}),
        ...(record.agent_key ? { agent_key: record.agent_key } : {}),
      }
      : {};
    const payload = {
      ...base,
      result,
      ...(errorText ? { error: errorText } : {}),
      ...(sessionId ? { session_id: sessionId } : {}),
      ...profileFields,
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
    const first = !this.durabilityDegraded;
    this.durabilityDegraded = true;
    this.durabilityLossCount += 1;
    // V1-019：磁盘持续不可用时只告警一次（fail-closed 状态不变，日志不刷屏）
    if (first) {
      console.error(`[fail-closed] 本地持久化失败（${reason}${commandId ? `, command_id=${commandId}` : ''}）: ${err?.message || err}`);
      console.error('[fail-closed] 已停止命令轮询：磁盘/权限恢复前不再执行任何命令（防止不可逆命令在结果不可记录状态下执行）；已持久化的结果将在重启后恢复 ACK。');
    }
    this.pollingEnabled = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /**
   * 命令 → 目标会话解析（executeCommand 与 handlePulledCommand 的 ACK 元数据共用同一规则）：
   *   - 显式 session_id 只按显式路由（E08/TASK-003：未知 sid 绝不回退唯一会话）；
   *   - 兼容保留：未携带 session_id 的历史命令在本机仅一个会话时仍路由到它
   *     （TASK-007 命令契约落地后移除）。
   */
  resolveTargetSession(command) {
    const sid = typeof command?.session_id === 'string' ? command.session_id : '';
    if (sid) return this.sessions.get(sid) || null;
    if (this.sessions.size === 1) return this.sessions.values().next().value;
    return null;
  }

  async executeCommand(command) {
    const type = command?.command_type;
    // E08 修复（TASK-003）：显式 session_id 在本机不存在 → 拒绝执行并回传失败 ACK，
    // 删除"回退唯一会话"兜底（否则停止/发消息会误落到错误任务）。
    // 兼容保留：未携带 session_id 的历史命令（旧云端/旧手机版本）在本机仅一个会话时
    // 仍路由到它；TASK-007 命令契约（强制 client_request_id+session 语义）落地后移除。
    const sid = typeof command?.session_id === 'string' ? command.session_id : '';
    const session = sid ? (this.sessions.get(sid) || null) : this.resolveTargetSession(command);
    if (!session && type !== 'create_session') {
      if (sid) {
        console.warn(`[session-manager] 拒绝命令 ${type || 'unknown'}：未知 session_id=${sid}`);
        // 目标可能已经退出，管理器没有它的序号水位。新建 sequencer 会重复历史 seq=1；
        // 失败原因随命令结果信封持久化/ACK 回流，由页面的命令跟踪展示。
        return {
          ok: false,
          session_id: sid,
          error: `unknown-session: 会话不存在或已退出，命令 ${type || 'unknown'} 未执行`,
        };
      }
      return false;
    }
    switch (type) {
      case 'send_text':
        // V12-09：能力键更名 send → append（追加输入；初始输入由 initialPromptChannel 表达）
        if (!session.capabilities.append) return this.rejectCapability(session, command, 'append');
        return session.sendText(command.payload?.content || '');
      case 'respond_action':
        if (!session.capabilities.approve) return this.rejectCapability(session, command, 'approve');
        return this.forwardDecision(session, command);
      case 'stop_session': {
        if (!session.capabilities.stop) return this.rejectCapability(session, command, 'stop');
        // V1-015③：接纳（命令已受理）与实际退出分开——runner.stop() 等待真实退出并
        // 返回证据（exited/code/signal/taskkill 退出码）；退出证据随 session_stop_result
        // 事件回流；进程未确认退出时 ACK 如实 failed（不假装停止成功）。
        const stopResult = await session.stop();
        this.emitStopResult(session, stopResult);
        if (stopResult?.exited && (session.agentKey !== 'comate' || stopResult.confirmed === true)) return true;
        if (session.agentKey === 'comate') return { ok: false, error: `stop-not-confirmed: native Comate cancellation unconfirmed (reason=${stopResult?.reason || 'unknown'})` };
        const tk = stopResult?.taskkill_exit_code != null ? `, taskkill_exit=${stopResult.taskkill_exit_code}` : '';
        return { ok: false, error: `stop-not-confirmed: process still alive after stop (reason=${stopResult?.reason || 'unknown'}${tk})` };
      }
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

  /**
   * V1-015③：stop_session 的退出证据事件（custom/session_stop_result）——
   * 「停止命令已接纳」与「进程确实已退出」在事件载荷中分开表达；
   * 手机端据此区分「已受理」与「已生效」，不猜测。
   */
  emitStopResult(session, stopResult) {
    try {
      const exited = stopResult?.exited === true;
      const nativeConfirmed = session.agentKey !== 'comate' || stopResult?.confirmed === true;
      const event = createEvent({
        sessionId: session.sessionId,
        agentType: session.agentType,
        sequencer: session.sequencer,
        eventType: 'custom',
        payload: {
          custom_type: 'session_stop_result',
          fallback_text: !nativeConfirmed ? 'Comate 原生停止未确认（见证据字段）'
            : exited ? '停止命令已执行：进程已退出' : '停止命令已接纳：进程退出未确认（见证据字段）',
          accepted: true,
          exited,
          reason: stopResult?.reason || null,
          code: stopResult?.code ?? null,
          signal: stopResult?.signal ?? null,
          ...(session.agentKey === 'comate' ? { confirmed: stopResult?.confirmed === true,
            native_cancelled: stopResult?.native_cancelled === true } : {}),
          ...(stopResult?.taskkill_exit_code != null ? { taskkill_exit_code: stopResult.taskkill_exit_code } : {}),
        },
      });
      this.onEvent?.(session.sessionId, event);
      this.enqueueEvent(event);
    } catch {
      // 证据事件构造/入队失败不影响停止语义本身
    }
  }

  /**
   * create_session：手机端新建任务——在本机配置的 agent 命令上，以指定工作区 cwd
   * 拉起新会话并注入初始提示。
   *
   * V12-11（N09 修复）双路径，绝无静默回退（§8.2「绝不能 fallback 到 defaultSpec」）：
   *   - 携带 agent_profile_id / agent_profile_revision（成对）→ 按 profile 路由：
   *     AdapterFactory 二次验证本机 profile 并生成冻结 spec；任何失败都是明确错误码，
   *     绝不退回 defaultSpec；
   *   - 不带 profile 字段 → legacy（v0.2）语义：defaultSpec（本机 config 显式配置）。
   * TASK-012/D4 工作区授权边界：绝对路径 → stat 目录 → realpath 前后授权根前缀判断
   * （防符号链接逃逸）；拒绝时零进程拉起 + 最小审计（时间/cwd/原因，不含 prompt）。
   * CLI 本地 `run` 不受限（用户本机操作即授权）。
   * 返回 { ok, session_id?, error? }：session_id 供 ack 回填（手机端经 result_session_id
   * 获知新会话）；correlation_id 随 session_meta 事件回流；成功时回传实际执行 profile
   * （agent_profile_id/agent_profile_revision/agent_key，§14.3 ACK 比对）。
   */
  createSessionFromCommand(payload = {}, command = {}) {
    const rawCwd = typeof payload.cwd === 'string' ? payload.cwd.trim() : '';
    const prompt = typeof payload.prompt === 'string' ? payload.prompt.trim() : '';
    const profileId = typeof payload.agent_profile_id === 'string' ? payload.agent_profile_id.trim() : '';
    const hasProfileRevision = payload.agent_profile_revision !== undefined && payload.agent_profile_revision !== null;
    if (profileId || hasProfileRevision) {
      // profile 路由：两字段必须成对（云端 V12-05/10 已强制；桥端 fail-closed 兜底）
      if (!profileId || !hasProfileRevision) return { ok: false, error: 'invalid-profile-route' };
      if (!this.adapterFactory) {
        // 旧 bridge / 未接线工厂：明确失败，绝不按 defaultSpec 执行（N09 反例）
        console.warn('[session-manager] 拒绝 create_session：携带 profile 路由但本机未启用 profile 调度（不回退 defaultSpec）');
        return { ok: false, error: 'profile-routing-unsupported' };
      }
      // AdapterFactory 二次验证本机 profile（存在/未删/未停/revision/agent_key/verified
      // adapter/可执行文件）并生成冻结 spec；任何失败都是明确错误码，绝不退回 defaultSpec。
      let spec;
      try {
        spec = this.adapterFactory.createFrozenSpec({
          profileId,
          revision: payload.agent_profile_revision,
          commandAgentKey: command?.agent_key ?? null,
        });
      } catch (err) {
        if (err instanceof ProfileRouteError) {
          console.warn(`[session-manager] 拒绝 create_session（profile 路由）：${err.code}（profile=${profileId}）`);
          appendAuditLine(this.auditFile, {
            event: 'profile-route-denied',
            profile_id: profileId,
            reason: err.code,
            command_id: command?.command_id || null,
          });
          return { ok: false, error: err.code };
        }
        throw err;
      }
      // 声明层执行门禁（adapter-contract §2.2）：verified create 已在工厂把关，此处防御兜底；
      // workspace_id 为 opaque 引用，真实路径在本机由 cwd/授权列表裁决（云端不解析）。
      const caps = spec.executionCapabilities || capabilitiesFor(spec.agentType);
      if (!caps.create) return { ok: false, error: 'profile-capability-unsupported' };
      if (prompt && !caps.initialPromptChannel) {
        return { ok: false, error: 'capability-unsupported', capability: 'initial_prompt', reason: 'prompt-inject-unsupported' };
      }
      if (spec.agentKey === 'aider' && isAiderNativeCommand(prompt)) {
        return { ok: false, error: 'prompt-command-unsupported', reason: 'task-description-required' };
      }
      // 全局工作区授权（D4 语义不变）：拒绝时零进程 + 审计行
      const authz = authorizeWorkspace({ rawCwd, workspaces: this.workspaces });
      if (!authz.ok) {
        appendAuditLine(this.auditFile, {
          event: 'workspace-denied',
          cwd: rawCwd.slice(0, 500),
          reason: authz.reason,
          profile_id: spec.profileId,
          command_id: command?.command_id || null,
        });
        return { ok: false, error: authz.reason };
      }
      // profile 自身授权目录叠加校验（非空时）：§8.2 bridge 二次验证「权限」
      if (spec.workspaceAllowlist.length > 0) {
        const profileAuthz = authorizeWorkspace({ rawCwd: authz.cwd, workspaces: spec.workspaceAllowlist });
        if (!profileAuthz.ok) {
          appendAuditLine(this.auditFile, {
            event: 'profile-workspace-denied',
            cwd: authz.cwd.slice(0, 500),
            reason: profileAuthz.reason,
            profile_id: spec.profileId,
            command_id: command?.command_id || null,
          });
          return { ok: false, error: 'workspace-not-authorized' };
        }
      }
      // 并发会话上限（结束会话已即时移除，这里只计活跃会话）
      if (this.sessions.size >= this.maxSessions) {
        appendAuditLine(this.auditFile, {
          event: 'session-limit-rejected',
          cwd: authz.cwd,
          reason: `active=${this.sessions.size},max=${this.maxSessions}`,
          profile_id: spec.profileId,
          command_id: command?.command_id || null,
        });
        return { ok: false, error: 'session-limit' };
      }
      // V12-13：每 profile 并发上限（§8.3「总运行上限与每 profile 上限分开」——单产品
      // 限流/失效不得挤占全部并发；拒绝显式反馈，不静默排队）
      const profileActive = [...this.sessions.values()].filter((s) => s.profileId === spec.profileId).length;
      if (profileActive >= this.maxSessionsPerProfile) {
        appendAuditLine(this.auditFile, {
          event: 'profile-session-limit-rejected',
          cwd: authz.cwd,
          reason: `active=${profileActive},max=${this.maxSessionsPerProfile}`,
          profile_id: spec.profileId,
          command_id: command?.command_id || null,
        });
        return { ok: false, error: 'profile-session-limit' };
      }
      // 初始 prompt 通道：launch-args=codex exec 位置参数；stdin=claude-code 输入帧（会话
      // 启动后 sendText）；null=拒绝（能力检查已拦截，防御兜底）。
      let launchPrompt = prompt && caps.initialPromptChannel === 'launch-args' ? prompt : null;
      // Cline 3.0.65 将无空白的位置参数当成未知命令；尾空格保留原正文，
      // 静态配方的 -- 同时阻止命令名/旗标形文字被解释为 CLI 控制。
      if (spec.agentKey === 'cline' && launchPrompt && !/\s/.test(launchPrompt)) launchPrompt += ' ';
      const sessionId = `s_${crypto.randomUUID()}`;
      // V12-13：写任务工作区互斥（§8.3）——同 realpath 只允许一个任务；冲突显式反馈
      // 持有者信息（手机端据此「等待重试」或「另选独立目录」），绝不静默并行双写。
      if (this.workspaceLocks) {
        const lock = this.workspaceLocks.acquire({
          cwd: authz.cwd,
          sessionId,
          profileId: spec.profileId,
          agentKey: spec.agentKey,
        });
        if (!lock.ok) {
          const holder = lock.holder || null;
          appendAuditLine(this.auditFile, {
            event: 'workspace-busy',
            cwd: authz.cwd.slice(0, 500),
            reason: lock.reason,
            holder_session: holder?.session_id || null,
            profile_id: spec.profileId,
            command_id: command?.command_id || null,
          });
          return {
            ok: false,
            error: lock.reason === 'workspace-busy'
              ? `workspace-busy: held by ${holder?.agent_key || 'unknown'} session=${holder?.session_id || 'unknown'}`
              : lock.reason,
            ...(holder ? { holder } : {}),
          };
        }
      }
      const correlationId = String(command.correlation_id || command.command_id || '');
      let prepared;
      try {
        prepared = prepareProductLaunch(spec, { sessionId, dataDir: this.adapterFactory.profileStore?.dir });
        if (prepared.stateDir) fs.mkdirSync(prepared.stateDir, { recursive: true });
      } catch (err) {
        this.workspaceLocks?.release(sessionId);
        appendAuditLine(this.auditFile, {
          event: 'profile-runtime-unavailable',
          profile_id: spec.profileId,
          agent_key: spec.agentKey,
          session_id: sessionId,
          reason: err?.code || 'invalid-local-runtime',
          command_id: command?.command_id || null,
        });
        return { ok: false, error: 'profile-runtime-unavailable' };
      }
      const session = this.startSession({
        sessionId,
        agentType: spec.agentType,
        command: spec.command,
        args: launchPrompt ? [...prepared.args, launchPrompt] : prepared.args, // 冻结配方 + 本机会话状态 + 可选末位 prompt
        productEnv: prepared.productEnv,
        cwd: authz.cwd,
        correlationId,
        profileId: spec.profileId,
        profileRevision: spec.profileRevision,
        agentKey: spec.agentKey,
        adapterVersion: spec.adapterVersion,
        executionCapabilities: spec.executionCapabilities,
        capabilitySnapshot: spec.capabilitySnapshot,
      });
      // profile 恢复记录：启动台账（含进程归属身份，重启对账依据）
      this.launchLedger?.recordLaunch({
        bridgeSessionId: sessionId,
        profileId: spec.profileId,
        profileRevision: spec.profileRevision,
        agentKey: spec.agentKey,
        adapterId: spec.agentType,
        pid: session.runner?.ownership?.pid ?? null,
        instanceId: session.runner?.ownership?.instanceId ?? null,
        spawnedAt: session.runner?.ownership?.spawnedAtMs ?? null,
        command: spec.command,
      });
      appendAuditLine(this.auditFile, {
        event: 'profile-session-created',
        profile_id: spec.profileId,
        profile_revision: spec.profileRevision,
        agent_key: spec.agentKey,
        adapter_id: spec.agentType,
        session_id: sessionId,
        command_id: command?.command_id || null,
      });
      let promptOk = true;
      if (prompt && !launchPrompt) promptOk = session.sendText(prompt) !== false;
      return {
        ...(promptOk ? { ok: true } : { ok: false, error: 'prompt-inject-failed' }),
        session_id: sessionId,
        // 实际执行 profile 回传（ACK 比对 §14.3；revision 为本机冻结值，任何不一致由云端判冲突）
        agent_profile_id: spec.profileId,
        agent_profile_revision: spec.profileRevision,
        agent_key: spec.agentKey,
        ...(spec.adapterVersion ? { adapter_version: spec.adapterVersion } : {}),
      };
    }

    // —— legacy（v0.2）路径：不带 profile 字段的 create_session → 本机 defaultSpec ——
    if (!this.defaultSpec) return { ok: false, error: 'no-agent-spec' };
    const agentType = this.defaultSpec.agentType || 'generic';
    const caps = openCapabilitiesFor(agentType);
    if (!caps.create) {
      return { ok: false, error: 'capability-unsupported', capability: 'create' };
    }
    // 能力前置检查（零进程拒绝）：create 本身 + 初始 prompt 注入（V1-005①：初始输入与
    // 追加输入是两个独立能力——codex exec 官方支持把初始 prompt 作为末位位置参数，
    // 不得再借 send=false 拒绝携带 prompt 的创建；追加 send_text 仍按 append=false 拒绝）。
    // 旧命令同样受真实能力门禁约束；声明层有实现不能绕过开放视图。
    if (!caps.create) return { ok: false, error: 'capability-unsupported', capability: 'create' };
    if (prompt && !caps.initialPromptChannel) {
      return { ok: false, error: 'capability-unsupported', capability: 'initial_prompt', reason: 'prompt-inject-unsupported' };
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
    // 初始 prompt 通道（V1-005② / V12-09 更名 initialPromptChannel）：
    // launch-args=codex exec 位置参数（spawn args 数组直传，无 shell、无拼接，长度上限
    // 4000 由云函数 sendCommand 侧已校验）；stdin=claude-code 输入帧（会话启动后 sendText，
    // 既有路径）；null=拒绝（能力检查已拦截，防御兜底）。
    const launchPrompt = prompt && caps.initialPromptChannel === 'launch-args' ? prompt : null;
    const sessionId = `s_${crypto.randomUUID()}`;
    // V12-13：写任务工作区互斥（§8.3）——legacy（defaultSpec）任务同样是写任务，
    // 与 profile 路由任务共用同一把 realpath 锁；冲突显式反馈，绝不静默并行双写。
    if (this.workspaceLocks) {
      const lock = this.workspaceLocks.acquire({
        cwd: authz.cwd,
        sessionId,
        profileId: null,
        agentKey: agentType,
      });
      if (!lock.ok) {
        const holder = lock.holder || null;
        appendAuditLine(this.auditFile, {
          event: 'workspace-busy',
          cwd: authz.cwd.slice(0, 500),
          reason: lock.reason,
          holder_session: holder?.session_id || null,
          command_id: command?.command_id || null,
        });
        return {
          ok: false,
          error: lock.reason === 'workspace-busy'
            ? `workspace-busy: held by ${holder?.agent_key || 'unknown'} session=${holder?.session_id || 'unknown'}`
            : lock.reason,
          ...(holder ? { holder } : {}),
        };
      }
    }
    const correlationId = String(command.correlation_id || command.command_id || '');
    const baseArgs = this.defaultSpec.args || [];
    const session = this.startSession({
      sessionId,
      agentType,
      agentKey: agentType,
      executionCapabilities: caps,
      capabilitySnapshot: caps,
      command: this.defaultSpec.command,
      args: launchPrompt ? [...baseArgs, launchPrompt] : baseArgs,
      cwd: authz.cwd,
      correlationId,
    });
    let promptOk = true;
    if (prompt && !launchPrompt) promptOk = session.sendText(prompt) !== false;
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
    // V12-13：兜底释放本进程名下全部工作区锁（正常路径 onExit 已逐个释放；
    // 只触碰自己名下的锁，绝不清扫他人锁文件）
    this.workspaceLocks?.releaseAll();
    // 退出排空：等在途完成并持续排空至期限；未确认项留在磁盘/内存，重启后恢复重发
    await this.outbox.flush({ deadlineMs: this.drainDeadlineMs });
    return results;
  }
}
