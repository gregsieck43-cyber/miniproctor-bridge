import http from 'node:http';
import crypto from 'node:crypto';
import {EventEmitter} from 'node:events';
import {geminiFailure} from './gemini-core-runtime.js';

const route='/v1beta/models/deepseek-flash:streamGenerateContent?alt=sse';
const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
const keys=(value,allowed)=>object(value)&&Object.keys(value).every(k=>allowed.includes(k));
function messagesFrom(value){
  if(!keys(value,['contents','systemInstruction','generationConfig','tools','toolConfig'])
    ||!keys(value.generationConfig,['maxOutputTokens','temperature','topP','topK','thinkingConfig','responseMimeType'])
    ||!Number.isSafeInteger(value.generationConfig.maxOutputTokens)||value.generationConfig.maxOutputTokens<1||value.generationConfig.maxOutputTokens>512
    ||!Array.isArray(value.contents)||value.contents.length<1||value.contents.length>12)throw geminiFailure('gemini-gateway-body-invalid');
  if(value.tools!==undefined&&(!Array.isArray(value.tools)||value.tools.some(t=>!keys(t,['functionDeclarations'])||t.functionDeclarations!==undefined&&(!Array.isArray(t.functionDeclarations)||t.functionDeclarations.length))))throw geminiFailure('gemini-gateway-tools-disabled');
  if(value.toolConfig!==undefined&&(!keys(value.toolConfig,['functionCallingConfig'])||!keys(value.toolConfig.functionCallingConfig,['mode'])||value.toolConfig.functionCallingConfig.mode!=='NONE'))throw geminiFailure('gemini-gateway-tools-disabled');
  const text=parts=>{if(!Array.isArray(parts)||parts.length<1||parts.length>64||parts.some(p=>!keys(p,['text'])||typeof p.text!=='string'))throw geminiFailure('gemini-gateway-text-required');return parts.map(p=>p.text).join('\n');};
  const messages=[];
  if(value.systemInstruction!==undefined){if(!keys(value.systemInstruction,['parts','role'])||value.systemInstruction.role!==undefined&&!['system','user'].includes(value.systemInstruction.role))throw geminiFailure('gemini-gateway-body-invalid');messages.push({role:'system',content:text(value.systemInstruction.parts)});}
  for(const c of value.contents){if(!keys(c,['role','parts'])||!['user','model'].includes(c.role))throw geminiFailure('gemini-gateway-body-invalid');messages.push({role:c.role==='model'?'assistant':'user',content:text(c.parts)});}
  return messages;
}
function readRequest(request){return new Promise((resolve,reject)=>{
  let bytes=0;const chunks=[],cleanup=()=>{clearTimeout(timer);request.off('data',data);request.off('end',end);request.off('error',error);request.off('aborted',error);};
  const error=()=>{cleanup();reject(geminiFailure('gemini-gateway-body-failed'));};
  const end=()=>{cleanup();resolve(Buffer.concat(chunks));};
  const data=chunk=>{bytes+=chunk.length;if(bytes>2*1024*1024){cleanup();request.resume();reject(geminiFailure('gemini-gateway-body-limit'));}else chunks.push(chunk);};
  const timer=setTimeout(()=>{cleanup();request.resume();reject(geminiFailure('gemini-gateway-body-timeout'));},5000);
  request.on('data',data);request.once('end',end);request.once('error',error);request.once('aborted',error);
});}
async function readResponse(response,key,signal){
  if(!response.ok||!response.body)throw geminiFailure('gemini-gateway-upstream-failed');
  const reader=response.body.getReader(),chunks=[];let bytes=0;
  const abort=()=>{reader.cancel().catch(()=>{});};signal.addEventListener('abort',abort,{once:true});
  try{for(;;){if(signal.aborted)throw geminiFailure('gemini-stop');const {done,value}=await reader.read();if(done)break;bytes+=value.length;if(bytes>2*1024*1024)throw geminiFailure('gemini-gateway-response-limit');chunks.push(Buffer.from(value));}
    const raw=Buffer.concat(chunks);if(raw.includes(Buffer.from(key)))throw geminiFailure('gemini-gateway-credential-echo');return JSON.parse(raw.toString('utf8'));
  }finally{signal.removeEventListener('abort',abort);await reader.cancel().catch(()=>{});reader.releaseLock();}
}
/** One buffered native-Gemini wire response; real provider key stays in this parent. */
export class GeminiModelGateway extends EventEmitter{
  #key;#childKey=crypto.randomBytes(32).toString('hex');#fetch;#server;#closing;#controllers=new Set();#tasks=new Set();#lastFailure=null;
  #counts={contacted:0,successful:0,failed:0,rejected:0,quota_exceeded:false};
  constructor({providerKey,fetchImpl=globalThis.fetch}={}){super();if(typeof providerKey!=='string'||providerKey.length<9||/[\r\n\0]/u.test(providerKey))throw geminiFailure('gemini-provider-key-missing');this.#key=providerKey;this.#fetch=fetchImpl;}
  get childKey(){return this.#childKey;}
  get baseUrl(){const a=this.#server?.address();if(!a||typeof a!=='object')throw geminiFailure('gemini-gateway-not-listening');return`http://127.0.0.1:${a.port}`;}
  async start(){if(this.#server||this.#closing)throw geminiFailure('gemini-gateway-start-state');this.#server=http.createServer((request,response)=>{const task=this.#serve(request,response);this.#tasks.add(task);task.finally(()=>this.#tasks.delete(task));});this.#server.maxHeadersCount=64;this.#server.headersTimeout=5000;this.#server.requestTimeout=5000;
    await new Promise((resolve,reject)=>{this.#server.once('error',reject);this.#server.listen(0,'127.0.0.1',()=>{this.#server.off('error',reject);resolve();});});return this.baseUrl;
  }
  async #serve(request,response){
    const refuse=(status,count=true)=>{if(count)this.#counts.rejected++;if(!response.destroyed){response.writeHead(status);response.end(JSON.stringify({error:{code:status,message:'Gemini local route refused'}}));}request.resume();};
    if(this.#closing||request.socket.remoteAddress!=='127.0.0.1'||request.headers['x-goog-api-key']!==this.#childKey){refuse(401,false);return;}
    if(request.url!==route){refuse(404);return;}if(request.method!=='POST'){refuse(405);return;}
    let messages,maxTokens;
    try{const body=await readRequest(request);if(body.includes(Buffer.from(this.#key)))throw geminiFailure('gemini-gateway-key-in-body');const value=JSON.parse(body);messages=messagesFrom(value);maxTokens=value.generationConfig.maxOutputTokens;}
    catch(e){refuse(e.code==='gemini-gateway-body-limit'?413:e.code==='gemini-gateway-body-timeout'?408:400);return;}
    if(this.#counts.contacted>=1){this.#counts.quota_exceeded=true;refuse(429);return;}
    const control=new AbortController(),timer=setTimeout(()=>control.abort(),45000),lost=()=>{if(!response.writableFinished)control.abort();};this.#controllers.add(control);response.once('close',lost);
    try{this.#counts.contacted++;this.emit('request-started',{call:this.#counts.contacted});
      const upstream=await this.#fetch('https://api.deepseek.com/chat/completions',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+this.#key},redirect:'error',signal:control.signal,body:JSON.stringify({model:'deepseek-flash',messages,max_tokens:maxTokens,stream:false,thinking:{type:'disabled'}})});
      const value=await readResponse(upstream,this.#key,control.signal),choice=value.choices?.[0],content=choice?.message?.content,usage=value.usage;
      if(choice?.finish_reason==='length')throw geminiFailure('gemini-gateway-response-truncated');
      if(value.choices.length!==1||choice.finish_reason!=='stop'||typeof content!=='string'||!content.trim()||Buffer.byteLength(content)>32000||choice.message.tool_calls?.length
        ||!usage||![usage.prompt_tokens,usage.completion_tokens,usage.total_tokens].every(n=>Number.isSafeInteger(n)&&n>=0)||usage.total_tokens!==usage.prompt_tokens+usage.completion_tokens)throw geminiFailure('gemini-gateway-response-invalid');
      const wire={candidates:[{index:0,content:{role:'model',parts:[{text:content}]},finishReason:'STOP'}],modelVersion:'deepseek-flash',responseId:typeof value.id==='string'?value.id:undefined,usageMetadata:{promptTokenCount:usage.prompt_tokens,candidatesTokenCount:usage.completion_tokens,totalTokenCount:usage.total_tokens}};
      if(control.signal.aborted)throw geminiFailure('gemini-stop');response.writeHead(200,{'Content-Type':'text/event-stream'});response.end('data: '+JSON.stringify(wire)+'\n\n');this.#counts.successful++;
    }catch(e){this.#counts.failed++;const allowed=new Set(['gemini-gateway-response-truncated','gemini-gateway-response-invalid','gemini-gateway-response-limit','gemini-gateway-credential-echo','gemini-gateway-upstream-failed','gemini-stop']);this.#lastFailure=control.signal.aborted?'gemini-stop':allowed.has(e.code)?e.code:'gemini-gateway-upstream-failed';if(!response.destroyed){if(!response.headersSent)response.writeHead(502);response.end(JSON.stringify({error:{code:502,message:'Gemini upstream request failed'}}));}}
    finally{clearTimeout(timer);response.off('close',lost);this.#controllers.delete(control);this.emit('request-ended',{active:this.#controllers.size});}
  }
  summary(){return{...this.#counts,active:this.#controllers.size,closed:Boolean(this.#closing),...(this.#lastFailure?{last_failure_code:this.#lastFailure}:{})};}
  close(){if(this.#closing)return this.#closing;this.#closing=Promise.resolve().then(async()=>{for(const c of this.#controllers)c.abort();if(!this.#server)return;const ended=new Promise(resolve=>this.#server.close(resolve));this.#server.closeAllConnections();await Promise.allSettled([...this.#tasks]);await ended;});return this.#closing;}
}
