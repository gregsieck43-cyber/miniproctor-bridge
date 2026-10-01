/**
 * CommandInbox：桥接侧持久化命令收件箱（TASK-007；CLOSE-010 结果信封与 fail-closed 强化）。
 *
 * 职责（对齐 event-protocol.md §9/§10 与首发范围 §5.1）：
 *  1. 去重：以 command_id 为主键（=云端 _id），重复拉取/租约重派只执行一次；
 *  2. 完整结果信封（CLOSE-010）：done 记录持久化完整执行结果——schema 版本、command_type、
 *     command_id、correlation/request_id、result_session_id、result/error、完成时间。
 *     租约重派（云端 ACK 丢失后的重发）从同一信封重建 ACK，两次 ACK 业务结果一致（R07）；
 *  3. 崩溃恢复 unknown 语义：恢复时若存在「executing 开始」而无结果记录 → 标记
 *     unknown 并如实 ack（不盲目重放——stdin 写入 ≠ Agent 完成；stop/approve 类
 *     不可逆命令尤其如此）。received（已领取未开始执行）→ 安全重放；
 *  4. ACK 入队确认（CLOSE-010）：markResult 后由调用方 markAckEnqueued 落「ACK 已持久
 *     入 outbox」标记；崩溃于「结果已持久化、ACK 未入队」之间 → 重启由
 *     pendingAckRecords() 恢复扫描重新入队（不静默丢失）；
 *  5. fail-closed 落盘契约：_persist 失败（磁盘满/权限）向上抛出，调用方据此拒绝执行
 *     不可逆命令；本类不在写路径内吞错误。
 *
 * 存储格式：<dir>/<command_id>.json（command_id 内非法文件名字符做替换），内容：
 * {
 *   command_id, command, claimed_at, started_at, finished_at, state,
 *   // ---- CLOSE-010 结果信封（state='done' 时必有；envelope_version 缺失 = 旧 schema 记录）----
 *   envelope_version, result, error, result_session_id,
 *   command_type, correlation_id, request_id,
 *   // ---- ACK 恢复标记 ----
 *   ack_enqueued_at
 * }
 * 写入为「临时文件+rename」原子替换；dir=null 时为纯内存模式（单元测试）。
 *
 * 损坏与半写（CLOSE-010 fail-closed）：
 *  - JSON 损坏/字段非法 → 原文件移入 <dir>/quarantine/ + 合成 unknown 信封记录（同名
 *    落盘）——重派时如实 ack unknown，绝不当作「未执行」盲目重放；
 *  - <name>.json.tmp-* 半写残留：tmp 内容完整（rename 前崩溃）→ 采信 tmp 状态（只前进）；
 *    tmp 半写（writeFileSync 中断）→ 无法证明最终状态 → 隔离 tmp + 合成 unknown 信封，
 *    绝不回退到「received」重放（不可逆命令安全优先）。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const STATES = Object.freeze(['received', 'executing', 'done']);
const STATE_RANK = Object.freeze({ received: 0, executing: 1, done: 2 });
const QUARANTINE_DIR = 'quarantine';

/** 结果信封 schema 版本：字段集合变更时递增；记录缺失 envelope_version = CLOSE-010 之前旧数据。 */
export const INBOX_ENVELOPE_VERSION = 1;

/**
 * done 记录保留期（CLOSE-010）：必须不短于云端命令重派窗口。
 * 云端租约 120s（pullCommands LEASE_MS）+ 命令 expires_at 10min（sendCommand）——
 * 同一 command_id 的重派只发生在创建后 ~10 分钟内；本保留期取 24h（≥144× 裕度），
 * 期间任何重派都能从结果信封原样回放 ACK。
 * 只有「envelope 完整且 ACK 已入队」的 done 记录到期才回收；未确认 ACK 的记录与
 * 旧 schema 记录不按期回收（恢复扫描/重派回放依赖它们，直到被重放确认）。
 */
export const INBOX_DONE_RETENTION_MS = 24 * 60 * 60 * 1000;

/**
 * V1-019③：quarantine/ 隔离文件保留治理——无上限的隔离目录同样是磁盘资源泄漏
 * （持续损坏的磁盘可无限产隔离件）。容量上限 + 保留期双约束，超限/超龄淘汰最旧
 * （文件名前缀 <ts>-<rand>-<原名>，时间序即淘汰序）。构造时与每次隔离动作后执行。
 */
export const QUARANTINE_MAX_FILES = 100;
export const QUARANTINE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

