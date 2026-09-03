import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './lib/config.js';
import { SessionSequencer } from './lib/events.js';
import { SessionManager } from './agent/session-manager.js';
import { buildDoctorReport } from './lib/doctor.js';
import { resolveCommandPath } from './lib/command-resolve.js';
import { lineToEvent } from './adapters/generic.js';
import { HttpPollTransport } from './transport/http-poll.js';
import { WssTransport } from './transport/wss.js';
import { CloudGatewayTransport } from './transport/cloud-gateway.js';
import { EndpointTransport } from './transport/endpoint.js';
import { createPairingOffer } from './pairing/pair.js';
import { loadAgentConfig } from './lib/agent-config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEMO_AGENT = path.resolve(__dirname, '../demo/demo-agent.mjs');

export async function main(argv = process.argv.slice(2)) {
  const [command = 'doctor', ...rest] = argv;
  if (command === 'doctor') return doctor(rest);
  if (command === 'pair') return pair(rest);
  if (command === 'run') return runSession(rest);
  if (command === 'demo') return runSession(['--command', process.execPath, '--arg', DEMO_AGENT, '--relay-url', 'http://127.0.0.1:8790', '--max-run-ms', '10000']);
  console.error(`unknown command: ${command}`);
  console.error('usage: node src/main.js [doctor|pair|run|demo]');
  process.exitCode = 2;
  return { ok: false, reason: 'unknown-command' };
}

async function doctor(args = []) {
  const checkAgent = !args.includes('--no-check-agent');
  const config = loadConfig();
  const state = loadDeviceState(config);
  const agentConfig = loadAgentConfig(config.agent.cwd);
  const out = buildDoctorReport({
    config,
    paired: Boolean(state),
    deviceId: state?.device_id || null,
    agentConfig: {
      source: agentConfig.source,
      miniproctor: agentConfig.miniproctor,
      ui: Boolean(agentConfig.ui),
    },
    // 真实探测：win32 走 where、posix 走 which（5s 超时）；--no-check-agent 可跳过
    checkAgent,
    probe: (command) => resolveCommandPath(command, { cwd: config.agent.cwd }),
  });
  console.log(JSON.stringify(out, null, 2));
  return out;
}

async function pair(args) {
  const config = loadConfig();
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--relay-url') config.relay.baseUrl = args[i + 1];
    if (args[i] === '--device-id') config.bridge.deviceName = args[i + 1];
    if (args[i] === '--max-wait-ms') config.bridge.maxWaitMs = Number(args[i + 1]);
  }
  const maxWaitMs = config.bridge.maxWaitMs || 10 * 60 * 1000;
  const offer = createPairingOffer({ deviceId: config.bridge.deviceName });
  const transport = makeTransport(config, {
    deviceId: config.bridge.deviceName,
    tokenHash: offer.token_hash,
    privateKey: offer.private_key,
  });

  const registered = await makeTransport(config, {
    deviceId: config.bridge.deviceName,
    tokenHash: offer.token_hash,
    privateKey: offer.private_key,
  }).registerPairing(offer);
  if (!registered.ok) return { ok: false, reason: 'register-pairing-failed', response: registered };

  console.log('[pairing] waiting for phone');
  console.log(`[pairing] code=${offer.pairing_code}`);
  console.log(`[pairing] url=miniproctor://bind?pairing_id=${offer.pairing_id}&nonce=${offer.nonce}`);

  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1000));
    const status = await transport.pairingStatus(offer.pairing_id);
    if (status?.data?.status === 'bound') {
      const state = {
        device_id: offer.device_id,
        device_name: config.bridge.deviceName,
        token_hash: offer.token_hash,
        token: offer.token,
        pairing_id: offer.pairing_id,
        public_key: offer.public_key,
        private_key: offer.private_key,
        paired_at: Date.now(),
      };
      saveDeviceState(config, state);
      console.log('[pairing] bound', JSON.stringify({ device_id: state.device_id, paired_at: state.paired_at }));
      return { ok: true, bound: true, device_id: state.device_id };
    }
  }
  return { ok: false, reason: 'pairing-timeout', pairing_id: offer.pairing_id };
}

