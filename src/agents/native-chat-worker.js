import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { AgentRunner, MAX_LINE_BYTES } from '../agent/runner.js';
import { NativeChatGateway } from './native-chat-gateway.js';
import { loadParentChatProvider } from './parent-chat-provider.js';

export const NATIVE_CHAT_PROTOCOL = 'miniproctor-native-chat-v1';
export const NATIVE_CHAT_PINS = Object.freeze({
  'claude-code': Object.freeze({ version: '2.1.286 (Claude Code)', bytes: 245092000, sha256: '0b6ecec8edef1ce3069682f696c894d1553239faa6b84e56e167a3ced88fa333' }),
  codex: Object.freeze({ version: 'codex-cli 0.155.1', bytes: 307108144, sha256: 'eba0f32c976667cb9298efafd98513e823eeda7b576a03ec658bb8be8d336316' }),
});
const failure = code => Object.assign(new Error(code), { code });
const inside = (a, b) => { const rel = path.relative(a, b); return rel === '' || rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel); };
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const identifier = value => typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,128}$/u.test(value);
const NATIVE_RESULT_SUBTYPES = new Set(['success', 'error', 'error_during_execution', 'error_max_turns', 'error_max_budget_usd', 'error_max_structured_output_retries']);
const NATIVE_TERMINAL_REASONS = new Set(['completed', 'max_turns', 'tool_deferred', 'aborted_streaming', 'aborted_tools', 'hook_stopped',
  'stop_hook_prevented', 'background_requested', 'blocking_limit', 'rapid_refill_breaker', 'prompt_too_long', 'image_error', 'model_error',
  'api_error', 'malformed_tool_use_exhausted', 'budget_exhausted', 'structured_output_retry_exhausted', 'tool_deferred_unavailable', 'turn_setup_failed']);
