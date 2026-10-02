import {createEvent,sanitizePreview,sanitizeSensitiveText} from '../lib/events.js';
const protocol='miniproctor-gemini-core-v1',types=new Set(['started','provider','message','result','error']);
const uuid=value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value);
export const isGeminiCoreFrame=raw=>Boolean(raw&&typeof raw==='object'&&!Array.isArray(raw)&&raw.protocol===protocol&&types.has(raw.type));
export const isGeminiCoreStartedFrame=raw=>isGeminiCoreFrame(raw)&&raw.type==='started'&&uuid(raw.native_session_id)&&raw.native_version==='0.61.0';
export function mapGeminiCoreFrame(raw,{sessionId,sequencer}){
  if(!isGeminiCoreFrame(raw))return[];
  const common={sessionId,agentType:'generic',sequencer},failed=code=>[createEvent({...common,eventType:'error',payload:{code:/^gemini-[a-z-]{1,64}$/u.test(code||'')?code:'gemini-native-incomplete',message:'Gemini 任务未正常完成，请检查电脑端配置和连接',severity:'fatal',recoverable:false}})];
  if(raw.type==='provider')return[];
  if(raw.type==='started')return isGeminiCoreStartedFrame(raw)?[createEvent({...common,eventType:'custom',payload:{custom_type:'gemini_core_started',fallback_text:'Gemini 会话已接收任务',data:{native_session_id:raw.native_session_id,native_cli_version:raw.native_version}}})]:failed('gemini-native-identity');
  if(raw.type==='message')return typeof raw.text==='string'&&raw.text?[createEvent({...common,eventType:'agent_message',payload:{role:'assistant',content:sanitizeSensitiveText(sanitizePreview(raw.text,32000)),content_type:'text',is_final:false}})]:[];
  if(raw.type==='error')return failed(raw.code);
  const exited=!raw.error_code&&raw.native_stop?.exited===true&&raw.native_stop.tree_verified===true&&raw.native_stop.remaining_owned_instances===0&&raw.gateway?.closed===true&&raw.gateway.active===0&&raw.runtime?.provider_key_matches===0,identity=uuid(raw.native_session_id);
  if(exited&&identity&&raw.status==='completed'&&raw.native_stop.code===0&&raw.gateway.contacted===1&&raw.gateway.successful===1&&raw.gateway.failed===0&&raw.gateway.rejected===0&&!raw.gateway.quota_exceeded)return[createEvent({...common,eventType:'session_end',payload:{reason:'completed',summary:'Gemini 单轮任务已完成',usage:{}}})];
  const early=raw.gateway?.contacted===0&&(raw.native_stop?.code===null&&raw.native_stop.owned_processes===0&&raw.native_stop.reason==='not-started'||raw.native_stop?.code===0&&raw.native_admission==='not-accepted'&&raw.native_event_count===0);
  if(exited&&raw.status==='cancelled'&&(raw.native_stop.code===0&&identity||early))return[createEvent({...common,eventType:'session_end',payload:{reason:'stopped',summary:'Gemini 任务已停止',usage:{}}})];
  return failed(raw.error_code);
}
