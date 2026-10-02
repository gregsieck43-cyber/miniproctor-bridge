import readline from 'node:readline';
import {runZCodeNative,verifyPinnedZCodeSource,validateZCodePrompt} from './zcode-sdk-runtime.js';
import {MAX_LINE_BYTES} from '../agent/runner.js';
const protocol='miniproctor-zcode-kernel-v1',failure=code=>Object.assign(new Error(code),{code});
const write=frame=>{const line=JSON.stringify({protocol,...frame});if(Buffer.byteLength(line)>=MAX_LINE_BYTES)throw failure('zcode-output-limit');process.stdout.write(line+'\n');};
try {
  const verified=verifyPinnedZCodeSource(process.env.MINIPROCTOR_ZCODE_SOURCE);
  if(process.argv.length===3&&process.argv[2]==='--verify-runtime')process.stdout.write(JSON.stringify({...verified,node_version:process.version})+'\n');
  else {
    if(process.argv.length!==2)throw failure('zcode-input-invalid');
    const control=new AbortController(),input=readline.createInterface({input:process.stdin,crlfDelay:Infinity});
    let phase='waiting',shutdown=false,result=null;
    const finish=()=>{if(phase==='running')return;input.removeAllListeners('close');input.close();process.stdin.destroy();};
    const invalid=()=>{control.abort(failure('zcode-input-invalid'));shutdown=true;if(phase==='waiting'){write({type:'error',code:'zcode-input-invalid'});process.exitCode=2;phase='failed';finish();}else if(phase==='done'){write({type:'error',code:'zcode-input-invalid'});process.exitCode=2;finish();}};
    input.on('close',()=>{control.abort(failure('zcode-input-closed'));shutdown=true;if(phase==='waiting'){process.exitCode=2;phase='failed';finish();}});
    input.on('line',line=>{
      try {
        if(Buffer.byteLength(line)>20000)throw failure('zcode-input-invalid');const frame=JSON.parse(line);
        if(frame.type==='control_stop'&&Object.keys(frame).length===1){control.abort(failure('zcode-stop'));if(phase==='waiting'){result={type:'result',status:'cancelled',native_session_id:null,native_turn_id:null,...verified,error_code:null,text:null,tool_count:0,native_events:[]};write(result);phase='done';process.exitCode=0;}return;}
        if(frame.type==='control_shutdown'&&Object.keys(frame).length===1){shutdown=true;if(phase!=='done'){control.abort(failure('zcode-shutdown-before-result'));if(phase==='waiting'){phase='failed';process.exitCode=2;write({type:'error',code:'zcode-shutdown-before-result'});}}finish();return;}
        if(frame.type!=='start'||Object.keys(frame).length!==2||phase!=='waiting')throw failure('zcode-input-invalid');validateZCodePrompt(frame.prompt);phase='running';
        (async()=>{
          try{result=await runZCodeNative({sourceRoot:process.env.MINIPROCTOR_ZCODE_SOURCE,workspace:process.cwd(),baseUrl:process.env.MINIPROCTOR_ZCODE_URL,childKey:process.env.MINIPROCTOR_ZCODE_LOCAL_KEY,apiFormat:'openai-chat-completions',prompt:frame.prompt,signal:control.signal,emit:write});process.exitCode=result.status==='failed'?2:0;}
          catch(error){write({type:'error',code:/^zcode-[a-z-]{1,64}$/u.test(error.code||'')?error.code:'zcode-native-failed'});process.exitCode=2;shutdown=true;}
          finally{phase='done';if(shutdown)finish();}
        })().catch(()=>{process.exitCode=2;phase='failed';finish();});
      }catch{invalid();}
    });
  }
}catch(error){write({type:'error',code:/^zcode-[a-z-]{1,64}$/u.test(error.code||'')?error.code:'zcode-runtime-unverified'});process.exitCode=2;}
