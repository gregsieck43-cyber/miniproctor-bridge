const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),readline=require('node:readline');
const Client=require('./workbuddy-acp-client.cjs');
const pin=require('./workbuddy-runtime-pin.json');
const PROTOCOL='miniproctor-workbuddy-native-v1',VERSION=pin.cli_version;
const failure=code=>Object.assign(new Error(code),{code});
const nativeId=value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
const requestId=value=>typeof value==='string'&&/^[0-9a-f]{32}$/.test(value);

// Electron's patched fs presents ASAR files as directories. Pins cover physical bytes.
const physicalFs=process.versions.electron?require('original-fs'):fs;
function physical(file){for(let current=path.resolve(file);;current=path.dirname(current)){if(physicalFs.existsSync(current)&&physicalFs.lstatSync(current).isSymbolicLink())throw failure('workbuddy-runtime-link');if(path.dirname(current)===current)break;}}
function verifyPinnedWorkbuddyRuntime(runtimeRoot){
  if(process.platform!=='win32'||process.arch!=='x64'||typeof runtimeRoot!=='string'||!path.isAbsolute(runtimeRoot))throw failure('workbuddy-runtime-unverified');
  physical(runtimeRoot);let files=0;const visited=new Set();
  function walk(dir){for(const entry of physicalFs.readdirSync(dir,{withFileTypes:true})){
    const file=path.join(dir,entry.name),stat=physicalFs.lstatSync(file);if(stat.isSymbolicLink())throw failure('workbuddy-runtime-link');
    if(entry.isDirectory())walk(file);else{const rel=path.relative(runtimeRoot,file).split(path.sep).join('/'),row=pin.files[rel];
      if(!stat.isFile()||!row||stat.size!==row.bytes||crypto.createHash('sha256').update(physicalFs.readFileSync(file)).digest('hex')!==row.sha256)throw failure('workbuddy-runtime-unverified');visited.add(rel);files++;}
  }}
  try{walk(runtimeRoot);}catch(error){throw failure(error.code?.startsWith('workbuddy-')?error.code:'workbuddy-runtime-unverified');}
  if(files!==Object.keys(pin.files).length||visited.size!==files)throw failure('workbuddy-runtime-unverified');
  return{runtime_version:pin.runtime_version,cli_version:VERSION,files};
}

function restrictedProduct(product,baseUrl){
  if(product?.productName!=='WorkBuddy'||product.authentication?.id!=='workbuddy-desktop')throw failure('workbuddy-product-unverified');
  const restricted=structuredClone(product);
  Object.assign(restricted.productFeatures,{
    DisableHooks:true,DisablePlugin:true,Mcp:false,McpMarket:false,McpInstallationGuide:false,Skills:false,SkillManage:false,TencentPptxBuiltinDefaultEnabled:false,
    Agents:false,Task:false,Connector:false,ScheduledTasks:false,WebFetch:false,WebSearch:false,BrowserUse:false,ComputerUse:false,MemoryManagement:false,DisableCloudSkillSync:true,DisableCloudExpertSync:true
  });
  restricted.builtInMarketplaces={};restricted.builtInMarketPlugins=[];restricted.disabledBuiltinSkills=['*'];
  if(baseUrl){
    restricted.models=[...(restricted.models||[]).filter(x=>x.id!=='deepseek-v4-flash'),{id:'deepseek-v4-flash',name:'DeepSeek text',url:baseUrl,maxOutputTokens:512,maxInputTokens:65536,supportsToolCall:false,supportsImages:false,supportsReasoning:false}];
    for(const agent of restricted.agents||[]){agent.model='deepseek-v4-flash';agent.models=['deepseek-v4-flash'];}
  }
  return restricted;
}