const NATIVE_STOP_REASONS = new Set(['end_turn', 'max_tokens', 'stop_sequence', 'tool_use', 'pause_turn', 'refusal', 'tool_deferred']);
const enumDiagnostic = (value, allowed) => value == null ? null : allowed.has(value) ? value : 'unknown';
export function verifyNativeChatPhysicalPath(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || /^(?:\\\\|\/\/)/u.test(value) || /[\u0000-\u001f\u007f"]/u.test(value)) throw failure('native-chat-path-invalid');
  for (let current = path.resolve(value);; current = path.dirname(current)) {
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw failure('native-chat-path-link');
    if (path.dirname(current) === current) break;
  }
}
export function verifyNativeChatExecutable(agent, command) {
  verifyNativeChatPhysicalPath(command);
  const pin = NATIVE_CHAT_PINS[agent];
  if (!pin || !/\.exe$/iu.test(command)) throw failure('native-chat-executable-invalid');
  const stat = fs.statSync(command);
  if (!stat.isFile() || stat.size !== pin.bytes || crypto.createHash('sha256').update(fs.readFileSync(command)).digest('hex') !== pin.sha256) throw failure('native-chat-pin-mismatch');
  return pin;
}
export function verifyNativeChatWorkspaceIsolation(agent, workspace) {
  verifyNativeChatPhysicalPath(workspace);
  if (!fs.statSync(workspace).isDirectory()) throw failure('native-chat-workspace-invalid');
  if (agent !== 'codex') return;
  // CODEX_HOME is isolated, but project config/skills may be discovered in an
  // ancestor. Never load an unreviewed project MCP, hook or credential helper.
  for (let current = path.resolve(workspace);; current = path.dirname(current)) {
    for (const relative of [path.join('.codex', 'config.toml'), path.join('.agents', 'skills')]) {
      if (fs.existsSync(path.join(current, relative))) throw failure('native-chat-discovery-source-denied');
    }
    if (path.dirname(current) === current) break;
  }
}
export function validateNativeChatPrompt(prompt) {
  if (typeof prompt !== 'string' || !prompt.trim() || Buffer.byteLength(prompt) > 16000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(prompt) || Buffer.from(prompt).toString('utf8') !== prompt) throw failure('native-chat-prompt-invalid');
}

/** No ambient provider/auth/config/key-path variables reach the real CLI. */
export function buildNativeChatLaunch({ agent, command, runDir, workspace, baseUrl, childKey, model, ambientEnv = process.env } = {}) {
  for (const value of [command, runDir, workspace]) if (typeof value !== 'string' || !path.isAbsolute(value) || /[\u0000-\u001f\u007f"]/u.test(value) || /^(?:\\\\|\/\/)/u.test(value)) throw failure('native-chat-path-invalid');
  command = path.resolve(command); runDir = path.resolve(runDir); workspace = path.resolve(workspace);
  const roots = [path.dirname(command), runDir, workspace];
  if (!NATIVE_CHAT_PINS[agent] || !/\.exe$/iu.test(command) || roots.some((a, i) => roots.slice(i + 1).some(b => inside(a, b) || inside(b, a)))) throw failure('native-chat-path-invalid');
  const endpoint = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})$/u.exec(baseUrl || '');
  if (!endpoint || Number(endpoint[1]) > 65535 || !/^[0-9a-f]{64}$/u.test(childKey || '') || model !== 'deepseek/deepseek-v4.1-flash') throw failure('native-chat-gateway-invalid');
  const env = {};
  for (const name of ['SystemRoot', 'WINDIR', 'SystemDrive']) if (ambientEnv[name]) env[name] = ambientEnv[name];
  // Do not reuse a user-controlled PATH (Node preload, wrappers, Git hooks, credential helpers).
  if (env.SystemRoot) env.PATH = [path.join(env.SystemRoot, 'System32'), env.SystemRoot, path.join(env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0')].join(path.delimiter);
  Object.assign(env, {
    HOME: path.join(runDir, 'home'), USERPROFILE: path.join(runDir, 'home'),
    APPDATA: path.join(runDir, 'appdata'), LOCALAPPDATA: path.join(runDir, 'localappdata'),
    TEMP: path.join(runDir, 'temp'), TMP: path.join(runDir, 'temp'), TMPDIR: path.join(runDir, 'temp'),
    XDG_CONFIG_HOME: path.join(runDir, 'config'), XDG_CACHE_HOME: path.join(runDir, 'cache'), XDG_DATA_HOME: path.join(runDir, 'state'), XDG_STATE_HOME: path.join(runDir, 'state'),
    npm_config_cache: path.join(runDir, 'cache'), NODE_OPTIONS: '', NODE_PATH: '', NODE_DISABLE_COMPILE_CACHE: '1', NODE_COMPILE_CACHE: '',
    GIT_CONFIG_GLOBAL: 'NUL', GIT_CONFIG_NOSYSTEM: '1', OTEL_TRACES_EXPORTER: 'none',
    DISABLE_AUTOUPDATER: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1',
    // Nonessential outbound traffic fails locally rather than borrowing native identity.
    HTTP_PROXY: 'http://127.0.0.1:1', HTTPS_PROXY: 'http://127.0.0.1:1', ALL_PROXY: 'http://127.0.0.1:1', NO_PROXY: '127.0.0.1',
  });
  if (agent === 'claude-code') {
    Object.assign(env, { CLAUDE_CONFIG_DIR: path.join(runDir, 'config'), ANTHROPIC_API_KEY: childKey, ANTHROPIC_BASE_URL: baseUrl,
      ANTHROPIC_MODEL: model, ANTHROPIC_DEFAULT_OPUS_MODEL: model, ANTHROPIC_DEFAULT_SONNET_MODEL: model, ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
      CLAUDE_CODE_SUBAGENT_MODEL: model, CLAUDE_CODE_MAX_OUTPUT_TOKENS: '512', MAX_THINKING_TOKENS: '0',
      CLAUDE_CODE_MAX_RETRIES: '0', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' });
    return { command, env, args: ['--print', '--verbose', '--output-format', 'stream-json', '--input-format', 'stream-json',
      '--bare', '--restricted', '--tools', '', '--disallowedTools', 'mcp__*', '--strict-mcp-config', '--no-session-persistence',
      '--setting-sources', '', '--disable-slash-commands', '--permission-mode', 'dontAsk', '--model', model] };
  }
  Object.assign(env, { CODEX_HOME: path.join(runDir, 'config'), MINIPROCTOR_NATIVE_PROXY_KEY: childKey });
  const config = [
    'model = ' + JSON.stringify(model), 'model_provider = "miniproctor_parent_chat"',
    'sandbox_mode = "read-only"', 'approval_policy = "never"', 'web_search = "disabled"',
    'model_max_output_tokens = 512', 'model_reasoning_effort = "none"', 'model_reasoning_summary = "none"',
    'cli_auth_credentials_store = "ephemeral"', 'project_doc_max_bytes = 0',
    '[features]', 'shell_tool = false', 'apply_patch_freeform = false', 'multi_agent = false', 'js_repl = false', 'apps = false',
    '[model_providers.miniproctor_parent_chat]', 'name = "CommandCode parent ChatCompletions gateway"',
    'base_url = ' + JSON.stringify(baseUrl + '/v1'), 'wire_api = "responses"',
    'env_key = "MINIPROCTOR_NATIVE_PROXY_KEY"', 'requires_openai_auth = false',
    'request_max_retries = 0', 'stream_max_retries = 0', 'stream_idle_timeout_ms = 45000', '',
  ].join('\n');
  return { command, env, args: ['app-server', '--listen', 'stdio://'], config };
}

/** Public native control boundary. All accepted identities/text/terminals come from CLI frames. */
export class NativeChatControl {
  constructor({ agent, send, model, workspace, onNative = () => {} } = {}) {
    if (!NATIVE_CHAT_PINS[agent] || typeof send !== 'function') throw failure('native-chat-control-invalid');
    Object.assign(this, { agent, send, model, workspace, onNative, identity: null, text: '', terminal: null, stopRequested: false, stopAccepted: false });
    this.pending = new Map(); this.sequence = 0; this.prompt = null; this.resultDiagnostic = null;
  }
  diagnostic() { return this.resultDiagnostic ? { ...this.resultDiagnostic } : null; }
  request(method, params, kind) {
    const id = 'parent-' + ++this.sequence; this.pending.set(id, kind || method);
    if (!this.send({ id, method, params })) throw failure('native-chat-control-send-failed'); return id;
  }
  begin(prompt) {
    validateNativeChatPrompt(prompt); if (this.prompt !== null || this.stopRequested) throw failure('native-chat-single-turn'); this.prompt = prompt;
    if (this.agent === 'claude-code') {
      if (!this.send({ type: 'user', message: { role: 'user', content: prompt } })) throw failure('native-chat-control-send-failed');
    } else this.request('initialize', { clientInfo: { name: 'miniproctor_parent_chat', version: '1.0' }, capabilities: { experimentalApi: false } });
  }
  stop() {
    if (this.stopRequested || this.terminal) return false;
    this.stopRequested = true; return this.interrupt();
  }
  interrupt() {
    if (!this.identity || this.stopId || !this.stopRequested || this.terminal) return false;
    if (this.agent === 'claude-code') {
      this.stopId = crypto.randomUUID();
      if (!this.send({ type: 'control_request', request_id: this.stopId, request: { subtype: 'interrupt' } })) throw failure('native-chat-control-send-failed');
    } else if (this.identity.turnId) this.stopId = this.request('turn/interrupt', { threadId: this.identity.threadId, turnId: this.identity.turnId });
    return Boolean(this.stopId);
  }
  accept(raw) {
    if (!object(raw)) throw failure('native-chat-protocol-invalid');
    if (this.agent === 'claude-code') return this.claude(raw);
    if (Object.hasOwn(raw, 'id') && !raw.method) {
      const kind = this.pending.get(raw.id); if (!kind) return;
      this.pending.delete(raw.id); if (raw.error || !object(raw.result)) throw failure('native-chat-rpc-error');
      if (kind === 'initialize') {
        if (!this.send({ method: 'initialized', params: {} })) throw failure('native-chat-control-send-failed');
        if (this.stopRequested) return;
        this.request('thread/start', { model: this.model, modelProvider: 'miniproctor_parent_chat', cwd: this.workspace, approvalPolicy: 'never', sandbox: 'read-only', ephemeral: true });
      } else if (kind === 'thread/start') {
        if (this.identity || !identifier(raw.result.thread?.id) || raw.result.model !== this.model || raw.result.modelProvider !== 'miniproctor_parent_chat') throw failure('native-chat-identity-invalid');
        this.identity = { threadId: raw.result.thread.id, turnId: null };
        this.onNative(raw);
        if (!this.stopRequested) this.request('turn/start', { threadId: this.identity.threadId, model: this.model, effort: 'none', summary: 'none', input: [{ type: 'text', text: this.prompt, text_elements: [] }] });
      } else if (kind === 'turn/start') {
        if (!identifier(raw.result.turn?.id)) throw failure('native-chat-identity-invalid');
        if (this.identity.turnId && this.identity.turnId !== raw.result.turn.id) throw failure('native-chat-identity-invalid');
        this.identity.turnId = raw.result.turn.id; this.onNative(raw); this.interrupt();
      } else if (kind === 'turn/interrupt') { this.stopAccepted = true; this.onNative(raw); }
      return;
    }
    if (Object.hasOwn(raw, 'id') && raw.method) throw failure('native-chat-tool-request-denied');
    const params = raw.params || {};
    if (['turn/started', 'turn/completed', 'item/started', 'item/completed', 'item/agentMessage/delta'].includes(raw.method)) {
      if (!this.identity || params.threadId !== this.identity.threadId) throw failure('native-chat-identity-invalid');
      const turnId = params.turnId || params.turn?.id;
      if (!identifier(turnId) || this.identity.turnId && turnId !== this.identity.turnId) throw failure('native-chat-identity-invalid');
      if (!this.identity.turnId) this.identity.turnId = turnId;
      if (raw.method === 'turn/completed') {
        if (this.terminal || !['completed', 'interrupted', 'failed'].includes(params.turn.status)) throw failure('native-chat-terminal-invalid');
        this.terminal = params.turn.status;
      } else if (raw.method === 'item/completed') {
        if (!['agentMessage', 'userMessage', 'reasoning'].includes(params.item?.type)) throw failure('native-chat-tool-output-denied');
        if (params.item.type === 'agentMessage') { if (typeof params.item.text !== 'string') throw failure('native-chat-protocol-invalid'); this.text += params.item.text; }
      } else if (raw.method === 'item/started' && !['agentMessage', 'userMessage', 'reasoning'].includes(params.item?.type)) throw failure('native-chat-tool-output-denied');
      this.onNative(raw); this.interrupt(); return;
    }
    if (typeof raw.method === 'string' && raw.method.startsWith('item/') && !raw.method.startsWith('item/reasoning/')) throw failure('native-chat-tool-output-denied');
    if (raw.method === 'error' && params.willRetry !== false) throw failure('native-chat-native-error');
  }
  claude(raw) {
    if (raw.type === 'system' && raw.subtype === 'init') {
      if (this.identity || !identifier(raw.session_id) || raw.model !== this.model || !Array.isArray(raw.tools) || raw.tools.length) throw failure('native-chat-identity-invalid');
      this.identity = { sessionId: raw.session_id }; this.onNative(raw); this.interrupt();
    } else if (raw.type === 'assistant') {
      if (!this.identity || raw.session_id && raw.session_id !== this.identity.sessionId || !Array.isArray(raw.message?.content)) throw failure('native-chat-identity-invalid');
      for (const part of raw.message.content) { if (part.type !== 'text' || typeof part.text !== 'string') throw failure('native-chat-tool-output-denied'); this.text += part.text; }
      this.onNative(raw);
    } else if (raw.type === 'result') {
      if (this.terminal === 'completed' || raw.session_id && raw.session_id !== this.identity?.sessionId) throw failure('native-chat-terminal-invalid');
      const terminalBefore = this.terminal;
      this.terminal = raw.subtype === 'success' && raw.is_error === false ? 'completed' : 'failed';
      this.resultDiagnostic = Object.freeze({ result_subtype: NATIVE_RESULT_SUBTYPES.has(raw.subtype) ? raw.subtype : 'unknown',
        result_is_error: typeof raw.is_error === 'boolean' ? raw.is_error : null, terminal_before_result: terminalBefore,
        terminal_after_result: this.terminal, interrupt_accepted_before_result: this.stopAccepted,
        terminal_reason: enumDiagnostic(raw.terminal_reason, NATIVE_TERMINAL_REASONS), stop_reason: enumDiagnostic(raw.stop_reason, NATIVE_STOP_REASONS),
        api_error_status: Number.isInteger(raw.api_error_status) && raw.api_error_status >= 100 && raw.api_error_status <= 599 ? raw.api_error_status : null,
        // Parent-derived category, not a field claimed to originate from the CLI.
        // Admit observed absent API status or explicit null, never masked invalid values.
        native_cancel_kind: this.stopRequested && this.stopAccepted && terminalBefore === 'interrupt-accepted' && this.terminal === 'failed'
          && raw.subtype === 'error_during_execution' && raw.is_error === true && raw.terminal_reason === 'aborted_streaming'
          && raw.stop_reason === null && (!Object.hasOwn(raw, 'api_error_status') || raw.api_error_status === null) ? 'matched-interrupt-aborted-streaming' : null });
      this.onNative(raw);
    } else if (raw.type === 'control_response') {
      if (this.stopId && raw.response?.request_id === this.stopId && raw.response.subtype === 'success') { this.stopAccepted = true; if (!this.terminal) this.terminal = 'interrupt-accepted'; this.onNative(raw); }
    } else if (raw.type === 'control_request') throw failure('native-chat-tool-request-denied');
    // control_cancel_request only cancels approval; it never confirms turn interruption.
  }
}

export function classifyNativeChatOutcome({ agent, nativeVersion, nativeDiagnostic, nativeSignal, runtimeSealed = false, controllerRequested, stopAccepted, terminal, nativeClosed, nativeExitCode, ownedVerified, remainingOwned, forced, gateway, wasProviderActive = false, text = '', textMatchesUpstream = false, error = null } = {}) {
  const closed = nativeClosed === true && ownedVerified === true && remainingOwned === 0 && !forced && gateway?.closed === true && gateway.active === 0;
  if (!closed || error) return 'failed';
  // Only the pinned CC contract was observed to report a streaming interrupt as
  // failed/exit1. Preserve both raw values; this exception never applies to Codex.
  const streamingInterrupt = agent === 'claude-code' && nativeVersion === NATIVE_CHAT_PINS['claude-code'].version
    && terminal === 'failed' && nativeExitCode === 1 && nativeSignal === null && forced === false && runtimeSealed === true
    && nativeDiagnostic?.native_cancel_kind === 'matched-interrupt-aborted-streaming'
    && nativeDiagnostic.result_subtype === 'error_during_execution' && nativeDiagnostic.result_is_error === true
    && nativeDiagnostic.terminal_before_result === 'interrupt-accepted' && nativeDiagnostic.terminal_after_result === 'failed'
    && nativeDiagnostic.interrupt_accepted_before_result === true && nativeDiagnostic.terminal_reason === 'aborted_streaming'
    && nativeDiagnostic.stop_reason === null && nativeDiagnostic.api_error_status === null;
  if (controllerRequested === true) return stopAccepted === true
    && (streamingInterrupt || nativeExitCode === 0 && ['interrupted', 'interrupt-accepted'].includes(terminal))
    && wasProviderActive === true && gateway.contacted === 1 && gateway.aborted === 1 && gateway.failed === 1 && gateway.rejected === 0
    && gateway.successful === 0 ? 'cancelled' : 'failed';
  return nativeExitCode === 0 && terminal === 'completed' && text.trim() && textMatchesUpstream && gateway.contacted === 1 && gateway.successful === 1 && gateway.failed === 0 && gateway.rejected === 0 ? 'completed' : 'failed';
}

export class NativeChatRunner extends AgentRunner {
  buildChildEnv() { return { ...this.env, LANG: 'en_US.UTF-8', FORCE_COLOR: '0', NO_COLOR: '1' }; }
}
async function bounded(promise, timeout) {
  let timer; try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(failure('native-chat-close-timeout')), timeout); })]); }
  finally { clearTimeout(timer); }
}
function sealRuntime(runDir, provider, nonce) {
  const pending = [runDir]; let files = 0, bytes = 0, masked = 0;
  while (pending.length) {
    const file = pending.pop(); verifyNativeChatPhysicalPath(file); const stat = fs.lstatSync(file);
    if (stat.isDirectory()) { for (const name of fs.readdirSync(file)) pending.push(path.join(file, name)); continue; }
    if (!stat.isFile() || ++files > 4000 || (bytes += stat.size) > 32 * 1024 * 1024) throw failure('native-chat-runtime-scan-limit');
    const data = fs.readFileSync(file); if (provider.containsSecret(data)) throw failure('native-chat-secret-persisted');
    if (data.includes(Buffer.from(nonce))) { const text = data.toString('utf8'); if (!Buffer.from(text).equals(data)) throw failure('native-chat-token-binary'); fs.writeFileSync(file, text.split(nonce).join('[EXPIRED_LOCAL_PROXY_NONCE]')); masked++; }
  }
  return { files, bytes, provider_key_matches: 0, expired_nonce_files: masked };
}

