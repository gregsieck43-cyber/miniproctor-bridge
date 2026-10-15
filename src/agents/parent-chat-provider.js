import fs from 'node:fs';
import path from 'node:path';

const CONFIG_ENV = 'MINIPROCTOR_CHAT_PROVIDER_CONFIG';
const COMMANDCODE_BASE = 'https://api.commandcode.ai/provider/v1';
const COMMANDCODE_MODEL = 'deepseek/deepseek-v4.1-flash';
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const credentials = new WeakMap();
const failureDiagnostics = new WeakMap();
const ownedFailures = new WeakSet();
const FAILURE_CODES = new Set(['parent-chat-provider-invalid','parent-chat-request-invalid','parent-chat-budget-invalid',
  'parent-chat-text-only','parent-chat-credential-echo','parent-chat-aborted','parent-chat-timeout',
  'parent-chat-upstream-status','parent-chat-response-invalid','parent-chat-response-limit','parent-chat-upstream-failed']);
const safeFinishReason = value => ['stop','length','tool_calls','function_call','content_filter'].includes(value) ? value : null;
const TRANSPORT_CODES = new Map([
  ['ENOTFOUND','dns-not-found'],['EAI_AGAIN','dns-temporary'],['ECONNREFUSED','connection-refused'],
  ['ECONNRESET','connection-reset'],['EPIPE','connection-broken'],['UND_ERR_CONNECT_TIMEOUT','connect-timeout'],
  ['ETIMEDOUT','socket-timeout'],['ENETUNREACH','network-unreachable'],['EHOSTUNREACH','network-unreachable'],
  ['UND_ERR_HEADERS_TIMEOUT','headers-timeout'],['UND_ERR_SOCKET','socket-failure'],
  ...['CERT_HAS_EXPIRED','CERT_NOT_YET_VALID','DEPTH_ZERO_SELF_SIGNED_CERT','SELF_SIGNED_CERT_IN_CHAIN',
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE','UNABLE_TO_GET_ISSUER_CERT_LOCALLY','ERR_TLS_CERT_ALTNAME_INVALID'].map(code=>[code,'tls-certificate']),
  ...['ERR_SSL_WRONG_VERSION_NUMBER','ERR_TLS_PROTOCOL_VERSION_CONFLICT'].map(code=>[code,'tls-protocol']),
]);
function transportFailure(error) {
  const kinds = new Set(),seen = new Set(),pending = [{value:error,depth:0}];
  const own = (value,name) => { try { return Object.getOwnPropertyDescriptor(value,name)?.value; } catch { return undefined; } };
  const enqueue = (value,depth) => { if (value && typeof value === 'object' && !seen.has(value) && pending.length + seen.size < 8) pending.push({value,depth}); };
  while (pending.length && seen.size < 8) {
    const {value,depth} = pending.shift();
    if (!value || typeof value !== 'object' || seen.has(value)) continue;
    seen.add(value); const kind = TRANSPORT_CODES.get(own(value,'code')); if (kind) kinds.add(kind);
    if (depth >= 2) continue;
    enqueue(own(value,'cause'),depth+1);
    const errors = own(value,'errors'),length = Array.isArray(errors) ? own(errors,'length') : 0;
    for (let i=0;i<Math.min(Number.isSafeInteger(length)?length:0,8);i++) enqueue(own(errors,String(i)),depth+1);
  }
  return kinds.size > 1 ? 'mixed' : kinds.values().next().value || 'unknown';
}
const failure = code => { const error = Object.assign(new Error(code), {code}); ownedFailures.add(error); return error; };

/** Only diagnostics minted by this module are trusted; arbitrary upstream error properties are not. */
export function getParentChatFailureDiagnostic(error) { return failureDiagnostics.get(error) || null; }
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const NATIVE_FIELDS = Object.freeze(['model','messages','max_tokens','stream','stream_options','tools','tool_choice','temperature','top_p','stop','thinking']);
const SHAPE_FIELDS = Object.freeze([...NATIVE_FIELDS,'system','stop_sequences','response_format','metadata','max_completion_tokens','user','seed','n','logprobs','parallel_tool_calls','extra_vars']);
const MESSAGE_SHAPE_FIELDS = Object.freeze(['role','content','type','name','tool_calls','function_call','refusal','agent','isSubAgent','agentColor','conversationRequestId']);
const BLOCK_SHAPE_FIELDS = Object.freeze(['type','text','cache_control','image_url','source','name','input','content']);
function nativeInputShape(value,allowed,messageIndex,blockIndex){
  const own=(object,name)=>{try{return Object.getOwnPropertyDescriptor(object,name)?.value;}catch{return undefined;}};
  const kind=item=>item===undefined?'missing':item===null?'null':Array.isArray(item)?'array':['string','number','boolean','object'].includes(typeof item)?typeof item:'other';
  const enumOf=(item,values)=>item===undefined?'missing':values.find(value=>value===item)||'other';
  const fields=(object,known)=>{
    if(!plain(object))return{known_fields:Object.freeze([]),unknown_fields_count:null};
    const names=Object.keys(object);return{known_fields:Object.freeze(known.filter(name=>Object.hasOwn(object,name))),unknown_fields_count:names.filter(name=>!known.includes(name)).length};
  };
  try{
    const messages=own(value,'messages'),sample=messageIndex??(Array.isArray(messages)&&messages.length?0:null),message=sample===null?undefined:own(messages,String(sample)),content=own(message,'content');
    const messageShape=message===undefined?null:Object.freeze({...fields(message,MESSAGE_SHAPE_FIELDS),
      role:enumOf(own(message,'role'),['system','user','assistant','developer','tool','function']),
      type:enumOf(own(message,'type'),['message','function_call','function_call_output']),content_type:kind(content),content_count:Array.isArray(content)?content.length:null});
    const block=blockIndex===null?undefined:own(content,String(blockIndex));
    const blockShape=blockIndex===null?null:Object.freeze({...fields(block,BLOCK_SHAPE_FIELDS),
      type:enumOf(own(block,'type'),['text','input_text','output_text','image','image_url','tool_use','tool_result']),text_type:kind(own(block,'text'))});
    return Object.freeze({...fields(value,SHAPE_FIELDS),unsupported_fields_count:plain(value)?Object.keys(value).filter(name=>!allowed.includes(name)).length:null,
      messages_type:kind(messages),message_count:Array.isArray(messages)?messages.length:null,sampled_message_index:sample,
      failure_message_index:messageIndex,failure_block_index:blockIndex,message:messageShape,block:blockShape});
  }catch{return Object.freeze({unavailable:true});}
}
function nativeRefusal(reason,value,allowed,messageIndex=null,blockIndex=null,error=failure('parent-chat-text-only')){
  const diagnostic=Object.freeze({failure_code:'parent-chat-text-only',stage:'native-admission',shape_reason:reason,
    shape:nativeInputShape(value,allowed,messageIndex,blockIndex)});
  Object.defineProperty(error,'diagnostic',{value:diagnostic});failureDiagnostics.set(error,diagnostic);return error;
}

function localFile(file, maximum) {
  // Windows UNC/device paths are not local credential sources. Never accept URLs or relative paths.
  if (typeof file !== 'string' || !path.isAbsolute(file) || /^(?:\\\\|\/\/)/u.test(file)
    || /[\u0000-\u001f\u007f]/u.test(file)) throw failure('parent-chat-file-invalid');
  try {
    for (let current = path.resolve(file);; current = path.dirname(current)) {
      if (fs.lstatSync(current).isSymbolicLink()) throw failure('parent-chat-file-invalid');
      if (path.dirname(current) === current) break;
    }
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size < 1 || stat.size > maximum) throw failure('parent-chat-file-invalid');
    const bytes = fs.readFileSync(file), text = bytes.toString('utf8');
    if (!Buffer.from(text).equals(bytes)) throw failure('parent-chat-file-invalid');
    return text;
  } catch { throw failure('parent-chat-file-invalid'); }
}