function safeFileName(commandId) {
  return String(commandId).replace(/[^A-Za-z0-9._-]/g, '_');
}

/** 记录是否结构有效（可信任其 state 字段）。 */
function looksValidRecord(rec) {
  return Boolean(
    rec && typeof rec === 'object' && !Array.isArray(rec)
    && typeof rec.command_id === 'string' && rec.command_id
    && STATES.includes(rec.state),
  );
}

export class CommandInbox {
  constructor({
    dir = null,
    logger = console,
    doneRetentionMs = INBOX_DONE_RETENTION_MS,
    quarantineMaxFiles = QUARANTINE_MAX_FILES,
    quarantineRetentionMs = QUARANTINE_RETENTION_MS,
  } = {}) {
    this.dir = dir ? path.resolve(String(dir)) : null;
    this.logger = logger;
    this._records = new Map(); // command_id -> record
    // <=0 视为禁用回收（显式选择）；否则必须 ≥ 云端重派窗口（见 INBOX_DONE_RETENTION_MS 注释）
    this.doneRetentionMs = Number.isFinite(doneRetentionMs) && doneRetentionMs > 0 ? doneRetentionMs : 0;
    // V1-019③：隔离保留（0 = 禁用对应维度，显式选择）
    this.quarantineMaxFiles = Number.isFinite(quarantineMaxFiles) && quarantineMaxFiles > 0 ? quarantineMaxFiles : 0;
    this.quarantineRetentionMs = Number.isFinite(quarantineRetentionMs) && quarantineRetentionMs > 0 ? quarantineRetentionMs : 0;
    if (this.dir) {
      fs.mkdirSync(this.dir, { recursive: true });
      this._loadFromDisk();
      this._pruneRetention(Date.now());
      this._pruneQuarantine(Date.now());
    }
  }

  _loadFromDisk() {
    const tmpResidues = [];
    for (const entry of fs.readdirSync(this.dir, { withFileTypes: true })) {
      if (entry.isDirectory()) continue; // quarantine/ 子目录
      const name = entry.name;
      const full = path.join(this.dir, name);
      if (name.includes('.json.tmp-')) {
        tmpResidues.push(name); // 半写/未 rename 的临时文件，统一在主记录加载后裁决
        continue;
      }
      if (!name.endsWith('.json')) {
        try { fs.rmSync(full, { force: true }); } catch { /* ignore */ }
        continue;
      }
      let rec = null;
      try {
        rec = JSON.parse(fs.readFileSync(full, 'utf8'));
      } catch {
        rec = null;
      }
      if (!looksValidRecord(rec)) {
        // 损坏记录：隔离 + 合成 unknown 信封（fail-closed：绝不当「未执行」重放）
        const derivedId = this._quarantineFile(name, 'corrupt-record');
        if (derivedId) {
          this._adoptUnknownMarker(derivedId, 'inbox record corrupt (quarantined): outcome unknown', true);
        }
        continue;
      }
      this._records.set(rec.command_id, rec);
    }
    for (const name of tmpResidues) this._adoptTmpResidue(name);
  }

  /**
   * 半写 tmp 残留裁决：<base>.json.tmp-<pid>[..]。tmp 是「writeFileSync 完成后、rename 前
   * 崩溃」的证据，其内容代表了比磁盘主记录更新的状态意图：
   *  - 内容完整可解析 → 采信（状态只前进不回退），rename 覆盖主记录；
   *  - 内容半写（无法解析）→ 真实状态不可证明（可能是 executing/done 写入中途）→
   *    fail-closed：主记录非 done 时合成 unknown 信封，绝不回退 received 重放。
   */
  _adoptTmpResidue(name) {
    const cut = name.indexOf('.json.tmp-');
    if (cut <= 0) {
      try { fs.rmSync(path.join(this.dir, name), { force: true }); } catch { /* ignore */ }
      return;
    }
    const base = name.slice(0, cut); // 已消毒的 command_id（safeFileName 对标准 id 可逆）
    const commandId = base;
    const mainPath = path.join(this.dir, `${base}.json`);
    const tmpPath = path.join(this.dir, name);
    const mainRec = this._records.get(commandId) || null;
    let tmpRec = null;
    try {
      tmpRec = JSON.parse(fs.readFileSync(tmpPath, 'utf8'));
    } catch {
      tmpRec = null;
    }
    if (looksValidRecord(tmpRec)) {
      if (!mainRec || STATE_RANK[tmpRec.state] > STATE_RANK[mainRec.state]) {
        try {
          fs.renameSync(tmpPath, mainPath);
          this._records.set(commandId, tmpRec);
        } catch {
          this._quarantineFile(name, 'tmp-adopt-rename-failed');
        }
      } else {
        try { fs.rmSync(tmpPath, { force: true }); } catch { /* ignore */ }
      }
      return;
    }
    this._quarantineFile(name, 'partial-tmp');
    if (!mainRec || mainRec.state !== 'done') {
      this._adoptUnknownMarker(commandId, 'inbox record half-written (crash during persist): outcome unknown', true);
    }
  }

