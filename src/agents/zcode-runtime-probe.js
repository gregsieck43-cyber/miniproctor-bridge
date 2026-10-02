import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';import {fileURLToPath} from 'node:url';import {spawnSync} from 'node:child_process';
import {verifyPinnedZCodeArtifacts} from './zcode-sdk-runtime.js';
const pin=JSON.parse(fs.readFileSync(new URL('./zcode-node-pin.json',import.meta.url),'utf8')),native=fileURLToPath(new URL('./zcode-sdk-native.mjs',import.meta.url)),failure=code=>Object.assign(new Error(code),{code});
export const ZCODE_PROFILE_VERSION='ZCode CLI 0.16.9 / Node v24.14.0 / SDK 29628c9';
const inside=(a,b)=>{const r=path.relative(a,b);return r===''||r!=='..'&&!r.startsWith('..'+path.sep)&&!path.isAbsolute(r);};
function physical(file){for(let current=path.resolve(file);;current=path.dirname(current)){if(fs.existsSync(current)&&fs.lstatSync(current).isSymbolicLink())throw failure('zcode-runtime-link');if(path.dirname(current)===current)break;}}
/** Local official CLI reference selects only its pinned SDK and sibling pinned Node. */
export function zcodeProfileRuntime(command){
 if(typeof command!=='string'||!path.isAbsolute(command)||/[\u0000-\u001f\u007f"]/u.test(command))throw failure('zcode-profile-entry-invalid');
 const entry=path.resolve(command),suffix=path.join('apps','zcode-cli','packages','cli','dist','zcode.cjs');if(!entry.toLowerCase().endsWith((path.sep+suffix).toLowerCase()))throw failure('zcode-profile-entry-invalid');
 const sourceRoot=entry.slice(0,-suffix.length-1),nodeExecutable=path.join(path.dirname(sourceRoot),'node','node-v24.14.0-win-x64','node.exe');return{sourceRoot,nodeExecutable};
}
/** No bootstrap, account or model. Pin all vendor bytes before the fixed kernel probe. */
export function probeZCodeRuntime({command,dataDir}={}){
 const out={ok:false,exit_code:null,output:'',stderr:'',truncated:false,timed_out:false,error:null,version_line:null,reason:null};let scope=null,exited=false;
 try{if(process.platform!==pin.platform||process.arch!==pin.architecture)throw failure('zcode-platform-unverified');const {sourceRoot,nodeExecutable}=zcodeProfileRuntime(command),vendor=verifyPinnedZCodeArtifacts(sourceRoot);physical(nodeExecutable);if(crypto.createHash('sha256').update(fs.readFileSync(nodeExecutable)).digest('hex')!==pin.sha256)throw failure('zcode-node-unverified');
  if(typeof dataDir!=='string'||!path.isAbsolute(dataDir))throw failure('zcode-probe-state-required');dataDir=path.resolve(dataDir);physical(dataDir);for(const root of [sourceRoot,path.dirname(nodeExecutable)])if(inside(root,dataDir)||inside(dataDir,root))throw failure('zcode-probe-state-invalid');
  scope=path.join(dataDir,'zcode-version-probes',crypto.randomUUID());fs.mkdirSync(scope,{recursive:true});const env={};for(const n of ['SystemRoot','WINDIR','ComSpec','SystemDrive'])if(process.env[n])env[n]=process.env[n];for(const n of ['HOME','USERPROFILE','APPDATA','LOCALAPPDATA','TEMP','TMP','TMPDIR','XDG_CONFIG_HOME','XDG_DATA_HOME','XDG_STATE_HOME','XDG_CACHE_HOME','npm_config_cache'])env[n]=scope;Object.assign(env,{MINIPROCTOR_ZCODE_SOURCE:sourceRoot,NODE_DISABLE_COMPILE_CACHE:'1',NODE_COMPILE_CACHE:'',NODE_OPTIONS:'',NODE_PATH:'',GIT_CONFIG_GLOBAL:'NUL',GIT_CONFIG_NOSYSTEM:'1',OTEL_TRACES_EXPORTER:'none'});
  const r=spawnSync(nodeExecutable,[native,'--verify-runtime'],{cwd:scope,env,windowsHide:true,timeout:10000,encoding:'utf8',maxBuffer:8192});exited=r.status!==null;out.exit_code=r.status;out.timed_out=r.error?.code==='ETIMEDOUT';out.truncated=r.error?.code==='ENOBUFS';const checked=r.status===0&&JSON.parse(r.stdout);if(!checked||checked.node_version!==pin.version||checked.cli_version!==vendor.cli_version||checked.source_commit!==vendor.source_commit||checked.files!==vendor.files)throw failure('zcode-runtime-unverified');verifyPinnedZCodeArtifacts(sourceRoot);if(crypto.createHash('sha256').update(fs.readFileSync(nodeExecutable)).digest('hex')!==pin.sha256)throw failure('zcode-node-unverified');out.ok=true;out.output=ZCODE_PROFILE_VERSION;out.version_line=ZCODE_PROFILE_VERSION;
 }catch(error){out.reason=/^zcode-[a-z-]+$/u.test(error.code||'')?error.code:'zcode-runtime-unverified';}
 finally{if(scope&&exited){try{physical(scope);fs.rmSync(scope,{recursive:true});const parent=path.dirname(scope);if(fs.readdirSync(parent).length===0)fs.rmdirSync(parent);}catch{out.ok=false;out.version_line=null;out.reason='zcode-probe-cleanup-failed';}}}return out;
}