function opaqueProvider(metadata, key, privatePaths = []) {
  const secrets = [...new Set([key, ...privatePaths].filter(Boolean).flatMap(value => [value,JSON.stringify(value).slice(1,-1)]))];
  const textOf = value => Buffer.isBuffer(value) ? value.toString('utf8')
    : typeof value === 'string' ? value : JSON.stringify(value) || '';
  const containsSecret = value => {
    const text = textOf(value);
    if (secrets.some(secret => text.includes(secret))) return true;
    // JSON escapes must not hide a secret in raw native JSONL or persisted state.
    try { const decoded = JSON.stringify(JSON.parse(text)); return secrets.some(secret => decoded.includes(secret)); }
    catch { return false; }
  };
  const provider = {...metadata};
  Object.defineProperties(provider, {
    containsSecret: {value: containsSecret},
    redact: {value: value => secrets.reduce((text, secret) => text.split(secret).join('[REDACTED_PARENT_PROVIDER]'), String(value))},
  });
  credentials.set(provider, key);
  return Object.freeze(provider);
}

/** Only the trusted parent/Node worker loads this file. No real key is an object property. */
export function loadParentChatProvider({env = process.env, legacyApiKey, legacyUrl, legacyModel} = {}) {
  if (Object.hasOwn(env, CONFIG_ENV)) {
    const configPath = env[CONFIG_ENV];
    let config;
    try { config = JSON.parse(localFile(configPath, 32768)); }
    catch { throw failure('parent-chat-config-invalid'); }
    if (!plain(config) || Object.keys(config).sort().join(',') !== 'api_format,api_key_file,base_url,model'
      || config.api_format !== 'chat-completions' || config.base_url !== COMMANDCODE_BASE
      || config.model !== COMMANDCODE_MODEL) throw failure('parent-chat-config-invalid');
    const key = localFile(config.api_key_file, 8192).trim();
    if (!/^[\x21-\x7e]{9,4096}$/u.test(key)) throw failure('parent-chat-key-invalid');
    return opaqueProvider({configured:true,provider:'commandcode',apiFormat:'chat-completions',
      url:COMMANDCODE_BASE + '/chat/completions',model:COMMANDCODE_MODEL}, key, [configPath, config.api_key_file]);
  }
  if (!legacyApiKey) return null;
  if (typeof legacyApiKey !== 'string' || !/^[\x21-\x7e]{9,4096}$/u.test(legacyApiKey)
    || !['https://api.deepseek.com/chat/completions','https://api.deepseek.com/anthropic/v1/messages'].includes(legacyUrl)
    || typeof legacyModel !== 'string' || !legacyModel) throw failure('parent-chat-legacy-invalid');
  return opaqueProvider({configured:false,provider:'deepseek-official',
    apiFormat:legacyUrl.endsWith('/messages')?'legacy-messages':'chat-completions',url:legacyUrl,model:legacyModel}, legacyApiKey);
}