async function runSession(args) {
  const config = loadConfig();
  let command = config.agent.command;
  let maxRunMs = 0;
  const agentArgs = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--command') command = args[i + 1];
    if (args[i] === '--max-run-ms') maxRunMs = Number(args[i + 1]);
    if (args[i] === '--arg') agentArgs.push(args[i + 1]);
    if (args[i] === '--relay-url') config.relay.baseUrl = args[i + 1];
    // 测试/本地联调用：强制 transport 形态（mock relay 只会说 http-poll 协议）
    if (args[i] === '--relay-kind') config.relay.kind = args[i + 1];
    if (args[i] === '--device-id') config.bridge.deviceName = args[i + 1];
    if (args[i] === '--poll-ms') config.bridge.pollIntervalMs = Number(args[i + 1]);
    if (args[i] === '--push-batch-ms') config.bridge.pushBatchMs = Number(args[i + 1]);
  }
  if (command === 'claude') agentArgs.push(...config.agent.args);

  const agentConfig = loadAgentConfig(config.agent.cwd);
  if (agentConfig.ok) {
    console.log('[agent-config]', JSON.stringify({ source: agentConfig.source, miniproctor: agentConfig.miniproctor, ui_block_present: Boolean(agentConfig.ui) }));
    const poll = agentConfig.miniproctor?.bridge?.poll_interval_ms;
    if (Number.isInteger(poll) && poll > 0) config.bridge.pollIntervalMs = poll;
  }

  const state = loadDeviceState(config);
  const sessionId = `s_${crypto.randomUUID()}`;
  const transport = makeTransport(config, {
    deviceId: state?.device_id || config.bridge.deviceName,
    tokenHash: state?.token_hash || null,
    privateKey: state?.private_key || null,
  });
  if (transport instanceof WssTransport) await transport.connect();
  const manager = new SessionManager({
    transport,
    pollIntervalMs: config.bridge.pollIntervalMs,
    pushBatchMs: Number(config.bridge.pushBatchMs) || 0,
    onEvent: (sid, event) => {
      console.log(`[event ${event.seq}] ${sid} ${event.event_type} ${JSON.stringify(event)}`);
    },
  });
  const session = manager.startSession({ sessionId, agentType: 'generic', command, args: agentArgs, cwd: config.agent.cwd });
  manager.startPolling();
  console.log(`[started] ${sessionId} ${command} ${agentArgs.join(' ')}`);

  let watchdog = null;
  if (Number.isInteger(maxRunMs) && maxRunMs > 0) {
    watchdog = setTimeout(async () => {
      console.warn(`[watchdog] max-run-ms=${maxRunMs} reached, stopping session`);
      await manager.stopAll();
    }, maxRunMs);
    watchdog.unref?.();
  }

  const exitInfo = await new Promise((resolve) => session.runner.once('exit', resolve));
  if (watchdog) clearTimeout(watchdog);
  await manager.stopAll();
  return { ok: exitInfo.code === 0 || exitInfo.code === null, exitInfo };
}

function statePath(config) {
  return path.join(config.bridge.dataDir, 'device.json');
}

/** 按 relay.kind 构造 transport：cloud=AppSecret 网关（开发者自用）；endpoint=公网直连（公开运营，无 AppSecret）；wss/http-poll=自建中继。 */
function makeTransport(config, { deviceId, tokenHash, privateKey }) {
  if (config.relay.kind === 'cloud') {
    return new CloudGatewayTransport({ config, deviceId, tokenHash, privateKey });
  }
  if (config.relay.kind === 'endpoint') {
    return new EndpointTransport({ config, deviceId, tokenHash, privateKey });
  }
  if (config.relay.kind === 'wss') {
    return new WssTransport({ url: config.relay.baseUrl, timeoutMs: config.relay.timeoutMs, tokenHash });
  }
  return new HttpPollTransport({ baseUrl: config.relay.baseUrl, timeoutMs: config.relay.timeoutMs, deviceId, tokenHash });
}

function saveDeviceState(config, state) {
  fs.mkdirSync(config.bridge.dataDir, { recursive: true });
  fs.writeFileSync(statePath(config), JSON.stringify(state, null, 2), 'utf8');
}

function loadDeviceState(config) {
  try {
    return JSON.parse(fs.readFileSync(statePath(config), 'utf8'));
  } catch {
    return null;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (result) => console.log('[done]', JSON.stringify(result)),
    (err) => { console.error(err); process.exitCode = 1; },
  );
}
