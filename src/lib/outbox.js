/**
 * EventOutbox：桥接侧持久化发件箱（TASK-006，可靠性核心）。
 *
 * 解决的审计缺陷：
 *  - E06：endpoint 网络异常返回失败对象而不抛错，调用方只 catch 异常 → 失败事件被当
 *    成功、缓冲清空丢失。本轮统一传输错误语义：transport 在网络失败 / HTTP 非 2xx /
 *    非法 JSON / null / HTTP200+ok:false 时**抛 TransportError**（本文件定义，全桥唯一
 *    规范错误）；成功返回 { ok:true, status, data }。outbox 以「先落盘、后发送、按响应
 *    分类确认」闭环，失败事件绝不静默丢弃。
 *  - 后发先到（T08/V12-18）：outbox 优先认领到期 critical 事件与 ACK，同优先级内按
 *    入队序发送；ACK 先于同轮事件批。所有项先持久化，不另设直推通道。游标契约见 §11
 *    （服务端 (server_received_at, event_id) 稳定排序），发送端乱序不会造成漏读。
 *
 * 存储格式：单事件一 JSON 文件（<dir>/000000000001_<rand>.json），文件名前缀为单调
 * 递增序号（12 位零填充），字典序即入队序。选择理由：① 写入=「临时文件+rename」原子
 * 替换，断电不会半写；② ack 删除=unlink 单文件，无需 append 日志压缩；③ 积压计数=
 * readdir，天然有界（maxItems 上限）。代价是小文件多，但上限 5000 条可控。
 * dead-letter：<dir>/dead/，带 dead_reason / dead_at，不再重试。CLOSE-014 保留治理：
 * 容量上限 maxDeadLetters（默认 200）+ 保留期 deadLetterRetentionMs（默认 30 天），
 * 超限/超龄淘汰最旧；淘汰不丢账——stats().dead_total = dead + dead_evicted，
 * 记账跨重启持久于 dead/_retention.json（deadLetters()/stats() 跳过该记账文件）。
 *
 * 状态机：pending → sending（内存标记，崩溃即回 pending，at-least-once）
 *        → 确认（syncReport accepted/duplicates 或 ack ok）→ 删除
 *        → 永久错误（unauthorized/session-deleted/event-id-conflict/schema/4xx）→ dead/
 *        → 瞬时错误（网络/超时/5xx/INTERNAL）→ 指数退避重试（2s ×2 封顶 5min，±20% 抖动；
 *          critical 初始 500ms，并在到期项中优先认领）。
 *
 * CLOSE-009（R06 修复）投影失败补偿通道：syncReport 响应 projection.failed 带失败会话
 * 明细（{session_id, error}）时，**事件已被服务端入库（duplicate 重放幂等）但投影写失败**。
 * 属于失败会话的事件不确认删除，转入投影补偿重试：保留原事件、独立重试预算
 * （maxProjectionRetries，默认 8 次）与退避（复用指数退避曲线），重发后经服务端
 * duplicate 路径幂等修复投影；预算耗尽或超期（projectionMaxAgeMs）→ dead-letter
 * （dead_reason=projection-retry-exhausted/expired，stats 可见，绝不静默）。
 * 其他已成功会话的事件照常确认——部分投影失败不拖垮整批、不无限重传。
 * 顺序保护在服务端（syncReport last_seq/status_seq/meta 水位单调），补偿重发乱序安全。
 *
 * 积压上限：pending ≥ maxItems（默认 5000）时普通事件停止入队并告警日志；关键审批事件
 * 仍可入队。单个事件的退避不阻塞其他事件（按 next_attempt_at 独立调度）。
 *
 * 退出排空：flush({ deadlineMs }) 在途完成后持续排空至期限（默认 10s，由调用方
 * SessionManager 传入）；期限后未确认项留在磁盘，重启由 _loadFromDisk 恢复重发。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * 永久失败错误码（云端业务 error 字符串）：重试无意义，直接 dead-letter。
 * 与 event-protocol.md §12 / syncReport 逐事件错误码对齐。
 */
export const PERMANENT_ERROR_CODES = Object.freeze(new Set([
  'unauthorized',
  'forbidden',
  'forbidden-session',
  'not-found',
  'event-id-conflict',
  'batch-too-large',
  'invalid-event',
  'invalid-seq',
  'invalid-event-type',
  'invalid-ts',
  'event-too-large',
  'payload-conflict',
  'missing-token-hash',
  'device-mismatch',
  // CLOSE-003 交接项（docs/data-retention.md「用户删除后的数据保留」）：删除墓碑拒收
  // 为永久语义——重发无意义（会话已删除，重放不得复活），直接 dead-letter。
  'session-deleted',
]));

