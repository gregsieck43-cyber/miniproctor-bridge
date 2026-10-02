import {createEvent,sanitizePreview,sanitizeSensitiveText} from '../lib/events.js';
const PROTOCOL='miniproctor-workbuddy-native-v1',TYPES=new Set(['started','provider','message','result','error']);
const uuid=value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
export function isWorkbuddyNativeFrame(raw){return Boolean(raw&&typeof raw==='object'&&!Array.isArray(raw)&&raw.protocol===PROTOCOL&&TYPES.has(raw.type));}
export function isWorkbuddyStartedFrame(raw){return isWorkbuddyNativeFrame(raw)&&raw.type==='started'&&uuid(raw.native_session_id)&&typeof raw.native_request_id==='string'&&/^[0-9a-f]{32}$/.test(raw.native_request_id)&&raw.native_version==='2.147.0';}
export function mapWorkbuddyNativeFrame(raw,{sessionId,sequencer}){
  if(!isWorkbuddyNativeFrame(raw))return[];const common={sessionId,agentType:'generic',sequencer};
  const failed=code=>[createEvent({...common,eventType:'error',payload:{code:typeof code==='string'&&/^workbuddy-[a-z-]{1,64}$/.test(code)?code:'workbuddy-native-incomplete',message:'WorkBuddy 任务未正常完成，请检查电脑端配置和连接',severity:'fatal',recoverable:false}})];
  if(raw.type==='provider')return[];
  if(raw.type==='started')return isWorkbuddyStartedFrame(raw)?[createEvent({...common,eventType:'custom',payload:{custom_type:'workbuddy_native_started',fallback_text:'WorkBuddy 会话已接收任务',data:{native_session_id:raw.native_session_id,native_request_id:raw.native_request_id,native_cli_version:raw.native_version}}})]:failed('workbuddy-native-identity');
  if(raw.type==='message'){if(typeof raw.text!=='string'||!raw.text)return[];return[createEvent({...common,eventType:'agent_message',payload:{role:'assistant',content:sanitizeSensitiveText(sanitizePreview(raw.text,32000)),content_type:'text',is_final:false}})];}
  if(raw.type==='error')return failed(raw.code);
  const exited=!raw.error_code&&raw.native_stop?.exited===true&&raw.native_stop.tree_verified===true&&raw.native_stop.remaining_owned_instances===0&&raw.gateway?.closed===true&&raw.gateway.active===0&&raw.runtime?.provider_key_matches===0;
  if(exited&&raw.status==='completed'&&raw.native_stop.code===0&&raw.gateway.contacted===1&&raw.gateway.successful===1&&raw.gateway.failed===0&&raw.gateway.rejected===0&&!raw.gateway.quota_exceeded)return[createEvent({...common,eventType:'session_end',payload:{reason:'completed',summary:'WorkBuddy 单轮任务已完成',usage:{}}})];
  const early=raw.native_stop?.code===null&&raw.native_stop?.owned_processes===0&&raw.native_stop?.reason==='not-started'&&raw.gateway?.contacted===0;
  if(exited&&raw.status==='cancelled'&&(raw.native_stop.code===0||early))return[createEvent({...common,eventType:'session_end',payload:{reason:'stopped',summary:'WorkBuddy 任务已停止',usage:{}}})];
  return failed(raw.error_code);
}
