import {createEvent,sanitizePreview,sanitizeSensitiveText} from '../lib/events.js';
const PROTOCOL='miniproctor-dsh-sdk-v1',TYPES=new Set(['started','provider','message','result','error']);
export function isDshSdkFrame(raw){return Boolean(raw&&typeof raw==='object'&&!Array.isArray(raw)&&raw.protocol===PROTOCOL&&TYPES.has(raw.type));}
export function mapDshSdkFrame(raw,{sessionId,sequencer}){
 if(!isDshSdkFrame(raw))return[];const common={sessionId,agentType:'generic',sequencer};
 const failed=code=>[createEvent({...common,eventType:'error',payload:{code:typeof code==='string'&&/^dsh-[a-z-]+$/.test(code)?code:'dsh-native-incomplete',message:'DSH 任务未正常完成，请检查电脑端配置和连接',severity:'fatal',recoverable:false}})];
 if(raw.type==='provider')return[];
 if(raw.type==='started')return[createEvent({...common,eventType:'custom',payload:{custom_type:'dsh_sdk_started',fallback_text:'DSH 会话已接收任务',data:{native_session_id:typeof raw.native_session_id==='string'?raw.native_session_id.slice(0,128):null}}})];
 if(raw.type==='message'){if(typeof raw.text!=='string'||!raw.text)return[];return[createEvent({...common,eventType:'agent_message',payload:{role:'assistant',content:sanitizeSensitiveText(sanitizePreview(raw.text,32000)),content_type:'text',is_final:false}})];}
 if(raw.type==='error')return failed(raw.code);
 const exited=raw.native_stop?.exited===true&&raw.native_stop.tree_verified===true&&raw.native_stop.remaining_owned_instances===0&&raw.gateway?.closed===true&&raw.gateway.active===0&&raw.runtime?.provider_key_matches===0;
 if(exited&&raw.status==='completed'&&raw.native_stop.code===0&&raw.gateway.successful>0&&raw.gateway.failed===0&&raw.gateway.rejected===0&&!raw.gateway.quota_exceeded)return[createEvent({...common,eventType:'session_end',payload:{reason:'completed',summary:'DSH 单轮任务已完成',usage:{}}})];
 if(exited&&raw.status==='cancelled')return[createEvent({...common,eventType:'session_end',payload:{reason:'stopped',summary:'DSH 任务已停止',usage:{}}})];
 return failed(raw.error_code);
}