/** TransportError：全桥唯一规范传输错误（TASK-006 统一错误语义）。 */
export class TransportError extends Error {
  constructor(message, { code = 'UPSTREAM_UNAVAILABLE', status = 0, data = null, retryable = true } = {}) {
    super(message);
    this.name = 'TransportError';
    this.code = code;
    this.status = status; // HTTP 状态；0=未达 HTTP（网络/DNS/超时/非法 JSON）
    this.data = data;     // 已解析的响应体（ok:false 业务失败时携带，供逐事件分类）
    this.retryable = retryable;
  }
}

/** 业务错误码是否永久失败（invalid-/schema- 前缀视为永久）。 */
export function isPermanentCode(code) {
  const c = String(code || '');
  if (!c) return false;
  if (RETRYABLE_ERROR_CODES.has(c)) return false;
  if (PERMANENT_ERROR_CODES.has(c)) return true;
  return c.startsWith('invalid-') || c.startsWith('schema-');
}

/**
 * V1-003：云侧分类化故障响应的「可重试优先于永久表」判定。
 * 云端（_shared/lib-errors.js dbUnavailable）对 DB 读写故障返回分类响应
 * { error:'DB_UNAVAILABLE', code:'DB_UNAVAILABLE', retryable:true }——短暂云故障
 * 绝不能进死信（R14：伪装成 unauthorized 才是旧缺陷；分类码本身也不得被任何
 * 未来误登记进永久表后静默丢事件）。INTERNAL 同理可重试。
 * 与 protocol/schema.cjs CLOUD_ERROR_RETRYABLE 同源（schema 分类 retryable=false
 * 的 AUTH_REVOKED/UNBOUND 等不在本表，仍走永久表判定）。
 */
export const RETRYABLE_ERROR_CODES = Object.freeze(new Set([
  'DB_UNAVAILABLE',
  'INTERNAL',
]));

/**
 * 传输失败是否永久（不再重试）：
 *  - 响应显式 retryable:true → 可重试（V1-003 分类响应，优先于一切码表）；
 *  - 响应 error 码命中可重试分类表 → 可重试；命中永久表 → 永久；
 *  - HTTP 4xx（除 429 限流）→ 永久；
 *  - 网络/超时/非法响应/5xx/HTTP200+瞬时业务错 → 可重试。
 */
export function isPermanentFailure({ status = 0, data = null } = {}) {
  if (data && typeof data === 'object') {
    if (data.retryable === true) return false;
    const cls = typeof data.code === 'string' ? data.code : null;
    if (cls && RETRYABLE_ERROR_CODES.has(cls)) return false;
  }
  const code = data && typeof data === 'object' ? data.error : null;
  if (typeof code === 'string' && isPermanentCode(code)) return true;
  if (Number.isInteger(status) && status >= 400 && status < 500 && status !== 429) return true;
  return false;
}

