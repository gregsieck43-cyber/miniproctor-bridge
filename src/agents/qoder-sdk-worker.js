import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { AgentRunner, MAX_LINE_BYTES } from '../agent/runner.js';
import { sanitizeSensitiveText } from '../lib/events.js';
import { QoderSdkClient, classifyQoderExit, validateQoderPrompt, QODER_CLI_VERSION, QODER_SDK_CONTRACT_VERSION, QODER_MODEL_NAME } from './qoder-sdk-client.js';
export { validateQoderPrompt };
export const QODER_SDK_PROTOCOL = 'miniproctor-qoder-sdk-v1';
export const QODER_PROFILE_VERSION = '1.1.64 / Node 24.16.0 / wire 1.5.0';
export const QODER_ENTRY_SHA256 = '7568b1fadf9e514b5d084178810aeed16e6947ffc7adab94691dc5f4f975df1f';
const failure = code => Object.assign(new Error(code), { code });
const inside = (a, b) => { const r = path.relative(a, b); return r === '' || r !== '..' && !r.startsWith('..' + path.sep) && !path.isAbsolute(r); };
const digest = data => crypto.createHash('sha256').update(data).digest('hex');

export class QoderNativeRunner extends AgentRunner {
  buildChildEnv() { return { ...this.env, LANG: 'en_US.UTF-8', FORCE_COLOR: '0', NO_COLOR: '1' }; }
}