function nativeEvidence(agent, raw) {
  // Preserve only native identity/control/outcome evidence. Vendor CLI accounting
  // (including custom-model $0 defaults) is not authoritative provider usage.
  if (agent === 'claude-code') {
    if (raw.type === 'system') return { type: raw.type, subtype: raw.subtype, session_id: raw.session_id, model: raw.model, tools: raw.tools };
    if (raw.type === 'assistant') return { type: raw.type, session_id: raw.session_id, message: { id: raw.message.id, role: raw.message.role, content: raw.message.content, stop_reason: raw.message.stop_reason } };
    if (raw.type === 'result') return { type: raw.type, subtype: raw.subtype, is_error: raw.is_error, session_id: raw.session_id };
    return { type: raw.type, response: { subtype: raw.response?.subtype, request_id: raw.response?.request_id } };
  }
  if (raw.result?.thread) return { id: raw.id, result: { thread: { id: raw.result.thread.id }, model: raw.result.model, modelProvider: raw.result.modelProvider } };
  if (raw.result?.turn) return { id: raw.id, result: { turn: { id: raw.result.turn.id, status: raw.result.turn.status } } };
  if (raw.result) return { id: raw.id, result: {} };
  if (raw.params?.item?.type === 'reasoning') return null;
  return raw;
}

