/** 本机受信任的产品启动配方；目录条目本身不含可执行参数。 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CAPABILITY_KEYS, buildOpenCapabilities } from '../adapters/capabilities.js';
import { AIDER_SCRIPT_FLAGS } from '../adapters/aider.js';
import { AGENT_PRESETS } from '../lib/config.js';
import { getCatalogEntry } from './catalog.js';
import { buildJuniePlanLaunch } from './junie-plan-worker.js';
import { buildDshSdkLaunch } from './dsh-sdk-worker.js';

const OPENCLAW_CONFIG_PATH = fileURLToPath(new URL('./openclaw-readonly.json', import.meta.url));
const CODEBUDDY_EMPTY_MCP_PATH = fileURLToPath(new URL('./codebuddy-empty-mcp.json', import.meta.url));
const OPENCLAW_STATE_PLACEHOLDER = '__MINIPROCTOR_OPENCLAW_STATE_DIR__';
// OpenCode 1.18.20 默认多数工具 allow；未接审批时使用显式只读 primary Agent。
// 独立 Agent 权限晚于全局权限合并，项目配置关闭，模型/凭据仍由本机配置提供。
const OPENCODE_READONLY_PERMISSION = Object.freeze({
  '*': 'deny',
  read: { '*': 'allow', '*.env': 'deny', '*.env.*': 'deny', '*auth.json': 'deny', '*credentials*': 'deny' },
  glob: 'allow', grep: 'allow', list: 'allow',
  edit: 'deny', bash: 'deny', task: 'deny', webfetch: 'deny', websearch: 'deny',
  external_directory: 'deny',
});

const RECIPES = Object.freeze({
  'claude-code': Object.freeze({
    adapterId: 'claude-code',
    // 2.1.286：bare 不加载 hooks/插件/项目配置，restricted 限制文件系统/网络；
    // 未验审批前全禁内置工具/MCP，不使用任何权限绕过旗标。
    args: [...AGENT_PRESETS['claude-code'].args, '--bare', '--restricted', '--tools', '',
      '--disallowedTools', 'mcp__*', '--strict-mcp-config', '--no-session-persistence'],
    env: Object.freeze({ DISABLE_AUTOUPDATER: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1' }),
  }),
  codex: Object.freeze({ adapterId: 'codex', args: AGENT_PRESETS.codex.args }),
  opencode: Object.freeze({
    adapterId: 'generic', args: ['run', '--format', 'json', '--agent', 'miniproctor-readonly'],
    env: Object.freeze({
      OPENCODE_DISABLE_PROJECT_CONFIG: '1', OPENCODE_DISABLE_AUTOUPDATE: '1',
      OPENCODE_AUTO_SHARE: 'false',
      OPENCODE_PERMISSION: JSON.stringify(OPENCODE_READONLY_PERMISSION),
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        autoupdate: false, share: 'disabled', permission: OPENCODE_READONLY_PERMISSION,
        agent: { 'miniproctor-readonly': {
          description: 'Read-only workspace analysis without editing, shell, network or subagents.',
          mode: 'primary', permission: OPENCODE_READONLY_PERMISSION,
        } },
      }),
    }),
  }),
  continue: Object.freeze({
    adapterId: 'generic',
    // 1.5.47 --readonly 仍允许 Bash/MCP；--exclude '*' 在 CLI 旗标最高优先级禁全部工具。
    args: ['--exclude', '*', '--silent', '-p', '--format', 'json'],
  }),
  cline: Object.freeze({
    adapterId: 'generic',
    // 3.0.65 缺省自动批准全部工具；非 TTY 下 false 会拒绝需审批的编辑和命令。
    args: ['--auto-approve', 'false', '--json', '--retries', '1', '--timeout', '120', '--'],
    // SDK sandbox 选择与 CLI 同寿命的本地 backend；不等于 OS 权限沙箱。
    env: Object.freeze({ CLINE_SANDBOX: '1', CLINE_LOG_ENABLED: '0' }),
  }),
  'cursor-cli': Object.freeze({
    adapterId: 'generic',
    // 2026.09.26-dd393fe：print 默认可用写入和 Shell；Ask 模式实测只读。
    args: ['-p', '--mode', 'ask', '--output-format', 'stream-json', '--trust'],
  }),
  'kimi-code': Object.freeze({
    adapterId: 'generic',
    // 2.1.1 的 -p 默认 auto；固定只读 Agent 文件约束可用工具，实验引擎使文件策略生效。
    args: ['--agent-file', fileURLToPath(new URL('./kimi-readonly.md', import.meta.url)), '--output-format', 'stream-json', '-p'],
    env: Object.freeze({ KIMI_CODE_EXPERIMENTAL_FLAG: '1' }),
  }),
  openclaw: Object.freeze({
    adapterId: 'generic',
    // 2026.9.6 的临时状态清理在 Windows 会撞 SQLite EBUSY；独立 state-dir 由会话 ID 填入。
    // 固定配置全禁工具，凭据只从 DEEPSEEK_API_KEY 环境引用，不继承 ambient OpenClaw 配置。
    args: ['agent', 'exec', '--config', OPENCLAW_CONFIG_PATH, '--state-dir', OPENCLAW_STATE_PLACEHOLDER,
      '--code-mode', 'direct', '--timeout', '120', '--json'],
    env: Object.freeze({ OPENCLAW_CONFIG_READONLY: '1', OPENCLAW_OFFLINE: '1', OPENCLAW_LOAD_SHELL_ENV: '0' }),
  }),
  'copilot-cli': Object.freeze({
    adapterId: 'generic',
    // 1.0.88：BYOK 离线模式不连接 GitHub；仅暴露只读工具，禁内置 MCP/远程控制。
    args: ['--output-format=json', '--available-tools=view,grep,glob', '--deny-tool=write,shell,url',
      '--no-custom-instructions', '--disable-builtin-mcps', '--no-remote', '--no-remote-export',
      '--no-ask-user', '--disallow-temp-dir', '--secret-env-vars=COPILOT_PROVIDER_API_KEY',
      '--no-color', '-p'],
    env: Object.freeze({
      COPILOT_AUTO_UPDATE: 'false', COPILOT_OFFLINE: 'true',
      COPILOT_PROVIDER_BASE_URL: 'https://api.deepseek.com',
      COPILOT_PROVIDER_TYPE: 'openai', COPILOT_PROVIDER_WIRE_API: 'completions',
      COPILOT_MODEL: 'deepseek-chat',
    }),
  }),
  codebuddy: Object.freeze({
    adapterId: 'generic',
    // 2.159.0：只读工具白名单实测 Read/Glob 可用、Write/Edit/Bash 不可用；无 MCP 和会话持久化。
    args: ['-p', '--output-format', 'stream-json', '--tools', 'Read,Grep,Glob',
      '--permission-mode', 'dontAsk', '--setting-sources', 'user', '--strict-mcp-config',
      '--mcp-config', CODEBUDDY_EMPTY_MCP_PATH, '--no-session-persistence'],
    env: Object.freeze({
      CODEBUDDY_BASE_URL: 'https://api.deepseek.com', CODEBUDDY_MODEL: 'deepseek-flash',
      CODEBUDDY_BIG_SLOW_MODEL: 'deepseek-flash', CODEBUDDY_SMALL_FAST_MODEL: 'deepseek-flash',
      CODEBUDDY_CODE_SUBAGENT_MODEL: 'deepseek-flash', CODEBUDDY_IS_SANDBOX: '0',
      CODEBUDDY_AUTH_TOKEN: '', CODEBUDDY_DISABLE_AUTO_MEMORY: '1',
      CODEBUDDY_CODE_DISABLE_BACKGROUND_TASKS: '1', CODEBUDDY_SKIP_BUILTIN_MARKETPLACE: '1',
      DISABLE_AUTOUPDATER: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1',
      OTEL_TRACES_EXPORTER: 'none',
    }),
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
  aider: Object.freeze({
    adapterId: 'generic', args: [...AIDER_SCRIPT_FLAGS, '--message'],
    // 显式 false 令 Aider 确认默认拒绝，不继承本机环境/配置中的自动同意。
    env: Object.freeze({ AIDER_YES_ALWAYS: 'false' }),
  }),
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
  junie: Object.freeze({
    adapterId: 'generic',
    // Nightly 3596.1: the native executable is frozen by Factory; only this Node
    // worker receives one prompt. It checks Plan/off and denies native approvals.
    args: [fileURLToPath(new URL('./junie-plan-worker.js', import.meta.url))],
  }),
  dsh: Object.freeze({
    adapterId: 'generic',
    args: [fileURLToPath(new URL('./dsh-sdk-worker.js', import.meta.url))],
  }),
});

function buildRuntime(agentKey, recipe) {
  // These product recipes have only been verified on Windows.
  if ((agentKey === 'dsh' || agentKey === 'junie' || agentKey === 'openhands' || agentKey === 'goose' || agentKey === 'continue' || agentKey === 'cline' || agentKey === 'cursor-cli' || agentKey === 'kimi-code' || agentKey === 'openclaw' || agentKey === 'copilot-cli' || agentKey === 'codebuddy') && process.platform !== 'win32') return null;
  const entry = getCatalogEntry(agentKey);
  if (!entry || entry.adapter_id !== recipe.adapterId) return null;
  const declared = {};
  const verified = [];
  for (const key of CAPABILITY_KEYS) {
    declared[key] = entry.capabilities?.[key] === true;
    if (entry.verification?.[key]?.status === 'verified') verified.push(key);
  }
  declared.integrationMode = entry.integration_mode;
  declared.initialPromptChannel = entry.initial_prompt_channel;
  const open = buildOpenCapabilities(declared, verified);
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

/** 只计算本机启动参数；目录由 SessionManager 在工作区授权后创建。 */
export function prepareProductLaunch(spec, { sessionId, dataDir, workspace } = {}) {
  if (spec.agentKey !== 'dsh' && spec.agentKey !== 'junie' && spec.agentKey !== 'openclaw' && spec.agentKey !== 'copilot-cli' && spec.agentKey !== 'codebuddy') {
    return { args: [...spec.args], productEnv: { ...(spec.productEnv || {}) }, stateDir: null };
  }
  if (!/^s_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(sessionId || '')) {
    throw new TypeError('产品 sessionId 非 bridge UUID');
  }
  if (typeof dataDir !== 'string' || !path.isAbsolute(dataDir)) {
    throw new TypeError('产品 dataDir 必须为 bridge 本机绝对路径');
  }
  if (spec.agentKey === 'dsh') {
    const runtime = getProductRuntime('dsh');
    if (!runtime || spec.command !== process.execPath || JSON.stringify(spec.args) !== JSON.stringify(runtime.args)) {
      throw new TypeError('DSH 必须使用固定 Node 单轮 SDK worker');
    }
    const stateDir = path.join(path.resolve(dataDir), 'dsh-runs', sessionId);
    const runDir = path.join(stateDir, 'native');
    // Validate before the create ACK; ownership probes use only the host directory.
    buildDshSdkLaunch({ runDir, workspace, nativeEntry: spec.productEnv?.MINIPROCTOR_DSH_ENTRY,
      childKey: '0'.repeat(64), baseUrl: 'http://127.0.0.1:1/v1/messages', ambientEnv: {} });
    return { args: [...runtime.args], stateDir, productEnv: {
      ...(spec.productEnv || {}), ...runtime.env, MINIPROCTOR_DSH_RUN_DIR: runDir,
      HOME: stateDir, USERPROFILE: stateDir, APPDATA: stateDir, LOCALAPPDATA: stateDir,
      TEMP: stateDir, TMP: stateDir, TMPDIR: stateDir, XDG_CONFIG_HOME: stateDir,
      XDG_CACHE_HOME: stateDir, XDG_DATA_HOME: stateDir, XDG_STATE_HOME: stateDir,
      NODE_DISABLE_COMPILE_CACHE: '1', NODE_COMPILE_CACHE: '', NODE_OPTIONS: '',
    } };
  }
  if (spec.agentKey === 'junie') {
    const runtime = getProductRuntime('junie');
    if (!runtime || spec.command !== process.execPath || JSON.stringify(spec.args) !== JSON.stringify(runtime.args)) {
      throw new TypeError('Junie 必须使用固定 Node 单轮 Plan worker');
    }
    const stateDir = path.join(path.resolve(dataDir), 'junie-runs', sessionId);
    // Windows ownership probes may create a host AppData skeleton. Keep that
    // host state outside the new native runtime's strict empty-directory gate.
    const runDir = path.join(stateDir, 'native');
    // Validate runtime/workspace separation before directory creation or create ACK.
    buildJuniePlanLaunch({ runDir, workspace, nativeExecutable: spec.productEnv?.MINIPROCTOR_JUNIE_EXECUTABLE,
      childKey: '0'.repeat(64), baseUrl: 'http://127.0.0.1:1/v1/chat/completions', ambientEnv: {} });
    return { args: [...runtime.args], stateDir, productEnv: {
      ...(spec.productEnv || {}), ...runtime.env, MINIPROCTOR_JUNIE_RUN_DIR: runDir,
      HOME: stateDir, USERPROFILE: stateDir, APPDATA: stateDir, LOCALAPPDATA: stateDir,
      TEMP: stateDir, TMP: stateDir, TMPDIR: stateDir, XDG_CONFIG_HOME: stateDir,
      XDG_CACHE_HOME: stateDir, XDG_DATA_HOME: stateDir, XDG_STATE_HOME: stateDir,
      NODE_DISABLE_COMPILE_CACHE: '1', NODE_COMPILE_CACHE: '', NODE_OPTIONS: '',
    } };
  }
  if (spec.agentKey === 'codebuddy') {
    const runtime = getProductRuntime('codebuddy');
    if (!runtime || JSON.stringify(spec.args) !== JSON.stringify(runtime.args)) {
      throw new TypeError('CodeBuddy CLI 必须使用固定只读启动配方');
    }
    const stateDir = path.join(path.resolve(dataDir), 'codebuddy-runs', sessionId);
    return {
      args: [...runtime.args], stateDir,
      productEnv: {
        ...(spec.productEnv || {}), ...runtime.env,
        HOME: stateDir, USERPROFILE: stateDir, APPDATA: stateDir, LOCALAPPDATA: stateDir,
        XDG_CONFIG_HOME: stateDir, XDG_CACHE_HOME: stateDir, XDG_DATA_HOME: stateDir,
        TEMP: stateDir, TMP: stateDir,
        NODE_COMPILE_CACHE: path.join(path.resolve(dataDir), 'codebuddy-node-cache'),
      },
    };
  }
  if (spec.agentKey === 'copilot-cli') {
    const runtime = getProductRuntime('copilot-cli');
    if (!runtime || JSON.stringify(spec.args) !== JSON.stringify(runtime.args)) {
      throw new TypeError('Copilot CLI 必须使用固定只读启动配方');
    }
    const stateDir = path.join(path.resolve(dataDir), 'copilot-runs', sessionId);
    return {
      args: [...runtime.args], stateDir,
      productEnv: {
        ...(spec.productEnv || {}), ...runtime.env,
        COPILOT_HOME: path.join(stateDir, 'home'),
        COPILOT_CACHE_HOME: path.join(path.resolve(dataDir), 'copilot-cache'),
        HOME: stateDir, USERPROFILE: stateDir, APPDATA: stateDir, LOCALAPPDATA: stateDir,
        XDG_CONFIG_HOME: stateDir, TEMP: stateDir, TMP: stateDir,
        NODE_COMPILE_CACHE: path.join(path.resolve(dataDir), 'copilot-node-cache'),
      },
    };
  }
  if (!spec.args.includes(OPENCLAW_STATE_PLACEHOLDER)) {
    throw new TypeError('OpenClaw 启动配方缺少状态目录占位符');
  }
  const stateDir = path.join(path.resolve(dataDir), 'openclaw-runs', sessionId);
  const args = spec.args.map((arg) => arg === OPENCLAW_STATE_PLACEHOLDER ? stateDir : arg);
  const productEnv = {
    ...(spec.productEnv || {}),
    OPENCLAW_HOME: stateDir,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_CONFIG_PATH,
    HOME: stateDir,
    USERPROFILE: stateDir,
    APPDATA: stateDir,
    LOCALAPPDATA: stateDir,
    XDG_CONFIG_HOME: stateDir,
    TEMP: stateDir,
    TMP: stateDir,
    NODE_COMPILE_CACHE: stateDir,
  };
  return { args, productEnv, stateDir };
}
