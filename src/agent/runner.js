import { spawn, spawnSync } from 'node:child_process';
import readline from 'node:readline';
import { EventEmitter } from 'node:events';
import { resolveCommandPath, isCmdShimPath } from '../lib/command-resolve.js';

const DEFAULT_STOP_GRACE_MS = 3000;
const STDERR_TAIL_BYTES = 4096;
const NL = 0x0a; // '\n'

// cmd.exe 需要的环境防线：防 ANSI 色码污染 stream-json、强制子进程 UTF-8 输出。
const CHILD_ENV_GUARDS = Object.freeze({
  PYTHONIOENCODING: 'utf-8',
  LANG: 'en_US.UTF-8',
  FORCE_COLOR: '0',
});

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

    const rl = readline.createInterface({ input: this.child.stdout });
    rl.on('line', (line) => this.emit('line', line));
    rl.on('close', () => {
      this._stdoutDone = true;
      this.emit('stdout-end');
    });

    // stderr 按 UTF-8 行流处理：多字节字符跨 chunk 边界也不会产生乱码。
    this.child.stderr.on('data', (chunk) => this.consumeStderrChunk(chunk));
    this.child.stderr.on('end', () => this.flushStderrRemainder());
    return this;
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
    this.stdin.write(`${line.replace(/\r?\n$/, '')}\n`);
    return true;
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
    } else {
      try { this.child.kill('SIGTERM'); } catch { /* ignore */ }
    }
  }
}

function decodeUtf8(buffer) {
  return Buffer.isBuffer(buffer) ? buffer.toString('utf8') : String(buffer);
}