/** Runs only the pinned official CLI, never an SDK/model/identity substitute. */
export async function runNativeChat({ agent, command, runDir, workspace, prompt, signal, emit = () => {}, env = process.env } = {}) {
  validateNativeChatPrompt(prompt);
  const provider = loadParentChatProvider({ env });
  if (!provider?.configured || process.platform !== 'win32' || process.arch !== 'x64') throw failure('native-chat-platform-provider-required');
  const pin = verifyNativeChatExecutable(agent, command);
  const gateway = new NativeChatGateway({ format: agent === 'claude-code' ? 'messages' : 'responses', provider });
  const launch = buildNativeChatLaunch({ agent, command, runDir, workspace, childKey: gateway.childKey, baseUrl: 'http://127.0.0.1:1', model: provider.model, ambientEnv: env });
  for (const p of [runDir, workspace]) verifyNativeChatPhysicalPath(p);
  verifyNativeChatWorkspaceIsolation(agent, workspace);
  if (fs.existsSync(runDir) && (!fs.statSync(runDir).isDirectory() || fs.readdirSync(runDir).length)) throw failure('native-chat-runtime-not-empty');
  fs.mkdirSync(runDir, { recursive: true });
  for (const name of ['home', 'appdata', 'localappdata', 'temp', 'config', 'cache', 'state']) fs.mkdirSync(path.join(runDir, name));
  let runner, control, exit = null, closePromise, closeTask = null, admission = null, error = null, forced = false, stopRequested = false, wasProviderActive = false, upstream = null, sealed = null, nativeStop = null, timer;
  const owned = [], lifecycle = []; const lifecycleStarted = Date.now(); let lifecycleSuppressed = 0, closeTrigger = null;
  const recordLife = (event, fields = {}) => {
    if (lifecycle.length >= 24) { lifecycleSuppressed++; return; }
    lifecycle.push({ sequence: lifecycle.length + 1, elapsed_ms: Math.max(0, Date.now() - lifecycleStarted), event, ...fields });
  };
  const safeEmit = frame => {
    const value = { protocol: NATIVE_CHAT_PROTOCOL, agent, ...frame }, serialized = JSON.stringify(value);
    if (Buffer.byteLength(serialized) >= MAX_LINE_BYTES || provider.containsSecret(serialized) || serialized.includes(gateway.childKey)) throw failure('native-chat-output-invalid');
    emit(value);
  };
  const capture = async () => {
    const rows = await runner.getWindowsProcessTreeSnapshot();
    if (!runner.windowsProcessTreeIsOwned(rows)) throw failure('native-chat-ownership-unverified');
    const ids = new Set([runner.child.pid]);
    for (let changed = true; changed;) { changed = false; for (const row of rows) if (ids.has(row.parent) && !ids.has(row.pid)) { ids.add(row.pid); changed = true; } }
    for (const row of rows.filter(row => ids.has(row.pid))) if (!owned.some(old => old.pid === row.pid && old.birth === row.birth)) owned.push(row);
  };
  const closeNative = (trigger = 'unspecified') => {
    if (closeTask) return closeTask;
    closeTrigger = ['unspecified', 'native-terminal', 'interrupt-receipt', 'stop-grace'].includes(trigger) ? trigger : 'unknown';
    recordLife('native-close-requested', { trigger: closeTrigger, terminal: control?.terminal || null });
    closeTask = (async () => {
      if (!runner?.child) return { exited: true, code: null, tree_verified: false, remaining_owned_instances: 0, reason: 'not-started' };
      let treeVerified = false;
      try { await admission; if (runner.alive) await capture(); treeVerified = owned.length > 0; } catch { error ||= 'native-chat-ownership-unverified'; }
      if (runner.alive) { recordLife('native-stdin-eof', { terminal: control?.terminal || null }); try { runner.stdin.end(); } catch {} }
      try { await bounded(closePromise, 4500); }
      catch { forced = true; const stopped = await runner.stop(); if (!stopped.exited) error ||= 'native-chat-native-not-exited'; try { await bounded(closePromise, 4000); } catch {} }
      const rows = await runner.getWindowsProcessTreeSnapshot();
      const remaining = Array.isArray(rows) ? rows.filter(row => owned.some(old => old.pid === row.pid && old.birth === row.birth)).length : null;
      return { exited: Boolean(exit) && !runner.alive && treeVerified && remaining === 0, code: exit?.code ?? null, signal: exit?.signal ?? null,
        tree_verified: treeVerified && Array.isArray(rows), owned_processes: owned.length, owned_instances: owned, remaining_owned_instances: remaining, forced, reason: forced ? 'forced' : 'native-shutdown' };
    })(); closeTask.catch(() => {}); return closeTask;
  };
  const abort = () => {
    stopRequested = signal?.reason?.code === 'native-chat-stop'; wasProviderActive ||= gateway.summary().active > 0;
    if (!stopRequested) error ||= 'native-chat-controller-error';
    try { control?.stop(); } catch { error ||= 'native-chat-control-send-failed'; }
    recordLife('controller-stop', { controller_requested: stopRequested, provider_was_active: wasProviderActive });
    // Native interrupt goes first. Its real request/socket closure aborts the
    // upstream via the gateway's disconnect handler; finally closes the server.
    // Closing HTTP first could turn a valid native interrupt into a network failure.
    if (!stopRequested) gateway.close().catch(() => {});
    if (control?.stopId) setTimeout(() => closeNative('stop-grace').catch(() => {}), 300).unref();
    else { gateway.close().catch(() => {}); closeNative().catch(() => {}); }
  };
  signal?.addEventListener('abort', abort, { once: true });
  gateway.on('request-started', event => safeEmit({ type: 'provider', state: 'active', ...event, provider: provider.provider, model: provider.model }));
  gateway.on('request-ended', event => safeEmit({ type: 'provider', state: 'settled', ...event }));
  gateway.on('request-refused', event => safeEmit({ type: 'provider', state: 'refused', ...event, provider: provider.provider, model: provider.model }));
  gateway.on('completion', value => { upstream = value; });
  try {
    if (signal?.aborted) throw failure('native-chat-stop-before-start');
    const baseUrl = new URL(await gateway.start()).origin;
    const ready = buildNativeChatLaunch({ agent, command, runDir, workspace, childKey: gateway.childKey, baseUrl, model: provider.model, ambientEnv: env });
    if (ready.config) fs.writeFileSync(path.join(ready.env.CODEX_HOME, 'config.toml'), ready.config);
    runner = new NativeChatRunner({ command: ready.command, args: ready.args, cwd: workspace, env: ready.env });
    control = new NativeChatControl({ agent, send: raw => runner.sendJson(raw), model: provider.model, workspace, onNative: raw => {
      const evidence = nativeEvidence(agent, raw);
      if (evidence) safeEmit({ type: 'native', raw: evidence });
      if (raw.type === 'control_response' && control.stopAccepted) recordLife('native-interrupt-receipt');
      if (raw.type === 'result') recordLife('native-result', control.diagnostic() || {});
      if (control.terminal === 'completed' || control.terminal === 'failed' || control.terminal === 'interrupted') closeNative('native-terminal').catch(() => {});
      else if (control.stopAccepted) closeNative('interrupt-receipt').catch(() => {});
    } });
    runner.on('line', (line, metadata) => {
      try { if (metadata?.truncated || provider.containsSecret(line) || line.includes(gateway.childKey)) throw failure('native-chat-output-invalid'); control.accept(JSON.parse(line)); }
      catch (e) { error ||= /^native-chat-[a-z-]+$/u.test(e.code || '') ? e.code : 'native-chat-protocol-invalid'; gateway.close().catch(() => {}); closeNative().catch(() => {}); }
    });
    runner.on('stderr', line => { if (provider.containsSecret(line) || line.includes(gateway.childKey)) { error ||= 'native-chat-secret-output'; gateway.close().catch(() => {}); closeNative().catch(() => {}); } });
    runner.on('stdin-error', () => { error ||= 'native-chat-control-send-failed'; closeNative().catch(() => {}); });
    closePromise = new Promise(resolve => runner.once('io-close', value => {
      exit = value; recordLife('native-io-close', { code: value.code, signal: value.signal ?? null }); resolve();
    }));
    timer = setTimeout(() => { error ||= 'native-chat-task-timeout'; gateway.close().catch(() => {}); closeNative().catch(() => {}); }, 45000); timer.unref();
    runner.start(); admission = capture(); await admission;
    if (signal?.aborted) abort(); else control.begin(prompt);
    await closePromise;
  } catch (e) { error ||= /^native-chat-[a-z-]+$/u.test(e.code || '') ? e.code : 'native-chat-worker-failed'; }
  finally {
    signal?.removeEventListener('abort', abort); clearTimeout(timer);
    try { nativeStop = await closeNative(); } catch { error ||= 'native-chat-native-close-failed'; nativeStop = { exited: false, tree_verified: false }; }
    await gateway.close();
    if (nativeStop.exited) { try { sealed = sealRuntime(runDir, provider, gateway.childKey); verifyNativeChatExecutable(agent, command); } catch (e) { error ||= e.code || 'native-chat-seal-failed'; } }
  }
  const counts = gateway.summary();
  const status = classifyNativeChatOutcome({ agent, nativeVersion: pin.version, nativeDiagnostic: control?.diagnostic(), nativeSignal: nativeStop.signal,
    runtimeSealed: sealed?.provider_key_matches === 0, controllerRequested: stopRequested, stopAccepted: control?.stopAccepted === true, terminal: control?.terminal,
    nativeClosed: nativeStop.exited, nativeExitCode: nativeStop.code, ownedVerified: nativeStop.tree_verified, remainingOwned: nativeStop.remaining_owned_instances,
    forced, wasProviderActive, gateway: counts, text: control?.text || '', textMatchesUpstream: Boolean(upstream && upstream.text === control?.text), error: error || (!sealed ? 'native-chat-runtime-unsealed' : null) });
  const result = { type: 'result', status, error_code: status === 'failed' ? error || 'native-chat-proof-incomplete' : null,
    native_version: pin.version, native_identity: control?.identity || null, native_terminal: control?.terminal || null,
    native_diagnostic: { ...(control?.diagnostic() || {}), close_trigger: closeTrigger, lifecycle, lifecycle_suppressed: lifecycleSuppressed },
    cancellation: { controller_requested: stopRequested, native_accepted: control?.stopAccepted === true, provider_was_active: wasProviderActive, upstream_aborted: counts.aborted > 0 },
    native_stop: nativeStop, gateway: counts, runtime: sealed, provider: provider.provider, model: provider.model,
    text: status === 'completed' ? control.text : null, usage: counts.usage };
  safeEmit(result); return { ...result, exitCode: status === 'failed' ? 2 : 0 };
}