function validateMessages(messages) {
  if (!Array.isArray(messages) || !messages.length || messages.length > 1024) throw failure('parent-chat-text-only');
  for (const message of messages) {
    if (!plain(message) || Object.keys(message).some(key => !['role','content'].includes(key))
      || !['system','user','assistant'].includes(message.role) || typeof message.content !== 'string'
      || message.content.includes('\0') || !Buffer.from(message.content).equals(Buffer.from(message.content,'utf8'))
      || Buffer.from(message.content).toString('utf8') !== message.content) throw failure('parent-chat-text-only');
  }
}

function usageOf(value) {
  if (value === undefined || value === null) return null;
  if (!plain(value)) throw failure('parent-chat-response-invalid');
  const names = ['prompt_tokens','completion_tokens','total_tokens'];
  if (names.some(name => value[name] !== undefined && (!Number.isSafeInteger(value[name]) || value[name] < 0))) throw failure('parent-chat-response-invalid');
  // A missing measure is unknown, not zero and not inferred from another counter.
  if (names.some(name => value[name] === undefined)) return null;
  return Object.fromEntries(names.map(name => [name,value[name]]));
}
function textOnly(value) {
  if (!plain(value) || value.tool_calls?.length || value.function_call || value.refusal
    || value.audio || typeof value.content !== 'string' || !value.content.trim()) throw failure('parent-chat-response-invalid');
  return value.content;
}
function normalized(value, provider) {
  if (provider.containsSecret(value)) throw failure('parent-chat-credential-echo');
  if (!plain(value) || typeof value.id !== 'string' || !value.id || typeof value.model !== 'string' || !value.model
    || !Array.isArray(value.choices) || value.choices.length !== 1) throw failure('parent-chat-response-invalid');
  const choice = value.choices[0];
  if (!plain(choice) || choice.index !== 0 || !['stop','length'].includes(choice.finish_reason)
    || choice.message?.role !== 'assistant') throw failure('parent-chat-response-invalid');
  return {id:value.id,model:value.model,text:textOnly(choice.message),finish_reason:choice.finish_reason,usage:usageOf(value.usage)};
}