const DEFAULTS = Object.freeze({
  maxItems: 5000,
  initialBackoffMs: 2000,
  criticalInitialBackoffMs: 500,
  maxBackoffMs: 5 * 60 * 1000,
  maxBatch: 200,
  jitterRatio: 0.2,
  maxAcksPerCycle: 10,
  // CLOSE-009 投影补偿预算：同一事件投影失败重试上限（超过 → dead-letter）。
  // 配合指数退避（2s 起步 ×2 封顶 5min）≈ 9 分钟内限时收敛，不会无限重传。
  maxProjectionRetries: 8,
  // 投影补偿时限兜底：入队距今超过该时长仍投影失败 → dead-letter（背靠背宕机等极端场景）。
  projectionMaxAgeMs: 24 * 60 * 60 * 1000,
  // CLOSE-014 交接（dead-letter 保留治理）：dead/ 目录容量与保留期上限，防无界增长。
  // 超限淘汰最旧（按 dead_at，平序按入队序）；淘汰不丢账：dead_total（累计入死信数）
  // = dead（现存）+ dead_evicted（累计淘汰），跨重启经 dead/_retention.json 持久。
  maxDeadLetters: 200,
  deadLetterRetentionMs: 30 * 24 * 60 * 60 * 1000,
});

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export class EventOutbox {
  /**
   * @param {object} opts
   * @param {string|null} opts.dir 持久目录（如 <dataDir>/outbox）；null=纯内存模式（测试用）
   * @param {object|null} opts.transport 需实现 pushEvents(events) 与 ackCommand(payload)，失败必须抛 TransportError
   * @param {number} [opts.maxItems] 积压上限（普通事件）
   * @param {number} [opts.initialBackoffMs] 普通事件初始退避
   * @param {number} [opts.criticalInitialBackoffMs] 关键事件初始退避（认领优先级另由 _claimDue 决定）
   * @param {number} [opts.maxBackoffMs] 退避封顶
   * @param {number} [opts.maxBatch] 单次 pushEvents 最大事件数
   * @param {number} [opts.maxProjectionRetries] 投影失败补偿重试上限（CLOSE-009；耗尽 → dead-letter）
   * @param {number} [opts.projectionMaxAgeMs] 投影补偿时限（入队距今超时仍失败 → dead-letter）
   * @param {object} [opts.logger]
   */
  constructor(opts = {}) {
    this.dir = opts.dir ? path.resolve(String(opts.dir)) : null;
    this.transport = opts.transport || null;
    this.logger = opts.logger || console;
    this.maxItems = Number.isInteger(opts.maxItems) ? opts.maxItems : DEFAULTS.maxItems;
    this.initialBackoffMs = Number.isFinite(opts.initialBackoffMs) ? opts.initialBackoffMs : DEFAULTS.initialBackoffMs;
    this.criticalInitialBackoffMs = Number.isFinite(opts.criticalInitialBackoffMs) ? opts.criticalInitialBackoffMs : DEFAULTS.criticalInitialBackoffMs;
    this.maxBackoffMs = Number.isFinite(opts.maxBackoffMs) ? opts.maxBackoffMs : DEFAULTS.maxBackoffMs;
    this.maxBatch = Number.isInteger(opts.maxBatch) ? Math.max(1, opts.maxBatch) : DEFAULTS.maxBatch;
    this.jitterRatio = Number.isFinite(opts.jitterRatio) ? Math.max(0, opts.jitterRatio) : DEFAULTS.jitterRatio;
    this.maxAcksPerCycle = Number.isInteger(opts.maxAcksPerCycle) ? opts.maxAcksPerCycle : DEFAULTS.maxAcksPerCycle;
    this.maxProjectionRetries = Number.isInteger(opts.maxProjectionRetries) && opts.maxProjectionRetries >= 0
      ? opts.maxProjectionRetries
      : DEFAULTS.maxProjectionRetries;
    this.projectionMaxAgeMs = Number.isFinite(opts.projectionMaxAgeMs) && opts.projectionMaxAgeMs >= 0
      ? opts.projectionMaxAgeMs
      : DEFAULTS.projectionMaxAgeMs;
    // CLOSE-014：dead-letter 保留治理（容量上限 + 保留期；0 = 不按该维度限制，仅测试用）
    this.maxDeadLetters = Number.isInteger(opts.maxDeadLetters) && opts.maxDeadLetters >= 0
      ? opts.maxDeadLetters
      : DEFAULTS.maxDeadLetters;
    this.deadLetterRetentionMs = Number.isFinite(opts.deadLetterRetentionMs) && opts.deadLetterRetentionMs >= 0
      ? opts.deadLetterRetentionMs
      : DEFAULTS.deadLetterRetentionMs;

    this._items = new Map(); // id -> item（按 id 前缀序号排序 = 入队序）
    this._inFlight = new Set(); // 已同步认领、发送在途的 item（崩溃即丢标记，磁盘仍在 → at-least-once）
    this._dead = [];         // 内存模式的死信（磁盘模式下仅 fs 写失败时的兜底）
    this._seq = 0;
    this._pumpTimer = null;
    // 失败可见性（T07：失败计数可见）
    this.failures = 0;
    this.lastError = null;
    this.droppedNormal = 0;
    // CLOSE-009 投影补偿观测：累计补偿重试次数 / 因投影预算耗尽进死信的条数
    this.projectionRetries = 0;
    this.projectionDead = 0;
    // CLOSE-014 dead-letter 保留治理观测：累计入死信 / 累计淘汰（跨重启持久，见 _initDeadRetention）
    this.deadTotal = 0;
    this.deadEvicted = 0;

    if (this.dir) this._loadFromDisk();
    if (this.dir) this._initDeadRetention();
  }

  /* ------------------------------------------------------------------ *
   * 入队
   * ------------------------------------------------------------------ */

  /** 事件入队（先落盘）。普通事件受积压上限约束；critical（审批/错误）绕过上限。 */
  enqueue(event, { priority = 'normal' } = {}) {
    if (!event || !event.event_id) return false;
    if (this._items.size >= this.maxItems) {
      if (priority !== 'critical') {
        this.droppedNormal += 1;
        this.logger.warn?.(`[outbox] backlog full (${this._items.size}/${this.maxItems})，丢弃普通事件 ${event.event_id}（累计丢弃 ${this.droppedNormal}）`);
        return false;
      }
      this.logger.warn?.(`[outbox] backlog full (${this._items.size}/${this.maxItems})，关键事件 ${event.event_type || ''} ${event.event_id} 仍入队`);
    }
    return this._insert({ kind: 'event', priority, event_id: String(event.event_id), event });
  }

  enqueueMany(events, opts = {}) {
    let n = 0;
    for (const e of events || []) if (this.enqueue(e, opts)) n += 1;
    return n;
  }

  /**
   * 命令 ACK 入队（kind='ack'，到期时优先认领且先于同轮事件批；失败退避不阻塞执行）。
   * payload: { command_id, result, error?, session_id?, correlation_id?, lease_id?, attempts?, retryable? }
   */
  enqueueAck(payload, { priority = 'critical' } = {}) {
    if (!payload || !payload.command_id) return false;
    return this._insert({ kind: 'ack', priority, event_id: `ack:${payload.command_id}`, payload });
  }

  _insert(base) {
    const item = {
      id: this._nextId(),
      state: 'pending',
      attempts: 0,
      next_attempt_at: 0,
      enqueued_at: Date.now(),
      last_error: null,
      ...base,
    };
    if (this.dir) this._atomicWrite(this._itemPath(item.id), item);
    this._items.set(item.id, item);
    return true;
  }

  get size() {
    return this._items.size;
  }

  _nextId() {
    this._seq += 1;
    return `${String(this._seq).padStart(12, '0')}_${crypto.randomBytes(4).toString('hex')}`;
  }

  _itemPath(id) {
    return path.join(this.dir, `${id}.json`);
  }

  _atomicWrite(file, obj) {
    // 临时文件 + rename 原子替换：断电/崩溃不会留下半写文件
    const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
    fs.writeFileSync(tmp, JSON.stringify(obj), 'utf8');
    fs.renameSync(tmp, file);
  }

  _persist(item) {
    if (!this.dir) return;
    try {
      this._atomicWrite(this._itemPath(item.id), item);
    } catch (err) {
      this.logger.warn?.(`[outbox] persist failed for ${item.id}: ${err.message}`);
    }
  }

  _loadFromDisk() {
    fs.mkdirSync(this.dir, { recursive: true });
    let recovered = 0;
    for (const name of fs.readdirSync(this.dir)) {
      const full = path.join(this.dir, name);
      if (!name.endsWith('.json')) {
        // 崩溃残留的临时文件：直接清理
        try { fs.rmSync(full, { force: true }); } catch { /* ignore */ }
        continue;
      }
      try {
        const item = JSON.parse(fs.readFileSync(full, 'utf8'));
        if (item && item.id) {
          const seq = parseInt(name.slice(0, 12), 10);
          if (Number.isFinite(seq)) this._seq = Math.max(this._seq, seq);
          item.state = 'pending'; // 崩溃时的 in-flight 一律回到 pending（at-least-once）
          this._items.set(item.id, item);
          recovered += 1;
        }
      } catch (err) {
        this.logger.warn?.(`[outbox] skip corrupt item ${name}: ${err.message}`);
      }
    }
    if (recovered > 0) this.logger.log?.(`[outbox] recovered ${recovered} pending item(s) from ${this.dir}`);
  }

  /* ------------------------------------------------------------------ *
   * 排空（发送 + 分类确认）
   * ------------------------------------------------------------------ */

  /**
   * 排空一次（无期限）或持续排空至 deadlineMs（退出排空）。
   * 关键保证：认领与首包发送在 flush() 调用栈内同步完成（不做任何前置 await），
   * 使「critical 事件即时直推」的调用方语义与旧实现一致；并发 flush 通过
   * 「同步认领（claim）」互斥——同一 item 绝不会被两次发送（防双发）。
   */
  flush({ deadlineMs = 0 } = {}) {
    return this._drain(deadlineMs > 0 ? Date.now() + deadlineMs : 0);
  }

  async _drain(deadline) {
    for (;;) {
      const batch = this._claimDue(Date.now());
      if (batch.events.length || batch.acks.length) {
        await this._sendDue(batch);
      } else if (deadline) {
        const earliest = this._earliestNextAttempt();
        if (earliest === null || earliest >= deadline) return; // 期限后未确认 → 留在磁盘
        await sleep(Math.min(earliest - Date.now(), 200));
      } else {
        return; // 单趟模式：剩余项在退避或在途，留给下次入队/轮询/pump 驱动
      }
    }
  }

  /** 同步认领到期 item（从 _items 摘除入 _inFlight，防并发双发）。
   * V12-18：两级认领——critical（审批/错误/ACK）先认领，普通事件按入队序补足剩余
   * 事件额度；同一优先级内部保持入队序（id 序）。协议依据：event-protocol.md §11
   * 游标契约（(server_received_at, event_id) 稳定排序）使发送端次序与客户端读取解耦，
   * syncReport 逐事件 duplicate 幂等 + 投影 last_seq/status_seq 水位单调——critical
   * 先发不造成漏读或水位回退。动机：一方任务洪泛时，关键审批/ACK 不得排在 ≤5000
   * 条普通积压之后逐批排队（§15「一方洪泛不阻塞另一方关键审批/ACK」预算）；
   * 优先级作用域由「仅重试间隔」扩展为「重试间隔 + 认领次序」，不绕过 outbox
   * 持久化与逐事件确认。 */
  _claimDue(now) {
    // 卡死发送回收：认领超过 60s（远大于 transport 自身超时）视为悬挂，放回待认领
    for (const item of this._inFlight) {
      if (item.claimed_at && now - item.claimed_at >= 60 * 1000) {
        this._inFlight.delete(item);
        this._items.set(item.id, item);
      }
    }
    const events = [];
    const acks = [];
    const sorted = [...this._items.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
    // 第一遍：critical 事件与 ACK 优先认领（额度不变：事件 ≤maxBatch、ACK ≤maxAcksPerCycle；
    // 超额 item 本轮不认领，留在 _items 等下一轮，不设 claimed_at）
    for (const item of sorted) {
      if (item.next_attempt_at > now) continue;
      if (item.kind === 'ack') {
        if (acks.length >= this.maxAcksPerCycle) continue;
        this._items.delete(item.id);
        item.claimed_at = now;
        this._inFlight.add(item);
        acks.push(item);
      } else if (item.priority === 'critical' && events.length < this.maxBatch) {
        this._items.delete(item.id);
        item.claimed_at = now;
        this._inFlight.add(item);
        events.push(item);
      }
    }
    // 第二遍：普通事件按入队序补足剩余事件额度（critical 已认领的额度不回吐）
    for (const item of sorted) {
      if (events.length >= this.maxBatch) break;
      if (item.kind !== 'event' || item.priority === 'critical') continue;
      if (item.next_attempt_at > now) continue;
      this._items.delete(item.id);
      item.claimed_at = now;
      this._inFlight.add(item);
      events.push(item);
    }
    return { events, acks };
  }

  _earliestNextAttempt() {
    let earliest = null;
    for (const item of this._items.values()) {
      if (earliest === null || item.next_attempt_at < earliest) earliest = item.next_attempt_at;
    }
    return earliest;
  }

  async _sendDue({ events, acks }) {
    // V12-18：ACK 先于事件批发送——命令结果确认（含审批决议 ACK）直接驱动云端状态
    // 收敛（审批 applied/denied 可见、新建任务 sid 回填），不应排在同轮 ≤200 条事件
    // 的传输等待之后（§15「提交控制到明确接纳 p95≤5s」与「关键审批 ACK 不被洪泛
    // 阻塞」预算）。仅调整同一 outbox 内两类 item 的发送次序，确认/重试语义不变。
    for (const item of acks) await this._sendAck(item);
    if (events.length) await this._sendEventBatch(events);
  }

  /**
   * 事件批发送与逐事件分类确认。
   * 分类依据（syncReport 响应形状，字段只加不删）：
   *   - errors[]：逐事件拒收明细（{event_id, error}）→ permanent→dead / 瞬时→retry；
   *   - projection.failed[]：CLOSE-009 投影失败明细（{session_id, error}）→ 失败会话的
   *     事件转入补偿重试（事件已入库，重发经 duplicate 幂等修复投影），其余照常确认。
   */
  async _sendEventBatch(items) {
    let data = null;
    try {
      const res = await this.transport.pushEvents(items.map((i) => i.event));
      data = res && res.data;
      this._settleEventBatch(items, data);
      return;
    } catch (err) {
      this._recordFailure(err);
      const data = err && err.data;
      // 云端逐事件明细（HTTP200+ok:false 的 syncReport 响应）→ 按事件分类：
      // 明细之外的事件 = 已 accepted/duplicates → 确认；坏件按码 permanent→dead / 瞬时→retry。
      // 同一响应可同时携带 projection.failed（投影层失败与事件层拒收相互独立），一并分类。
      if (data && Array.isArray(data.errors) && data.errors.length) {
        this._settleEventBatch(items, data);
        return;
      }
      // 无逐事件明细的整批失败：
      //   永久（unauthorized/4xx 等）→ 全部 dead-letter；瞬时（网络/超时/5xx）→ 全部退避重试
      if (err instanceof TransportError && isPermanentFailure({ status: err.status, data })) {
        for (const item of items) this._deadLetter(item, this._errorSummary(err));
      } else {
        for (const item of items) this._retry(item, this._errorSummary(err));
      }
    }
  }

  _settleEventBatch(items, data) {
    const errMap = new Map();
    if (data && Array.isArray(data.errors)) {
      for (const e of data.errors) {
        if (e && e.event_id) errMap.set(String(e.event_id), String(e.error || 'unknown'));
      }
    }
    // CLOSE-009（R06 修复）：投影失败明细按 session_id 索引。该明细只说明「投影更新失败」，
    // 事件本身已被服务端接受（含 duplicate 幂等重放），因此这些事件既不能按 accepted 确认
    // 删除（投影缺口将无人修复——尤其最后一批 session_end 没有下一批来补），也不能按事件级
    // 错误处理（errors[] 里并没有它们）。
    const projFailed = new Map();
    if (data && data.projection && Array.isArray(data.projection.failed)) {
      for (const f of data.projection.failed) {
        if (f && f.session_id !== undefined && f.session_id !== null) {
          projFailed.set(String(f.session_id), String(f.error || 'projection-failed'));
        }
      }
    }
    for (const item of items) {
      const code = errMap.get(item.event_id);
      if (code === undefined) {
        const projErr = projFailed.get(String(item.event && item.event.session_id));
        if (projErr !== undefined) {
          this._retryProjection(item, projErr); // 事件已入库但投影失败 → 保留补偿，不确认删除
        } else {
          this._confirm(item); // accepted（含 duplicates 幂等重放）→ 确认删除
        }
      } else if (isPermanentCode(code)) {
        this._deadLetter(item, code); // schema/冲突/越权/墓碑类永久错 → 隔离，不再重试
      } else {
        this._retry(item, code); // 瞬时错（INTERNAL 等）→ 退避重试
      }
    }
  }

  /**
   * CLOSE-009 投影失败补偿（R06 修复）：失败会话的事件保留重发，带独立重试预算与退避。
   *  - 重发后服务端按 duplicate 路径幂等折叠投影（seq 水位单调，乱序/重复安全）；
   *  - 预算（maxProjectionRetries）耗尽或超期（projectionMaxAgeMs）→ dead-letter，
   *    dead_reason 明确标注 projection-retry-exhausted/expired，绝不静默丢弃；
   *  - 仅影响失败会话的事件，其他已成功事件照常确认，不因部分失败整体卡死。
   */
  _retryProjection(item, errorSummary) {
    this._inFlight.delete(item);
    item.projection_attempts = (item.projection_attempts || 0) + 1;
    item.attempts += 1; // 退避曲线随补偿次数升级（与 transport 重试共用同一条曲线）
    item.projection_last_error = String(errorSummary || 'projection-failed').slice(0, 300);
    item.last_error = `projection-failed: ${item.projection_last_error}`;
    item.claimed_at = null;
    this.projectionRetries += 1;
    this.failures += 1; // R06 语义修正：投影失败必须可见（failures/last_error）
    this.lastError = item.last_error;
    const session = String(item.event && item.event.session_id);
    const summary = `${session}: ${item.projection_last_error}`;
    if (item.projection_attempts > this.maxProjectionRetries) {
      this.projectionDead += 1;
      this._deadLetter(item, `projection-retry-exhausted(${this.maxProjectionRetries}): ${summary}`);
      return;
    }
    if (Date.now() - (Number(item.enqueued_at) || Date.now()) > this.projectionMaxAgeMs) {
      this.projectionDead += 1;
      this._deadLetter(item, `projection-retry-expired: ${summary}`);
      return;
    }
    this.logger.warn?.(
      `[outbox] projection failed for session ${session}, event ${item.event_id} retained for compensation retry (${item.projection_attempts}/${this.maxProjectionRetries}): ${item.projection_last_error}`,
    );
    item.next_attempt_at = Date.now() + this._backoffMs(item); // 退避重试（按 next_attempt_at 独立调度，不阻塞其他事件）
    this._items.set(item.id, item);
    this._persist(item);
  }

  async _sendAck(item) {
    try {
      await this.transport.ackCommand(item.payload);
      this._confirm(item);
    } catch (err) {
      this._recordFailure(err);
      if (err instanceof TransportError && isPermanentFailure({ status: err.status, data: err.data })) {
        this._deadLetter(item, this._errorSummary(err));
      } else {
        this._retry(item, this._errorSummary(err));
      }
    }
  }

  _confirm(item) {
    this._inFlight.delete(item);
    this._items.delete(item.id);
    if (this.dir) {
      try { fs.rmSync(this._itemPath(item.id), { force: true }); } catch { /* ignore */ }
    }
  }

  _retry(item, errorSummary) {
    this._inFlight.delete(item);
    item.attempts += 1;
    item.next_attempt_at = Date.now() + this._backoffMs(item);
    item.last_error = String(errorSummary || 'unknown').slice(0, 300);
    item.claimed_at = null;
    this._items.set(item.id, item);
    this._persist(item);
  }

  _backoffMs(item) {
    const base = item.priority === 'critical' ? this.criticalInitialBackoffMs : this.initialBackoffMs;
    const exp = Math.min(Math.max(item.attempts - 1, 0), 16);
    const raw = Math.min(base * 2 ** exp, this.maxBackoffMs);
    const jitter = 1 + (Math.random() * 2 - 1) * this.jitterRatio;
    return Math.max(50, Math.round(raw * jitter));
  }

  _deadLetter(item, reason) {
    this._inFlight.delete(item);
    this._items.delete(item.id);
    const dead = {
      ...item,
      state: 'dead',
      dead_reason: String(reason || 'unknown').slice(0, 300),
      dead_at: Date.now(),
    };
    if (this.dir) {
      try {
        fs.mkdirSync(path.join(this.dir, 'dead'), { recursive: true });
        this._atomicWrite(path.join(this.dir, 'dead', `${item.id}.json`), dead);
        fs.rmSync(this._itemPath(item.id), { force: true });
      } catch (err) {
        this.logger.warn?.(`[outbox] dead-letter write failed for ${item.id}: ${err.message}`);
        this._dead.push(dead);
      }
    } else {
      this._dead.push(dead);
    }
    // CLOSE-014：死信保留治理——淘汰超龄/超限死信并记账（计数不丢，跨重启持久）
    this.deadTotal += 1;
    const evicted = this._enforceDeadRetention();
    this.deadEvicted += evicted;
    this._persistDeadMeta();
    this.logger.warn?.(`[outbox] dead-letter ${item.event_id}: ${dead.dead_reason}`);
  }

  /* ------------------------------------------------------------------ *
   * CLOSE-014 dead-letter 保留治理
   * ------------------------------------------------------------------ */

  _deadDir() {
    return path.join(this.dir, 'dead');
  }

  /** dead/ 目录下的死信文件（跳过 _retention.json 记账文件），按文件名升序（≈入队序）。 */
  _deadFileNames() {
    try {
      return fs.readdirSync(this._deadDir())
        .filter((f) => f.endsWith('.json') && !f.startsWith('_'))
        .sort();
    } catch {
      return [];
    }
  }

  /** 读取单条死信的 dead_at（损坏/缺失按 0=最旧处理，优先被淘汰）。 */
  _deadAtOf(file) {
    try {
      const doc = JSON.parse(fs.readFileSync(path.join(this._deadDir(), file), 'utf8'));
      return Number(doc && doc.dead_at) || 0;
    } catch {
      return 0;
    }
  }

  /**
   * 构造时初始化：装载跨重启的 dead_total/dead_evicted 记账（legacy 目录无记账文件时
   * 以现存文件数播种），随后按保留期/容量淘汰一次（长期空闲的桥重启即收敛）。
   */
  _initDeadRetention() {
    let liveCount = this._deadFileNames().length;
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(this._deadDir(), '_retention.json'), 'utf8'));
      this.deadTotal = Math.max(Number(meta && meta.dead_total) || 0, liveCount);
      this.deadEvicted = Number(meta && meta.dead_evicted) || 0;
    } catch {
      this.deadTotal = liveCount; // legacy：无记账文件，从现状起步
      this.deadEvicted = 0;
    }
    const evicted = this._enforceDeadRetention();
    if (evicted > 0) {
      this.deadEvicted += evicted;
      liveCount -= evicted;
      this.logger.log?.(`[outbox] dead-letter retention pruned ${evicted} expired/overflow item(s) on startup`);
    }
    this._persistDeadMeta();
  }

  /**
   * 执行保留策略：先淘汰超过保留期（dead_at 早于 now-retentionMs）的死信，
   * 再按容量上限淘汰最旧（dead_at 升序，平序按文件名/入队序）。
   * 内存模式对 this._dead 同策略。@returns {number} 本次淘汰条数
   */
  _enforceDeadRetention() {
    let evicted = 0;
    const now = Date.now();
    if (this.dir) {
      const files = this._deadFileNames();
      const entries = files.map((f) => ({ file: f, deadAt: this._deadAtOf(f) }));
      const drop = new Set();
      if (this.deadLetterRetentionMs > 0) {
        for (const e of entries) {
          if (e.deadAt > 0 && now - e.deadAt > this.deadLetterRetentionMs) drop.add(e.file);
        }
      }
      if (this.maxDeadLetters > 0) {
        const kept = entries.filter((e) => !drop.has(e.file)).sort((a, b) => (a.deadAt !== b.deadAt ? a.deadAt - b.deadAt : (a.file < b.file ? -1 : 1)));
        for (let i = 0; i < kept.length - this.maxDeadLetters; i += 1) drop.add(kept[i].file);
      }
      for (const file of drop) {
        try { fs.rmSync(path.join(this._deadDir(), file), { force: true }); evicted += 1; } catch { /* ignore */ }
      }
    }
    if (this._dead.length) {
      const before = this._dead.length;
      if (this.deadLetterRetentionMs > 0) {
        this._dead = this._dead.filter((d) => !d.dead_at || now - d.dead_at <= this.deadLetterRetentionMs);
      }
      if (this.maxDeadLetters > 0 && this._dead.length > this.maxDeadLetters) {
        this._dead.sort((a, b) => (a.dead_at || 0) - (b.dead_at || 0));
        this._dead = this._dead.slice(this._dead.length - this.maxDeadLetters);
      }
      evicted += before - this._dead.length;
    }
    return evicted;
  }

  /** 死信记账持久化（dead/_retention.json；随 dead/ 目录一并保留，跨重启不丢账）。 */
  _persistDeadMeta() {
    if (!this.dir) return;
    try {
      fs.mkdirSync(this._deadDir(), { recursive: true });
      this._atomicWrite(path.join(this._deadDir(), '_retention.json'), {
        dead_total: this.deadTotal,
        dead_evicted: this.deadEvicted,
        updated_at: Date.now(),
      });
    } catch (err) {
      this.logger.warn?.(`[outbox] dead retention meta persist failed: ${err.message}`);
    }
  }

  _errorSummary(err) {
    if (err instanceof TransportError) return `${err.code}${err.status ? `/${err.status}` : ''}: ${err.message}`;
    return String((err && err.message) || err);
  }

  _recordFailure(err) {
    this.failures += 1;
    this.lastError = this._errorSummary(err);
  }

  /* ------------------------------------------------------------------ *
   * 后台 pump 与观测
   * ------------------------------------------------------------------ */

  /** 周期 pump：驱动退避重试（轮询循环/事件入队之外的第二驱动源）。 */
  start(pumpIntervalMs = 1000) {
    if (this._pumpTimer) return;
    this._pumpTimer = setInterval(() => {
      const now = Date.now();
      for (const item of this._items.values()) {
        if (item.next_attempt_at <= now) {
          this.flush();
          break;
        }
      }
    }, pumpIntervalMs);
    this._pumpTimer.unref?.();
  }

  stop() {
    if (this._pumpTimer) clearInterval(this._pumpTimer);
    this._pumpTimer = null;
  }

  /**
   * 观测：pending/dead/失败计数（测试与运维可见性）。
   * CLOSE-009 投影补偿可观测：projection_retries=累计补偿重试次数；
   * projection_pending=当前处于投影补偿通道的事件数；projection_dead=因投影预算耗尽/
   * 超期进死信的累计条数（dead 总数含各类死信，deadLetters() 可逐条查 dead_reason）。
   * CLOSE-014 死信保留治理观测：dead=现存死信（dead/ 文件 + 内存兜底）；
   * dead_total=累计入死信数；dead_evicted=累计被保留策略淘汰数
   * （不变量 dead_total = dead + dead_evicted，跨重启经 dead/_retention.json 持久）。
   */
  stats() {
    let dead = this._dead.length;
    if (this.dir) {
      dead = this._deadFileNames().length; // 跳过 _retention.json 记账文件
    }
    let acks = 0;
    let projectionPending = 0;
    for (const item of this._inFlight) {
      if (item.kind === 'ack') acks += 1;
      if (item.projection_attempts) projectionPending += 1;
    }
    for (const item of this._items.values()) {
      if (item.projection_attempts) projectionPending += 1;
    }
    return {
      pending: this._items.size + this._inFlight.size,
      events: this._items.size + this._inFlight.size - acks,
      acks,
      dead,
      failures: this.failures,
      last_error: this.lastError,
      dropped_normal: this.droppedNormal,
      projection_retries: this.projectionRetries,
      projection_pending: projectionPending,
      projection_dead: this.projectionDead,
      dead_total: this.deadTotal,
      dead_evicted: this.deadEvicted,
    };
  }

  deadLetters() {
    if (!this.dir) return [...this._dead];
    let files = [];
    try {
      files = fs.readdirSync(path.join(this.dir, 'dead'))
        .filter((f) => f.endsWith('.json') && !f.startsWith('_'));
    } catch {
      files = [];
    }
    const fromDisk = files
      .map((f) => {
        try { return JSON.parse(fs.readFileSync(path.join(this.dir, 'dead', f), 'utf8')); } catch { return null; }
      })
      .filter(Boolean);
    return [...fromDisk, ...this._dead]; // _dead 为磁盘模式写失败兜底，一并可见
  }
}
