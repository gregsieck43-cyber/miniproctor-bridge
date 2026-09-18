import { spawn, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { resolveCommandPath, isCmdShimPath } from '../lib/command-resolve.js';

const DEFAULT_STOP_GRACE_MS = 3000;
const STDERR_TAIL_BYTES = 4096;
const NL = 0x0a; // '\n'
// TASK-012 资源限制：超长单行输出截断（结构上限，内容级脱敏归 TASK-019）。
// 行缓冲以字节计，超过即进入截断模式（丢弃后续字节直到换行），内存上限 = 行上限。
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
  constructor({ command, args = [], cwd, env, stopGraceMs = DEFAULT_STOP_GRACE_MS } = {}) {
    super();
    if (!command) throw new TypeError('AgentRunner requires command');
    this.command = command;
    this.args = [...args];
    this.cwd = cwd || process.cwd();
    this.env = env;
    this.stopGraceMs = stopGraceMs;
    this.child = null;
    this.stdin = null;
    this.stderrTail = '';
    this._stdoutDone = false;
    this._stderrPending = Buffer.alloc(0);
    // stdout 行缓冲（替代 readline：需要行级字节上限以约束超长单行内存占用）
    this._stdoutPending = Buffer.alloc(0);
    this._stdoutTruncating = false;
    this._stdoutKept = null;
    this._stdoutDroppedBytes = 0;
    // 会话级诊断计数：exit 时随 session_exit 事件上报
    this.truncatedLineCount = 0;
    // 启动后写入的诊断信息：解析到的可执行文件路径与启动方式。
    this.resolvedCommand = null;
    this.launchMode = null;
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
    this.child.on('error', (err) => this.emit('exit', { code: null, signal: null, error: err }));
    this.child.on('exit', (code, signal) => {
      this.emit('exit', { code, signal, error: null, stderrTail: this.stderrTail });
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
    const line = decodeUtf8(lineBuf).replace(/\r$/, '');
    if (droppedBytes > 0) {
      this.truncatedLineCount += 1;
      this.emit('line', line, { truncated: true, droppedBytes });
      return;
    }
    this.emit('line', line);
  }

  consumeStderrChunk(chunk) {
    this._stderrPending = Buffer.concat([this._stderrPending, chunk]);
    let nl = this._stderrPending.indexOf(NL);
    while (nl !== -1) {
      this.emitStderrText(decodeUtf8(this._stderrPending.subarray(0, nl)));
      this._stderrPending = this._stderrPending.subarray(nl + 1);
      nl = this._stderrPending.indexOf(NL);
    }
  }

  flushStderrRemainder() {
    if (this._stderrPending.length > 0) {
      this.emitStderrText(decodeUtf8(this._stderrPending));
      this._stderrPending = Buffer.alloc(0);
    }
  }

  emitStderrText(text) {
    const line = text.replace(/\r$/, '');
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

  async stop() {
    if (!this.child) return { stopped: true, reason: 'never-started' };
    if (!this.alive) {
      return { stopped: true, reason: 'already-exited', code: this.child.exitCode, signal: this.child.signalCode };
    }
    try { this.stdin?.end(); } catch { /* ignore */ }

    const exited = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), this.stopGraceMs);
      const onExit = () => { clearTimeout(timer); this.removeListener('exit', onExit); resolve(true); };
      this.on('exit', onExit);
      if (!this.alive) { clearTimeout(timer); this.removeListener('exit', onExit); resolve(true); }
    });

    if (exited) return { stopped: true, reason: 'stdin-eof', code: this.child.exitCode, signal: this.child.signalCode };
    await this.killTree();
    return { stopped: true, reason: 'force-killed', code: this.child.exitCode, signal: this.child.signalCode };
  }

  async killTree() {
    if (!this.child || this.child.pid == null) return;
    if (process.platform === 'win32') {
      await new Promise((resolve) => {
        const killer = spawn('taskkill', ['/T', '/F', '/PID', String(this.child.pid)], { stdio: 'ignore', windowsHide: true });
        killer.on('error', () => resolve());
        killer.on('exit', () => resolve());
      });
      return;
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
  }
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