function parseSse(text, provider, observe = () => {}) {
  let id = null, model = null, output = '', reasoning = '', finish = null, usage = null, done = false;
  for (const record of text.replace(/\r\n/g,'\n').split(/\n\n/)) {
    const lines = record.split('\n').filter(line => line.startsWith('data:'));
    if (!lines.length) continue;
    const data = lines.map(line => line.slice(5).trimStart()).join('\n');
    if (done) throw failure('parent-chat-response-invalid');
    if (data === '[DONE]') { done = true; continue; }
    let value;
    try { value = JSON.parse(data); } catch { throw failure('parent-chat-response-invalid'); }
    if (provider.containsSecret(value)) throw failure('parent-chat-credential-echo');
    observe({finish_reason:safeFinishReason(value?.choices?.[0]?.finish_reason),usage_present:value?.usage !== undefined && value?.usage !== null});
    if (!plain(value) || value.error || !Array.isArray(value.choices) || value.choices.length > 1) throw failure('parent-chat-response-invalid');
    if (value.id !== undefined) {
      if (typeof value.id !== 'string' || !value.id || id !== null && id !== value.id) throw failure('parent-chat-response-invalid');
      id = value.id;
    }
    if (value.model !== undefined) {
      if (typeof value.model !== 'string' || !value.model || model !== null && model !== value.model) throw failure('parent-chat-response-invalid');
      model = value.model;
    }
    if (value.usage !== undefined && value.usage !== null) usage = usageOf(value.usage);
    if (!value.choices.length) continue;
    const choice = value.choices[0], delta = choice?.delta;
    if (!plain(choice) || choice.index !== 0 || !plain(delta) || delta.tool_calls?.length || delta.function_call || delta.audio || delta.refusal
      || delta.role !== undefined && delta.role !== 'assistant' || finish !== null) throw failure('parent-chat-response-invalid');
    if (delta.content !== undefined && delta.content !== null) {
      if (typeof delta.content !== 'string') throw failure('parent-chat-response-invalid');
      output += delta.content;
    }
    // Reasoning is never emitted/persisted. Check its aggregate too: a key may span SSE records.
    for (const name of ['reasoning_content','reasoning']) if (typeof delta[name] === 'string') reasoning += delta[name];
    if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
      if (!['stop','length'].includes(choice.finish_reason)) throw failure('parent-chat-response-invalid');
      finish = choice.finish_reason;
    }
  }
  if (provider.containsSecret(output) || provider.containsSecret(reasoning)) throw failure('parent-chat-credential-echo');
  if (!done || !id || !model || !finish || !output.trim()) throw failure('parent-chat-response-invalid');
  return {id,model,text:output,finish_reason:finish,usage};
}

/** Stop proof is sampled before shutdown, not inferred later from a completed response or worker exit. */
export function isParentChatActiveStop({nativeAccepted,nativeCompleted,gateway} = {}) {
  return nativeAccepted === true && nativeCompleted === false && gateway?.contacted === 1
    && gateway.active === 1 && gateway.successful === 0 && gateway.failed === 0 && gateway.closed === false;
}

