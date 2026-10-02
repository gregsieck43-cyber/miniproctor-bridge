import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import readline from 'node:readline';
import {spawnSync} from 'node:child_process';
import {AgentRunner,MAX_LINE_BYTES} from '../agent/runner.js';
import {sanitizeSensitiveText} from '../lib/events.js';
import {WorkbuddyCompletionsGateway} from './workbuddy-completions-gateway.js';
import kernel from './workbuddy-native-kernel.cjs';

export const WORKBUDDY_PROTOCOL=kernel.WORKBUDDY_PROTOCOL;
export const WORKBUDDY_CLI_VERSION=kernel.WORKBUDDY_CLI_VERSION;
export const WORKBUDDY_PROFILE_VERSION='WorkBuddy 5.6.2.39298511 / CLI '+WORKBUDDY_CLI_VERSION;
const nativeEntry=fileURLToPath(new URL('./workbuddy-native-kernel.cjs',import.meta.url));
const failure=code=>Object.assign(new Error(code),{code});
const contains=(parent,child)=>{const rel=path.relative(parent,child);return rel===''||rel!=='..'&&!rel.startsWith('..'+path.sep)&&!path.isAbsolute(rel);};
const overlap=(a,b)=>contains(a,b)||contains(b,a);
const nativeId=value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
const requestId=value=>typeof value==='string'&&/^[0-9a-f]{32}$/.test(value);

