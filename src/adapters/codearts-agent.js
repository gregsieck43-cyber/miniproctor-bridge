import { createEvent, redactThinkingEvent, sanitizePreview } from '../lib/events.js';

// 华为 CodeArts Agent CLI（agent_key=codearts-agent；官方命令 codearts——A21 快照口径；
// 编排简报候选命令 codearts-agent 与官方文档不符，以事实为准：探测应先 codearts、后 codearts-agent，
// 本适配器不依赖命令名）。
// 官方资料：xcx/docs/官方资料/A21-codeartsagent-cli.md：
//   - `codearts run [message]` 非交互运行（`--format default|json`、`--session <id>`/`--continue`
//     恢复会话、`--auto`/`--sandbox` Bash 工具模式、`--model`/`--agent`/`--file`）；
//   - `codearts session list --format json`；`codearts export [sessionID]` 以 JSON 打印会话数据；
//   - 会话 ID 形如 `ses_07885a8e7ffe8ESvH4zV1BdFJw`（文档示例）；
//   - `codearts serve` 本地 server（默认 127.0.0.1:4096，需 CODEARTS_SERVER_USERNAME/PASSWORD；
//     官方明示非标准云服务、不得暴露公网）；`codearts attach` 连接远端实例。
//
// 模式冻结（A21 卡"run/JSON导出/API择一"）：本适配器只实现 **run（stdio）** 候选解析；
// serve/attach（local-api）通路不声明不实现——官方自带"可能存在未授权访问/代码泄露风险"警示，
// 未经独立认证设计不得默认启用。export/import 仅作恢复通道候选，不做数据透传。
//
// 2026-09-29 官方 Windows 26.9.11 实机 --help 确认 --session/-s（旧文档 --sessionID 拼写已变）。
// 官方资料缺口（如实登记，不编造接口）：`run --format json` 的**事件帧 schema 未在快照中记载**。
// 解析器按"候选契约"实现通用类型化帧（session/message/tool/error/result），真实帧形状须 V03
// 真实 CLI 往返取证后修正 fixture。未取证前：
//   - isCodeartsAgentStreamType 只认「显式自报标记」「codearts_event 自标识信封」或携带官方文档
//     示例格式的 ses_ 前缀 session_id 的类型化帧，绝不按帧形抢占 claude-code / codex 分支；
//   - 不映射 confirm_required：官方 CLI 的 ask/审批交互无外部回写协议文档——A21 卡明确
//     "ask自动拒绝不可显示可远程批准"，手机端不出现虚假审批按钮；
//   - 不映射 file_change、usage：无文件变更/用量帧文档（`codearts stats` 是独立查询命令，
//     不构成事件流用量帧），无统计不伪造（§8.3）。

/** 本产品自报标记值（§7.1：自报 JSON 属不可信输入，仅用于"选哪个解析器猜帧"，不写权限）。 */
const SELF_REPORT_VALUES = Object.freeze(['codearts-agent', 'codearts', 'codeartsagent']);

/** 能力声明（声明层口径：代码路径是否存在；权威开放视图=capabilities.js 两层视图，本文件为逐产品登记副本）。
 * read=解析器已实现；stop=bridge runner 进程树终止（agent 无关代码路径）；
 * create=false：官方存在 `codearts run` 非交互入口，但 bridge 拉起参数模板未接线且真实 CLI 未验证；
 * resume=false：26.9.11 存在 `run --session/--continue` 恢复通道，适配器未实现映射路径；
 * approve/fileChanges/usage=false：无帧协议文档。 */
export const CODEARTS_AGENT_CAPABILITIES = Object.freeze({
  create: false, read: true, stop: true, append: false, resume: false, approve: false,
  fileChanges: false, usage: false,
  integrationMode: 'stdio', initialPromptChannel: 'launch-args',
});

export function isCodeartsAgentStreamType(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  if (selfReportsCodearts(raw)) return true;
  if (raw.type === 'codearts_event') return true;
  // ses_ 前缀会话 ID 为 A21 官方文档示例格式（codearts run --sessionID / export 输出）；
  // 仅在帧同时带类型字段时作为弱自标识，避免误吞其他产品的纯 UUID/纯文本帧。
  return typeof raw.type === 'string'
    && typeof raw.session_id === 'string'
    && raw.session_id.startsWith('ses_');
}

function selfReportsCodearts(raw) {
  for (const field of ['agent', 'agent_key', 'adapter', 'adapter_id', 'cli']) {
    const value = raw[field];
    if (typeof value === 'string' && SELF_REPORT_VALUES.includes(value.toLowerCase())) return true;
  }
  return false;
}