/** The old model is a native protocol label only, never the real configured upstream model. */
export function prepareNativeParentChat(value, {messagesFormat = false, parentOutputBudget = false, allowWorkbuddyTelemetry = false} = {}) {
  // Opted-in WorkBuddy CommandCode execution owns the hard budget even if native omits it.
  // Other native routes retain their original explicit-declaration admission rules.
  const declaredBudget = value?.max_tokens;
  const outputBudget = parentOutputBudget && declaredBudget === undefined ? 512 : declaredBudget;
  // Only a trusted WorkBuddy caller may discard opaque telemetry without reading its value.
  const allowed = [...NATIVE_FIELDS,...(messagesFormat ? ['system','stop_sequences'] : []),
    ...(!messagesFormat && allowWorkbuddyTelemetry === true ? ['extra_vars'] : [])];
  const refuse=(reason,messageIndex=null,blockIndex=null)=>nativeRefusal(reason,value,allowed,messageIndex,blockIndex);
  if (!plain(value)) throw refuse('top-object');
  if (Object.keys(value).some(key => !allowed.includes(key))) throw refuse('top-fields');
  if (value.model !== 'deepseek-v4-flash') throw refuse('model');
  if (!Number.isSafeInteger(outputBudget) || outputBudget < 1 || !parentOutputBudget && outputBudget > 2048) throw refuse('budget');
  if (value.stream !== undefined && typeof value.stream !== 'boolean') throw refuse('stream');
  if (value.tools !== undefined && (!Array.isArray(value.tools) || value.tools.length)) throw refuse('tools');
  if (value.tool_choice !== undefined && value.tool_choice !== 'none') throw refuse('tool-choice');
  if (value.thinking !== undefined && (!plain(value.thinking) || Object.keys(value.thinking).join(',') !== 'type' || value.thinking.type !== 'disabled')) throw refuse('thinking');
  if (value.stream_options !== undefined && (!plain(value.stream_options) || Object.keys(value.stream_options).some(key => key !== 'include_usage')
    || value.stream_options.include_usage !== undefined && typeof value.stream_options.include_usage !== 'boolean')) throw refuse('stream-options');
  const text = (content,messageIndex=null) => {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content) || !content.length) throw refuse('content-shape',messageIndex);
    content.forEach((block,blockIndex)=>{
      if (!plain(block)) throw refuse('content-block-object',messageIndex,blockIndex);
      if (block.type !== 'text') throw refuse('content-block-type',messageIndex,blockIndex);
      if (typeof block.text !== 'string') throw refuse('content-text-type',messageIndex,blockIndex);
      if (Object.keys(block).some(key => !['type','text','cache_control'].includes(key))) throw refuse('content-block-fields',messageIndex,blockIndex);
    });
    return content.map(block => block.text).join('');
  };
  if (!Array.isArray(value.messages) || !value.messages.length) throw refuse('messages');
  const messages = value.messages.map((message,messageIndex) => {
    if (!plain(message)) throw refuse('message-object',messageIndex);
    if (Object.keys(message).some(key => !['role','content'].includes(key)
      && !(['agent','isSubAgent','agentColor','conversationRequestId'].includes(key) && !messagesFormat
        && allowWorkbuddyTelemetry === true && message.role === 'user'))) throw refuse('message-fields',messageIndex);
    if (!(messagesFormat ? ['user','assistant'] : ['system','user','assistant']).includes(message.role)) throw refuse('message-role',messageIndex);
    return {role:message.role,content:text(message.content,messageIndex)};
  });
  if (messagesFormat && value.system !== undefined) messages.unshift({role:'system',content:text(value.system)});
  try{validateMessages(messages);}catch(error){
    if(ownedFailures.has(error)&&error.code==='parent-chat-text-only')throw nativeRefusal(messages.length>1024?'message-count':'text-validation',value,allowed,null,null,error);
    throw error;
  }
  const result = {messages,max_tokens:Math.min(512,outputBudget)};
  for (const [name,maximum] of [['temperature',2],['top_p',1]]) {
    if (value[name] === undefined) continue;
    if (!Number.isFinite(value[name]) || value[name] < 0 || value[name] > maximum) throw failure('parent-chat-request-invalid');
    result[name] = value[name];
  }
  if (value.stop !== undefined && value.stop_sequences !== undefined) throw failure('parent-chat-request-invalid');
  if (value.stop !== undefined || value.stop_sequences !== undefined) {
    const stop = value.stop ?? value.stop_sequences, stops = Array.isArray(stop) ? stop : [stop];
    if (!stops.length || stops.length > 4 || stops.some(item => typeof item !== 'string' || !item || item.length > 1024)) throw failure('parent-chat-request-invalid');
    result.stop = stop;
  }
  // Disabled native thinking is not rendered as visible output; upstream reasoning is discarded after secret checking.
  return result;
}

