const assert=require('node:assert/strict');
const failure=code=>Object.assign(new Error(code),{code});
const METHODS=new Set(['initialize','session/new','session/set_mode','session/prompt']);

/** Actual loopback HTTP ACP contract; no filesystem/terminal/delegate tools. */
module.exports=class WorkbuddyAcpClient{
  constructor(endpoint,bearerHeaders,onFrame=()=>{}){
    const url=new URL(endpoint);
    if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||!Number(url.port)||url.pathname!=='/api/v1/acp'||url.search||url.hash||url.username||url.password)throw failure('workbuddy-acp-endpoint-invalid');
    if(!/^Bearer [A-Za-z0-9_-]{16,128}$/.test(bearerHeaders?.Authorization||''))throw failure('workbuddy-acp-auth-invalid');
    this.endpoint=url.href;this.bearerHeaders={Authorization:bearerHeaders.Authorization};this.onFrame=onFrame;this.nextId=1;this.credentials=null;this.pending=new Map();this.requests=new Set();this.eventsAbort=null;this.eventsTask=null;this.fatalError=null;
  }
  headers(){if(!this.credentials)throw failure('workbuddy-acp-disconnected');return{'Content-Type':'application/json',Accept:'application/json, text/event-stream','x-codebuddy-request':'1','acp-connection-id':this.credentials.connectionId,...this.credentials.sessionToken?{'acp-session-token':this.credentials.sessionToken}:{},...this.bearerHeaders};}
  fail(error){if(this.fatalError)return;this.fatalError=failure(error?.code?.startsWith('workbuddy-')?error.code:'workbuddy-acp-protocol-invalid');for(const pending of this.pending.values()){clearTimeout(pending.timer);pending.reject(this.fatalError);}this.pending.clear();this.eventsAbort?.abort();for(const controller of this.requests)controller.abort();}
  async connect(){
    if(this.credentials)throw failure('workbuddy-acp-already-connected');
    const response=await fetch(this.endpoint+'/connect',{method:'POST',headers:{'x-codebuddy-request':'1',...this.bearerHeaders},redirect:'error',signal:AbortSignal.timeout(10000)});
    if(response.status!==200)throw failure('workbuddy-acp-connect-failed');
    const payload=await response.json();if(typeof payload.connectionId!=='string'||!payload.connectionId||payload.connectionId.length>256||payload.sessionToken!==undefined&&payload.sessionToken!==null&&typeof payload.sessionToken!=='string')throw failure('workbuddy-acp-protocol-invalid');
    this.credentials={connectionId:payload.connectionId,sessionToken:payload.sessionToken};
    const initialized=await this.call('initialize',{protocolVersion:1,clientInfo:{name:'miniproctor-workbuddy',version:'1.0.0'},clientCapabilities:{fs:{readTextFile:false,writeTextFile:false},terminal:false}});
    if(initialized?.protocolVersion!==1)throw failure('workbuddy-acp-version-unverified');
    this.eventsAbort=new AbortController();
    this.eventsTask=(async()=>{
      const stream=await fetch(this.endpoint,{method:'GET',headers:{Accept:'text/event-stream','acp-connection-id':this.credentials.connectionId,...this.bearerHeaders},redirect:'error',signal:this.eventsAbort.signal});
      if(!stream.ok||!stream.headers.get('content-type')?.includes('text/event-stream'))throw failure('workbuddy-acp-events-failed');await this.read(stream);
    })().catch(error=>{if(!this.eventsAbort.signal.aborted)this.fail(error);});
    return initialized;
  }
  async handle(frame){
    if(!frame||typeof frame!=='object'||Array.isArray(frame)||frame.jsonrpc!=='2.0')throw failure('workbuddy-acp-protocol-invalid');
    this.onFrame(frame);
    if(frame.method&&frame.id!==undefined){
      const response=frame.method==='session/request_permission'?{result:{outcome:{outcome:'cancelled'}}}:{error:{code:-32601,message:'Client capability unavailable'}};
      await this.post({jsonrpc:'2.0',id:frame.id,...response},5000);return;
    }
    if(frame.id===undefined)return;
    const pending=this.pending.get(frame.id);if(!pending)return;this.pending.delete(frame.id);clearTimeout(pending.timer);
    if(frame.error)pending.reject(failure(frame.error?.data?.category==='auth'?'workbuddy-auth-required':'workbuddy-acp-request-failed'));else pending.resolve(frame.result);
  }
  async read(response,expectedId){
    if(!response.headers.get('content-type')?.includes('text/event-stream')){
      const raw=await response.text();if(Buffer.byteLength(raw)>256*1024)throw failure('workbuddy-acp-frame-limit');if(raw.trim())await this.handle(JSON.parse(raw));return;
    }
    const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='',bytes=0;
    try{while(true){const{done,value}=await reader.read();if(done)break;if((bytes+=value.length)>8*1024*1024)throw failure('workbuddy-acp-stream-limit');
      buffer=(buffer+decoder.decode(value,{stream:true})).replace(/\r\n/g,'\n');let cut;
      while((cut=buffer.indexOf('\n\n'))!==-1){const block=buffer.slice(0,cut);buffer=buffer.slice(cut+2);if(Buffer.byteLength(block)>256*1024)throw failure('workbuddy-acp-frame-limit');
        const data=block.split('\n').filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart()).join('\n');if(data)await this.handle(JSON.parse(data));}
      if(Buffer.byteLength(buffer)>256*1024)throw failure('workbuddy-acp-frame-limit');
      if(expectedId!==undefined&&!this.pending.has(expectedId)){await reader.cancel();break;}
    }}finally{reader.releaseLock();}
  }
  async post(frame,timeout,expectedId){
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeout);this.requests.add(controller);
    try{const response=await fetch(this.endpoint,{method:'POST',headers:this.headers(),body:JSON.stringify(frame),redirect:'error',signal:controller.signal});if(!response.ok)throw failure('workbuddy-acp-http-failed');await this.read(response,expectedId);return response.status;}
    finally{clearTimeout(timer);this.requests.delete(controller);}
  }
  async call(method,params,{timeout=15000}={}){
    if(!METHODS.has(method)||method==='session/set_mode'&&params?.modeId!=='dontAsk'||method==='session/new'&&(!Array.isArray(params?.mcpServers)||params.mcpServers.length))throw failure('workbuddy-acp-method-invalid');
    if(this.fatalError)throw this.fatalError;
    assert(Number.isInteger(timeout)&&timeout>0&&timeout<=55000);
    const id=this.nextId++,response=new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(id);reject(failure('workbuddy-acp-request-timeout'));},timeout);this.pending.set(id,{resolve,reject,timer});});
    const transport=this.post({jsonrpc:'2.0',id,method,params},timeout,id).catch(error=>{const pending=this.pending.get(id);if(pending){this.pending.delete(id);clearTimeout(pending.timer);pending.reject(error?.code?.startsWith('workbuddy-')?error:failure('workbuddy-acp-transport-failed'));}throw error;});
    transport.catch(()=>{});
    try{const result=await response;await transport;return result;}catch(error){for(const controller of this.requests)controller.abort();throw error;}
  }
  async cancel(sessionId){if(typeof sessionId!=='string'||!sessionId||sessionId.length>128)throw failure('workbuddy-acp-method-invalid');return this.post({jsonrpc:'2.0',method:'session/cancel',params:{sessionId}},5000);}
  async close(){
    this.eventsAbort?.abort();for(const controller of this.requests)controller.abort();for(const pending of this.pending.values()){clearTimeout(pending.timer);pending.reject(failure('workbuddy-acp-disconnected'));}this.pending.clear();
    let status=null;if(this.credentials){try{const response=await fetch(this.endpoint,{method:'DELETE',headers:this.headers(),redirect:'error',signal:AbortSignal.timeout(5000)});status=response.status;}finally{this.credentials=null;}}
    await this.eventsTask;return status;
  }
};