  /** 合成/采纳 unknown 信封记录：损坏或半写历史的唯一诚实表达——结果未知，重派如实上报。 */
  _adoptUnknownMarker(commandId, reason, persistToDisk) {
    const marker = {
      command_id: commandId,
      command: null,
      claimed_at: null,
      started_at: null,
      finished_at: Date.now(),
      state: 'done',
      envelope_version: INBOX_ENVELOPE_VERSION,
      result: 'unknown',
      error: reason,
      result_session_id: null,
      command_type: null,
      correlation_id: null,
      request_id: null,
      quarantined: true,
    };
    if (persistToDisk) {
      try {
        this._persist(marker);
      } catch (err) {
        this.logger?.warn?.(`[inbox] unknown-marker persist failed for ${commandId}: ${err?.message || err}`);
      }
    }
    this._records.set(commandId, marker);
    return marker;
  }

  /** 把 <dir> 下的坏文件移入 quarantine/（带时间戳防覆盖）。返回由文件名反推的 command_id。 */
  _quarantineFile(name, reason) {
    const qDir = path.join(this.dir, QUARANTINE_DIR);
    try {
      fs.mkdirSync(qDir, { recursive: true });
      const target = path.join(qDir, `${Date.now()}-${crypto.randomBytes(3).toString('hex')}-${name}`);
      try {
        fs.renameSync(path.join(this.dir, name), target);
      } catch (err) {
        // rename 失败（Windows 句柄占用等）：保留原文件，仅告警——隔离失败不能阻止 unknown 标记
        this.logger?.warn?.(`[inbox] quarantine rename failed for ${name}: ${err?.message || err}（原文件保留）`);
        return name.endsWith('.json') ? name.slice(0, -'.json'.length) : name.slice(0, name.indexOf('.json.tmp-'));
      }
      this.logger?.warn?.(`[inbox] corrupt/partial record quarantined (${reason}): ${name}`);
      this._pruneQuarantine(Date.now()); // V1-019③：隔离动作后立即执行保留治理
      return name.endsWith('.json') ? name.slice(0, -'.json'.length) : name.slice(0, name.indexOf('.json.tmp-'));
    } catch (err) {
      this.logger?.warn?.(`[inbox] quarantine failed for ${name}: ${err?.message || err}`);
      return null;
    }
  }

  _file(commandId) {
    return path.join(this.dir, `${safeFileName(commandId)}.json`);
  }

  /**
   * 落盘（临时文件+rename 原子替换）。失败向上抛出——调用方（session-manager）以
   * fail-closed 语义处理：结果不可记录时不执行/不继续不可逆命令。
   */
  _persist(record) {
    if (!this.dir) return;
    const file = this._file(record.command_id);
    const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
    fs.writeFileSync(tmp, JSON.stringify(record), 'utf8');
    fs.renameSync(tmp, file);
  }

  get(commandId) {
    return this._records.get(String(commandId)) || null;
  }

  has(commandId) {
    return this._records.has(String(commandId));
  }

