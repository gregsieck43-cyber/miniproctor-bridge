import crypto from 'node:crypto';
import {loadGeminiCore,verifyPinnedGeminiArtifacts,verifyGeminiNode,geminiConfigParameters,validateGeminiPrompt,geminiFailure} from './gemini-core-runtime.js';

const protocol='miniproctor-gemini-kernel-v1';
const send=frame=>new Promise((resolve,reject)=>{
  if(!process.connected||!process.send){reject(geminiFailure('gemini-control-closed'));return;}
  if(Buffer.byteLength(JSON.stringify(frame))>64000){reject(geminiFailure('gemini-output-limit'));return;}
  process.send({protocol,...frame},error=>error?reject(error):resolve());
});
async function main(){
  const sourceRoot=process.env.MINIPROCTOR_GEMINI_SOURCE,verified=verifyPinnedGeminiArtifacts(sourceRoot);
  const nodeVersion=verifyGeminiNode(process.execPath,{current:true});
  if(process.argv.length===3&&process.argv[2]==='--verify-runtime'){
    process.stdout.write(JSON.stringify({...verified,node_version:nodeVersion})+'\n');return;
  }
  if(process.argv.length!==2||!process.connected||!process.send)throw geminiFailure('gemini-input-invalid');
  const control=new AbortController(),keepAlive=setInterval(()=>{},1000);
  let config,phase='initializing',error=null,finishTask=null,accepted=false,shutdown=false,stopReceivedAt=null;
  const disconnect=()=>{clearInterval(keepAlive);process.removeAllListeners('message');process.removeAllListeners('disconnect');if(process.connected)process.disconnect();};
  const finish=(result)=>{
    if(finishTask)return finishTask;
    finishTask=(async()=>{
      try{await config?.dispose();await send({...result,control_stop_received_at:stopReceivedAt,signal_aborted:control.signal.aborted});process.exitCode=result.status==='failed'?2:0;}
      finally{phase='done';if(control.signal.aborted||shutdown)disconnect();}
    })();finishTask.catch(()=>{process.exitCode=2;clearInterval(keepAlive);if(process.connected)process.disconnect();});return finishTask;
  };
  const stoppedBeforeStart=()=>finish({type:'result',status:error?'failed':'cancelled',...verified,native_session_id:null,native_events:[],text:null,tool_count:0,error_code:error});
  const abort=(code)=>{if(code!=='gemini-stop')error=code;control.abort(geminiFailure(code));if(phase==='waiting')void stoppedBeforeStart();};
  process.on('disconnect',()=>{error='gemini-control-closed';control.abort(geminiFailure(error));if(phase==='waiting')void stoppedBeforeStart();});
  process.on('message',frame=>{
    try{
      if(!frame||typeof frame!=='object'||Array.isArray(frame)||Buffer.byteLength(JSON.stringify(frame))>20000)throw geminiFailure('gemini-input-invalid');
      if(frame.type==='control_shutdown'&&Object.keys(frame).length===1){shutdown=true;if(phase==='done'){disconnect();return;}abort('gemini-stop');return;}
      if(frame.type==='control_stop'&&Object.keys(frame).length===1){stopReceivedAt=Date.now();if(phase==='done'){disconnect();return;}abort('gemini-stop');return;}
      if(frame.type!=='start'||Object.keys(frame).length!==2||phase!=='waiting'||control.signal.aborted)throw geminiFailure('gemini-input-invalid');
      validateGeminiPrompt(frame.prompt);phase='running';accepted=true;
      void(async()=>{
        const events=[];let text='',finished=false,cancelled=false,usage=null;
        try{
          await send({type:'started',native_session_id:config.getSessionId(),native_version:verified.cli_version});
          for await(const event of config.getGeminiClient().sendMessageStream(frame.prompt,control.signal,crypto.randomUUID(),1)){
            if(!['model_info','content','finished','user_cancelled','error','thought'].includes(event.type)||events.length>=512)throw geminiFailure('gemini-native-events-invalid');
            events.push({sequence:events.length+1,type:event.type});
            if(event.type==='content'){if(typeof event.value!=='string')throw geminiFailure('gemini-native-text-invalid');text+=event.value;if(Buffer.byteLength(text)>32000)throw geminiFailure('gemini-output-limit');}
            if(event.type==='finished'){finished=event.value?.reason==='STOP';usage=event.value?.usageMetadata||null;}
            if(event.type==='user_cancelled')cancelled=true;
            if(event.type==='error')error='gemini-native-model-failed';
          }
        }catch(e){error=/^gemini-[a-z-]{1,64}$/u.test(e.code||'')?e.code:'gemini-native-failed';}
        const status=!error&&control.signal.aborted&&cancelled?'cancelled':!error&&!control.signal.aborted&&finished&&text.trim()?'completed':'failed';
        await finish({type:'result',status,...verified,native_session_id:config.getSessionId(),text:status==='completed'?text:null,native_events:events,usage:status==='completed'?usage:null,tool_count:config.getToolRegistry().getFunctionDeclarations().length,error_code:error});
      })().catch(()=>{process.exitCode=2;clearInterval(keepAlive);if(process.connected)process.disconnect();});
    }catch(e){abort(e.code||'gemini-input-invalid');}
  });
  try{
    const core=await loadGeminiCore(sourceRoot);
    if(control.signal.aborted){phase='waiting';await stoppedBeforeStart();return;}
    config=new core.Config(geminiConfigParameters(crypto.randomUUID(),process.cwd()));
    await config.refreshAuth(core.AuthType.GATEWAY,process.env.MINIPROCTOR_GEMINI_LOCAL_KEY,process.env.MINIPROCTOR_GEMINI_URL);await config.initialize();
    if(config.getToolRegistry().getFunctionDeclarations().length!==0||config.getEnableHooks()!==false||config.getHookSystem()!==undefined||config.getMcpEnabled()!==false
      ||config.isAgentsEnabled()!==false||config.getExtensions().length!==0||config.isTrustedFolder()!==false)throw geminiFailure('gemini-native-permissions-unverified');
    phase='waiting';if(control.signal.aborted){await stoppedBeforeStart();return;}
    await send({type:'ready',...verified,tool_count:0,hooks:false,mcp:false,agents:false,extensions:0,workspace_trusted:false});
  }catch(e){error=/^gemini-[a-z-]{1,64}$/u.test(e.code||'')?e.code:'gemini-runtime-unverified';control.abort(geminiFailure(error));if(!accepted)await finish({type:'result',status:'failed',...verified,native_session_id:null,native_events:[],text:null,tool_count:0,error_code:error});}
}
try{await main();}catch{process.exitCode=2;if(process.connected){await send({type:'error',code:'gemini-runtime-unverified'}).catch(()=>{});process.disconnect();}}