async function main(){
  // Native logs never become wrapper frames or disclose transient local credentials.
  for(const method of ['log','info','warn','error','debug'])console[method]=()=>{};
  const write=frame=>process.stdout.write(JSON.stringify({protocol:PROTOCOL,...frame})+'\n');
  const input=readline.createInterface({input:process.stdin,crlfDelay:Infinity});
  let begin,closeResolve,stopped=false,inputError=null,started=false,acp=null,manager=null,handle=null,sessionId=null,acceptedRequest=null,prompting=false,output='',nativeResult=null,core=null;
  const startInput=new Promise(resolve=>begin=resolve),closeInput=new Promise(resolve=>closeResolve=resolve);
  const cancel=()=>{stopped=true;if(acp&&sessionId&&prompting)acp.cancel(sessionId).catch(()=>{});};
  input.on('close',()=>{cancel();begin(null);closeResolve();});
  input.on('line',line=>{
    try{if(Buffer.byteLength(line)>100000)throw failure('workbuddy-input-invalid');const frame=JSON.parse(line);
      if(frame.type==='start'&&!started){started=true;begin(frame.prompt);}
      else if(frame.type==='control_stop'){cancel();}
      else if(frame.type==='control_shutdown'){cancel();closeResolve();}
      else throw failure('workbuddy-input-invalid');
    }catch{inputError='workbuddy-input-invalid';cancel();begin(null);closeResolve();}
  });
  let guard,responseDiagnostic=null;const throwIfStopped=()=>{if(inputError)throw failure(inputError);if(stopped)throw failure('workbuddy-stop');};
  try{
    const prompt=await startInput;throwIfStopped();
    if(typeof prompt!=='string'||!prompt.trim()||/^[!/]/.test(prompt.trimStart())||prompt.includes('\0')||Buffer.byteLength(prompt)>16000)throw failure('workbuddy-prompt-invalid');
    const runtimeRoot=process.env.MINIPROCTOR_WORKBUDDY_RUNTIME_ROOT,runDir=process.env.MINIPROCTOR_WORKBUDDY_NATIVE_DIR,localKey=process.env.MINIPROCTOR_WORKBUDDY_LOCAL_KEY,baseUrl=process.env.MINIPROCTOR_WORKBUDDY_MODEL_URL;
    verifyPinnedWorkbuddyRuntime(runtimeRoot);
    if(process.version!==pin.native_node_version||process.execPath.toLowerCase()!==path.join(runtimeRoot,'WorkBuddy.exe').toLowerCase())throw failure('workbuddy-runtime-unverified');
    if(!/^[0-9a-f]{64}$/.test(localKey||'')||!/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/v1\/chat\/completions$/.test(baseUrl||''))throw failure('workbuddy-local-gateway-invalid');
    const workspace=process.cwd();physical(runDir);physical(workspace);
    for(const name of ['home','temp','appdata','localappdata','config','user-data','cache'])if(!fs.statSync(path.join(runDir,name)).isDirectory())throw failure('workbuddy-runtime-unverified');
    core=require(path.join(runtimeRoot,'resources/app.asar/main/code-cache.js'));core.setBundledAssetsRoot(path.join(runtimeRoot,'resources/app.asar'));
    const product=core.getWorkbuddyBootstrapProductConfiguration(),config=restrictedProduct(product,baseUrl),configPath=path.join(runDir,'config/restricted-product.json');
    fs.writeFileSync(configPath,JSON.stringify(config),{flag:'wx'});process.env.ACC_PRODUCT_CONFIG_PATH=configPath;delete process.env.ACC_PRODUCT_CONFIG_V3;
    manager=core.createWorkbuddySidecarManager();if(manager.dependencies.hostId!=='workbuddy-desktop')throw failure('workbuddy-product-unverified');
    const env=core.buildWorkbuddyCliEnv({CODEBUDDY_FORCE_LITE_WB_BUNDLE:'1',CODEBUDDY_SKIP_BUILTIN_MARKETPLACE:'1',CODEBUDDY_CODE_DISABLE_BACKGROUND_TASKS:'1',CODEBUDDY_DISABLE_AUTO_MEMORY:'1',CODEBUDDY_DISABLE_COMPILE_CACHE:'1',DISABLE_TELEMETRY:'1',DISABLE_ERROR_REPORTING:'1'}, {},manager.dependencies);
    Object.assign(env,{CODEBUDDY_API_KEY:localKey,CODEBUDDY_BASE_URL:baseUrl.replace(/\/chat\/completions$/,''),CODEBUDDY_MODEL:'deepseek-v4-flash',CODEBUDDY_FIRST_TOKEN_TIMEOUT_MS:'45000'});
    const settings={enabledPlugins:Object.fromEntries((product.builtInMarketPlugins||[]).map(x=>[x.name+'@'+x.marketplaceName,false])),hooks:{},permissions:{defaultMode:'dontAsk'}};
    const args=[path.join(runtimeRoot,'resources/app.asar.unpacked/cli/bin/codebuddy'),'--serve','--host','127.0.0.1','--port','0','--tools','','--permission-mode','dontAsk','--subagent-permission-mode','dontAsk','--max-turns','1','--model','deepseek-v4-flash','--system-prompt','Analyze only the supplied text. Do not access files, execute commands, or use any tools. Answer the requested text briefly.','--setting-sources','none','--strict-mcp-config','--mcp-config','{"mcpServers":{}}','--no-session-persistence','--settings',JSON.stringify(settings)];
    guard=setTimeout(()=>{inputError='workbuddy-task-timeout';cancel();closeResolve();},75000);guard.unref();throwIfStopped();
    handle=await manager.createSession({sessionId:'wb_'+crypto.randomUUID(),command:process.execPath,args,cwd:workspace,env,port:0});throwIfStopped();
    const onFrame=frame=>{
      if(frame.method!=='session/update'||!sessionId)return;
      if(frame.params?.sessionId!==sessionId)throw failure('workbuddy-native-identity');
      const update=frame.params.update;if(!update||typeof update!=='object')throw failure('workbuddy-acp-protocol-invalid');
      if(/tool_call/.test(update.sessionUpdate||''))throw failure('workbuddy-unexpected-execution');
      if(prompting&&update._meta?.['codebuddy.ai/agentPhase']?.phase==='model_requesting'){
        const id=frame.params._meta?.['codebuddy.ai/requestId'];if(!requestId(id)||acceptedRequest&&acceptedRequest!==id)throw failure('workbuddy-native-identity');
        if(!acceptedRequest){acceptedRequest=id;write({type:'started',native_session_id:sessionId,native_request_id:id,native_version:VERSION});}
      }
      if(update.sessionUpdate==='agent_message_chunk'){
        if(!acceptedRequest||update._meta?.['codebuddy.ai/requestId']!==acceptedRequest||!nativeId(update.messageId)||update.content?.type!=='text'||typeof update.content.text!=='string')throw failure('workbuddy-native-identity');
        output+=update.content.text;if(Buffer.byteLength(output)>32000)throw failure('workbuddy-output-limit');
      }
    };
    acp=new Client(handle.acpEndpoint,core.gatewaySecretHeaders(),onFrame);await acp.connect();throwIfStopped();
    const session=await acp.call('session/new',{cwd:workspace,mcpServers:[]});sessionId=session?.sessionId;
    if(!nativeId(sessionId)||session.models?.currentModelId!=='deepseek-v4-flash'||session.modes?.currentModeId!=='dontAsk')throw failure('workbuddy-native-identity');
    await acp.call('session/set_mode',{sessionId,modeId:'dontAsk'});throwIfStopped();prompting=true;
    const response=await acp.call('session/prompt',{sessionId,prompt:[{type:'text',text:prompt}]},{timeout:50000});prompting=false;
    responseDiagnostic={stop_reason:response.stopReason,native_outcome:response._meta?.['codebuddy.ai/outcome']||null,text_bytes:Buffer.byteLength(output)};
    if(!acceptedRequest||response._meta?.['codebuddy.ai/conversationRequestId']!==acceptedRequest||!nativeId(response.userMessageId))throw failure('workbuddy-native-identity');
    const completed=!stopped&&response.stopReason==='end_turn'&&response._meta?.['codebuddy.ai/outcome']==='SUCCESS'&&output.trim();
    if(!completed&&!stopped)throw failure('workbuddy-native-incomplete');
    nativeResult={type:'native_result',status:completed?'completed':'cancelled',text:completed?output:'',native_session_id:sessionId,native_request_id:acceptedRequest,native_message_id:response.userMessageId,stop_reason:response.stopReason};
    write(nativeResult);await closeInput;
  }catch(error){
    nativeResult={type:'native_result',status:stopped&&!inputError?'cancelled':'failed',error_code:inputError||error.code?.startsWith('workbuddy-')&&error.code||'workbuddy-native-failed',diagnostic:responseDiagnostic};write(nativeResult);await closeInput;
  }
  finally{
    clearTimeout(guard);let ok=true;
    try{await acp?.close();if(handle)await manager.killSessionConfirmed(handle.sessionId);if(manager&&(await manager.listSessions()).length)ok=false;await manager?.shutdown();}catch{ok=false;}
    write({type:'native_closed',closed:ok});input.removeAllListeners('close');input.close();process.stdin.destroy();process.exitCode=ok&&nativeResult?.status!=='failed'?0:2;
  }
}
module.exports={verifyPinnedWorkbuddyRuntime,restrictedProduct,WORKBUDDY_CLI_VERSION:VERSION,WORKBUDDY_PROTOCOL:PROTOCOL};
if(require.main===module)main().catch(()=>{process.stdout.write(JSON.stringify({protocol:PROTOCOL,type:'error',code:'workbuddy-native-failed'})+'\n');process.exitCode=2;});