  /**
   * 领取命令（幂等入口）。返回：
   *  - { action: 'execute', record }       新命令或崩溃于 executing 之前（安全重放）
   *  - { action: 'skip-done', record }     已执行过（租约重派）→ 幂等 ack（信封/旧记录由调用方按
   *                                          record.envelope_version 区分处理）
   *  - { action: 'recover-unknown', record } 崩溃于 executing 中 → 已置 unknown 终态，禁止重放
   */
  claim(command) {
    const commandId = String(command && command.command_id || '');
    if (!commandId) return { action: 'skip', record: null };
    const existing = this._records.get(commandId);
    if (existing && existing.state === 'done') {
      return { action: 'skip-done', record: existing };
    }
    if (existing && existing.state === 'executing') {
      // 上次进程在执行中崩溃：结果未知，如实上报，绝不重放（不可逆命令安全边界）。
      // 统一升级为 unknown 结果信封（旧 schema 的 executing 记录同样收敛到信封表达）。
      const recovered = {
        ...existing,
        state: 'done',
        finished_at: Date.now(),
        envelope_version: INBOX_ENVELOPE_VERSION,
        result: 'unknown',
        error: existing.error || 'crash-recovery: interrupted during previous execution',
        // 已明确指向旧会话的命令必须保留该目标；创建结果未知时原命令 sid 为空，
        // 不虚构新会话。启动恢复与后续租约重派由同一信封重建一致的业务 ACK。
        result_session_id: existing.result_session_id ?? existing.command?.session_id ?? null,
        command_type: existing.command_type ?? existing.command?.command_type ?? null,
        correlation_id: existing.correlation_id ?? existing.command?.correlation_id ?? null,
        request_id: existing.request_id ?? existing.command?.payload?.request_id ?? null,
      };
      this._persist(recovered);
      this._records.set(commandId, recovered);
      return { action: 'recover-unknown', record: recovered };
    }
    const record = existing || {
      command_id: commandId,
      command,
      claimed_at: Date.now(),
      started_at: null,
      finished_at: null,
      result: null,
      error: null,
      state: 'received',
    };
    record.state = 'received';
    this._persist(record); // 失败向上抛：领取都无法落盘时，调用方不应开始执行
    if (!existing) this._records.set(commandId, record);
    return { action: 'execute', record };
  }

  /** 执行开始（崩溃恢复边界：此后中断 = 结果未知）。落盘失败向上抛（fail-closed 前门禁）。 */
  markExecuting(commandId) {
    const record = this._records.get(String(commandId));
    if (!record) return null;
    const updated = { ...record, state: 'executing', started_at: Date.now() };
    this._persist(updated); // 执行前确认「executing + 之后的结果」可落盘——落盘失败则不允许执行
    this._records.set(String(commandId), updated);
    return updated;
  }

  /**
   * 执行结束：完整结果信封一次落盘（CLOSE-010）。落盘失败向上抛且内存记录保持原状
   * （内存与磁盘一致：markResult 成功才算 done）——调用方进入 fail-closed 处理。
   * result: 'succeeded' | 'failed' | 'unknown'
   * V12-11：agent_profile_id/agent_profile_revision/agent_key = 实际执行 profile
   * （create_session 等；缺省 null 不入库）——租约重放/重启恢复重建 ACK 时携带同一份，
   * 供云端与命令路由比对（'profile-ack-mismatch'，§14.3）。
   */
  markResult(commandId, {
    result, error = null, result_session_id = null, command_type = null,
    correlation_id = null, request_id = null,
    agent_profile_id = null, agent_profile_revision = null, agent_key = null,
  } = {}) {
    const record = this._records.get(String(commandId));
    if (!record) return null;
    const updated = {
      ...record,
      state: 'done',
      finished_at: Date.now(),
      envelope_version: INBOX_ENVELOPE_VERSION,
      result: result || 'unknown',
      error: error ? String(error).slice(0, 500) : null,
      result_session_id: result_session_id ?? null,
      command_type: command_type ?? record.command?.command_type ?? null,
      correlation_id: correlation_id ?? record.command?.correlation_id ?? null,
      request_id: request_id ?? record.command?.payload?.request_id ?? null,
      agent_profile_id: agent_profile_id ?? null,
      agent_profile_revision: Number.isInteger(agent_profile_revision) ? agent_profile_revision : null,
      agent_key: agent_key ?? null,
    };
    this._persist(updated);
    this._records.set(String(commandId), updated);
    return updated;
  }

  /**
   * ACK 已持久入 outbox 的确认标记。写失败只告警不抛——该标记是恢复扫描的去重优化，
   * 丢失的最坏后果是重启后多发一次幂等 ACK（ackCommand 幂等）。
   * 标记后顺手触发保留期回收（该记录自此具备回收资格）。
   */
  markAckEnqueued(commandId) {
    const record = this._records.get(String(commandId));
    if (!record) return false;
    record.ack_enqueued_at = Date.now();
    try {
      this._persist(record);
    } catch (err) {
      this.logger?.warn?.(`[inbox] ack flag persist failed for ${commandId}: ${err?.message || err}（重启后可能重复 ACK，幂等无害）`);
    }
    this._pruneRetention(Date.now());
    return true;
  }

  /** 「结果已持久化但 ACK 未入队」的 done 记录（重启恢复扫描依据；旧 schema 记录不参与——不虚构 ACK）。 */
  pendingAckRecords() {
    const out = [];
    for (const rec of this._records.values()) {
      if (rec.state === 'done' && rec.envelope_version != null && !rec.ack_enqueued_at) out.push(rec);
    }
    return out;
  }