export function mapCodeartsAgentRaw(raw, { sessionId, agentType = 'generic', sequencer }) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
  const events = [];
  switch (raw.type) {
    case 'session': {
      // 会话标识/状态帧：只登记 ID 形态与状态，不透传本机路径等环境字段。
      events.push(createEvent({
        sessionId, agentType, sequencer,
        eventType: 'custom',
        payload: {
          custom_type: 'system',
          system_subtype: raw.status || 'session',
          fallback_text: `CodeArts Agent 会话${raw.status === 'started' ? '已启动' : `状态：${raw.status || '未知'}`}`,
          data: { session_id: typeof raw.session_id === 'string' ? raw.session_id.slice(0, 128) : null, title: sanitizePreview(raw.title ?? '', 100) },
        },
      }));
      break;
    }
    case 'message':
    case 'assistant':
    case 'agent_message': {
      const text = extractText(raw.text ?? raw.content ?? raw.message);
      if (text) {
        events.push(createEvent({
          sessionId, agentType, sequencer,
          eventType: 'agent_message',
          payload: {
            message_id: raw.id || `m_${crypto.randomUUID()}`,
            stream_id: raw.session_id || raw.id || null,
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
    case 'user':
    case 'user_message': {
      const text = extractText(raw.text ?? raw.content ?? raw.message);
      if (text) {
        events.push(createEvent({
          sessionId, agentType, sequencer,
          eventType: 'user_message',
          payload: { message_id: raw.id || `m_${crypto.randomUUID()}`, role: 'user', content: text, content_type: 'text' },
        }));
      }
      break;
    }
    case 'tool_use':
    case 'tool_call':
    case 'tool': {
      events.push(createEvent({
        sessionId, agentType, sequencer,
        eventType: 'tool_call',
        payload: {
          tool_call_id: raw.id || raw.call_id || `tc_${crypto.randomUUID()}`,
          tool_name: raw.name || raw.tool_name || raw.tool || 'unknown',
          input_preview: sanitizePreview(raw.input || raw.arguments || raw.command || {}, 500),
          input_sensitive: false,
          status: raw.status || 'running',
        },
      }));
      break;
    }
    case 'tool_result': {
      events.push(createEvent({
        sessionId, agentType, sequencer,
        eventType: 'tool_result',
        payload: {
          tool_call_id: raw.id || raw.call_id || raw.tool_call_id || `tc_${crypto.randomUUID()}`,
          status: raw.status || (raw.is_error === true ? 'failed' : 'success'),
          output_preview: sanitizePreview(raw.output || raw.result || raw.content || '', 500),
          truncated: false,
        },
      }));
      break;
    }
    case 'thinking':
    case 'reasoning': {
      // 思考正文默认不上传（TASK-019 ②①）：一律走脱敏占位。
      const text = raw.thinking || raw.text || raw.summary;
      if (text) events.push(redactThinkingEvent({ sessionId, agentType, sequencer, originalText: String(text) }));
      break;
    }
    case 'error': {
      const message = String(raw.message || raw.error?.message || 'CodeArts Agent 错误').slice(0, 1000);
      events.push(createEvent({
        sessionId, agentType, sequencer,
        eventType: 'error',
        payload: {
          error_code: 'CODEARTS_AGENT_ERROR',
          severity: 'fatal',
          message,
          recoverable: false,
        },
      }));
      break;
    }
    case 'result':
    case 'end':
    case 'done':
    case 'session_end': {
      // 无用量帧文档：usage 恒空对象（无统计不伪造，§8.3）。
      events.push(createEvent({
        sessionId, agentType, sequencer,
        eventType: 'session_end',
        payload: {
          reason: raw.status === 'error' || raw.is_error === true ? 'error' : 'completed',
          summary: sanitizePreview(raw.summary || raw.result || '会话结束', 1000),
          usage: {},
        },
      }));
      break;
    }
    case 'control_request': {
      // 官方 ask/审批无外部回写协议文档：降级为诊断事件，绝不映射 confirm_required
      //（A21 卡"ask自动拒绝不可显示可远程批准"）。
      events.push(createEvent({
        sessionId, agentType, sequencer,
        eventType: 'custom',
        payload: {
          custom_type: 'control_request_unsupported',
          fallback_text: 'CodeArts Agent 存在未确认的交互请求；官方 CLI 审批回写通道未文档化，暂不支持远程批准',
          data: { request_id: raw.request_id || null, subtype: raw.request?.subtype || raw.subtype || null },
        },
      }));
      break;
    }
    default: {
      // 未知/未来新增帧（含 codearts_event 自标识信封）：custom 兜底，不猜测语义。
      events.push(createEvent({
        sessionId, agentType, sequencer,
        eventType: 'custom',
        payload: {
          custom_type: 'codearts_raw',
          fallback_text: `CodeArts Agent 事件：${typeof raw.type === 'string' ? raw.type : '未知'}`,
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
      else if (item && typeof item === 'object' && typeof (item.text ?? item.content) === 'string') {
        parts.push(item.text ?? item.content);
      }
    }
    return parts.join('\n');
  }
  if (value && typeof value === 'object') return extractText(value.content ?? value.text);
  return '';
}