/** The local profile refers to the signed desktop host, never CodeBuddy or Node. */
export function workbuddyRuntimeRoot(command){
  if(typeof command!=='string'||!path.isAbsolute(command)||path.basename(command).toLowerCase()!=='workbuddy.exe'||/[\u0000-\u001f\u007f"]/u.test(command))throw failure('workbuddy-runtime-unverified');
  return path.dirname(path.resolve(command));
}

export function validateWorkbuddyPrompt(prompt){
  if(typeof prompt!=='string'||!prompt.trim()||/^[!/]/.test(prompt.trimStart())||prompt.includes('\0')||Buffer.byteLength(prompt,'utf8')>16000||Buffer.from(prompt).toString('utf8')!==prompt)throw failure('workbuddy-prompt-invalid');
}

/** AgentRunner normally merges the host environment; this native boundary must replace it. */
export class WorkbuddyNativeRunner extends AgentRunner{
  buildChildEnv(){return{...this.env,PYTHONIOENCODING:'utf-8',LANG:'en_US.UTF-8',FORCE_COLOR:'0'};}
}

/** Frozen signed host entry; callers cannot supply native args, module, model or permissions. */
export function buildWorkbuddyNativeLaunch({runtimeRoot,runDir,workspace,childKey,baseUrl,ambientEnv=process.env,providerKey=null}={}){
  for(const value of [runtimeRoot,runDir,workspace])if(typeof value!=='string'||!path.isAbsolute(value)||/[\u0000-\u001f\u007f"]/u.test(value))throw failure('workbuddy-launch-path-invalid');
  runtimeRoot=path.resolve(runtimeRoot);runDir=path.resolve(runDir);workspace=path.resolve(workspace);
  if(overlap(runtimeRoot,runDir)||overlap(workspace,runDir)||overlap(runtimeRoot,workspace))throw failure('workbuddy-launch-path-invalid');
  const match=typeof baseUrl==='string'&&baseUrl.match(/^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})\/v1\/chat\/completions$/u);
  if(!match||Number(match[1])>65535||!/^[0-9a-f]{64}$/u.test(childKey||''))throw failure('workbuddy-local-gateway-invalid');
  const env={};
  for(const[key,value]of Object.entries(ambientEnv)){
    if(/TOKEN|SECRET|KEY|PASSWORD|AUTH|CREDENTIAL|CONNECTION|NODE_|ELECTRON|WORKBUDDY|CODEBUDDY|ACC_|PROXY|DSH|ZCODE|TSX_|BASH_ENV|ZDOTDIR|PROMPT_COMMAND|^ENV$|^(HOME|USERPROFILE|APPDATA|LOCALAPPDATA|TEMP|TMP|TMPDIR)$|^XDG_|npm_config_/i.test(key)||typeof providerKey==='string'&&providerKey&&typeof value==='string'&&value.includes(providerKey))continue;
    env[key]=value;
  }
  const dir=path.join(runDir,'native');
  Object.assign(env,{HOME:path.join(dir,'home'),USERPROFILE:path.join(dir,'home'),APPDATA:path.join(dir,'appdata'),LOCALAPPDATA:path.join(dir,'localappdata'),TEMP:path.join(dir,'temp'),TMP:path.join(dir,'temp'),TMPDIR:path.join(dir,'temp'),XDG_CONFIG_HOME:path.join(dir,'config'),XDG_DATA_HOME:path.join(dir,'user-data'),XDG_CACHE_HOME:path.join(dir,'cache'),XDG_STATE_HOME:path.join(dir,'user-data'),npm_config_cache:path.join(dir,'cache'),NODE_DISABLE_COMPILE_CACHE:'1',NODE_COMPILE_CACHE:'',ELECTRON_RUN_AS_NODE:'1',DISABLE_AUTOUPDATER:'1',DISABLE_TELEMETRY:'1',DISABLE_ERROR_REPORTING:'1',OTEL_TRACES_EXPORTER:'none',WORKBUDDY_CONFIG_DIR:path.join(dir,'config'),WORKBUDDY_USER_DATA_DIR:path.join(dir,'user-data'),WORKBUDDY_APP_PATH:path.join(runtimeRoot,'resources/app.asar'),WORKBUDDY_RESOURCES_PATH:path.join(runtimeRoot,'resources'),WORKBUDDY_APP_VERSION:'5.6.2.39298511',WORKBUDDY_DISABLE_CODE_CACHE:'1',WORKBUDDY_CLI_PREWARM_POOL_SIZE:'0',WORKBUDDY_PAC_RESOLVER:'off',CODEBUDDY_DISABLE_COMPILE_CACHE:'1',MINIPROCTOR_WORKBUDDY_RUNTIME_ROOT:runtimeRoot,MINIPROCTOR_WORKBUDDY_NATIVE_DIR:dir,MINIPROCTOR_WORKBUDDY_LOCAL_KEY:childKey,MINIPROCTOR_WORKBUDDY_MODEL_URL:baseUrl});
  return{command:path.join(runtimeRoot,'WorkBuddy.exe'),args:[nativeEntry],env};
}

function physical(file){for(let current=path.resolve(file);;current=path.dirname(current)){if(fs.existsSync(current)&&fs.lstatSync(current).isSymbolicLink())throw failure('workbuddy-runtime-link');if(path.dirname(current)===current)break;}}
function createRun(runDir,workspace){
  physical(runDir);physical(workspace);if(!fs.statSync(workspace).isDirectory())throw failure('workbuddy-launch-path-invalid');
  if(fs.existsSync(runDir)){if(!fs.statSync(runDir).isDirectory()||fs.readdirSync(runDir).length)throw failure('workbuddy-runtime-not-empty');}else fs.mkdirSync(runDir,{recursive:true});
  fs.mkdirSync(path.join(runDir,'native'));for(const name of ['home','temp','appdata','localappdata','config','user-data','cache'])fs.mkdirSync(path.join(runDir,'native',name));
}
function seal(runDir,childKey,providerKey){
  const pending=[runDir];let files=0,bytes=0,masked=0;
  while(pending.length){const file=pending.pop(),stat=fs.lstatSync(file);if(stat.isSymbolicLink())throw failure('workbuddy-runtime-link');if(stat.isDirectory()){for(const name of fs.readdirSync(file))pending.push(path.join(file,name));continue;}
    if(!stat.isFile()||++files>4000||(bytes+=stat.size)>32*1024*1024)throw failure('workbuddy-runtime-scan-limit');
    const raw=fs.readFileSync(file);if(raw.includes(Buffer.from(providerKey)))throw failure('workbuddy-provider-key-persisted');
    if(raw.includes(Buffer.from(childKey))){const text=raw.toString('utf8');if(!Buffer.from(text).equals(raw))throw failure('workbuddy-runtime-token-binary');fs.writeFileSync(file,text.split(childKey).join('[EXPIRED_LOCAL_MODEL_TOKEN]'));masked++;}
  }
  return{files,bytes,expired_local_tokens_masked:masked,provider_key_matches:0};
}
async function bounded(task,ms){let timer;try{return await Promise.race([task,new Promise((_,reject)=>{timer=setTimeout(()=>reject(failure('workbuddy-close-timeout')),ms);})]);}finally{clearTimeout(timer);}}

/** One native WorkBuddy turn. Final output follows identity, process, proxy and key checks. */
export async function runWorkbuddyNative({runtimeRoot,runDir,workspace,providerKey,prompt,signal,emit=()=>{},ambientEnv=process.env}={}){
  validateWorkbuddyPrompt(prompt);if(process.platform!=='win32')throw failure('workbuddy-platform-unverified');
  const gateway=new WorkbuddyCompletionsGateway({providerKey,maxCalls:1}),launch=buildWorkbuddyNativeLaunch({runtimeRoot,runDir,workspace,childKey:gateway.childKey,baseUrl:'http://127.0.0.1:1/v1/chat/completions',ambientEnv,providerKey});
  kernel.verifyPinnedWorkbuddyRuntime(runtimeRoot);createRun(runDir,workspace);
  let runner,closed,exitInfo=null,stopTask=null,stop=null,identity=null,nativeResult=null,nativeClosed=false,error=null,sealed=null,watchdog;
  const safeEmit=frame=>{
    const out={protocol:WORKBUDDY_PROTOCOL,...JSON.parse(JSON.stringify(frame).split(providerKey).join('[REDACTED_PROVIDER_KEY]').split(gateway.childKey).join('[REDACTED_LOCAL_KEY]'))};
    if(Buffer.byteLength(JSON.stringify(out))>MAX_LINE_BYTES-1)throw failure('workbuddy-output-limit');emit(out);
  };
  const closeNative=()=>{
    if(stopTask)return stopTask;
    if(!runner?.child)return Promise.resolve({exited:true,code:null,tree_verified:true,owned_processes:0,remaining_owned_instances:0,reason:'not-started'});
    stopTask=(async()=>{
      let owned=[],verified=false,forced=null;
      if(runner.alive){const before=await runner.getWindowsProcessTreeSnapshot();if(runner.windowsProcessTreeIsOwned(before)){
        const ids=new Set([runner.child.pid]);for(let changed=true;changed;){changed=false;for(const row of before)if(ids.has(row.parent)&&!ids.has(row.pid)){ids.add(row.pid);changed=true;}}
        owned=before.filter(row=>ids.has(row.pid));verified=true;
      }}
      try{
        if(runner.alive){if(signal?.aborted||error)runner.sendJson({type:'control_stop'});runner.sendJson({type:'control_shutdown'});}
        await bounded(closed,10000);
      }catch{forced=await runner.stop();try{await bounded(closed,5000);}catch{}}
      const after=await runner.getWindowsProcessTreeSnapshot();if(!Array.isArray(after))verified=false;
      const remaining=Array.isArray(after)?after.filter(row=>owned.some(old=>old.pid===row.pid&&old.birth===row.birth)).length:null;
      return{exited:!runner.alive&&Boolean(exitInfo)&&verified&&remaining===0,code:exitInfo?.code??null,signal:exitInfo?.signal??null,tree_verified:verified,owned_processes:owned.length,remaining_owned_instances:remaining,owned_instances:owned,reason:forced?.reason||'native-shutdown'};
    })();stopTask.catch(()=>{});return stopTask;
  };
  const abort=()=>{if(signal.reason?.code&&signal.reason.code!=='workbuddy-stop')error=signal.reason.code.startsWith('workbuddy-')?signal.reason.code:'workbuddy-input-invalid';closeNative().catch(()=>{});};signal?.addEventListener('abort',abort,{once:true});
  gateway.on('request-started',event=>safeEmit({type:'provider',state:'started',call:event.call}));gateway.on('request-ended',event=>safeEmit({type:'provider',state:'settled',active:event.active}));
  gateway.on('request-refused',event=>safeEmit({type:'provider',state:'refused',code:event.code}));
  const framesDone=new Promise((resolve,reject)=>{
    const onLine=(line,meta)=>{
      try{
        if(meta?.truncated)throw failure('workbuddy-output-limit');const frame=JSON.parse(line);
        if(frame.protocol!==WORKBUDDY_PROTOCOL||!['started','native_result','native_closed','error'].includes(frame.type))throw failure('workbuddy-wrapper-protocol-invalid');
        if(frame.type==='started'){
          if(identity||!nativeId(frame.native_session_id)||!requestId(frame.native_request_id)||frame.native_version!==WORKBUDDY_CLI_VERSION)throw failure('workbuddy-native-identity');
          identity={sessionId:frame.native_session_id,requestId:frame.native_request_id};safeEmit(frame);
        }else if(frame.type==='native_result'){
          if(nativeResult)throw failure('workbuddy-wrapper-protocol-invalid');nativeResult=frame;
          if(frame.status==='failed')error=frame.error_code?.startsWith('workbuddy-')?frame.error_code:'workbuddy-native-failed';
          if(frame.status==='completed'&&(!identity||frame.native_session_id!==identity.sessionId||frame.native_request_id!==identity.requestId||!nativeId(frame.native_message_id)||typeof frame.text!=='string'||Buffer.byteLength(frame.text)>32000))throw failure('workbuddy-native-identity');
          closeNative().catch(()=>{});
        }else if(frame.type==='native_closed'){if(nativeClosed||frame.closed!==true)throw failure('workbuddy-native-close-failed');nativeClosed=true;resolve();}
        else throw failure(frame.code?.startsWith('workbuddy-')?frame.code:'workbuddy-native-failed');
      }catch(value){error=value.code?.startsWith('workbuddy-')?value.code:'workbuddy-wrapper-protocol-invalid';reject(failure(error));closeNative().catch(()=>{});}
    };
    // Installed on the runner before any child can produce a frame.
    launch.onLine=onLine;
  });framesDone.catch(()=>{});
  try{
    if(signal?.aborted)throw failure(signal.reason?.code||'workbuddy-stop');
    const version=spawnSync(launch.command,[path.join(runtimeRoot,'resources/app.asar.unpacked/cli/bin/codebuddy'),'--version'],{cwd:workspace,env:launch.env,windowsHide:true,timeout:10000,encoding:'utf8',maxBuffer:16384});
    if(version.status!==0||version.stdout.trim()!==WORKBUDDY_CLI_VERSION)throw failure('workbuddy-version-unverified');
    launch.env.MINIPROCTOR_WORKBUDDY_MODEL_URL=await gateway.start();if(signal?.aborted)throw failure(signal.reason?.code||'workbuddy-stop');
    runner=new WorkbuddyNativeRunner({command:launch.command,args:launch.args,cwd:workspace,env:launch.env});runner.on('line',launch.onLine);runner.on('stderr',()=>{});
    runner.on('stdin-error',()=>{error='workbuddy-control-failed';closeNative().catch(()=>{});});
    closed=new Promise(resolve=>runner.once('io-close',info=>{exitInfo=info;resolve();}));
    watchdog=setTimeout(()=>{error='workbuddy-task-timeout';closeNative().catch(()=>{});},80000);watchdog.unref();
    runner.start();runner.sendJson({type:'start',prompt});
    await Promise.race([framesDone,closed.then(()=>{if(!nativeClosed)throw failure('workbuddy-wrapper-incomplete');})]);
  }catch(value){error=value.code?.startsWith('workbuddy-')?value.code:'workbuddy-worker-failed';if(error==='workbuddy-stop'&&signal?.aborted)error=null;}
  finally{
    signal?.removeEventListener('abort',abort);clearTimeout(watchdog);
    try{stop=await closeNative();}catch{stop={exited:false,tree_verified:false};error='workbuddy-native-stop-failed';}
    await gateway.close();
    if(stop.exited){try{sealed=seal(runDir,gateway.childKey,providerKey);kernel.verifyPinnedWorkbuddyRuntime(runtimeRoot);}catch(value){error=value.code?.startsWith('workbuddy-')?value.code:'workbuddy-runtime-seal-failed';}}else error='workbuddy-native-not-exited';
  }
  const counts=gateway.summary(),cancelled=signal?.aborted&&!signal.reason?.code||signal?.aborted&&signal.reason?.code==='workbuddy-stop';
  const complete=!cancelled&&!error&&nativeResult?.status==='completed'&&nativeClosed&&stop.exited&&stop.code===0&&counts.successful===1&&counts.failed===0&&counts.rejected===0&&!counts.quota_exceeded&&sealed;
  const cancelledClean=cancelled&&!error&&stop.exited&&sealed&&(!runner?.child||nativeClosed&&nativeResult?.status==='cancelled'&&stop.code===0);
  if(!complete&&!cancelledClean&&!error)error=nativeResult?.error_code||'workbuddy-native-incomplete';
  if(complete)safeEmit({type:'message',text:sanitizeSensitiveText(nativeResult.text),native_message_id:nativeResult.native_message_id});
  const outcome={type:'result',status:complete?'completed':cancelledClean?'cancelled':'failed',error_code:error,native_diagnostic:nativeResult?.diagnostic||null,native_stop:stop,gateway:counts,runtime:sealed,native_session_id:identity?.sessionId||null,native_request_id:identity?.requestId||null};safeEmit(outcome);
  return{...outcome,exitCode:outcome.status==='failed'?2:0};
}

async function main(){
  const control=new AbortController(),input=readline.createInterface({input:process.stdin,crlfDelay:Infinity});
  const stop=()=>control.abort(failure('workbuddy-stop'));input.on('close',stop);input.on('line',line=>{try{if(Buffer.byteLength(line)>1024||JSON.parse(line).type!=='control_stop')throw failure('workbuddy-input-invalid');stop();}catch{control.abort(failure('workbuddy-input-invalid'));}});
  const emit=frame=>process.stdout.write(JSON.stringify(frame)+'\n');
  try{
    if(process.argv.length!==3)throw failure('workbuddy-prompt-invalid');
    const result=await runWorkbuddyNative({runtimeRoot:process.env.MINIPROCTOR_WORKBUDDY_RUNTIME_ROOT,runDir:process.env.MINIPROCTOR_WORKBUDDY_RUN_DIR,workspace:process.cwd(),providerKey:process.env.DEEPSEEK_API_KEY,prompt:process.argv[2],signal:control.signal,emit});process.exitCode=result.exitCode;
  }catch(error){emit({protocol:WORKBUDDY_PROTOCOL,type:'error',code:error.code?.startsWith('workbuddy-')?error.code:'workbuddy-worker-failed'});process.exitCode=2;}
  finally{input.removeAllListeners('close');input.close();process.stdin.destroy();}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