/** Buffered native framing of a real upstream answer; this is not a live token stream. */
export function frameNativeParentChat(result, {messagesFormat = false, stream = false} = {}) {
  const model = 'deepseek-v4-flash';
  if (!messagesFormat) {
    const value = {id:result.id,object:'chat.completion',model,
      choices:[{index:0,message:{role:'assistant',content:result.text},finish_reason:result.finish_reason}],usage:result.usage};
    if (!stream) return {contentType:'application/json',body:JSON.stringify(value)};
    const frames = [
      {id:result.id,object:'chat.completion.chunk',model,choices:[{index:0,delta:{role:'assistant',content:result.text},finish_reason:null}]},
      {id:result.id,object:'chat.completion.chunk',model,choices:[{index:0,delta:{},finish_reason:result.finish_reason}],usage:result.usage},
    ];
    return {contentType:'text/event-stream',body:frames.map(frame=>'data: '+JSON.stringify(frame)+'\n\n').join('')+'data: [DONE]\n\n'};
  }
  const usage = result.usage === null ? null : {input_tokens:result.usage.prompt_tokens,output_tokens:result.usage.completion_tokens};
  const stop_reason = result.finish_reason === 'length' ? 'max_tokens' : 'end_turn';
  const value = {id:result.id,type:'message',role:'assistant',model,content:[{type:'text',text:result.text}],stop_reason,stop_sequence:null,usage};
  if (!stream) return {contentType:'application/json',body:JSON.stringify(value)};
  const frames = [
    ['message_start',{type:'message_start',message:{...value,content:[],stop_reason:null,usage}}],
    ['content_block_start',{type:'content_block_start',index:0,content_block:{type:'text',text:''}}],
    ['content_block_delta',{type:'content_block_delta',index:0,delta:{type:'text_delta',text:result.text}}],
    ['content_block_stop',{type:'content_block_stop',index:0}],
    ['message_delta',{type:'message_delta',delta:{stop_reason,stop_sequence:null},usage:usage === null ? null : {output_tokens:usage.output_tokens}}],
    ['message_stop',{type:'message_stop'}],
  ];
  return {contentType:'text/event-stream',body:frames.map(([name,frame])=>'event: '+name+'\ndata: '+JSON.stringify(frame)+'\n\n').join('')};
}

