import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { sanitizeSensitiveText } from '../lib/events.js';

const pin = JSON.parse(fs.readFileSync(fileURLToPath(new URL('./zcode-sdk-pin.json', import.meta.url)), 'utf8'));
const failure = code => Object.assign(new Error(code), { code });
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const maximumEvents = 512;

export function validateZCodePrompt(prompt) {
  if (typeof prompt !== 'string' || !prompt.trim() || /^[!/]/u.test(prompt.trimStart())
    || prompt.includes('\0') || Buffer.byteLength(prompt, 'utf8') > 16000
    || Buffer.from(prompt).toString('utf8') !== prompt) throw failure('zcode-prompt-invalid');
}

function validate(input) {
  for (const p of [input.sourceRoot, input.workspace]) {
    if (typeof p !== 'string' || !path.isAbsolute(p) || /[\u0000-\u001f\u007f"]/u.test(p)) throw failure('zcode-launch-invalid');
  }
  const relative = path.relative(input.workspace, input.sourceRoot);
  if (!relative || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))) throw failure('zcode-launch-invalid');
  if (input.apiFormat !== undefined && !['anthropic-messages', 'openai-chat-completions'].includes(input.apiFormat)) throw failure('zcode-launch-invalid');
  const endpoint = typeof input.baseUrl === 'string' && input.baseUrl.match(/^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})\/v1\/(messages|chat\/completions)$/u);
  if (!endpoint || Number(endpoint[1]) > 65535 || !/^[0-9a-f]{64}$/u.test(input.childKey || '')) throw failure('zcode-launch-invalid');
  if (endpoint[2] !== (input.apiFormat === 'openai-chat-completions' ? 'chat/completions' : 'messages')) throw failure('zcode-launch-invalid');
  validateZCodePrompt(input.prompt);
  if (input.signal?.aborted) throw failure('zcode-stop');
}

/** Frozen official CLI build artifacts. Configuration files cannot choose a module. */
export function verifyPinnedZCodeSource(sourceRoot) {
  if (process.platform !== 'win32' || process.version !== pin.node_version) throw failure('zcode-runtime-unverified');
  return verifyPinnedZCodeArtifacts(sourceRoot);
}

/** Parent verifies vendor bytes without loading the SDK under a different Node. */
export function verifyPinnedZCodeArtifacts(sourceRoot) {
  if (typeof sourceRoot !== 'string' || !path.isAbsolute(sourceRoot)) throw failure('zcode-source-unverified');
  for (let current = path.resolve(sourceRoot); ; current = path.dirname(current)) {
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw failure('zcode-source-link');
    if (path.dirname(current) === current) break;
  }
  const root = fs.realpathSync(sourceRoot);
  if (fs.lstatSync(sourceRoot).isSymbolicLink() || root.toLowerCase() !== path.resolve(sourceRoot).toLowerCase()) throw failure('zcode-source-link');
  for (const [relative, hash] of Object.entries(pin.files)) {
    const file = path.resolve(root, relative), rel = path.relative(root, file);
    if (!rel || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)
      || !fs.statSync(file).isFile() || !fs.realpathSync(file).toLowerCase().startsWith(root.toLowerCase() + path.sep)
      || sha(fs.readFileSync(file)) !== hash) throw failure('zcode-source-unverified');
  }
  return { source_commit: pin.source_commit, cli_version: pin.cli_version, files: Object.keys(pin.files).length };
}

/**
 * One official ZCode AgentRuntime turn. Uses the native model adapter/event store;
 * no bootstrap loader, host execution/filesystem/context/skill/MCP/workflow ports.
 * The production catalog stays closed until the separate owner/profile/cloud gates.
 */
