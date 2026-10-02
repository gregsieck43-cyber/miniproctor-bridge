import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';import {fileURLToPath} from 'node:url';import {spawnSync} from 'node:child_process';
import {verifyPinnedGeminiArtifacts,verifyGeminiNode,verifyPhysicalPath,geminiFailure} from './gemini-core-runtime.js';
export const GEMINI_PROFILE_VERSION='Gemini CLI 0.61.0 / Node v24.14.0 / Core 0.61.0';
const native=fileURLToPath(new URL('./gemini-core-native.mjs',import.meta.url));
const inside=(a,b)=>{const r=path.relative(a,b);return r===''||r!=='..'&&!r.startsWith('..'+path.sep)&&!path.isAbsolute(r);};
/** The official package entry can only select its pinned core and sibling fixed Node. */
export function geminiProfileRuntime(command){
  if(typeof command!=='string'||!path.isAbsolute(command)||/[\u0000-\u001f\u007f"]/u.test(command))throw geminiFailure('gemini-profile-entry-invalid');
  const entry=path.resolve(command),suffix=path.join('node_modules','@google','gemini-cli','bundle','gemini.js');
  if(!entry.toLowerCase().endsWith((path.sep+suffix).toLowerCase()))throw geminiFailure('gemini-profile-entry-invalid');
  const sourceRoot=path.dirname(path.dirname(entry)),installRoot=path.resolve(sourceRoot,'../../..'),nodeExecutable=path.join(installRoot,'node','node-v24.14.0-win-x64','node.exe');
  return{sourceRoot,nodeExecutable};
}
/** Version-only official CLI and fixed core probe. No credentials or model calls. */
export function probeGeminiRuntime({command,dataDir}={}){
  const out={ok:false,exit_code:null,output:'',stderr:'',truncated:false,timed_out:false,error:null,version_line:null,reason:null};let scope=null,exited=false;
  try{
    const{sourceRoot,nodeExecutable}=geminiProfileRuntime(command),vendor=verifyPinnedGeminiArtifacts(sourceRoot),nodeVersion=verifyGeminiNode(nodeExecutable);
    if(typeof dataDir!=='string'||!path.isAbsolute(dataDir))throw geminiFailure('gemini-probe-state-required');dataDir=path.resolve(dataDir);verifyPhysicalPath(dataDir);
    for(const root of [sourceRoot,path.dirname(nodeExecutable)])if(inside(root,dataDir)||inside(dataDir,root))throw geminiFailure('gemini-probe-state-invalid');
    scope=path.join(dataDir,'gemini-version-probes',crypto.randomUUID());fs.mkdirSync(scope,{recursive:true});const env={};for(const n of ['SystemRoot','WINDIR','ComSpec','SystemDrive'])if(process.env[n])env[n]=process.env[n];
    for(const n of ['HOME','USERPROFILE','GEMINI_CLI_HOME','APPDATA','LOCALAPPDATA','TEMP','TMP','TMPDIR','XDG_CONFIG_HOME','XDG_DATA_HOME','XDG_STATE_HOME','XDG_CACHE_HOME','npm_config_cache'])env[n]=scope;
    Object.assign(env,{MINIPROCTOR_GEMINI_SOURCE:sourceRoot,NODE_DISABLE_COMPILE_CACHE:'1',NODE_COMPILE_CACHE:'',NODE_OPTIONS:'',NODE_PATH:'',GIT_CONFIG_GLOBAL:'NUL',GIT_CONFIG_NOSYSTEM:'1',OTEL_TRACES_EXPORTER:'none'});
    const cli=spawnSync(nodeExecutable,[command,'--version'],{cwd:scope,env,windowsHide:true,timeout:10000,encoding:'utf8',maxBuffer:8192});exited=cli.status!==null;
    if(cli.status!==0||cli.stdout.trim()!=='0.61.0')throw geminiFailure('gemini-cli-unverified');
    const r=spawnSync(nodeExecutable,[native,'--verify-runtime'],{cwd:scope,env,windowsHide:true,timeout:10000,encoding:'utf8',maxBuffer:8192});exited=r.status!==null;out.exit_code=r.status;out.timed_out=r.error?.code==='ETIMEDOUT';out.truncated=r.error?.code==='ENOBUFS';
    const checked=r.status===0&&JSON.parse(r.stdout);if(!checked||checked.node_version!==nodeVersion||checked.cli_version!==vendor.cli_version||checked.files!==vendor.files)throw geminiFailure('gemini-runtime-unverified');
    verifyPinnedGeminiArtifacts(sourceRoot);verifyGeminiNode(nodeExecutable);out.ok=true;out.output=GEMINI_PROFILE_VERSION;out.version_line=GEMINI_PROFILE_VERSION;
  }catch(e){out.reason=/^gemini-[a-z-]+$/u.test(e.code||'')?e.code:'gemini-runtime-unverified';}
  finally{if(scope&&exited){try{verifyPhysicalPath(scope);if(!inside(path.resolve(dataDir),scope))throw geminiFailure('gemini-probe-state-invalid');fs.rmSync(scope,{recursive:true});const parent=path.dirname(scope);if(fs.readdirSync(parent).length===0)fs.rmdirSync(parent);}catch{out.ok=false;out.version_line=null;out.reason='gemini-probe-cleanup-failed';}}}
  return out;
}