  /** executing 态记录（V1-015①：启动恢复扫描依据——上次进程执行中崩溃的命令）。 */
  executingRecords() {
    const out = [];
    for (const rec of this._records.values()) {
      if (rec.state === 'executing') out.push(rec);
    }
    return out;
  }

  /* ------------------------------------------------------------------ *
   * V1-019③：quarantine/ 保留治理（容量上限 + 保留期；main.js clean 可手动触发）
   * ------------------------------------------------------------------ */

  /**
   * 执行隔离保留策略：先淘汰超过保留期的隔离件，再按容量上限淘汰最旧
   * （文件名前缀 <ts>-… 时间序）。@returns {number} 本次删除文件数
   */
  _pruneQuarantine(now) {
    if (!this.dir || (!this.quarantineMaxFiles && !this.quarantineRetentionMs)) return 0;
    const qDir = path.join(this.dir, QUARANTINE_DIR);
    let names = [];
    try {
      names = fs.readdirSync(qDir).filter((f) => !f.startsWith('_'));
    } catch {
      return 0; // 目录不存在 = 无隔离件
    }
    const entries = names.map((name) => {
      const head = Number.parseInt(name.split('-')[0], 10);
      let mtimeMs = 0;
      if (!Number.isFinite(head) || head <= 0) {
        try { mtimeMs = fs.statSync(path.join(qDir, name)).mtimeMs; } catch { /* missing */ }
      }
      return { name, ts: Number.isFinite(head) && head > 0 ? head : Math.floor(mtimeMs || 0) };
    });
    const drop = new Set();
    if (this.quarantineRetentionMs > 0) {
      for (const e of entries) {
        if (e.ts > 0 && now - e.ts > this.quarantineRetentionMs) drop.add(e.name);
      }
    }
    if (this.quarantineMaxFiles > 0) {
      const kept = entries
        .filter((e) => !drop.has(e.name))
        .sort((a, b) => (a.ts !== b.ts ? a.ts - b.ts : (a.name < b.name ? -1 : 1)));
      for (let i = 0; i < kept.length - this.quarantineMaxFiles; i += 1) drop.add(kept[i].name);
    }
    let removed = 0;
    for (const name of drop) {
      try { fs.rmSync(path.join(qDir, name), { force: true }); removed += 1; } catch { /* ignore */ }
    }
    if (removed > 0) this.logger?.log?.(`[inbox] quarantine retention pruned ${removed} file(s)`);
    return removed;
  }

  /** 清理入口（main.js clean / 测试）：立即执行隔离保留策略，返回删除文件数。 */
  pruneQuarantine() {
    return this._pruneQuarantine(Date.now());
  }

  /** quarantine/ 现状观测（doctor/clean 报告用）。 */
  quarantineStats() {
    if (!this.dir) return { files: 0, bytes: 0 };
    const qDir = path.join(this.dir, QUARANTINE_DIR);
    let files = 0;
    let bytes = 0;
    try {
      for (const name of fs.readdirSync(qDir)) {
        files += 1;
        try { bytes += fs.statSync(path.join(qDir, name)).size; } catch { /* ignore */ }
      }
    } catch { /* 目录不存在 */ }
    return { files, bytes };
  }

  /** 保留期回收：仅回收「信封完整 + ACK 已入队」且超过保留期的 done 记录（见常量注释）。 */
  _pruneRetention(now) {
    if (!(this.doneRetentionMs > 0) || !this.dir) return;
    for (const [id, rec] of this._records) {
      if (rec.state !== 'done' || rec.envelope_version == null || !rec.ack_enqueued_at) continue;
      if (now - (Number(rec.finished_at) || 0) >= this.doneRetentionMs) {
        try {
          fs.rmSync(this._file(id), { force: true });
        } catch (err) {
          this.logger?.warn?.(`[inbox] retention prune failed for ${id}: ${err?.message || err}`);
          continue;
        }
        this._records.delete(id);
      }
    }
  }

  stats() {
    const counts = { received: 0, executing: 0, done: 0 };
    let pendingAcks = 0;
    for (const rec of this._records.values()) {
      counts[rec.state] = (counts[rec.state] || 0) + 1;
      if (rec.state === 'done' && rec.envelope_version != null && !rec.ack_enqueued_at) pendingAcks += 1;
    }
    return { total: this._records.size, ...counts, pending_acks: pendingAcks };
  }
}

export { STATES };
