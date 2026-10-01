import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import readline from 'node:readline';
import {spawnSync} from 'node:child_process';
import {AgentRunner,MAX_LINE_BYTES} from '../agent/runner.js';
import {sanitizeSensitiveText} from '../lib/events.js';
import {DshSdkClient,DSH_RUNTIME_VERSION} from './dsh-sdk-client.js';
import {DshMessagesGateway} from './dsh-messages-gateway.js';

export const DSH_SDK_PROTOCOL='miniproctor-dsh-sdk-v1';
const failure=code=>Object.assign(new Error(code),{code});
const fixedPatch=fileURLToPath(new URL('./dsh-restricted.patch.json',import.meta.url));
const contains=(parent,child)=>{const rel=path.relative(parent,child);return rel===''||(!rel.startsWith('..'+path.sep)&&rel!=='..'&&!path.isAbsolute(rel));};

/** Local frozen entry only; no native flags, model URL or credential supplied by phone commands. */
export function buildDshSdkLaunch({runDir,workspace,nativeEntry,childKey,baseUrl,ambientEnv=process.env,providerKey=null}={}){
 for(const value of [runDir,workspace,nativeEntry])if(typeof value!=='string'||!path.isAbsolute(value)||/[\u0000-\u001f\u007f"]/.test(value))throw failure('dsh-launch-path-invalid');
 runDir=path.resolve(runDir);workspace=path.resolve(workspace);
 if(contains(workspace,runDir))throw failure('dsh-runtime-inside-workspace');
 if(typeof childKey!=='string'||!/^[0-9a-f]{64}$/.test(childKey)||typeof baseUrl!=='string'||!/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/v1\/messages$/.test(baseUrl))throw failure('dsh-local-gateway-invalid');
 const env={...ambientEnv};for(const name of Object.keys(env)){
  if(/TOKEN|SECRET|KEY|PASSWORD|CREDENTIAL|AUTH|CONNECTIONSTRING|CONNECTION_STRING|DSH|NODE_OPTIONS|TSX_/i.test(name)
    ||(typeof providerKey==='string'&&providerKey&&typeof env[name]==='string'&&env[name].includes(providerKey)))env[name]='';
 }
 Object.assign(env,{MINIPROCTOR_DSH_PROXY_KEY:childKey,DSH_HOME:path.join(runDir,'home/dsh'),HOME:path.join(runDir,'home'),USERPROFILE:path.join(runDir,'home'),APPDATA:path.join(runDir,'appdata'),LOCALAPPDATA:path.join(runDir,'localappdata'),TEMP:path.join(runDir,'temp'),TMP:path.join(runDir,'temp'),TMPDIR:path.join(runDir,'temp'),XDG_CONFIG_HOME:path.join(runDir,'home'),XDG_CACHE_HOME:path.join(runDir,'cache'),XDG_DATA_HOME:path.join(runDir,'state'),XDG_STATE_HOME:path.join(runDir,'state'),npm_config_cache:path.join(runDir,'cache'),NODE_DISABLE_COMPILE_CACHE:'1',NODE_COMPILE_CACHE:''});
 const config=JSON.parse(fs.readFileSync(fixedPatch,'utf8')).find(row=>row.id==='llm-deepseek')?.config;
 return {command:process.execPath,args:[nativeEntry,'--profile','sdk-minimal','--patch',fixedPatch,'--patch',path.join(runDir,'connection.patch.json')],env,connection:{id:'llm-deepseek',config:{...config,baseURL:baseUrl.replace(/\/messages$/,''),apiKeyEnv:'MINIPROCTOR_DSH_PROXY_KEY'}}};
}

function physical(value){let current=path.resolve(value);for(;;){if(fs.existsSync(current)&&fs.lstatSync(current).isSymbolicLink())throw failure('dsh-runtime-link');const parent=path.dirname(current);if(parent===current)break;current=parent;}}
function createRun(runDir,workspace,nativeEntry){
 for(const value of [runDir,workspace,nativeEntry])physical(value);
 if(!fs.statSync(workspace).isDirectory()||!fs.statSync(nativeEntry).isFile())throw failure('dsh-launch-path-invalid');
 if(fs.existsSync(runDir)){if(!fs.statSync(runDir).isDirectory()||fs.readdirSync(runDir).length)throw failure('dsh-runtime-not-empty');}else fs.mkdirSync(runDir,{recursive:true});
 for(const name of ['home','appdata','localappdata','temp','cache','state'])fs.mkdirSync(path.join(runDir,name));
}
function seal(runDir,childKey,providerKey){
 const pending=[runDir];let files=0,bytes=0,masked=0;
 while(pending.length){const current=pending.pop(),stat=fs.lstatSync(current);if(stat.isSymbolicLink())throw failure('dsh-runtime-link');if(stat.isDirectory()){for(const name of fs.readdirSync(current))pending.push(path.join(current,name));continue;}
  if(++files>4000||(bytes+=stat.size)>32*1024*1024)throw failure('dsh-runtime-scan-limit');
  const raw=fs.readFileSync(current);if(raw.includes(Buffer.from(providerKey)))throw failure('dsh-provider-key-persisted');
  if(raw.includes(Buffer.from(childKey))){const text=raw.toString('utf8');if(!Buffer.from(text).equals(raw))throw failure('dsh-runtime-token-binary');fs.writeFileSync(current,text.split(childKey).join('[EXPIRED_LOCAL_PROXY_KEY]'));masked++;}
 }
 return{files,bytes,expired_local_tokens_masked:masked,provider_key_matches:0};
}
async function bounded(task,ms){let timer;try{return await Promise.race([task,new Promise((_,reject)=>{timer=setTimeout(()=>reject(failure('dsh-native-close-timeout')),ms);})]);}finally{clearTimeout(timer);}}

/** One native SDK root, one prompt; completion follows verified process/IO and proxy closure. */
export async function runDshSdk({nativeEntry,runDir,workspace,providerKey,prompt,signal,emit=()=>{},ambientEnv=process.env}={}){
 if(process.platform!=='win32')throw failure('dsh-platform-unverified');
 if(typeof prompt!=='string'||!prompt.trim()||Buffer.byteLength(prompt,'utf8')>16000)throw failure('dsh-prompt-invalid');
 const gateway=new DshMessagesGateway({providerKey}),launch=buildDshSdkLaunch({nativeEntry,runDir,workspace,childKey:gateway.childKey,baseUrl:'http://127.0.0.1:1/v1/messages',ambientEnv,providerKey});
 createRun(runDir,workspace,nativeEntry);
 let runner,client,stopTask,closed,exitInfo=null,result=null,error=null,stop=null,sealed=null;
 const safeEmit=frame=>{const clean=JSON.parse(JSON.stringify(frame).split(providerKey).join('[REDACTED_PROVIDER_KEY]').split(gateway.childKey).join('[REDACTED_LOCAL_KEY]'));const out={protocol:DSH_SDK_PROTOCOL,...clean};if(Buffer.byteLength(JSON.stringify(out),'utf8')>MAX_LINE_BYTES-1)throw failure('dsh-wrapper-output-limit');emit(out);};
 const stopNative=()=>{
  if(stopTask)return stopTask;
  if(!runner?.child)return Promise.resolve({exited:true,code:null,reason:'not-started',tree_verified:true,remaining_owned_instances:0,owned_processes:0});
  stopTask=(async()=>{
   let owned=[],verified=false,forced=null;
   if(runner.alive){const tree=await runner.getWindowsProcessTreeSnapshot();if(runner.windowsProcessTreeIsOwned(tree)){
     const ids=new Set([runner.child.pid]);for(let changed=true;changed;){changed=false;for(const row of tree)if(ids.has(row.parent)&&!ids.has(row.pid)){ids.add(row.pid);changed=true;}}
     owned=tree.filter(row=>ids.has(row.pid));verified=true;
   }}
   try{await bounded(client.shutdown(),4500);await bounded(closed,4500);}catch{forced=await runner.stop();try{await bounded(closed,5000);}catch{}}
   const after=await runner.getWindowsProcessTreeSnapshot();if(!Array.isArray(after))verified=false;
   const remaining=Array.isArray(after)?after.filter(row=>owned.some(old=>old.pid===row.pid&&old.birth===row.birth)).length:null;
   return{exited:!runner.alive&&Boolean(exitInfo)&&verified&&remaining===0,code:exitInfo?.code??null,signal:exitInfo?.signal??null,reason:forced?.reason||'sdk-shutdown',tree_verified:verified,owned_processes:owned.length,remaining_owned_instances:remaining};
  })();stopTask.catch(()=>{});return stopTask;
 };
 const abort=()=>{stopNative().catch(()=>{});};
 gateway.on('request-started',event=>safeEmit({type:'provider',state:'started',call:event.call}));gateway.on('request-ended',event=>safeEmit({type:'provider',state:'settled',active:event.active}));
 signal?.addEventListener('abort',abort,{once:true});
 try{
  if(signal?.aborted)throw failure('dsh-stop');
  const version=spawnSync(process.execPath,[nativeEntry,'--version'],{cwd:workspace,env:launch.env,encoding:'utf8',windowsHide:true,timeout:10000,maxBuffer:16384});
  if(version.status!==0||version.stdout.trim()!==DSH_RUNTIME_VERSION)throw failure('dsh-version-unverified');
  launch.connection.config.baseURL=(await gateway.start()).replace(/\/messages$/,'');
  fs.writeFileSync(path.join(runDir,'connection.patch.json'),JSON.stringify([launch.connection])+'\n',{flag:'wx'});
  if(signal?.aborted)throw failure('dsh-stop');
  runner=new AgentRunner({command:launch.command,args:launch.args,env:launch.env,cwd:workspace});
  client=new DshSdkClient({send:frame=>runner.sendJson(frame),maxTextBytes:32000});
  client.on('accepted',accepted=>safeEmit({type:'started',native_session_id:accepted.sessionId,native_message_id:accepted.messageId,native_version:DSH_RUNTIME_VERSION}));
  runner.on('line',(line,meta)=>{if(meta?.truncated)client.acceptLine('');else client.acceptLine(line);});runner.on('stderr',()=>{});runner.on('stdin-error',()=>client.close());
  closed=new Promise(resolve=>runner.once('io-close',info=>{exitInfo=info;client.close();resolve();}));runner.start();
  await client.initialize(workspace,'s_'+crypto.randomUUID());
  if(signal?.aborted)throw failure('dsh-stop');
  result=await client.prompt(prompt);
 }catch(value){error=typeof value?.code==='string'&&/^dsh-[a-z-]+$/.test(value.code)?value.code:'dsh-worker-failed';}
 finally{
  signal?.removeEventListener('abort',abort);
  try{stop=await stopNative();}catch{stop={exited:false,tree_verified:false};error='dsh-native-stop-failed';}
  await gateway.close();client?.close();
  if(stop.exited){try{sealed=seal(runDir,gateway.childKey,providerKey);}catch(value){error=value.code||'dsh-runtime-seal-failed';}}else error='dsh-native-not-exited';
 }
 const cancelled=signal?.aborted&&(typeof signal.reason?.code!=='string'||signal.reason.code==='dsh-stop'),counts=gateway.summary();
 if(typeof signal?.reason?.code==='string'&&signal.reason.code!=='dsh-stop')error=signal.reason.code;
 const complete=!cancelled&&!error&&result?.finishReason==='completed'&&stop.exited&&stop.code===0&&counts.successful>0&&counts.failed===0&&counts.rejected===0&&!counts.quota_exceeded&&sealed;
 // Cancellation may interrupt an upstream request; its failed count cannot become read success.
 const cancelledClean=cancelled&&stop.exited&&sealed&&!['dsh-provider-key-persisted','dsh-native-not-exited','dsh-native-stop-failed'].includes(error);
 if(!complete&&!cancelledClean&&!error)error='dsh-native-incomplete';
 if(complete)safeEmit({type:'message',text:sanitizeSensitiveText(result.text)});
 const outcome={type:'result',status:complete?'completed':cancelledClean?'cancelled':'failed',finish_reason:result?.finishReason||null,error_code:error,native_stop:stop,gateway:counts,runtime:sealed};safeEmit(outcome);
 return{...outcome,exitCode:outcome.status==='failed'?2:0};
}

async function main(){
 const control=new AbortController(),input=readline.createInterface({input:process.stdin,crlfDelay:Infinity}),stop=()=>control.abort(failure('dsh-stop'));
 input.on('close',stop);input.on('line',line=>{try{if(Buffer.byteLength(line)>1024)throw failure('dsh-input-invalid');const frame=JSON.parse(line);if(frame.type==='control_stop')stop();else control.abort(failure('dsh-input-invalid'));}catch{control.abort(failure('dsh-input-invalid'));}});
 const write=frame=>process.stdout.write(JSON.stringify(frame)+'\n');
 try{if(process.argv.length!==3)throw failure('dsh-prompt-invalid');const result=await runDshSdk({nativeEntry:process.env.MINIPROCTOR_DSH_ENTRY,runDir:process.env.MINIPROCTOR_DSH_RUN_DIR,workspace:process.cwd(),providerKey:process.env.DEEPSEEK_API_KEY,prompt:process.argv[2],signal:control.signal,emit:write});process.exitCode=result.exitCode;}
 catch(error){write({protocol:DSH_SDK_PROTOCOL,type:'error',code:typeof error.code==='string'&&/^dsh-[a-z-]+$/.test(error.code)?error.code:'dsh-worker-failed'});process.exitCode=2;}
 finally{input.removeAllListeners('close');input.close();process.stdin.destroy();}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