/** One HTTP request, no retries. True upstream SSE is buffered before any native protocol output. */
export async function requestParentChatCompletion(provider, options = {}) {
  const state = {stage:'request-validation',fetch_started:false,http_status:null,request_bytes:null,response_bytes:0,finish_reason:null,usage_present:false};
  let observer,controller,reader,timer,callerAbort,callerSignal,abortCode = 'parent-chat-aborted';
  const notify = (stage, failure_code = null) => {
    state.stage = stage;
    if (observer) { try { observer(Object.freeze({failure_code,...state})); } catch {} }
  };
  const observeMetadata = value => {
    if (value.finish_reason !== null) state.finish_reason = value.finish_reason;
    state.usage_present ||= value.usage_present;
  };
  try {
    const {messages,max_tokens = 512,signal,fetchImpl = globalThis.fetch,timeoutMs = 45000,temperature,top_p,stop,onDiagnostic,thinking} = options;
    if (onDiagnostic !== undefined && typeof onDiagnostic !== 'function') throw failure('parent-chat-request-invalid');
    observer = onDiagnostic; callerSignal = signal;
    if (!credentials.has(provider) || provider.apiFormat !== 'chat-completions') throw failure('parent-chat-provider-invalid');
    if (Object.keys(options).some(key => !['messages','max_tokens','signal','fetchImpl','timeoutMs','temperature','top_p','stop','onDiagnostic','thinking'].includes(key))) throw failure('parent-chat-request-invalid');
    const includeThinking = Object.hasOwn(options,'thinking');
    if (includeThinking && (!plain(thinking) || ![Object.prototype,null].includes(Object.getPrototypeOf(thinking))
      || Reflect.ownKeys(thinking).length !== 1 || Object.getOwnPropertyDescriptor(thinking,'type')?.value !== 'disabled')) throw failure('parent-chat-request-invalid');
    if (!Number.isInteger(max_tokens) || max_tokens < 1 || max_tokens > 512 || typeof fetchImpl !== 'function') throw failure('parent-chat-budget-invalid');
    validateMessages(messages);
    const sampling = {};
    for (const [name,value,maximum] of [['temperature',temperature,2],['top_p',top_p,1]]) {
      if (value === undefined) continue;
      if (!Number.isFinite(value) || value < 0 || value > maximum) throw failure('parent-chat-request-invalid');
      sampling[name] = value;
    }
    if (stop !== undefined) {
      const stops = Array.isArray(stop) ? stop : [stop];
      if (!stops.length || stops.length > 4 || stops.some(item => typeof item !== 'string' || !item || item.length > 1024)) throw failure('parent-chat-request-invalid');
      sampling.stop = stop;
    }
    const body = JSON.stringify({model:provider.model,messages,max_tokens,stream:true,stream_options:{include_usage:true},...sampling,...(includeThinking ? {thinking:{type:'disabled'}} : {})});
    state.request_bytes = Buffer.byteLength(body);
    if (state.request_bytes > 2 * 1024 * 1024 || provider.containsSecret(body)) throw failure('parent-chat-credential-echo');
    if (signal?.aborted) throw failure('parent-chat-aborted');
    controller = new AbortController();
    let rejectAbort;
    const aborted = new Promise((_, reject) => { rejectAbort = reject; });
    const abort = code => {
      abortCode = code; controller.abort();
      if (reader) Promise.resolve(reader.cancel()).catch(()=>{});
      rejectAbort(failure(code));
    };
    callerAbort = () => abort('parent-chat-aborted');
    signal?.addEventListener('abort', callerAbort, {once:true});
    const duration = Number.isFinite(timeoutMs) ? Math.min(45000, Math.max(1,Math.floor(timeoutMs))) : 45000;
    timer = setTimeout(()=>abort('parent-chat-timeout'), duration);
    const work = (async()=>{
      // This marker is at the actual fetch invocation, not native admission or request validation.
      state.fetch_started = true; notify('fetch-started');
      const upstream = await fetchImpl(provider.url,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+credentials.get(provider)},
        body,redirect:'error',signal:controller.signal});
      state.http_status = Number.isInteger(upstream.status) && upstream.status >= 100 && upstream.status <= 599 ? upstream.status : null;
      notify('response-headers');
      if (controller.signal.aborted) { await upstream.body?.cancel().catch(()=>{}); throw failure(abortCode); }
      if (!upstream.ok || upstream.redirected) { await upstream.body?.cancel().catch(()=>{}); throw failure('parent-chat-upstream-status'); }
      if (!upstream.body) throw failure('parent-chat-response-invalid');
      reader = upstream.body.getReader(); notify('response-body');
      const chunks = [];
      for (;;) {
        const chunk = await reader.read();
        if (controller.signal.aborted) throw failure(abortCode);
        if (chunk.done) break;
        state.response_bytes += chunk.value.byteLength;
        if (state.response_bytes > MAX_RESPONSE_BYTES) { await reader.cancel(); throw failure('parent-chat-response-limit'); }
        chunks.push(Buffer.from(chunk.value));
      }
      const raw = Buffer.concat(chunks);
      if (provider.containsSecret(raw)) throw failure('parent-chat-credential-echo');
      const text = raw.toString('utf8');
      if (!Buffer.from(text).equals(raw)) throw failure('parent-chat-response-invalid');
      let result;
      if (/^text\/event-stream/i.test(upstream.headers.get('content-type') || '')) {
        notify('sse-parse'); result = parseSse(text, provider, observeMetadata);
      } else {
        notify('json-parse');
        let value;
        try { value = JSON.parse(text); } catch { throw failure('parent-chat-response-invalid'); }
        observeMetadata({finish_reason:safeFinishReason(value?.choices?.[0]?.finish_reason),usage_present:value?.usage !== undefined && value?.usage !== null});
        result = normalized(value, provider);
      }
      notify('response-validated'); return result;
    })();
    return await Promise.race([work,aborted]);
  } catch (error) {
    // A strict code/field allowlist, never an upstream message, body, header, URL or credential path.
    const code = controller?.signal.aborted ? abortCode : ownedFailures.has(error) && FAILURE_CODES.has(error?.code) ? error.code : 'parent-chat-upstream-failed';
    if (code === 'parent-chat-upstream-failed' && state.stage === 'fetch-started') state.transport_failure = transportFailure(error);
    const diagnostic = Object.freeze({failure_code:code,...state});
    const safeError = failure(code);
    Object.defineProperty(safeError,'diagnostic',{value:diagnostic}); failureDiagnostics.set(safeError,diagnostic);
    notify(state.stage,code); throw safeError;
  } finally {
    clearTimeout(timer);
    if (callerAbort) callerSignal?.removeEventListener('abort',callerAbort);
    if (reader) { try { reader.releaseLock(); } catch {} }
  }
}
