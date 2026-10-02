import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {pathToFileURL} from 'node:url';

export const geminiFailure=code=>Object.assign(new Error(code),{code});
const pin=JSON.parse(fs.readFileSync(new URL('./gemini-core-pin.json',import.meta.url),'utf8'));
const sha=raw=>crypto.createHash('sha256').update(raw).digest('hex');
export function validateGeminiPrompt(prompt){
  if(typeof prompt!=='string'||!prompt.trim()||/^[!/]/u.test(prompt.trimStart())||prompt.includes('\0')
    ||Buffer.byteLength(prompt)>16000||Buffer.from(prompt).toString('utf8')!==prompt)throw geminiFailure('gemini-prompt-invalid');
}
export function verifyPhysicalPath(file){
  for(let current=path.resolve(file);;current=path.dirname(current)){
    if(fs.existsSync(current)&&fs.lstatSync(current).isSymbolicLink())throw geminiFailure('gemini-runtime-link');
    if(path.dirname(current)===current)break;
  }
}
/** Exact installed official package, including file set and physical ancestors. */
export function verifyPinnedGeminiArtifacts(sourceRoot){
  if(typeof sourceRoot!=='string'||!path.isAbsolute(sourceRoot))throw geminiFailure('gemini-source-unverified');
  verifyPhysicalPath(sourceRoot);
  const actual=[],pending=[sourceRoot];
  while(pending.length){
    const file=pending.pop(),stat=fs.lstatSync(file);
    if(stat.isSymbolicLink())throw geminiFailure('gemini-runtime-link');
    if(stat.isDirectory())for(const name of fs.readdirSync(file))pending.push(path.join(file,name));
    else if(stat.isFile())actual.push(path.relative(sourceRoot,file).replaceAll('\\','/'));
    else throw geminiFailure('gemini-source-unverified');
    if(actual.length>pin.files.length)throw geminiFailure('gemini-source-unverified');
  }
  actual.sort();const expected=pin.files.map(f=>f.path).sort();
  if(JSON.stringify(actual)!==JSON.stringify(expected))throw geminiFailure('gemini-source-unverified');
  for(const f of pin.files){const file=path.join(sourceRoot,f.path),stat=fs.statSync(file);
    if(stat.size!==f.bytes||sha(fs.readFileSync(file))!==f.sha256)throw geminiFailure('gemini-source-unverified');
  }
  return{cli_version:pin.version,files:pin.files.length};
}
export function verifyGeminiNode(nodeExecutable,{current=false}={}){
  verifyPhysicalPath(nodeExecutable);
  if(process.platform!==pin.node.platform||process.arch!==pin.node.architecture
    ||!fs.statSync(nodeExecutable).isFile()||sha(fs.readFileSync(nodeExecutable))!==pin.node.sha256
    ||current&&process.version!==pin.node.version)throw geminiFailure('gemini-node-unverified');
  return pin.node.version;
}
export function geminiConfigParameters(sessionId,workspace){return{
  sessionId,clientName:'miniproctor-gemini-core',clientVersion:pin.version,targetDir:workspace,cwd:workspace,model:'deepseek-flash',
  coreTools:[],mainAgentTools:[],mcpEnabled:false,mcpServers:{},extensionsEnabled:false,enabledExtensions:[],
  enableHooks:false,enableHooksUI:false,enableAgents:false,skillsSupport:false,adminSkillsEnabled:false,
  plan:false,tracker:false,ideMode:false,enableEventDrivenScheduler:false,folderTrust:true,trustedFolder:false,
  includeDirectoryTree:false,includeDirectories:[],userMemory:'',geminiMdFileCount:0,geminiMdFilePaths:[],memoryBoundaryMarkers:[],
  usageStatisticsEnabled:false,telemetry:{enabled:false,logPrompts:false},checkpointing:false,enableShellOutputEfficiency:false,
  enableInteractiveShell:false,useRipgrep:false,interactive:false,skipNextSpeakerCheck:true,maxSessionTurns:1,maxAttempts:1,retryFetchErrors:false,
  experimentalAutoMemory:false,experimentalGemma:false,extensionManagement:false,enableExtensionReloading:false,enableConseca:false,
  fileFiltering:{enableFileWatcher:false,enableRecursiveFileSearch:false,enableFuzzySearch:false,respectGitIgnore:false,respectGeminiIgnore:false},
  modelConfigServiceConfig:{overrides:[{match:{model:'deepseek-flash'},modelConfig:{generateContentConfig:{maxOutputTokens:512,temperature:0,thinkingConfig:{includeThoughts:false}}}}]},
};}
export async function loadGeminiCore(sourceRoot){
  verifyPinnedGeminiArtifacts(sourceRoot);verifyGeminiNode(process.execPath,{current:true});
  const core=await import(pathToFileURL(path.join(sourceRoot,pin.entry)).href);
  if(core.AuthType.GATEWAY!=='gateway'||typeof core.Config!=='function')throw geminiFailure('gemini-runtime-unverified');
  return core;
}
