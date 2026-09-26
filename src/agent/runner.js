import { spawn, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { resolveCommandPath, isCmdShimPath } from '../lib/command-resolve.js';

// V12-11：强杀前创建时间核验的查询超时（win32 powershell 查询；超时放弃核验走句柄兜底）。
const OWNERSHIP_PROBE_TIMEOUT_MS = 3000;

const DEFAULT_STOP_GRACE_MS = 3000;
// V1-019⑤：强制停止（killTree）后等待真实退出的上限——stop() 的结果必须与
// 「进程确实不再运行」一致，而不是"发了 taskkill/kill 就报成功"。
const DEFAULT_FORCE_EXIT_WAIT_MS = 3000;
const STDERR_TAIL_BYTES = 4096;
const NL = 0x0a; // '\n'
// TASK-012 资源限制：超长单行输出截断（结构上限，内容级脱敏归 TASK-019）。
// V1-019①：上限同时作用于 stdout 与 stderr 两条流——stderr 此前对无换行 chunk
// 无上限累计（R11），一个不写换行的失控子进程即可耗尽内存。
// 行缓冲以字节计，超过即进入截断模式（丢弃后续字节直到换行），
// 内存上限 = 行上限（单流峰值 = 行上限 + 单个 chunk 大小）。
export const MAX_LINE_BYTES = 256 * 1024;

// cmd.exe 需要的环境防线：防 ANSI 色码污染 stream-json、强制子进程 UTF-8 输出。
// LANG/PYTHONIOENCODING 仅 Windows 注入——posix 上若系统无该 locale 反而触发
// setlocale 告警甚至 ASCII 回退，污染 stdout 的 JSONL。
const CHILD_ENV_GUARDS = process.platform === 'win32'
  ? Object.freeze({ PYTHONIOENCODING: 'utf-8', LANG: 'en_US.UTF-8', FORCE_COLOR: '0' })
  : Object.freeze({ FORCE_COLOR: '0' });

/**
 * 构造经过转义的单个 token（cmd 引号规则：内嵌双引号写成 ""）。
 * 该输出总是再拼进一个外层引号字符串里，由 `cmd /d /s /c "<line>"` 解释；
 * /s 规则会剥掉最外层一对引号而保留内部引号，因此逐 token 引号是安全的。
 */
export function escapeCmdToken(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

export class AgentRunner extends EventEmitter {
  constructor({
    command,
    args = [],
    cwd,
    env,
    stopGraceMs = DEFAULT_STOP_GRACE_MS,
    forceExitWaitMs = DEFAULT_FORCE_EXIT_WAIT_MS,
  } = {}) {
    super();
    if (!command) throw new TypeError('AgentRunner requires command');
    this.command = command;
    this.args = [...args];
    this.cwd = cwd || process.cwd();
    this.env = env;
    this.stopGraceMs = stopGraceMs;
    this.forceExitWaitMs = Math.max(0, Number(forceExitWaitMs) || 0);
    this.child = null;
    this.stdin = null;
    this.stderrTail = '';
    this._stdoutDone = false;
    this._stderrPending = Buffer.alloc(0);
    // V1-019①：stderr 与 stdout 同构的行字节上限截断状态（无换行超限 → 丢字节直到换行）
    this._stderrTruncating = false;
    this._stderrKept = null;
    this._stderrDroppedBytes = 0;
    // stdout 行缓冲（替代 readline：需要行级字节上限以约束超长单行内存占用）
    this._stdoutPending = Buffer.alloc(0);
    this._stdoutTruncating = false;
    this._stdoutKept = null;
    this._stdoutDroppedBytes = 0;
    // 会话级诊断计数：exit 时随 session_exit 事件上报
    this.truncatedLineCount = 0;
    this.stderrTruncatedLineCount = 0;
    // 启动后写入的诊断信息：解析到的可执行文件路径与启动方式。
    this.resolvedCommand = null;
    this.launchMode = null;
    // V12-11：本次 spawn 的归属身份（进程树终止只作用于本实例拥有的子进程，§8.3）。
    //   - instanceId：spawn 时生成的随机实例令牌（实例级身份，与 PID 解耦）；
    //   - createTimeToken：OS 侧进程创建时间令牌（win32=CIM CreationDate；posix=/proc starttime），
    //     强杀前与实时查询比对，防「子进程已退出、PID 被复用后误杀无关进程」。
    this.ownership = null;
  }

  /**
   * 解析启动方式：Windows 上 npm 全局的 claude/codex 是 .cmd shim，
   * 直接 spawn 非 shell 会 ENOENT/EINVAL，必须经由 cmd.exe /d /s /c 启动。
   * 返回 { executable, mode }；mode 为 'direct' 或 'cmd-shell'。
   */
  resolveLaunch() {
    if (process.platform === 'win32') {
      const resolved = resolveCommandPath(this.command, { cwd: this.cwd }) || this.command;
      if (isCmdShimPath(resolved) || isCmdShimPath(this.command)) {
        return { executable: resolved, mode: 'cmd-shell' };
      }
      return { executable: resolved, mode: 'direct' };
    }
    return { executable: this.command, mode: 'direct' };
  }

  buildSpawnOptions(mode) {
    const options = {
      cwd: this.cwd,
      env: this.buildChildEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      // posix 下 detached 使子进程成为进程组组长（pgid=pid），killTree 才能整树终止；
      // Windows 走 taskkill /T，不需要。
      detached: process.platform !== 'win32',
    };
    if (mode === 'cmd-shell') {
      const comSpec = process.env.ComSpec || 'cmd.exe';
      const quotedLine = [
        escapeCmdToken(this.resolvedCommand),
        ...this.args.map(escapeCmdToken),
      ].join(' ');
      return {
        file: comSpec,
        args: ['/d', '/s', '/c', `"${quotedLine}"`],
        options: { ...options, windowsVerbatimArguments: true },
      };
    }
    return { file: this.command, args: this.args, options };
  }

  buildChildEnv() {
    const base = this.env ? { ...process.env, ...this.env } : { ...process.env };
    // 防线后置：编码与去色码声明不可被子进程配置意外还原。
    return { ...base, ...CHILD_ENV_GUARDS };
  }

  start() {
    if (this.child) throw new Error('runner already started');
    const launch = this.resolveLaunch();
    this.resolvedCommand = launch.executable;
    this.launchMode = launch.mode;
    const { file, args, options } = this.buildSpawnOptions(launch.mode);
    this.child = spawn(file, args, options);
    this.stdin = this.child.stdin;
    // V12-11：spawn 即登记归属身份（pid + 实例令牌 + 异步捕获创建时间令牌）。
    this.ownership = {
      pid: this.child.pid ?? null,
      instanceId: crypto.randomUUID(),
      spawnedAtMs: Date.now(),
      createTimeToken: null,
    };
    if (this.child.pid != null) {
      // 创建时间令牌异步捕获（不阻塞启动）；查询失败保持 null——强杀核验退化为句柄判定。
      const pidAtSpawn = this.child.pid;
      this.getProcessCreationTimeToken(pidAtSpawn)
        .then((token) => {
          if (this.ownership && this.ownership.pid === pidAtSpawn) {
            this.ownership.createTimeToken = token;
          }
        })
        .catch(() => { /* 查询失败：句柄判定兜底（见 verifyOwnership） */ });
    }
    this.child.on('error', (err) => this.emit('exit', { code: null, signal: null, error: err }));
    this.child.on('exit', (code, signal) => {
      this.emit('exit', { code, signal, error: null, stderrTail: this.stderrTail });
    });
    // exit 可能早于 stdout/stderr 管道排空；文本型产品须等 close 后才判定最终答复。
    this.child.on('close', (code, signal) => {
      this.emit('io-close', { code, signal, error: null, stderrTail: this.stderrTail });
    });

    // TASK-012：stdin 写入错误（EPIPE 等）必须显式暴露——静默悬挂会让命令"假成功"。
    this.stdin.on('error', (err) => this.emit('stdin-error', err));

    // stdout 手工分行：按字节缓冲、跨 chunk 的 UTF-8 在行边界统一解码；
    // 单行超过 MAX_LINE_BYTES 即截断（丢弃后续字节直到换行，内存有界）。
    this.child.stdout.on('data', (chunk) => this._handleStdoutChunk(chunk));
    this.child.stdout.on('end', () => this._flushStdoutRemainder());

    // stderr 按 UTF-8 行流处理：多字节字符跨 chunk 边界也不会产生乱码。
    this.child.stderr.on('data', (chunk) => this.consumeStderrChunk(chunk));
    this.child.stderr.on('end', () => this.flushStderrRemainder());
    return this;
  }

  _handleStdoutChunk(chunk) {
    if (this._stdoutTruncating) {
      // 截断模式：丢弃字节直到换行，再按正常路径处理剩余部分
      const nl = chunk.indexOf(NL);
      if (nl === -1) {
        this._stdoutDroppedBytes += chunk.length;
        return;
      }
      this._stdoutDroppedBytes += nl;
      this._flushTruncatedLine();
      this._handleStdoutChunk(chunk.subarray(nl + 1));
      return;
    }
    this._stdoutPending = this._stdoutPending.length
      ? Buffer.concat([this._stdoutPending, chunk])
      : chunk;
    let nl = this._stdoutPending.indexOf(NL);
    while (nl !== -1) {
      this.emitStdoutLine(this._stdoutPending.subarray(0, nl), 0);
      this._stdoutPending = this._stdoutPending.subarray(nl + 1);
      nl = this._stdoutPending.indexOf(NL);
    }
    if (this._stdoutPending.length > MAX_LINE_BYTES) {
      // 进入截断模式：保留前 MAX 字节，其余丢弃直到换行
      this._stdoutTruncating = true;
      this._stdoutKept = Buffer.from(this._stdoutPending.subarray(0, MAX_LINE_BYTES));
      this._stdoutDroppedBytes = this._stdoutPending.length - MAX_LINE_BYTES;
      this._stdoutPending = Buffer.alloc(0);
    }
  }

  _flushTruncatedLine() {
    this.emitStdoutLine(this._stdoutKept, this._stdoutDroppedBytes);
    this._stdoutTruncating = false;
    this._stdoutKept = null;
    this._stdoutDroppedBytes = 0;
  }

  _flushStdoutRemainder() {
    if (this._stdoutTruncating) {
      this._flushTruncatedLine();
    } else if (this._stdoutPending.length > 0) {
      this.emitStdoutLine(this._stdoutPending, 0);
      this._stdoutPending = Buffer.alloc(0);
    }
    this._stdoutDone = true;
    this.emit('stdout-end');
  }

  emitStdoutLine(lineBuf, droppedBytes) {
    // V1-019①：截断保留窗口可能劈开多字节字符——解码前去掉尾部不完整 UTF-8 序列，
    // 绝不产生半个多字节字符（U+FFFD 乱码）。
    const line = decodeUtf8(trimIncompleteUtf8Tail(lineBuf)).replace(/\r$/, '');
    if (droppedBytes > 0) {
      this.truncatedLineCount += 1;
      this.emit('line', line, { truncated: true, droppedBytes });
      return;
    }
    this.emit('line', line);
  }

  consumeStderrChunk(chunk) {
    // V1-019①：与 stdout 同构的截断模式——无换行 chunk 超过 MAX_LINE_BYTES 后
    // 只保留前 MAX 字节，其余丢弃直到换行（内存有界，R11：pending 严格小于注入总量）。
    if (this._stderrTruncating) {
      const nl = chunk.indexOf(NL);
      if (nl === -1) {
        this._stderrDroppedBytes += chunk.length;
        return;
      }
      this._stderrDroppedBytes += nl;
      this._flushTruncatedStderr();
      this.consumeStderrChunk(chunk.subarray(nl + 1));
      return;
    }
    this._stderrPending = Buffer.concat([this._stderrPending, chunk]);
    let nl = this._stderrPending.indexOf(NL);
    while (nl !== -1) {
      this.emitStderrText(decodeUtf8(trimIncompleteUtf8Tail(this._stderrPending.subarray(0, nl))), 0);
      this._stderrPending = this._stderrPending.subarray(nl + 1);
      nl = this._stderrPending.indexOf(NL);
    }
    if (this._stderrPending.length > MAX_LINE_BYTES) {
      this._stderrTruncating = true;
      this._stderrKept = Buffer.from(this._stderrPending.subarray(0, MAX_LINE_BYTES));
      this._stderrDroppedBytes = this._stderrPending.length - MAX_LINE_BYTES;
      this._stderrPending = Buffer.alloc(0);
    }
  }

  _flushTruncatedStderr() {
    this.emitStderrText(decodeUtf8(trimIncompleteUtf8Tail(this._stderrKept)), this._stderrDroppedBytes);
    this._stderrTruncating = false;
    this._stderrKept = null;
    this._stderrDroppedBytes = 0;
  }

  flushStderrRemainder() {
    if (this._stderrTruncating) {
      this._flushTruncatedStderr();
      return;
    }
    if (this._stderrPending.length > 0) {
      this.emitStderrText(decodeUtf8(trimIncompleteUtf8Tail(this._stderrPending)), 0);
      this._stderrPending = Buffer.alloc(0);
    }
  }

  emitStderrText(text, droppedBytes = 0) {
    let line = text.replace(/\r$/, '');
    if (droppedBytes > 0) {
      // 截断标记必须可见（诊断不静默丢字）：行尾附加截断摘要并计数
      this.stderrTruncatedLineCount += 1;
      line = `${line}…[truncated, +${droppedBytes} bytes]`;
    }
    this.appendStderrTail(line);
    this.emit('stderr', line);
  }

  appendStderrTail(line) {
    this.stderrTail = `${this.stderrTail}${line}\n`.slice(-STDERR_TAIL_BYTES);
  }

  sendRawLine(line) {
    if (!this.stdin || !this.stdin.writable) return false;
    try {
      this.stdin.write(`${line.replace(/\r?\n$/, '')}\n`);
      return true;
    } catch {
      // 写入同步抛错（流已销毁等）→ 失败，由调用方决定 ack/事件语义
      return false;
    }
  }

  sendJson(obj) {
    return this.sendRawLine(JSON.stringify(obj));
  }

  get alive() {
    return Boolean(this.child && this.child.exitCode === null && this.child.signalCode === null);
  }

  /**
   * 查询 OS 侧「进程创建时间令牌」（V12-11 PID 复用防护）：
   *   - win32：powershell Get-CimInstance Win32_Process.CreationDate（CIM 时间串原样作令牌）；
   *   - posix：/proc/<pid>/stat 的 starttime（时钟滴答，同一进程实例内稳定）。
   * 同一 PID + 同一创建时间 ⇒ 同一进程实例；PID 被复用后令牌必然不同。
   * 查询失败/超时返回 null（强杀核验退化为 Node 子进程句柄判定，不阻塞停止主语义）。
   * @returns {Promise<string|null>}
   */
  async getProcessCreationTimeToken(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return null;
    if (process.platform === 'win32') {
      return new Promise((resolve) => {
        const script = `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CreationDate`;
        const probe = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
          stdio: ['ignore', 'pipe', 'ignore'],
          windowsHide: true,
        });
        let out = '';
        let settled = false;
        const finish = (token) => { if (!settled) { settled = true; resolve(token); } };
        const timer = setTimeout(() => { try { probe.kill(); } catch { /* ignore */ } finish(null); }, OWNERSHIP_PROBE_TIMEOUT_MS);
        probe.stdout.on('data', (chunk) => { out += chunk.toString('utf8'); });
        probe.on('error', () => { clearTimeout(timer); finish(null); });
        probe.on('exit', () => { clearTimeout(timer); finish(out.trim() || null); });
      });
    }
    try {
      // /proc/<pid>/stat：状态字段含括号包住的 comm（可能含空格），取最后一个 ')' 之后切分；
      //starttime 为第 22 字段 = 去掉 pid/comm 后的第 19 项（0 起）。
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      const afterComm = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/);
      const starttime = afterComm[19];
      return starttime ? String(starttime) : null;
    } catch {
      return null;
    }
  }

  /**
   * 强杀前的归属核验（V12-11 / §8.3「验证创建时间/实例ID防PID复用」）：
   *   ① 归属身份存在且 pid 未漂移；② Node 子进程句柄存活（句柄即实例身份：
   *      已退出的 ChildProcess 不会被复活，复用 PID 的无关进程过不了这关）。
   * @returns {boolean}
   */
  verifyOwnership() {
    if (!this.ownership || !this.child) return false;
    if (this.ownership.pid !== this.child.pid) return false;
    if (!this.alive) return false;
    return true;
  }

  /**
   * 等待真实退出（V1-019⑤ 停止证据）：返回是否在 ms 内观察到 exit。
   * 'error' 路径也发 'exit'（见 start），此处一并覆盖。
   */
  _waitForExit(ms) {
    return new Promise((resolve) => {
      if (!this.alive) return resolve(true);
      const onExit = () => { clearTimeout(timer); this.removeListener('exit', onExit); resolve(true); };
      const timer = setTimeout(() => { this.removeListener('exit', onExit); resolve(false); }, Math.max(0, ms));
      this.on('exit', onExit);
    });
  }

  /**
   * 停止子进程，结果与实际退出严格一致（V1-019⑤ / V1-015③）：
   *   - never-started / already-exited / stdin-eof：进程确认不再运行（exited=true）；
   *   - force-killed：killTree 后仍在 forceExitWaitMs 内观察到真实退出（exited=true）；
   *   - survived：强制停止后进程仍存活（exited=false）——如实上报失败，不假装停止成功。
   * 附带退出证据：code/signal，Windows 强制路径附带 taskkill 退出码（taskkill 失败可见）。
   */
  async stop() {
    if (!this.child) return { stopped: true, reason: 'never-started', exited: true, code: null, signal: null };
    if (!this.alive) {
      return {
        stopped: true,
        reason: 'already-exited',
        exited: true,
        code: this.child.exitCode,
        signal: this.child.signalCode,
      };
    }
    try { this.stdin?.end(); } catch { /* ignore */ }

    const graceful = await this._waitForExit(this.stopGraceMs);
    if (graceful) {
      return {
        stopped: true,
        reason: 'stdin-eof',
        exited: true,
        code: this.child.exitCode,
        signal: this.child.signalCode,
      };
    }

    const killed = await this.killTree();
    // V12-11：归属核验拒绝（疑似 PID 复用/实例身份不匹配）→ 绝不强杀，如实上报
    // 'ownership-unverified'（进程树只终止本次启动拥有的实例，宁可少杀不可误杀）。
    if (killed?.ownership_rejected) {
      const exited = await this._waitForExit(this.forceExitWaitMs);
      return {
        stopped: exited,
        reason: 'ownership-unverified',
        exited,
        code: exited ? this.child.exitCode : null,
        signal: exited ? this.child.signalCode : null,
      };
    }
    const exited = await this._waitForExit(this.forceExitWaitMs);
    return {
      stopped: exited,
      reason: exited ? 'force-killed' : 'survived',
      exited,
      code: exited ? this.child.exitCode : null,
      signal: exited ? this.child.signalCode : null,
      ...(killed && killed.taskkill_exit_code != null ? { taskkill_exit_code: killed.taskkill_exit_code } : {}),
    };
  }

  /**
   * 强制终止进程树。返回 { taskkill_exit_code? , ownership_rejected? }：
   *  - V12-11 归属核验（实例身份/创建时间令牌）不通过 → { ownership_rejected: true }，
   *    绝不向疑似 PID 复用的无关进程发 taskkill（§8.3「不按进程名杀用户其他会话」的同族边界）；
   *  - Windows：taskkill /T /F 的真实退出码（null=spawn 失败；非 0=taskkill 报告失败，
   *    例如权限不足——调用方 stop() 仍会等待真实退出并如实上报 survived）；
   *  - POSIX：进程组 SIGTERM → 2s 宽限 → SIGKILL 升级，并等待真实退出后才返回。
   */
  async killTree() {
    if (!this.child || this.child.pid == null) return { taskkill_exit_code: null };
    if (!this.verifyOwnership()) return { ownership_rejected: true, taskkill_exit_code: null };
    // 创建时间令牌核验：spawn 期与强杀前两侧都拿得到才比对；任一侧缺失退化为句柄判定
    // （查询失败不阻塞停止主语义——stdin EOF 优雅路径已先行尝试）。
    const expectedToken = this.ownership.createTimeToken;
    if (expectedToken) {
      const currentToken = await this.getProcessCreationTimeToken(this.child.pid);
      if (currentToken !== expectedToken) {
        return { ownership_rejected: true, taskkill_exit_code: null };
      }
      // 拿到实时令牌后进程可能刚退出：核验句柄仍在，才继续强杀
      if (!this.verifyOwnership()) return { ownership_rejected: true, taskkill_exit_code: null };
    }
    if (process.platform === 'win32') {
      const taskkillExitCode = await new Promise((resolve) => {
        const killer = spawn('taskkill', ['/T', '/F', '/PID', String(this.child.pid)], { stdio: 'ignore', windowsHide: true });
        killer.on('error', () => resolve(null));
        killer.on('exit', (code) => resolve(code));
      });
      return { taskkill_exit_code: taskkillExitCode };
    }
    // posix：对进程组整树 SIGTERM，2s 宽限后 SIGKILL 升级，并等待真实退出
    // （只 kill 直接子进程会漏掉孙进程，Rust 系 CLI 还可能忽略 SIGTERM）。
    const signalGroup = (sig) => { try { process.kill(-this.child.pid, sig); } catch { /* 已退出 */ } };
    signalGroup('SIGTERM');
    await new Promise((resolve) => {
      const timer = setTimeout(() => { signalGroup('SIGKILL'); resolve(); }, 2000);
      this.child.once('exit', () => { clearTimeout(timer); resolve(); });
      if (!this.alive) { clearTimeout(timer); resolve(); }
    });
    return {};
  }
}

