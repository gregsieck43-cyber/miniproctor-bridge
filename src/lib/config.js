import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const DEFAULTS = Object.freeze({
  bridge: {
    deviceName: crypto.randomUUID().slice(0, 8),
    dataDir: './data',
    pollIntervalMs: 3000,
    pushBatchMs: 5000,
    permissionTimeoutAction: 'deny',
  },
  relay: {
    kind: 'http-poll',
    baseUrl: 'http://127.0.0.1:8790',
    timeoutMs: 5000,
  },
  wechat: {
    appid: 'TEST_APPID',
    secret: '',
    envId: '',
  },
  agent: {
    adapter: 'auto',
    command: 'claude',
    args: [
      '-p',
      '--output-format', 'stream-json',
      '--input-format', 'stream-json',
      '--permission-prompt-tool', 'stdio',
      '--replay-user-messages',
    ],
    cwd: '.',
  },
});

function merge(base, override = {}) {
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value && typeof value === 'object' && !Array.isArray(value) && base && typeof base[key] === 'object' && !Array.isArray(base[key])) {
      out[key] = merge(base[key], value);
    } else if (value !== undefined) {
      out[key] = value;
    }
  }
  return out;
}

export function loadConfig(configPath = process.env.MINIPROCTOR_CONFIG || 'config.json') {
  let fileConfig = {};
  if (fs.existsSync(configPath)) {
    fileConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  }
  const config = merge(DEFAULTS, fileConfig);
  if (process.env.MINIPROCTOR_RELAY_URL) config.relay.baseUrl = process.env.MINIPROCTOR_RELAY_URL;
  if (process.env.MINIPROCTOR_DEVICE_NAME) config.bridge.deviceName = process.env.MINIPROCTOR_DEVICE_NAME;
  if (process.env.MINIPROCTOR_DATA_DIR) config.bridge.dataDir = process.env.MINIPROCTOR_DATA_DIR;
  config.bridge.dataDir = path.resolve(process.cwd(), config.bridge.dataDir);
  return config;
}
