import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * P1-A（CLOSE-007）：各 CLI 的默认启动参数集。config.agent 段不再是「Claude 参数
 * 原样保留 + 深度合并」——用户显式提供 args 则原样使用；未提供则按 adapter/command
 * 推断 CLI 类型取对应预设。否则 `{"agent":{"command":"codex"}}` 会把 Claude 的
 * `-p --output-format stream-json …` 混进 codex 命令行，实测必炸
 * （codex: error: unexpected argument '--output-format'；-p 被解析为 --profile）。
 *
 * codex 预设对齐 codex-cli 0.144.1 实测 flags（`codex exec --help` 逐项核对）：
 *   exec                    非交互执行子命令
 *   --json                  stdout 输出 JSONL 事件流（bridge codex adapter 消费）
 *   --sandbox read-only     只读沙箱（bridge 默认取最保守档；需写权限的用户显式覆盖 args）
 *   --skip-git-repo-check   允许非 git 目录（手机授权工作区未必是 git 仓库）
 *   --ephemeral             不落会话文件（会话生命周期由 bridge 管理，隐私最小化）
 *   --color never           防 ANSI 色码污染 JSONL（runner FORCE_COLOR=0 之外的第二道防线）
 * 注意：codex 的初始任务提示需作为最后一个 argv 附加在 args 末尾（bridge 对 codex
 * 关闭 prompt 注入；stdin 语义见 session-manager.js 的 P2-E 注释——必须立即 EOF）。
 */
export const AGENT_PRESETS = Object.freeze({
  'claude-code': Object.freeze({
    command: 'claude',
    args: Object.freeze([
      '-p',
      '--output-format', 'stream-json',
      '--input-format', 'stream-json',
      '--permission-prompt-tool', 'stdio',
      '--replay-user-messages',
    ]),
  }),
  codex: Object.freeze({
    command: 'codex',
    args: Object.freeze([
      'exec',
      '--json',
      '--sandbox', 'read-only',
      '--skip-git-repo-check',
      '--ephemeral',
      '--color', 'never',
    ]),
  }),
  // 未知 CLI 无可推断的参数集——宁空勿错（Claude 参数混进任意 CLI 同样是灾难）。
  generic: Object.freeze({ command: null, args: Object.freeze([]) }),
});

/** 按 command 名推断 agent 类型（参数预设与能力协商的缺省来源）：claude→claude-code，codex→codex，其余 generic。 */
export function inferAgentType(command) {
  const base = path.basename(String(command || '')).toLowerCase().replace(/\.(exe|cmd|bat)$/i, '');
  if (base.includes('claude')) return 'claude-code';
  if (base.includes('codex')) return 'codex';
  return 'generic';
}

const DEFAULTS = Object.freeze({
  bridge: {
    deviceName: crypto.randomUUID().slice(0, 8),
    dataDir: './data',
    pollIntervalMs: 3000,
    pushBatchMs: 5000,
    permissionTimeoutAction: 'deny',
    // TASK-008：审批 deadline（毫秒）——confirm_required 事件注入 payload.deadline，
    // 到期由 bridge 本机默认 deny（permissionTimeoutAction），不依赖手机在线。
    permissionTimeoutMs: 10 * 60 * 1000,
    // TASK-012：远程 create_session 只允许落在本机授权工作区（realpath 校验，D4）。
    // 空列表 = 未授权任何工作区，远程新建一律拒绝；`node src/main.js workspace add <path>` 维护。
    workspaces: [],
    // TASK-012：并发会话上限（远程 create_session 受限；CLI 本地 run 不受限）。
    maxSessions: 8,
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
    command: AGENT_PRESETS['claude-code'].command,
    args: [...AGENT_PRESETS['claude-code'].args],
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
  applyAgentPreset(config, fileConfig && typeof fileConfig === 'object' ? fileConfig.agent : undefined);
  if (process.env.MINIPROCTOR_RELAY_URL) config.relay.baseUrl = process.env.MINIPROCTOR_RELAY_URL;
  if (process.env.MINIPROCTOR_DEVICE_NAME) config.bridge.deviceName = process.env.MINIPROCTOR_DEVICE_NAME;
  if (process.env.MINIPROCTOR_DATA_DIR) config.bridge.dataDir = process.env.MINIPROCTOR_DATA_DIR;
  config.bridge.dataDir = path.resolve(process.cwd(), config.bridge.dataDir);
  return config;
}

/**
 * P1-A：agent 段参数解析（深度合并只应作用于 bridge/relay/wechat 等段；agent.args 是
 * 「命令行整体」，跨 CLI 合并无意义）。判定顺序：
 *   1. 用户显式提供 args（数组，含空数组）→ 原样使用，绝不注入预设；
 *   2. 未提供 → 推断 CLI 类型取预设 args：
 *      - command 显式提供 → 按 command 名推断（跟随实际要拉起的命令）；
 *      - command 未提供而 adapter 显式指向已知 CLI → 取该 CLI 预设（含 command，
 *        避免 adapter=codex 却拉起默认 claude）；
 *      - 全缺省 → 保持 claude-code 预设（产品默认）。
 *   - generic（未知 CLI）无预设 → args=[]（宁空勿错）。
 */
function applyAgentPreset(config, fileAgent) {
  const explicit = fileAgent && typeof fileAgent === 'object' && !Array.isArray(fileAgent) ? fileAgent : {};
  const hasExplicitArgs = Array.isArray(explicit.args);
  const hasExplicitCommand = typeof explicit.command === 'string' && explicit.command.trim() !== '';
  const adapterExplicit = typeof explicit.adapter === 'string' && explicit.adapter && explicit.adapter !== 'auto';
  const presetKey = hasExplicitCommand
    ? inferAgentType(explicit.command)
    : (adapterExplicit && AGENT_PRESETS[explicit.adapter] ? explicit.adapter : inferAgentType(config.agent.command));
  const preset = AGENT_PRESETS[presetKey];
  if (!preset) return;
  if (!hasExplicitArgs) config.agent.args = [...preset.args];
  if (!hasExplicitCommand && adapterExplicit && preset.command) config.agent.command = preset.command;
}
