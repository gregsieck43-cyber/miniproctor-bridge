import { createEvent, redactThinkingEvent, sanitizePreview } from '../lib/events.js';

// Qoder CN（国内版，agent_key=qoder-cn；命令 qodercn，旧名 qoderclicn；灵码为历史别名/产品代际）。
// 官方资料：xcx/docs/官方资料/A19a-qoder-cn-commands.md（TUI + headless `qodercn -p '<提示词>'`）、
// A19b-aliyun-lingma.md（Qoder CN 系列含原通义灵码 IDE/插件，属同系列代际，IDE 旧会话不迁移）。
//
// 官方资料缺口（如实登记，不编造接口）：A19a 仅记载 headless 接受"提交提示词的命令"；
// 2026-09-29 官方参数已列 stream-json 输入/输出与 --session-id/--resume，但仍无事件帧和
// 审批回写的可对接 schema；纯文本 headless ask 自动拒绝，Host 驱动 stream-json 可转发确认。
// 因此本解析器按"候选契约"实现（若 CLI 发出该形状帧则能正确翻译），候选形状以 Claude
// stream-json 同族为假设（Qoder CLI 的 TUI/命令语义与 Claude Code 同族，仅作候选、非官方确认）；
// 项目内 npm 兼容包 1.1.64 仅 version/help 已验，无认证模型；真实帧形状须 V03 往返取证后修正 fixture。未取证前：
//   - isQoderCnStreamType 只认「显式自报标记」或 qoder_event 自标识信封，绝不按帧形抢占
//     claude-code / codex 分支（避免同形帧被硬编码 agent_type 错标产品，§7.1 身份优先级）；
//   - 不映射 confirm_required（无审批通道文档——手机端不出现虚假"可远程批准"按钮，§5.2）；
//   - 不映射 file_change、usage（无文件变更/用量帧文档，无统计不伪造，§8.3）。
// generic 式文本产品不伪造工具事件：tool_use 候选帧只翻译 tool_call，不衍生其他事件。

/** 本产品自报标记值（§7.1：自报 JSON 属不可信输入，仅用于"选哪个解析器猜帧"，不写权限）。 */
const SELF_REPORT_VALUES = Object.freeze(['qoder-cn', 'qodercn', 'qoderclicn', 'lingma']);

/** 能力声明（声明层口径：代码路径是否存在；权威开放视图=capabilities.js 两层视图，本文件为逐产品登记副本）。
 * read=解析器已实现；stop=bridge runner 进程树终止（agent 无关代码路径，runner*.test.js）；
 * create=false：官方存在 headless 入口（`qodercn -p`），但 bridge 拉起参数模板未接线且真实 CLI
 * 未验证；append/resume/approve/fileChanges/usage=false：无文档化通道/帧，未实现不声明。 */
export const QODER_CN_CAPABILITIES = Object.freeze({
  create: false, read: true, stop: true, append: false, resume: false, approve: false,
  fileChanges: false, usage: false,
  integrationMode: 'stdio', initialPromptChannel: 'launch-args',
});

export function isQoderCnStreamType(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  if (selfReportsQoderCn(raw)) return true;
  return raw.type === 'qoder_event';
}

function selfReportsQoderCn(raw) {
  for (const field of ['agent', 'agent_key', 'adapter', 'adapter_id', 'cli']) {
    const value = raw[field];
    if (typeof value === 'string' && SELF_REPORT_VALUES.includes(value.toLowerCase())) return true;
  }
  return false;
}

