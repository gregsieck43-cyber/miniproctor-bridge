/** Version-pinned native host. No credential, native reasoning or raw log goes to stdout. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import readline from 'node:readline';
import { pathToFileURL } from 'node:url';
import { deriveComateLocalAuth, installComateHttpGuard } from './comate-local-auth.js';
import { ComateSessionApi } from './comate-session-api.js';
import { verifyComateNativeRuntime } from './comate-runtime.js';
import { installComateConfigGuard } from './comate-config-guard.js';

const wire = process.stdout.write.bind(process.stdout);
let license = '';
let localAuth = '';
function emit(type, fields = {}) {
  let line = JSON.stringify({ protocol: 'comate-local-api-v1', type, ...fields });
  for (const secret of [license, localAuth]) if (secret) line = line.split(secret).join('[redacted]');
  wire(line + '\n');
}
// Upstream may print raw stream or account diagnostics. Keep both native streams local.
for (const stream of [process.stdout, process.stderr]) stream.write = (chunk, encoding, callback) => {
  const cb = typeof encoding === 'function' ? encoding : callback;
  if (typeof cb === 'function') queueMicrotask(cb);
  return true;
};

let api = null;
let stopRequested = false;
let stopPromise = null;
let shuttingDown = false;
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
function requestStop() {
  stopRequested = true;
  if (api && !stopPromise) stopPromise = api.stop().then((result) => {
    emit('stop_result', result);
    return result;
  });
}
input.on('line', (line) => {
  if (Buffer.byteLength(line) > 4096) return;
  let frame; try { frame = JSON.parse(line); } catch { return; }
  if (frame?.type === 'control_stop') requestStop();
});
input.on('close', () => { if (!shuttingDown) requestStop(); });

let nativeStarted = false;
async function main() {
  const configPath = process.env.COMATE_BRIDGE_CONFIG;
  const prompt = process.argv[2];
  if (!configPath || !path.isAbsolute(configPath) || typeof prompt !== 'string' || !prompt || prompt.length > 4000) throw new Error('invalid-config');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8').replace(/^\uFEFF/, ''));
  if (![config.root, config.core, config.authFile].every((value) => typeof value === 'string' && path.isAbsolute(value))) throw new Error('invalid-config');
  // Explicit local config owns runtime state; never use the vendor's ambient home.
  if (fs.realpathSync(path.dirname(path.dirname(configPath))).toLowerCase() !== fs.realpathSync(config.root).toLowerCase()) throw new Error('invalid-state-root');
  const { core } = verifyComateNativeRuntime(config.core);
  const login = JSON.parse(fs.readFileSync(config.authFile, 'utf8'));
  if (login.platform !== 'SAAS' || typeof login.license !== 'string' || !login.license) throw new Error('saas-login-required');
  license = login.license;
  localAuth = deriveComateLocalAuth(license, crypto.randomBytes(32).toString('hex'));
  const cid = `comate_${crypto.randomUUID()}`;
  const root = path.join(fs.realpathSync(config.root), 'runs', cid);
  const dirs = {
    HOME: 'home', USERPROFILE: 'home', APPDATA: 'appdata', LOCALAPPDATA: 'localappdata',
    TEMP: 'temp', TMP: 'temp', TMPDIR: 'temp', XDG_CONFIG_HOME: 'home', XDG_DATA_HOME: 'state',
    XDG_CACHE_HOME: 'cache', XDG_STATE_HOME: 'state', NODE_COMPILE_CACHE: 'node-cache',
    npm_config_cache: 'npm-cache',
  };
  for (const [key, relative] of Object.entries(dirs)) {
    const directory = path.join(root, relative);
    fs.mkdirSync(directory, { recursive: true });
    process.env[key] = directory;
  }
  Object.assign(process.env, {
    IDE: 'zulucli', IS_CLI: 'true', PLATFORM: 'saas', COMATE_VARIANT: 'saas',
    COMATE_AUTH_DIR: path.join(root, 'home', '.cot'), COMATE_CLIENT_VERSION: '2.0.0',
    COMATE_CLIENT_TYPE: '@comate/comatecli', COMATE_CLIENT_SCENE: 'cli',
  });
  installComateConfigGuard(); // Native serve enables MCP; Ask alone does not suppress startup commands.
  const guard = installComateHttpGuard(localAuth);
  const { runCli } = await import(pathToFileURL(core).href);
  const boot = runCli({ argv: ['serve', '--host', '127.0.0.1', '--port', '0', '--license', license],
    binaryName: 'comatecli', binaryLabel: 'Comate of Terminal', binaryVersion: '2.0.0' });
  // Observe the owned server handle, never a global port scan or another user's PID file.
  const server = await Promise.race([
    (async () => {
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        const candidate = guard.servers.find((item) => item.listening);
        if (candidate) return candidate;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error('native-start-timeout');
    })(),
    boot.then(() => { throw new Error('native-start-failed'); }),
  ]);
  nativeStarted = true;
  const address = server.address();
  if (!address || address.address !== '127.0.0.1') throw new Error('invalid-native-listener');
  api = new ComateSessionApi({
    origin: `http://127.0.0.1:${address.port}`, localAuth, license, conversationId: cid,
    cwd: process.cwd(), prompt,
    onFrame(frame) {
      if (frame.type === 'terminal') return; // Emit terminal after pending cancel/history verification.
      emit(frame.type, frame);
    },
  });
  emit('ready', { conversation_id: cid, port: address.port });
  if (stopRequested) requestStop();
  const result = await api.run();
  const stop = stopPromise ? await stopPromise : null;
  if (result.status === 'not-started' && stop?.confirmed) emit('stopped', { native_cancelled: false, reason: 'not-started' });
  else if (result.status === 'cancelled' && stop?.confirmed) emit('stopped', { native_cancelled: true, reason: 'native-cancelled' });
  else if (result.status === 'completed') emit('finished');
  else throw new Error('native-terminal-not-confirmed');
  shuttingDown = true;
  input.close();
  await new Promise((resolve) => wire('', resolve));
  process.emit('SIGINT'); // Official shutdown, after the native conversation has reached its terminal.
}

main().catch(async () => {
  emit('error', { code: 'comate-native-failed', message: 'Comate 本机控制链路失败；未宣称原生取消成功' });
  await new Promise((resolve) => wire('', resolve));
  if (nativeStarted) process.emit('SIGINT');
  else process.exit(2);
});
