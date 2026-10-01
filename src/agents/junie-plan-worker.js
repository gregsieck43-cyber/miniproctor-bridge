import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline';
import { AgentRunner, MAX_LINE_BYTES } from '../agent/runner.js';
import { sanitizeSensitiveText } from '../lib/events.js';
import { JuniePlanClient } from './junie-plan-client.js';
import { JuniePlanGateway } from './junie-plan-gateway.js';

export const JUNIE_PLAN_PROTOCOL = 'miniproctor-junie-acp-plan-v1';
const failure = code => Object.assign(new Error(code), { code });
const contains = (parent, child) => {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
};

/** Trusted local inputs only; no flags, model URL or executable come from phone payloads. */
export function buildJuniePlanLaunch({ runDir, workspace, nativeExecutable, childKey, baseUrl,
  ambientEnv = process.env, providerKey = null } = {}) {
  for (const value of [runDir, workspace, nativeExecutable]) {
    if (typeof value !== 'string' || !path.isAbsolute(value) || /[\u0000-\u001f\u007f"]/.test(value)) throw failure('junie-launch-path-invalid');
  }
  runDir = path.resolve(runDir); workspace = path.resolve(workspace);
  if (contains(workspace, runDir)) throw failure('junie-runtime-inside-workspace');
  if (typeof childKey !== 'string' || !/^[0-9a-f]{64}$/.test(childKey)
    || typeof baseUrl !== 'string' || !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/v1\/chat\/completions$/.test(baseUrl)) {
    throw failure('junie-local-gateway-invalid');
  }
  const env = { ...ambientEnv };
  for (const name of Object.keys(env)) {
    if (/TOKEN|SECRET|KEY|PASSWORD|CREDENTIAL|AUTH|CONNECTIONSTRING|CONNECTION_STRING|^JUNIE_/i.test(name)
      || ['NODE_OPTIONS', 'JDK_JAVA_OPTIONS', '_JAVA_OPTIONS', 'JAVA_OPTS', 'CLASSPATH'].includes(name.toUpperCase())) env[name] = '';
    else if (typeof providerKey === 'string' && providerKey && typeof env[name] === 'string'
      && env[name].includes(providerKey)) env[name] = '';
  }
  Object.assign(env, {
    MINIPROCTOR_ACP_PROXY_KEY: childKey,
    HOME: path.join(runDir, 'home'), USERPROFILE: path.join(runDir, 'home'),
    APPDATA: path.join(runDir, 'appdata'), LOCALAPPDATA: path.join(runDir, 'localappdata'),
    TEMP: path.join(runDir, 'temp'), TMP: path.join(runDir, 'temp'), TMPDIR: path.join(runDir, 'temp'),
    XDG_CONFIG_HOME: path.join(runDir, 'home'), XDG_CACHE_HOME: path.join(runDir, 'cache'),
    XDG_DATA_HOME: path.join(runDir, 'state'), XDG_STATE_HOME: path.join(runDir, 'state'),
    npm_config_cache: path.join(runDir, 'cache'), NODE_DISABLE_COMPILE_CACHE: '1', NODE_COMPILE_CACHE: '',
    JUNIE_HOME: path.join(runDir, 'state'),
    JAVA_TOOL_OPTIONS: `-Duser.home="${path.join(runDir, 'home')}" -Djava.io.tmpdir="${path.join(runDir, 'temp')}" -Dfile.encoding=UTF-8 -Dstdout.encoding=UTF-8 -Dstderr.encoding=UTF-8`,
  });
  return {
    command: nativeExecutable,
    args: ['--acp', 'true', '--skip-update-check', '--share-anonymous-statistics', 'false',
      '--cache-dir', path.join(runDir, 'cache'), '--config-default-locations', 'false',
      '--model-default-locations', 'false', '--model-location', path.join(runDir, 'models'),
      '--mcp-default-locations', 'false', '--skill-default-locations', 'false',
      '--command-default-location', 'false', '--agent-default-location', 'false',
      '--extensions-default-location', path.join(runDir, 'extensions'),
      '--agent-mode', 'chat', '--model', 'custom:deepseek', '--project', workspace],
    env,
    model: { id: 'deepseek-flash', displayName: 'Miniproctor Junie single-turn Plan', providerName: 'DeepSeek',
      baseUrl, apiType: 'OpenAICompletion', apiKey: '${MINIPROCTOR_ACP_PROXY_KEY}',
      maxContextLength: 131072, extraBody: { thinking: { type: 'disabled' } } },
  };
}

function assertPhysicalPath(value) {
  let current = path.resolve(value);
  while (true) {
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw failure('junie-runtime-link');
    const parent = path.dirname(current); if (parent === current) break; current = parent;
  }
}

function createRun(runDir, workspace, nativeExecutable) {
  for (const value of [runDir, workspace, nativeExecutable]) assertPhysicalPath(value);
  if (!fs.statSync(workspace).isDirectory() || !fs.statSync(nativeExecutable).isFile()) throw failure('junie-launch-path-invalid');
  if (fs.existsSync(runDir)) {
    if (!fs.statSync(runDir).isDirectory() || fs.readdirSync(runDir).length) throw failure('junie-runtime-not-empty');
  } else fs.mkdirSync(runDir, { recursive: true });
  for (const name of ['home', 'appdata', 'localappdata', 'temp', 'cache', 'state', 'models', 'extensions']) {
    fs.mkdirSync(path.join(runDir, name));
  }
}

/** Only this new owned runtime is visited, after native exit and gateway closure. */
function sealExpiredKey(runDir, childKey, providerKey) {
  const pending = [runDir]; let files = 0, bytes = 0, masked = 0;
  while (pending.length) {
    const current = pending.pop(), stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) throw failure('junie-runtime-link');
    if (stat.isDirectory()) { for (const name of fs.readdirSync(current)) pending.push(path.join(current, name)); continue; }
    if (++files > 4000 || (bytes += stat.size) > 32 * 1024 * 1024) throw failure('junie-runtime-scan-limit');
    const raw = fs.readFileSync(current);
    if (raw.includes(Buffer.from(providerKey))) throw failure('junie-provider-key-persisted');
    if (raw.includes(Buffer.from(childKey))) {
      const text = raw.toString('utf8');
      if (!Buffer.from(text).equals(raw)) throw failure('junie-runtime-token-binary');
      fs.writeFileSync(current, text.split(childKey).join('[EXPIRED_LOCAL_PROXY_KEY]')); masked++;
    }
  }
  return { files, bytes, expired_local_tokens_masked: masked, provider_key_matches: 0 };
}

/** Run one actual native prompt. EOF/control_stop cancellation never fabricates completion. */
export async function runJuniePlan({ nativeExecutable, runDir, workspace, providerKey, prompt,
  signal, emit = () => {}, ambientEnv = process.env } = {}) {
  if (process.platform !== 'win32') throw failure('junie-platform-unverified');
  if (typeof prompt !== 'string' || !prompt.trim() || Buffer.byteLength(prompt, 'utf8') > 16000) throw failure('junie-prompt-invalid');
  const gateway = new JuniePlanGateway({ providerKey });
  const launch = buildJuniePlanLaunch({ runDir, workspace, nativeExecutable,
    childKey: gateway.childKey, baseUrl: 'http://127.0.0.1:1/v1/chat/completions', ambientEnv, providerKey });
  createRun(runDir, workspace, nativeExecutable);
  let runner, client, stopPromise, result = null, error = null, stop = null, sealed = null;
  const safeEmit = frame => {
    const clean = JSON.parse(JSON.stringify(frame).split(providerKey).join('[REDACTED_PROVIDER_KEY]')
      .split(gateway.childKey).join('[REDACTED_LOCAL_KEY]'));
    if (Buffer.byteLength(JSON.stringify(clean), 'utf8') > MAX_LINE_BYTES - 1) throw failure('junie-wrapper-output-limit');
    emit({ protocol: JUNIE_PLAN_PROTOCOL, ...clean });
  };
  const stopNative = () => {
    client?.cancel();
    if (runner?.child && !stopPromise) stopPromise = runner.stop().catch(() => ({ exited: false, reason: 'junie-stop-failed' }));
    return stopPromise;
  };
  gateway.on('request-started', event => safeEmit({ type: 'provider', state: 'started', call: event.call }));
  gateway.on('request-ended', event => safeEmit({ type: 'provider', state: 'settled', active: event.active }));
  signal?.addEventListener('abort', stopNative, { once: true });
  try {
    if (signal?.aborted) throw failure('junie-cancelled');
    launch.model.baseUrl = await gateway.start();
    fs.writeFileSync(path.join(runDir, 'models', 'deepseek.json'), JSON.stringify(launch.model, null, 2) + '\n', { flag: 'wx' });
    if (signal?.aborted) throw failure('junie-cancelled');
    runner = new AgentRunner({ command: launch.command, args: launch.args, env: launch.env, cwd: workspace });
    client = new JuniePlanClient({ send: frame => runner.sendJson(frame), maxTextBytes: 32000 });
    client.on('update', update => safeEmit({ type: 'update', update }));
    runner.on('line', line => client.acceptLine(line));
    runner.on('stderr', () => {}); // Raw native logs may contain paths/arguments; not a phone event.
    runner.on('stdin-error', () => {});
    runner.on('io-close', () => client.close());
    runner.start();
    const initialized = await client.initialize(workspace);
    safeEmit({ type: 'started', native_session_id: initialized.sessionId, native_version: initialized.version });
    result = await client.prompt(prompt);
    if (!signal?.aborted && result.stopReason === 'end_turn') safeEmit({ type: 'message', text: sanitizeSensitiveText(result.text) });
  } catch (value) {
    error = typeof value?.code === 'string' && /^junie-[a-z-]+$/.test(value.code) ? value.code : 'junie-worker-failed';
  } finally {
    signal?.removeEventListener('abort', stopNative);
    stop = runner ? await (stopPromise || stopNative()) : { exited: true, code: null, reason: 'not-started' };
    await gateway.close();
    if (stop?.exited) {
      try { sealed = sealExpiredKey(runDir, gateway.childKey, providerKey); }
      catch (value) { error = value.code || 'junie-runtime-seal-failed'; }
    } else error = 'junie-native-not-exited';
  }
  const cancelled = signal?.aborted && (!signal.reason?.code || signal.reason.code === 'junie-stop');
  const counts = gateway.summary();
  const completed = !cancelled && !error && result?.stopReason === 'end_turn' && stop?.exited && stop.code === 0
    && counts.successful > 0 && counts.failed === 0 && counts.rejected === 0 && !counts.quota_exceeded && sealed;
  if (signal?.reason?.code && signal.reason.code !== 'junie-stop') error = signal.reason.code;
  if (!completed && !cancelled && !error) error = 'junie-native-incomplete';
  const outcome = { type: 'result', status: completed ? 'completed' : cancelled && stop?.exited && sealed ? 'cancelled' : 'failed',
    stop_reason: result?.stopReason || null, error_code: error, native_stop: stop, gateway: counts, runtime: sealed };
  safeEmit(outcome);
  return { ...outcome, exitCode: outcome.status === 'failed' ? 2 : 0 };
}

async function main() {
  const control = new AbortController();
  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  const stop = () => control.abort(failure('junie-stop'));
  input.on('close', stop);
  input.on('line', line => {
    try { const frame = JSON.parse(line); if (frame.type === 'control_stop') stop(); else control.abort(failure('junie-input-invalid')); }
    catch { control.abort(failure('junie-input-invalid')); }
  });
  const write = frame => process.stdout.write(JSON.stringify(frame) + '\n');
  try {
    if (process.argv.length !== 3) throw failure('junie-prompt-invalid');
    const result = await runJuniePlan({ nativeExecutable: process.env.MINIPROCTOR_JUNIE_EXECUTABLE,
      runDir: process.env.MINIPROCTOR_JUNIE_RUN_DIR, workspace: process.cwd(), providerKey: process.env.DEEPSEEK_API_KEY,
      prompt: process.argv[2], signal: control.signal, emit: write });
    process.exitCode = result.exitCode;
  } catch (error) {
    write({ protocol: JUNIE_PLAN_PROTOCOL, type: 'error', code: typeof error.code === 'string' && /^junie-[a-z-]+$/.test(error.code) ? error.code : 'junie-worker-failed' });
    process.exitCode = 2;
  } finally { input.removeAllListeners('close'); input.close(); process.stdin.destroy(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
