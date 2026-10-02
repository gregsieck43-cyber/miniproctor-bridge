import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import kernel from './workbuddy-native-kernel.cjs';
import {workbuddyRuntimeRoot,WORKBUDDY_CLI_VERSION,WORKBUDDY_PROFILE_VERSION} from './workbuddy-native-worker.js';

const failure=code=>Object.assign(new Error(code),{code});
const inside=(parent,child)=>{const rel=path.relative(parent,child);return rel===''||rel!=='..'&&!rel.startsWith('..'+path.sep)&&!path.isAbsolute(rel);};
function physical(file){for(let current=path.resolve(file);;current=path.dirname(current)){if(fs.existsSync(current)&&fs.lstatSync(current).isSymbolicLink())throw failure('workbuddy-runtime-link');if(path.dirname(current)===current)break;}}

/** No account/model access. Verify physical vendor bytes before invoking the embedded version entry. */
export function probeWorkbuddyRuntime({command,dataDir}={}){
  const out={ok:false,exit_code:null,output:'',stderr:'',truncated:false,timed_out:false,error:null,version_line:null,reason:null};
  let scope=null,exited=false;
  try{
    const root=workbuddyRuntimeRoot(command);kernel.verifyPinnedWorkbuddyRuntime(root);
    if(typeof dataDir!=='string'||!path.isAbsolute(dataDir))throw failure('workbuddy-probe-state-required');
    dataDir=path.resolve(dataDir);physical(dataDir);
    if(inside(root,dataDir)||inside(dataDir,root))throw failure('workbuddy-probe-state-invalid');
    scope=path.join(dataDir,'workbuddy-version-probes',crypto.randomUUID());fs.mkdirSync(scope,{recursive:true});
    const env={};for(const name of ['SystemRoot','WINDIR','ComSpec','SystemDrive'])if(process.env[name])env[name]=process.env[name];
    for(const name of ['HOME','USERPROFILE','APPDATA','LOCALAPPDATA','TEMP','TMP','TMPDIR','XDG_CONFIG_HOME','XDG_DATA_HOME','XDG_CACHE_HOME','XDG_STATE_HOME','npm_config_cache'])env[name]=scope;
    Object.assign(env,{ELECTRON_RUN_AS_NODE:'1',NODE_DISABLE_COMPILE_CACHE:'1',NODE_COMPILE_CACHE:'',WORKBUDDY_DISABLE_CODE_CACHE:'1',CODEBUDDY_DISABLE_COMPILE_CACHE:'1',DISABLE_AUTOUPDATER:'1',DISABLE_TELEMETRY:'1',DISABLE_ERROR_REPORTING:'1'});
    const result=spawnSync(command,[path.join(root,'resources/app.asar.unpacked/cli/bin/codebuddy'),'--version'],{cwd:scope,env,windowsHide:true,timeout:10000,encoding:'utf8',maxBuffer:8192});
    exited=result.status!==null;out.exit_code=result.status;out.timed_out=result.error?.code==='ETIMEDOUT';out.truncated=result.error?.code==='ENOBUFS';
    if(result.status!==0||result.stdout.trim()!==WORKBUDDY_CLI_VERSION)throw failure('workbuddy-version-unverified');
    kernel.verifyPinnedWorkbuddyRuntime(root);out.ok=true;out.output=WORKBUDDY_PROFILE_VERSION;out.version_line=WORKBUDDY_PROFILE_VERSION;
  }catch(error){out.reason=error.code?.startsWith('workbuddy-')?error.code:'workbuddy-runtime-unverified';}
  finally{
    // The fixed --version entry starts no sidecar. Failed/uncertain exit keeps its unique directory.
    if(scope&&exited){try{physical(scope);fs.rmSync(scope,{recursive:true});const parent=path.dirname(scope);if(fs.readdirSync(parent).length===0)fs.rmdirSync(parent);}catch{out.ok=false;out.version_line=null;out.reason='workbuddy-probe-cleanup-failed';}}
  }
  return out;
}
