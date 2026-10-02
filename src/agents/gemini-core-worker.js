import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {AgentRunner,MAX_LINE_BYTES} from '../agent/runner.js';
import {sanitizeSensitiveText} from '../lib/events.js';
import {verifyPinnedGeminiArtifacts,verifyGeminiNode,verifyPhysicalPath,validateGeminiPrompt,geminiFailure} from './gemini-core-runtime.js';
import {GeminiModelGateway} from './gemini-model-gateway.js';
export {validateGeminiPrompt};
export const GEMINI_CORE_PROTOCOL='miniproctor-gemini-core-v1';
const nativeEntry=fileURLToPath(new URL('./gemini-core-native.mjs',import.meta.url));
const uuid=value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value);
const inside=(a,b)=>{const r=path.relative(a,b);return r===''||r!=='..'&&!r.startsWith('..'+path.sep)&&!path.isAbsolute(r);};
export class GeminiNativeRunner extends AgentRunner{
  buildChildEnv(){return{...this.env,LANG:'en_US.UTF-8',FORCE_COLOR:'0'};}
  buildSpawnOptions(mode){const launch=super.buildSpawnOptions(mode);launch.options.stdio=['pipe','pipe','pipe','ipc'];return launch;}
}
export function buildGeminiCoreLaunch({sourceRoot,nodeExecutable,runDir,workspace,baseUrl,childKey,ambientEnv=process.env}={}){
  for(const v of [sourceRoot,nodeExecutable,runDir,workspace])if(typeof v!=='string'||!path.isAbsolute(v)||/[\u0000-\u001f\u007f"]/u.test(v))throw geminiFailure('gemini-launch-path-invalid');
  sourceRoot=path.resolve(sourceRoot);nodeExecutable=path.resolve(nodeExecutable);runDir=path.resolve(runDir);workspace=path.resolve(workspace);
  const roots=[sourceRoot,path.dirname(nodeExecutable),runDir,workspace];
  if(path.basename(nodeExecutable).toLowerCase()!=='node.exe'||roots.some((a,i)=>roots.slice(i+1).some(b=>inside(a,b)||inside(b,a))))throw geminiFailure('gemini-launch-path-invalid');
  const endpoint=typeof baseUrl==='string'&&baseUrl.match(/^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})$/u);
  if(!endpoint||Number(endpoint[1])>65535||!/^[0-9a-f]{64}$/u.test(childKey||''))throw geminiFailure('gemini-local-gateway-invalid');
  const env={};for(const n of ['SystemRoot','WINDIR','ComSpec','SystemDrive','PATH','PATHEXT','PROCESSOR_ARCHITECTURE','NUMBER_OF_PROCESSORS'])if(ambientEnv[n])env[n]=ambientEnv[n];
  Object.assign(env,{HOME:path.join(runDir,'home'),USERPROFILE:path.join(runDir,'home'),GEMINI_CLI_HOME:path.join(runDir,'home'),APPDATA:path.join(runDir,'appdata'),LOCALAPPDATA:path.join(runDir,'localappdata'),TEMP:path.join(runDir,'temp'),TMP:path.join(runDir,'temp'),TMPDIR:path.join(runDir,'temp'),XDG_CONFIG_HOME:path.join(runDir,'config'),XDG_DATA_HOME:path.join(runDir,'state'),XDG_STATE_HOME:path.join(runDir,'state'),XDG_CACHE_HOME:path.join(runDir,'cache'),npm_config_cache:path.join(runDir,'cache'),NODE_DISABLE_COMPILE_CACHE:'1',NODE_COMPILE_CACHE:'',NODE_OPTIONS:'',NODE_PATH:'',GIT_CONFIG_GLOBAL:'NUL',GIT_CONFIG_NOSYSTEM:'1',OTEL_TRACES_EXPORTER:'none',MINIPROCTOR_GEMINI_SOURCE:sourceRoot,MINIPROCTOR_GEMINI_URL:baseUrl,MINIPROCTOR_GEMINI_LOCAL_KEY:childKey});
  return{command:nodeExecutable,args:[nativeEntry],env};
}
function seal(runDir,childKey,providerKey){
  const pending=[runDir];let files=0,bytes=0,masked=0;
  while(pending.length){const file=pending.pop(),stat=fs.lstatSync(file);if(stat.isSymbolicLink())throw geminiFailure('gemini-runtime-link');if(stat.isDirectory()){for(const name of fs.readdirSync(file))pending.push(path.join(file,name));continue;}
    if(!stat.isFile()||++files>4000||(bytes+=stat.size)>32*1024*1024)throw geminiFailure('gemini-runtime-scan-limit');const raw=fs.readFileSync(file);
    if(raw.includes(Buffer.from(providerKey)))throw geminiFailure('gemini-provider-key-persisted');
    if(raw.includes(Buffer.from(childKey))){const text=raw.toString('utf8');if(!Buffer.from(text).equals(raw))throw geminiFailure('gemini-runtime-token-binary');fs.writeFileSync(file,text.split(childKey).join('[EXPIRED_LOCAL_MODEL_TOKEN]'));masked++;}
  }return{files,bytes,expired_local_tokens_masked:masked,provider_key_matches:0};
}
async function bounded(task,ms){let timer;try{return await Promise.race([task,new Promise((_,reject)=>{timer=setTimeout(()=>reject(geminiFailure('gemini-close-timeout')),ms);})]);}finally{clearTimeout(timer);}}
export async function runGeminiCore({sourceRoot,nodeExecutable,runDir,workspace,providerKey,prompt,signal,emit=()=>{},ambientEnv=process.env}={}){
  validateGeminiPrompt(prompt);
  const gateway=new GeminiModelGateway({providerKey}),launch=buildGeminiCoreLaunch({sourceRoot,nodeExecutable,runDir,workspace,baseUrl:'http://127.0.0.1:1',childKey:gateway.childKey,ambientEnv});
  for(const file of [sourceRoot,nodeExecutable,runDir,workspace])verifyPhysicalPath(file);
  const verified=verifyPinnedGeminiArtifacts(sourceRoot),nodeVersion=verifyGeminiNode(nodeExecutable);
  if(!fs.statSync(workspace).isDirectory())throw geminiFailure('gemini-launch-path-invalid');
  if(fs.existsSync(runDir)){if(!fs.statSync(runDir).isDirectory()||fs.readdirSync(runDir).length)throw geminiFailure('gemini-runtime-not-empty');}else fs.mkdirSync(runDir,{recursive:true});
  for(const n of ['home','appdata','localappdata','temp','config','state','cache'])fs.mkdirSync(path.join(runDir,n));
  let runner,closed,exit=null,identity=null,nativeResult=null,error=null,stopTask=null,stop=null,sealed=null,watchdog,admissionTask=null,ready=false,submitted=false,stopRequestedAt=null,nativeStopSentAt=null;
  const owned=[],safeEmit=frame=>{const out={protocol:GEMINI_CORE_PROTOCOL,...JSON.parse(JSON.stringify(frame).split(providerKey).join('[REDACTED_PROVIDER_KEY]').split(gateway.childKey).join('[REDACTED_LOCAL_KEY]'))};if(Buffer.byteLength(JSON.stringify(out))>=MAX_LINE_BYTES)throw geminiFailure('gemini-output-limit');emit(out);};
  const capture=async()=>{const rows=await runner.getWindowsProcessTreeSnapshot();if(!runner.windowsProcessTreeIsOwned(rows))throw geminiFailure('gemini-native-ownership-unverified');const ids=new Set([runner.child.pid]);for(let changed=true;changed;){changed=false;for(const row of rows)if(ids.has(row.parent)&&!ids.has(row.pid)){ids.add(row.pid);changed=true;}}for(const row of rows.filter(r=>ids.has(r.pid)))if(!owned.some(old=>old.pid===row.pid&&old.birth===row.birth))owned.push(row);};
  const control=type=>{if(!runner?.child?.connected)return false;if(type==='control_stop')nativeStopSentAt=Date.now();runner.child.send({type},e=>{if(e&&!nativeResult&&!signal?.aborted){error='gemini-control-failed';void closeNative();}});return true;};
  // Admission owns PID+birth before any model prompt. Stop waits for that same query.
  const closeNative=()=>{
    if(stopTask)return stopTask;
    if(!runner?.child)return Promise.resolve({exited:true,code:null,tree_verified:true,owned_processes:0,remaining_owned_instances:0,reason:'not-started'});
    stopTask=(async()=>{
      let verifiedTree=false,forced=null;try{await admissionTask;verifiedTree=owned.length>0;}catch{verifiedTree=false;}
      // Admission already owns the IPC ChildProcess before any model prompt. Send its
      // private control without another CIM round trip; forced /T still verifies in
      // runner.stop(), and completion still requires fresh PID+birth instances zero.
      if(runner.alive){if(signal?.aborted||error||!nativeResult)control('control_stop');else control('control_shutdown');}
      try{await bounded(closed,4500);}catch{forced=await runner.stop();try{await bounded(closed,5000);}catch{}}
      const rows=await runner.getWindowsProcessTreeSnapshot();if(!Array.isArray(rows))verifiedTree=false;
      const remaining=Array.isArray(rows)?rows.filter(r=>owned.some(o=>r.pid===o.pid&&r.birth===o.birth)).length:null;
      return{exited:!runner.alive&&Boolean(exit)&&verifiedTree&&remaining===0,code:exit?.code??null,signal:exit?.signal??null,tree_verified:verifiedTree,owned_processes:owned.length,owned_instances:owned,remaining_owned_instances:remaining,reason:forced?.reason||'native-dispose'};
    })();stopTask.catch(()=>{});return stopTask;
  };
  const abort=()=>{stopRequestedAt=Date.now();if(signal.reason?.code&&signal.reason.code!=='gemini-stop')error=/^gemini-[a-z-]{1,64}$/u.test(signal.reason.code)?signal.reason.code:'gemini-input-invalid';void closeNative();};signal?.addEventListener('abort',abort,{once:true});
  gateway.on('request-started',e=>safeEmit({type:'provider',state:'started',call:e.call}));gateway.on('request-ended',e=>safeEmit({type:'provider',state:'settled',active:e.active}));
  try{
    if(signal?.aborted)throw geminiFailure('gemini-stop');
    const probe=spawnSync(nodeExecutable,[nativeEntry,'--verify-runtime'],{cwd:workspace,env:launch.env,windowsHide:true,timeout:10000,encoding:'utf8',maxBuffer:8192});
    const checked=probe.status===0&&JSON.parse(probe.stdout);if(!checked||checked.node_version!==nodeVersion||checked.cli_version!==verified.cli_version||checked.files!==verified.files)throw geminiFailure('gemini-runtime-unverified');
    if(signal?.aborted)throw geminiFailure('gemini-stop');launch.env.MINIPROCTOR_GEMINI_URL=await gateway.start();if(signal?.aborted)throw geminiFailure('gemini-stop');
    runner=new GeminiNativeRunner({command:launch.command,args:launch.args,cwd:workspace,env:launch.env});
    const submit=async()=>{await admissionTask;if(signal?.aborted||error||submitted||!ready)return;submitted=true;runner.child.send({type:'start',prompt},e=>{if(e){error='gemini-control-failed';void closeNative();}});};
    runner.on('line',(line,meta)=>{if(meta?.truncated||line.includes(providerKey)||line.includes(gateway.childKey)){error='gemini-native-log-invalid';void closeNative();}});
    runner.on('stderr',text=>{if(text.includes(providerKey)||text.includes(gateway.childKey)){error='gemini-native-log-invalid';void closeNative();}});
    closed=new Promise(resolve=>runner.once('io-close',info=>{exit=info;resolve();}));
    runner.start();runner.child.on('error',()=>{error='gemini-native-spawn-failed';void closeNative();});
    runner.child.on('message',raw=>{try{
      if(!raw||raw.protocol!=='miniproctor-gemini-kernel-v1'||Buffer.byteLength(JSON.stringify(raw))>64000||JSON.stringify(raw).includes(providerKey)||JSON.stringify(raw).includes(gateway.childKey))throw geminiFailure('gemini-wrapper-protocol-invalid');
      if(raw.type==='ready'){if(ready||raw.cli_version!==verified.cli_version||raw.files!==verified.files||raw.tool_count!==0||raw.hooks!==false||raw.mcp!==false||raw.agents!==false||raw.extensions!==0||raw.workspace_trusted!==false)throw geminiFailure('gemini-native-permissions-unverified');ready=true;void submit().catch(()=>{error='gemini-native-ownership-unverified';void closeNative();});}
      else if(raw.type==='started'){if(!submitted||identity||!uuid(raw.native_session_id)||raw.native_version!==verified.cli_version)throw geminiFailure('gemini-native-identity');identity=raw.native_session_id;safeEmit({type:'started',native_session_id:identity,native_version:verified.cli_version});}
      else if(raw.type==='result'){
        if(nativeResult||raw.cli_version!==verified.cli_version||raw.files!==verified.files||raw.tool_count!==0||!Array.isArray(raw.native_events)||raw.native_events.length>512
          ||raw.native_events.some((e,i)=>e.sequence!==i+1||!['model_info','content','finished','user_cancelled','error','thought'].includes(e.type)))throw geminiFailure('gemini-native-result-invalid');
        if(identity?raw.native_session_id!==identity:raw.status!=='cancelled'||raw.native_events.length!==0||gateway.summary().contacted!==0||raw.native_session_id!==null)throw geminiFailure('gemini-native-identity');
        if(raw.status==='completed'&&(typeof raw.text!=='string'||!raw.text.trim()||Buffer.byteLength(raw.text)>32000||raw.error_code||!raw.native_events.some(e=>e.type==='finished')))throw geminiFailure('gemini-native-result-invalid');
        nativeResult=raw;void closeNative();
      }else throw geminiFailure('gemini-wrapper-protocol-invalid');
    }catch(e){error=/^gemini-[a-z-]{1,64}$/u.test(e.code||'')?e.code:'gemini-wrapper-protocol-invalid';void closeNative();}});
    admissionTask=capture();watchdog=setTimeout(()=>{error='gemini-task-timeout';void closeNative();},120000);watchdog.unref();await admissionTask;await submit();await closed;
  }catch(e){error=/^gemini-[a-z-]{1,64}$/u.test(e.code||'')?e.code:'gemini-worker-failed';if(error==='gemini-stop'&&signal?.aborted)error=null;}
  finally{
    signal?.removeEventListener('abort',abort);clearTimeout(watchdog);
    try{stop=await closeNative();}catch{stop={exited:false,tree_verified:false};error='gemini-native-stop-failed';}
    await gateway.close();if(stop.exited){try{sealed=seal(runDir,gateway.childKey,providerKey);verifyPinnedGeminiArtifacts(sourceRoot);verifyGeminiNode(nodeExecutable);}catch(e){error=e.code||'gemini-runtime-seal-failed';}}else error='gemini-native-not-exited';
  }
  const counts=gateway.summary(),cancelled=signal?.aborted&&(!signal.reason?.code||signal.reason.code==='gemini-stop');
  const complete=!cancelled&&!error&&identity&&nativeResult?.status==='completed'&&stop.exited&&stop.code===0&&counts.contacted===1&&counts.successful===1&&counts.failed===0&&counts.rejected===0&&!counts.quota_exceeded&&sealed;
  const cancelledClean=cancelled&&!error&&stop.exited&&sealed&&(!runner?.child||nativeResult?.status==='cancelled'&&!nativeResult.error_code&&stop.code===0);
  if(!complete&&!cancelledClean&&!error)error=(nativeResult?.error_code==='gemini-native-model-failed'&&counts.last_failure_code)||nativeResult?.error_code||'gemini-native-incomplete';
  if(complete)safeEmit({type:'message',text:sanitizeSensitiveText(nativeResult.text)});
  const outcome={type:'result',status:complete?'completed':cancelledClean?'cancelled':'failed',error_code:error,native_admission:identity?'accepted':'not-accepted',native_session_id:identity,native_event_count:nativeResult?.native_events.length||0,native_control:{stop_requested_at:stopRequestedAt,stop_sent_at:nativeStopSentAt,stop_received_at:nativeResult?.control_stop_received_at??null,signal_aborted:nativeResult?.signal_aborted??null},native_stop:stop,gateway:counts,runtime:sealed};safeEmit(outcome);return{...outcome,exitCode:outcome.status==='failed'?2:0};
}
async function main(){
  const control=new AbortController(),input=readline.createInterface({input:process.stdin,crlfDelay:Infinity}),stop=()=>control.abort(geminiFailure('gemini-stop'));
  input.on('close',stop);input.on('line',line=>{try{const f=JSON.parse(line);if(Buffer.byteLength(line)>1024||f.type!=='control_stop'||Object.keys(f).length!==1)throw geminiFailure('gemini-input-invalid');stop();}catch{control.abort(geminiFailure('gemini-input-invalid'));}});
  const emit=frame=>process.stdout.write(JSON.stringify(frame)+'\n');
  try{if(process.argv.length!==3)throw geminiFailure('gemini-prompt-invalid');const result=await runGeminiCore({sourceRoot:process.env.MINIPROCTOR_GEMINI_SOURCE,nodeExecutable:process.env.MINIPROCTOR_GEMINI_NODE,runDir:process.env.MINIPROCTOR_GEMINI_RUN_DIR,workspace:process.cwd(),providerKey:process.env.DEEPSEEK_API_KEY,prompt:process.argv[2],signal:control.signal,emit});process.exitCode=result.exitCode;}
  catch(e){emit({protocol:GEMINI_CORE_PROTOCOL,type:'error',code:/^gemini-[a-z-]{1,64}$/u.test(e.code||'')?e.code:'gemini-worker-failed'});process.exitCode=2;}
  finally{input.removeAllListeners('close');input.close();process.stdin.destroy();}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