async function main() {
  const [agent, launchPrompt] = process.argv.slice(2), controller = new AbortController();
  let used = false, pending = null; const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  const emit = frame => process.stdout.write(JSON.stringify(frame) + '\n');
  const stop = () => controller.abort(failure('native-chat-stop'));
  input.on('close', stop);
  const start = prompt => {
    if (used) throw failure('native-chat-single-turn'); used = true;
    pending = runNativeChat({ agent, command: process.env.MINIPROCTOR_NATIVE_CHAT_EXECUTABLE, runDir: process.env.MINIPROCTOR_NATIVE_CHAT_RUN_DIR,
      workspace: process.cwd(), prompt, signal: controller.signal, emit }).then(result => { process.exitCode = result.exitCode; })
      .catch(() => { emit({ protocol: NATIVE_CHAT_PROTOCOL, agent, type: 'error', code: 'native-chat-worker-failed' }); process.exitCode = 2; })
      .finally(() => { input.removeAllListeners('close'); input.close(); process.stdin.destroy(); });
  };
  input.on('line', line => {
    try {
      if (Buffer.byteLength(line) >= MAX_LINE_BYTES) throw failure('native-chat-input-invalid'); const raw = JSON.parse(line);
      if (raw.type === 'control_stop' && Object.keys(raw).length === 1) stop();
      else if (agent === 'claude-code' && raw.type === 'user' && raw.message?.role === 'user' && typeof raw.message.content === 'string') start(raw.message.content);
      else throw failure('native-chat-input-invalid');
    } catch { controller.abort(failure('native-chat-input-invalid')); if (!pending) { process.exitCode = 2; input.removeAllListeners('close'); input.close(); process.stdin.destroy(); } }
  });
  if (agent === 'codex') { try { start(launchPrompt); } catch { process.exitCode = 2; input.removeAllListeners('close'); input.close(); process.stdin.destroy(); } }
  else if (agent !== 'claude-code' || launchPrompt !== undefined) { process.exitCode = 2; input.removeAllListeners('close'); input.close(); process.stdin.destroy(); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
