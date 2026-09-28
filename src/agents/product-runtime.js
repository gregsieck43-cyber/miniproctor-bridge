/** 本机受信任的产品启动配方；目录条目本身不含可执行参数。 */
import { fileURLToPath } from 'node:url';
import { CAPABILITY_KEYS } from '../adapters/capabilities.js';
import { AIDER_SCRIPT_FLAGS } from '../adapters/aider.js';
import { AGENT_PRESETS } from '../lib/config.js';
import { getCatalogEntry } from './catalog.js';

const RECIPES = Object.freeze({
  'claude-code': Object.freeze({ adapterId: 'claude-code', args: AGENT_PRESETS['claude-code'].args }),
  codex: Object.freeze({ adapterId: 'codex', args: AGENT_PRESETS.codex.args }),
  opencode: Object.freeze({ adapterId: 'generic', args: ['run', '--format', 'json'] }),
  continue: Object.freeze({
    adapterId: 'generic',
    // 1.5.47 --readonly 仍允许 Bash/MCP；--exclude '*' 在 CLI 旗标最高优先级禁全部工具。
    args: ['--exclude', '*', '--silent', '-p', '--format', 'json'],
  }),
  goose: Object.freeze({
    adapterId: 'generic',
    args: ['run', '--no-profile', '--no-session', '--output-format', 'stream-json', '--max-turns', '2', '--text'],
    env: Object.freeze({ GOOSE_MODE: 'chat' }),
  }),
  'qwen-code': Object.freeze({
    adapterId: 'generic',
    args: ['--bare', '--approval-mode', 'default', '--output-format', 'stream-json', '--prompt'],
  }),
  aider: Object.freeze({ adapterId: 'generic', args: [...AIDER_SCRIPT_FLAGS, '--message'] }),
  iflow: Object.freeze({
    adapterId: 'generic',
    args: ['--default', '--stream=false', '--telemetry=false', '--telemetry-log-prompts=false', '--prompt'],
    env: Object.freeze({
      IFLOW_approvalMode: 'default',
      IFLOW_autoAccept: 'false',
      IFLOW_disableAutoUpdate: 'true',
    }),
  }),
  openhands: Object.freeze({
    adapterId: 'generic',
    args: [fileURLToPath(new URL('./openhands-sdk-worker.py', import.meta.url))],
  }),
});

function buildRuntime(agentKey, recipe) {
  // These product recipes have only been verified on Windows.
  if ((agentKey === 'openhands' || agentKey === 'goose' || agentKey === 'continue') && process.platform !== 'win32') return null;
  const entry = getCatalogEntry(agentKey);
  if (!entry || entry.adapter_id !== recipe.adapterId) return null;
  const declared = {};
  const open = {};
  for (const key of CAPABILITY_KEYS) {
    declared[key] = entry.capabilities?.[key] === true;
    open[key] = declared[key] && entry.verification?.[key]?.status === 'verified';
  }
  declared.integrationMode = entry.integration_mode;
  declared.initialPromptChannel = entry.initial_prompt_channel;
  open.integrationMode = entry.integration_mode;
  open.initialPromptChannel = open.create && open.read ? entry.initial_prompt_channel : null;
  return Object.freeze({
    agentKey,
    adapterId: recipe.adapterId,
    args: Object.freeze([...recipe.args]),
    env: Object.freeze({ ...(recipe.env || {}) }),
    declared: Object.freeze(declared),
    open: Object.freeze(open),
  });
}

const RUNTIMES = Object.freeze(Object.fromEntries(
  Object.entries(RECIPES)
    .map(([key, recipe]) => [key, buildRuntime(key, recipe)])
    .filter(([, runtime]) => runtime !== null),
));

export function getProductRuntime(agentKey) {
  return Object.hasOwn(RUNTIMES, agentKey) ? RUNTIMES[agentKey] : null;
}