export function buildQoderSdkLaunch({ entry, authConfigDir, runDir, workspace, ambientEnv = process.env } = {}) {
  for (const p of [entry, authConfigDir, runDir, workspace]) if (typeof p !== 'string' || !path.isAbsolute(p) || /[\u0000-\u001f\u007f"]/u.test(p)) throw failure('qoder-launch-path-invalid');
  entry = path.resolve(entry); authConfigDir = path.resolve(authConfigDir); runDir = path.resolve(runDir); workspace = path.resolve(workspace);
  if (path.basename(entry).toLowerCase() !== 'qodercli.js' || path.basename(path.dirname(entry)).toLowerCase() !== 'bundle') throw failure('qoder-entry-invalid');
  const roots = [path.dirname(path.dirname(entry)), authConfigDir, runDir, workspace];
  if (roots.some((a, i) => roots.slice(i + 1).some(b => inside(a, b) || inside(b, a)))) throw failure('qoder-launch-path-invalid');
  const env = {};
  for (const n of ['SystemRoot', 'WINDIR', 'ComSpec', 'COMSPEC', 'SystemDrive', 'PATH', 'PATHEXT', 'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS']) if (ambientEnv[n]) env[n] = ambientEnv[n];
  Object.assign(env, {
    HOME: path.join(runDir, 'home'), USERPROFILE: path.join(runDir, 'home'),
    HOMEDRIVE: path.parse(runDir).root.slice(0, 2), HOMEPATH: path.join(runDir, 'home').slice(2),
    APPDATA: path.join(runDir, 'appdata'), LOCALAPPDATA: path.join(runDir, 'localappdata'),
    TEMP: path.join(runDir, 'temp'), TMP: path.join(runDir, 'temp'), TMPDIR: path.join(runDir, 'temp'),
    XDG_CONFIG_HOME: path.join(runDir, 'config'), XDG_DATA_HOME: path.join(runDir, 'state'), XDG_STATE_HOME: path.join(runDir, 'state'), XDG_CACHE_HOME: path.join(runDir, 'cache'),
    npm_config_cache: path.join(runDir, 'cache'), NODE_DISABLE_COMPILE_CACHE: '1', NODE_COMPILE_CACHE: '', NODE_OPTIONS: '', NODE_PATH: '',
    QODER_CONFIG_DIR: path.join(runDir, 'config'), QODER_AGENT_SDK_ENTRYPOINT: 'sdk-ts', QODER_AGENT_SDK_VERSION: QODER_SDK_CONTRACT_VERSION,
    QODER_SDK_AUTH_PAYLOAD_FILE: path.join(runDir, 'auth-payload.json'), QODER_SDK_AUTH_CONFIG_DIR: authConfigDir,
    BROWSER: 'www-browser', CI: '1', OTEL_TRACES_EXPORTER: 'none',
  });
  const args = [entry, '--print', '--output-format', 'stream-json', '--input-format', 'stream-json',
    '--no-session-persistence', '--model', QODER_MODEL_NAME, '--permission-mode', 'dont_ask', '--tools', '',
    '--permission-prompt-tool', 'stdio', '--strict-mcp-config', '--disable-builtin-skills', '--setting-sources', '',
    '--max-turns', '1', '--max-output-tokens', '512', '--max-model-request-retries', '0', '--include-partial-messages', '--thinking', 'disabled'];
  return { command: process.execPath, args, env };
}

export function verifyQoderPhysicalPath(value) {
  let current = path.resolve(value);
  for (;;) {
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw failure('qoder-runtime-link');
    const parent = path.dirname(current); if (parent === current) break; current = parent;
  }
}
export function verifyQoderEntry(entry) {
  verifyQoderPhysicalPath(entry);
  const stat = fs.statSync(entry);
  if (!stat.isFile() || stat.size !== 33188301 || digest(fs.readFileSync(entry)) !== QODER_ENTRY_SHA256) throw failure('qoder-runtime-pin-mismatch');
  const pkg = JSON.parse(fs.readFileSync(path.join(path.dirname(entry), '..', 'package.json'), 'utf8'));
  if (pkg.name !== '@qoder-ai/qodercli' || pkg.version !== QODER_CLI_VERSION) throw failure('qoder-runtime-version-mismatch');
  return QODER_CLI_VERSION;
}
export function snapshotQoderAuthState(root) {
  const authRoot = path.join(root, '.auth');
  verifyQoderPhysicalPath(authRoot);
  const rows = []; let bytes = 0, directories = 0;
  const walk = dir => {
    if (++directories > 128) throw failure('qoder-auth-state-limit');
    const handle = fs.opendirSync(dir);
    try { for (let e; (e = handle.readSync()) !== null;) {
      const p = path.join(dir, e.name), stat = fs.lstatSync(p);
      if (stat.isSymbolicLink()) throw failure('qoder-auth-link');
      if (stat.isDirectory()) walk(p);
      else {
        if (!stat.isFile()) throw failure('qoder-auth-state-invalid');
        if (rows.length >= 64 || bytes + stat.size > 8 * 1024 * 1024) throw failure('qoder-auth-state-limit');
        const data = fs.readFileSync(p);
        if (data.length !== stat.size) throw failure('qoder-auth-state-changed');
        bytes += data.length;
        rows.push([path.relative(root, p), digest(data)]);
      }
    } } finally { handle.closeSync(); }
  };
  walk(authRoot);
  return digest(JSON.stringify(rows.sort((a, b) => a[0].localeCompare(b[0]))));
}
async function bounded(task, ms) {
  let timer;
  try { return await Promise.race([task, new Promise((_, reject) => { timer = setTimeout(() => reject(failure('qoder-close-timeout')), ms); })]); }
  finally { clearTimeout(timer); }
}

/** No provider key is copied. Native qodercliAuth reads the authorized store read-only. */
export async function runQoderSdk({ entry, authConfigDir, runDir, workspace, prompt, signal, emit = () => {}, ambientEnv = process.env } = {}) {
  validateQoderPrompt(prompt);
  const launch = buildQoderSdkLaunch({ entry, authConfigDir, runDir, workspace, ambientEnv });
  for (const p of [entry, authConfigDir, runDir, workspace]) verifyQoderPhysicalPath(p);
  if (process.platform !== 'win32' || process.versions.node !== '24.16.0') throw failure('qoder-node-version-unverified');
  verifyQoderEntry(entry);
  if (!fs.statSync(workspace).isDirectory() || !fs.statSync(authConfigDir).isDirectory()) throw failure('qoder-launch-path-invalid');
  const originalAuth = snapshotQoderAuthState(authConfigDir);
  if (fs.existsSync(runDir)) {
    if (!fs.statSync(runDir).isDirectory() || fs.readdirSync(runDir).length) throw failure('qoder-runtime-not-empty');
  } else fs.mkdirSync(runDir, { recursive: true });
  for (const name of ['home', 'config', 'appdata', 'localappdata', 'temp', 'state', 'cache']) fs.mkdirSync(path.join(runDir, name));
  fs.writeFileSync(launch.env.QODER_SDK_AUTH_PAYLOAD_FILE, JSON.stringify({ type: 'qodercli' }), { flag: 'wx', mode: 0o600 });
  const safeEmit = value => {
    const frame = { protocol: QODER_SDK_PROTOCOL, ...value };
    if (Buffer.byteLength(JSON.stringify(frame)) >= MAX_LINE_BYTES) throw failure('qoder-output-limit');
    emit(frame);
  };
  let runner, client, closed, exit = null, result = null, error = null, stopTask = null, stop = null;
  let admissionTask = null, closing = false, watchdog, stderrBytes = 0, identity = null, authUnchanged = false;
  const owned = [];
  const capture = async () => {
    const token = runner.ownership.createTimeToken || await runner.getProcessCreationTimeToken(runner.child.pid);
    if (!token || !runner.alive) throw failure('qoder-native-ownership-unverified');
    runner.ownership.createTimeToken = token;
    const rows = await runner.getWindowsProcessTreeSnapshot();
    if (!runner.windowsProcessTreeIsOwned(rows) || rows.find(r => r.pid === runner.child.pid)?.birth !== token) throw failure('qoder-native-ownership-unverified');
    const ids = new Set([runner.child.pid]);
    for (let changed = true; changed;) { changed = false; for (const r of rows) if (ids.has(r.parent) && !ids.has(r.pid)) { ids.add(r.pid); changed = true; } }
    for (const r of rows.filter(r => ids.has(r.pid))) if (!owned.some(o => o.pid === r.pid && o.birth === r.birth)) owned.push(r);
  };
  const closeNative = () => {
    if (stopTask) return stopTask;
    if (!runner?.child) return Promise.resolve({ exited: true, code: null, tree_verified: true, owned_processes: 0, owned_instances: [], remaining_owned_instances: 0, reason: 'not-started' });
    closing = true;
    stopTask = (async () => {
      let tree = false, forced = null;
      try { await admissionTask; tree = owned.length > 0; } catch { tree = false; }
      if (runner.alive && signal?.aborted && client?.userSent && !['complete', 'cancelled', 'failed', 'closed'].includes(client.phase)) {
        try { await bounded(client.interrupt(), 5000); } catch { error ||= 'qoder-native-interrupt-unverified'; }
        try { if (turnTask) result = await bounded(turnTask, 5000); } catch { /* Exact terminal evidence is checked after IO close. */ }
      }
      if (runner.alive && !runner.stdin.writableEnded) runner.stdin.end();
      try { await bounded(closed, 5000); }
      catch { forced = await runner.stop(); try { await bounded(closed, 5000); } catch {} }
      const rows = await runner.getWindowsProcessTreeSnapshot();
      if (!Array.isArray(rows)) tree = false;
      const remaining = Array.isArray(rows) ? rows.filter(r => owned.some(o => r.pid === o.pid && r.birth === o.birth)).length : null;
      return { exited: !runner.alive && Boolean(exit) && tree && remaining === 0, code: exit?.code ?? null, signal: exit?.signal ?? null,
        tree_verified: tree, owned_processes: owned.length, owned_instances: owned, remaining_owned_instances: remaining,
        reason: forced?.reason || 'sdk-stdio-close', forced: Boolean(forced && ['force-killed', 'survived'].includes(forced.reason)) };
    })();
    stopTask.catch(() => {}); return stopTask;
  };
  const stopReason = () => !signal?.reason?.code || signal.reason.code === 'qoder-stop';
  const abort = () => { if (!stopReason()) error = /^qoder-[a-z-]{1,64}$/u.test(signal.reason.code || '') ? signal.reason.code : 'qoder-input-invalid'; void closeNative(); };
  signal?.addEventListener('abort', abort, { once: true });
  let turnTask = null;
  try {
    if (signal?.aborted) throw failure('qoder-stop');
    runner = new QoderNativeRunner({ command: launch.command, args: launch.args, cwd: workspace, env: launch.env });
    client = new QoderSdkClient({ send: frame => runner.sendJson(frame), endInput: () => {
      if (runner.alive && !runner.stdin.writableEnded) runner.stdin.end();
    } });
    client.on('failed', e => {
      const intentionalEarlyClose = closing && signal?.aborted && stopReason() && !client.userSent && e.code === 'qoder-process-closed';
      if (!intentionalEarlyClose) error ||= e.code;
      if (!closing) void closeNative();
    });
    client.on('accepted', data => {
      if (!owned.length || !data.sessionId || identity) { error ||= 'qoder-native-identity'; void closeNative(); return; }
      identity = data.sessionId;
      safeEmit({ type: 'started', native_session_id: identity, native_version: QODER_CLI_VERSION, native_protocol: '1.5.0' });
    });
    client.on('model-stream-started', () => safeEmit({ type: 'provider', state: 'streaming' }));
    runner.on('line', (line, meta) => {
      if (meta?.truncated) { error ||= 'qoder-native-output-limit'; void closeNative(); }
      else client.acceptLine(line);
    });
    runner.on('stderr', text => { stderrBytes += Buffer.byteLength(text); if (stderrBytes > 128 * 1024) { error ||= 'qoder-native-log-limit'; void closeNative(); } });
    closed = new Promise(resolve => runner.once('io-close', info => {
      exit = info;
      if (!['complete', 'cancelled', 'failed', 'closed'].includes(client.phase)) client.close();
      resolve();
    }));
    runner.start(); admissionTask = capture(); admissionTask.catch(() => {});
    watchdog = setTimeout(() => { error ||= 'qoder-task-timeout'; void closeNative(); }, 120000); watchdog.unref();
    await client.initialize({ nativePid: runner.child.pid });
    await admissionTask;
    if (signal?.aborted) throw failure('qoder-stop');
    turnTask = client.prompt(prompt); turnTask.catch(() => {});
    result = await turnTask;
  } catch (e) {
    const earlyStop = signal?.aborted && stopReason() && (!client?.userSent || e.code === 'qoder-stop');
    if (!earlyStop) error ||= /^qoder-[a-z-]{1,64}$/u.test(e.code || '') ? e.code : 'qoder-worker-failed';
  } finally {
    signal?.removeEventListener('abort', abort); clearTimeout(watchdog);
    try { stop = await closeNative(); } catch { stop = { exited: false, tree_verified: false }; error ||= 'qoder-native-close-failed'; }
    client?.removeAllListeners('failed'); client?.close();
    if (stop.exited) {
      try { authUnchanged = originalAuth === snapshotQoderAuthState(authConfigDir); verifyQoderEntry(entry); }
      catch { error ||= 'qoder-runtime-final-verification-failed'; }
    }
    if (!stop.exited) error ||= 'qoder-native-not-exited';
    if (!authUnchanged) error ||= 'qoder-auth-state-changed';
  }
  const nativeStatus = classifyQoderExit(result, exit);
  const early = signal?.aborted && stopReason() && !client?.userSent && !client?.modelCallsAllowed && stop.exited;
  const complete = !error && stop.exited && !stop.forced && nativeStatus === 'completed';
  const cancelled = !error && stop.exited && (nativeStatus === 'cancelled' && !stop.forced || early);
  if (!complete && !cancelled && !error) error = 'qoder-native-incomplete';
  if (complete) safeEmit({ type: 'message', text: sanitizeSensitiveText(result.text) });
  const outcome = { type: 'result', status: complete ? 'completed' : cancelled ? 'cancelled' : 'failed', error_code: error,
    native_admission: identity ? 'accepted' : 'not-accepted', native_session_id: identity,
    native_stop: stop, model_calls_allowed: client?.modelCallsAllowed || 0,
    cancellation: { verified: result?.interruptVerified === true, command_cancelled: result?.cancelledCommand === true,
      kind: result?.cancelKind || (early ? 'before-prompt' : null), terminal_reason: result?.terminalReason || null,
      operation_aborted: result?.operationAborted === true },
    auth_files_unchanged: authUnchanged, tool_count: 0 };
  safeEmit(outcome);
  return { ...outcome, exitCode: outcome.status === 'failed' ? 2 : 0 };
}

async function main() {
  const control = new AbortController();
  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  const stop = () => control.abort(failure('qoder-stop'));
  input.on('close', stop);
  input.on('line', line => { try { const frame = JSON.parse(line);
    if (Buffer.byteLength(line) > 1024 || frame.type !== 'control_stop' || Object.keys(frame).length !== 1) throw failure('qoder-input-invalid');
    stop();
  } catch { control.abort(failure('qoder-input-invalid')); } });
  const emit = frame => process.stdout.write(JSON.stringify(frame) + '\n');
  try {
    if (process.argv.length !== 3) throw failure('qoder-prompt-invalid');
    const outcome = await runQoderSdk({ entry: process.env.MINIPROCTOR_QODER_ENTRY, authConfigDir: process.env.MINIPROCTOR_QODER_AUTH_DIR,
      runDir: process.env.MINIPROCTOR_QODER_RUN_DIR, workspace: process.cwd(), prompt: process.argv[2], signal: control.signal, emit });
    process.exitCode = outcome.exitCode;
  } catch (e) { emit({ protocol: QODER_SDK_PROTOCOL, type: 'error', code: /^qoder-[a-z-]{1,64}$/u.test(e.code || '') ? e.code : 'qoder-worker-failed' }); process.exitCode = 2; }
  finally { input.removeAllListeners('close'); input.close(); process.stdin.destroy(); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