export function mapQoderCnRaw(raw, { sessionId, agentType = 'generic', sequencer }) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
  const events = [];
  switch (raw.type) {
    case 'system': {
      // 候选 init 帧：只保留 model 与工具名清单（≤20 项），不透传 cwd/环境等本机字段。
      events.push(createEvent({
        sessionId, agentType, sequencer,
        eventType: 'custom',
        payload: {
          custom_type: 'system',
          system_subtype: raw.subtype || 'unknown',
          fallback_text: raw.subtype === 'init' ? 'Qoder CN 会话已初始化' : `Qoder CN 系统事件：${raw.subtype || 'unknown'}`,
          data: {
            model: raw.model || null,
            tools: Array.isArray(raw.tools) ? raw.tools.slice(0, 20) : [],
          },
        },
      }));
      break;
    }
    case 'assistant': {
      const message = raw.message || {};
      const content = Array.isArray(message.content) ? message.content : [];
      for (const item of content) {
        if (!item || typeof item !== 'object') continue;
        if (item.type === 'text' && typeof item.text === 'string' && item.text) {
          events.push(createEvent({
            sessionId, agentType, sequencer,
            eventType: 'agent_message',
            payload: {
              message_id: message.id || `m_${crypto.randomUUID()}`,
              stream_id: message.id || null,
              role: 'assistant',
              content: item.text,
              content_type: 'text',
              is_final: Boolean(message.stop_reason),
              stop_reason: message.stop_reason || null,
            },
          }));
        } else if (item.type === 'thinking' && typeof item.thinking === 'string' && item.thinking) {
          // 思考正文默认不上传（TASK-019 ②①）：一律走脱敏占位，不做透传开关。
          events.push(redactThinkingEvent({ sessionId, agentType, sequencer, originalText: item.thinking }));
        } else if (item.type === 'tool_use') {
          events.push(createEvent({
            sessionId, agentType, sequencer,
            eventType: 'tool_call',
            payload: {
              tool_call_id: item.id || `tc_${crypto.randomUUID()}`,
              tool_name: item.name || 'unknown',
              input_preview: sanitizePreview(item.input, 500),
              input_sensitive: false,
              status: 'running',
            },
          }));
          // 无官方文件变更帧文档：不衍生 file_change 事件（claude-code 的 Edit→file_change 映射不适用）。
        }
      }
      break;
    }
    case 'user': {
      const message = raw.message || {};
      const content = message.content;
      const text = typeof content === 'string' ? content : sanitizePreview(content || '');
      if (text) {
        events.push(createEvent({
          sessionId, agentType, sequencer,
          eventType: 'user_message',
          payload: {
            message_id: `m_${crypto.randomUUID()}`,
            role: 'user',
            content: text,
            content_type: 'text',
          },
        }));
      }
      break;
    }
    case 'result': {
      // 候选 result 帧：usage 无文档，恒空对象（无统计不伪造，§8.3）。
      const subtype = raw.subtype || 'completed';
      events.push(createEvent({
        sessionId, agentType, sequencer,
        eventType: 'session_end',
        payload: {
          reason: subtype === 'success' ? 'completed' : subtype === 'error_max_turns' ? 'timeout' : 'stopped',
          summary: typeof raw.result === 'string' ? raw.result.slice(0, 1000) : `会话结束（${subtype}）`,
          usage: {},
        },
      }));
      break;
    }
    case 'message':
    case 'agent_message':
    case 'assistant_message': {
      // 通用候选：扁平消息帧（text/content/message 字段），content 支持字符串或分段数组。
      const text = extractText(raw.text ?? raw.content ?? raw.message);
      if (text) {
        events.push(createEvent({
          sessionId, agentType, sequencer,
          eventType: 'agent_message',
          payload: {
            message_id: raw.id || `m_${crypto.randomUUID()}`,
            stream_id: raw.id || null,
            role: 'assistant',
            content: text,
            content_type: 'text',
            is_final: raw.is_final === true || Boolean(raw.stop_reason),
            stop_reason: raw.stop_reason || null,
          },
        }));
      }
      break;
    }
    case 'error': {
      const message = String(raw.message || raw.error?.message || 'Qoder CN 错误').slice(0, 1000);
      events.push(createEvent({
        sessionId, agentType, sequencer,
        eventType: 'error',
        payload: {
          error_code: 'QODER_CN_ERROR',
          severity: 'fatal',
          message,
          recoverable: false,
        },
      }));
      break;
    }
    case 'control_request': {
      // 无官方审批通道文档：审批类帧降级为诊断事件，绝不映射 confirm_required
      //（否则手机端出现无法回写的虚假审批按钮，§5.2/§23.1"未实测能力一律 false"）。
      events.push(createEvent({
        sessionId, agentType, sequencer,
        eventType: 'custom',
        payload: {
          custom_type: 'control_request_unsupported',
          fallback_text: 'Qoder CN 存在未确认的交互请求；官方 headless 审批通道未文档化，暂不支持远程批准',
          data: { request_id: raw.request_id || null, subtype: raw.request?.subtype || raw.subtype || null },
        },
      }));
      break;
    }
    default: {
      // 未知/未来新增帧（含 qoder_event 自标识信封）：custom 兜底，一句话摘要，不猜测语义。
      events.push(createEvent({
        sessionId, agentType, sequencer,
        eventType: 'custom',
        payload: {
          custom_type: 'qoder_cn_raw',
          fallback_text: `Qoder CN 事件：${typeof raw.type === 'string' ? raw.type : '未知'}`,
          data: { type: typeof raw.type === 'string' ? raw.type : null, id: raw.id || null },
        },
      }));
      break;
    }
  }
  return events;
}

/** 从字符串 / {text} 分段数组 / {content} 嵌套中提取可展示文本；取不到返回空串。 */
function extractText(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    const parts = [];
    for (const item of value) {
      if (typeof item === 'string') parts.push(item);
      else if (item && typeof item === 'object' && typeof item.text === 'string') parts.push(item.text);
    }
    return parts.join('\n');
  }
  if (value && typeof value === 'object') return extractText(value.content ?? value.text);
  return '';
}