export async function runZCodeNative(input = {}) {
  validate(input);
  const { sourceRoot, workspace, baseUrl, childKey, prompt, signal, emit = () => {} } = input;
  const verified = verifyPinnedZCodeSource(sourceRoot);
  // The official build uses aliases for workspace TypeScript exports. Direct
  // dist imports leave .js -> .ts subpaths unresolved; load the pinned CJS
  // bundle of public SDK exports built with that same alias/Zod policy.
  const loaded = await import(pathToFileURL(path.join(sourceRoot, pin.native_entry)).href);
  const { AgentRuntime, createToolRegistry, createSessionId, createInMemorySessionEventStore, AiSdkModelAdapter } = loaded.default;
  if (signal?.aborted) throw failure('zcode-stop');
  const sessionId = createSessionId(), registry = createToolRegistry(), local = new AbortController();
  const combined = signal ? AbortSignal.any([signal, local.signal]) : local.signal;
  const selection = { providerId: 'miniproctor-deepseek', modelId: 'deepseek-v4-flash', options: { reasoningLevel: 'none', maxOutputTokens: 2048 } };
  const adapter = new AiSdkModelAdapter({ env: {}, network: { httpProxy: '', noProxy: '*' }, retry: { maxAttempts: 1 }, modelIoFullRetentionEnabled: false, streamIdleTimeoutMs: 45000 });
  const properties = {
    requiresMfjsToolSchema: false, contextWindow: 65536,
    inputFormat: { supportsText: true, supportsImage: false, supportsVideo: false, supportsAudio: false, supportsPdf: false },
    outputFormat: { supportsText: true }, supportsToolCall: false, supportsJsonSchemaOutput: false,
    supportsNativeWebSearch: false, supportsMidConversationSystem: true,
  };
  const modelConfig = { enabled: true, properties, optionSpecs: {
    maxOutputTokens: { max: 2048, map: '{"max_tokens": maxOutputTokens}' },
    reasoningLevel: { values: ['none'], map: '{"thinking": {"type": "disabled"}}' },
  } };
  const providerConfig = { group: 'standard-personal', access: { type: 'api-key', apiKey: childKey }, api: { type: input.apiFormat || 'anthropic-messages', baseUrl: baseUrl.replace(/\/(messages|chat\/completions)$/u, '') } };
  let nativeTurnId = null, safetyError = null, result = null, errorCode = null, nativeErrorType = null;
  const events = [];
  const eventSink = { onSessionEvent(event) {
    if (event.sessionId !== sessionId || typeof event.id !== 'string' || !event.id || !Number.isInteger(event.sequenceNumber)) throw failure('zcode-native-identity');
    if (events.length >= maximumEvents) throw failure('zcode-event-limit');
    if (registry.list().length || /^(tool_call_|permission_|hook_|workflow_|subagent_)/u.test(event.type)) {
      safetyError = 'zcode-unexpected-execution-event'; local.abort(failure(safetyError)); throw failure(safetyError);
    }
    const item = { id: event.id, session_id: event.sessionId, turn_id: event.turnId || null, type: event.type, sequence: event.sequenceNumber };
    events.push(item);
    if (event.type === 'turn_started') {
      nativeTurnId = event.turnId;
      emit({ type: 'started', native_session_id: sessionId, native_turn_id: nativeTurnId, native_version: pin.cli_version });
    }
    if (event.type === 'model_request') emit({ type: 'model_request', native_session_id: sessionId, native_turn_id: event.turnId, event_id: event.id });
  } };
  const runtime = new AgentRuntime(sessionId, {
    workingDirectory: workspace, workspacePath: workspace, agentName: 'zcode-agent',
    mode: 'plan', planEnabled: false, maxTurns: 1, toolset: 'main', toolAllowlist: [],
    modelStreaming: 'on', streamingToolExecution: 'off', modelSelection: selection,
    subagents: { enabled: false, profiles: [] }, dynamicWorkflowEnabled: false,
    runtimeFeatures: { nodeRepl: false, browserUse: false, computerUse: false },
    mcp: { enabled: false, servers: {} }, hooks: { enabled: false, events: {} },
    memory: { enabled: false, use: false, extractionEnabled: false }, titleGeneration: { enabled: false },
    targetCompletionVerification: { enabled: false }, nativeSearchEnhancementsEnabled: false,
  }, {
    appVersion: pin.cli_version, eventStore: createInMemorySessionEventStore(), toolRegistry: registry, eventSink,
    modelFactory: ({ selection: requested, requestDependencies }) => {
      if (requested.providerId !== selection.providerId || requested.modelId !== selection.modelId) throw failure('zcode-model-unverified');
      return adapter.createModel({ providerId: selection.providerId, modelId: selection.modelId, providerConfig, modelConfig, options: selection.options, requestDependencies });
    },
  });
  if (registry.list().length !== 0) throw failure('zcode-tool-surface-changed');
  const timeout = setTimeout(() => local.abort(failure('zcode-task-timeout')), 120000);
  try {
    result = await runtime.executeTurn(prompt, [], { abortSignal: combined, continueActiveTargetAfterTurn: false, modelExecution: { selectionScope: 'execution', memoryExtraction: 'skip', subagents: { foregroundModel: 'submission', background: 'deny' } } });
    const complete = result.events.find(e => e.type === 'turn_complete');
    if (!complete || complete.payload?.resultType !== 'success' || complete.payload.toolCallCount !== 0
      || result.turnId !== nativeTurnId || !result.response?.trim() || Buffer.byteLength(result.response, 'utf8') > 32000
      || registry.list().length) throw failure('zcode-turn-incomplete');
  } catch (error) {
    nativeErrorType = error.type || null;
    errorCode = typeof error?.code === 'string' && /^zcode-[a-z-]+$/u.test(error.code) ? error.code : 'zcode-native-failed';
    const causes = [];
    for (let current = error.cause; current && causes.length < 5; current = current.cause) causes.push({
      name: current.name, type: current.type || null, code: current.code || null,
      message: sanitizeSensitiveText(String(current.message || '')).split(childKey).join('[REDACTED_LOCAL_KEY]').slice(0, 1000),
    });
    try { input.onNativeError?.({
      name: error.name, type: error.type || null, code: error.code || null,
      message: sanitizeSensitiveText(String(error.message || '')).split(childKey).join('[REDACTED_LOCAL_KEY]').slice(0, 1000),
      detail: sanitizeSensitiveText(JSON.stringify(error.data || {})).split(childKey).join('[REDACTED_LOCAL_KEY]').slice(0, 3000),
      causes,
    }); } catch { /* Diagnostic observers cannot change the native outcome. */ }
  } finally {
    clearTimeout(timeout); runtime.beginShutdown(); await runtime.closeBrowserSession();
  }
  const cancelled = signal?.aborted && signal.reason?.code === 'zcode-stop' && !local.signal.aborted && !safetyError && nativeErrorType === 'turn_cancelled';
  const complete = !combined.aborted && !errorCode && result;
  const outcome = {
    type: 'result', status: complete ? 'completed' : cancelled ? 'cancelled' : 'failed',
    native_session_id: sessionId, native_turn_id: nativeTurnId, ...verified,
    error_code: safetyError || (complete || cancelled ? null : local.signal.reason?.code || errorCode),
    text: complete ? sanitizeSensitiveText(result.response).split(childKey).join('[REDACTED_LOCAL_KEY]') : null,
    tool_count: registry.list().length, native_events: events,
  };
  emit(outcome); return outcome;
}