/**
 * 去掉 Buffer 尾部不完整的 UTF-8 序列（V1-019① Unicode 截断边界）：
 * 截断保留窗口按字节切割，可能劈开多字节字符——直接 toString 会产生 U+FFFD。
 * 返回子缓冲（可能原样返回），保证尾部是完整码点边界。
 */
function trimIncompleteUtf8Tail(buf) {
  if (!buf || buf.length === 0) return buf;
  const end = buf.length;
  for (let i = 1; i <= 3 && i <= end; i += 1) {
    const b = buf[end - i];
    if (b < 0x80) return buf; // ASCII 结尾：完整
    if (b >= 0xC0) {
      // 找到 lead byte：其后应有 need 个续字节，实际只有 i-1 个
      const need = b >= 0xF0 ? 3 : b >= 0xE0 ? 2 : 1;
      return need > i - 1 ? buf.subarray(0, end - i) : buf;
    }
    // 0x80..0xBF 续字节：继续向前找 lead（最多 4 字节序列，3 步内必达）
  }
  return buf; // 末尾 3 字节全是续字节 → 4 字节序列完整（lead 在 end-4）
}

function decodeUtf8(buffer) {
  return Buffer.isBuffer(buffer) ? buffer.toString('utf8') : String(buffer);
}

// TASK-012：stderr 诊断脱敏——截断 + 去凭据形态内容后才允许作为错误诊断事件回流。
// 匹配常见凭据形态（API key/token/Bearer/密码赋值），只替换值不保留原文。
const CREDENTIAL_PATTERNS = [
  [/sk-[A-Za-z0-9_-]{6,}/g, 'sk-***'],
  [/gh[pousr]_[A-Za-z0-9]{6,}/g, 'gh_***'],
  [/Bearer\s+[A-Za-z0-9._~+/=-]{6,}/gi, 'Bearer ***'],
  [/(\b(?:api[_-]?key|token|secret|password|passwd|authorization)\b\s*[=:：]\s*)("[^"]*"|'[^']*'|\S+)/gi, '$1***'],
];

export function sanitizeDiagnosticText(raw, maxChars = 500) {
  let text = typeof raw === 'string' ? raw : (() => {
    try { return JSON.stringify(raw) ?? String(raw); } catch { return String(raw); }
  })();
  for (const [pattern, replacement] of CREDENTIAL_PATTERNS) {
    text = text.replace(pattern, replacement);
  }
  text = text.replace(/\s+/g, ' ').trim();
  if (text.length > maxChars) text = `${text.slice(0, maxChars)}…`;
  return text;
}
