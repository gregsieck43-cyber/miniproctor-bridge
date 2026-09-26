import { createEvent, redactThinkingEvent, sanitizePreview } from '../lib/events.js';

// TRAE CLI（agent_key=trae-cli；官方命令 traecli——A20a/A20b 快照口径；编排简报候选命令 `trae`
// 与官方文档不符，以事实为准：探测应先 traecli、后 trae，本适配器不依赖命令名）。
// 官方资料：xcx/docs/官方资料/A20a-trae-cli2-get-started.md（安装/启动/登录；Windows 建议 WSL2，
// 原生版首次启动需完成沙箱初始化）、A20b-trae-cli-parameters.md（`traecli exec [选项] [PROMPT]`
// 非交互运行；`--json` 把事件以 JSONL 流式打印到 stdout；`-o` 写出最后一条消息；
// `--sandbox read-only|workspace-write|danger-full-access`；`--ask-for-approval`；resume/fork 子命令）。
//
// 官方资料缺口（如实登记，不编造接口）：A20b 只记载 `--json` 输出"JSONL 事件流"，**未记载事件帧
// schema**。TRAE CLI2 的参数面与 codex exec 高度同构（--sandbox/--ask-for-approval/--ephemeral/
// --skip-git-repo-check），候选契约按 codex 同族 JSONL 帧实现（thread.*/turn.*/event_msg/item 容器），
// 真实帧形状须 V03 真实 CLI 往返取证后修正 fixture。未取证前：
//   - isTraeCliStreamType 只认「显式自报标记」或 trae_event 自标识信封，绝不按帧形抢占 codex 分支
//     （generic.js 分发里 codex 探测按帧形硬编码 agent_type='codex'，同形帧先入会产品错标）；
//   - 不映射 confirm_required：官方有 `--ask-for-approval` 旗标，但无"外部客户端回写审批决议"的
//     帧协议文档——手机端不出现虚假"可远程批准"按钮（§5.2/A20 卡"沙箱权限按策略授权"）；
//   - 不映射 file_change、usage：无文件变更/用量帧文档，无统计不伪造（§8.3）。
// 安全默认：`--sandbox`/`--ask-for-approval` 的具体取值由本机 profile 冻结 spec 决定；本适配器
// 不内置 danger-full-access/--yolo 等官方示例中的危险参数作为默认（简报禁止照抄）。

/** 本产品自报标记值（§7.1：自报 JSON 属不可信输入，仅用于"选哪个解析器猜帧"，不写权限）。 */
const SELF_REPORT_VALUES = Object.freeze(['trae-cli', 'trae', 'traecli', 'traecode']);

/** 能力声明（声明层口径：代码路径是否存在；权威开放视图=capabilities.js 两层视图，本文件为逐产品登记副本）。
 * read=解析器已实现；stop=bridge runner 进程树终止（agent 无关代码路径）；
 * create=false：官方存在 `traecli exec` 非交互入口，但 bridge 拉起参数模板未接线且真实 CLI 未验证；
 * append=false：exec 单次运行无中途追加通道文档；resume=false：官方存在 `traecli resume` 子命令，
 * 适配器未实现映射路径；approve/fileChanges/usage=false：无帧协议文档。 */
export const TRAE_CLI_CAPABILITIES = Object.freeze({
  create: false, read: true, stop: true, append: false, resume: false, approve: false,
  fileChanges: false, usage: false,
  integrationMode: 'stdio', initialPromptChannel: 'launch-args',
});

export function isTraeCliStreamType(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  if (selfReportsTrae(raw)) return true;
  return raw.type === 'trae_event';
}

function selfReportsTrae(raw) {
  for (const field of ['agent', 'agent_key', 'adapter', 'adapter_id', 'cli']) {
    const value = raw[field];
    if (typeof value === 'string' && SELF_REPORT_VALUES.includes(value.toLowerCase())) return true;
  }
  return false;
}

export function mapTraeCliRaw(raw, { sessionId, agentType = 'generic', sequencer }) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
  const events = [];

  // 容器帧（event_msg / item / item.completed）：按 item.type 分派（codex 同族候选）。
  const payload = raw.payload || {};
  let item = raw.item || payload.item || null;
  if (!item && payload && typeof payload === 'object' && typeof payload.type === 'string' && payload.type !== 'item') {
    // 无内层 item 容器的变体：payload 本身即 item（如 payload:{type:'agent_message',…}）。
    item = payload;
  }
  if (item && typeof item === 'object') {
    const itemType = item.type || payload.type;
    if (itemType === 'agent_message' || itemType === 'assistant_message') {
      const message = item.message || item;
      const text = extractText(message.content ?? message.text ?? message.message);
      if (text) {
        events.push(createEvent({
          sessionId, agentType, sequencer,
          eventType: 'agent_message',
          payload: {
            message_id: item.id || `m_${crypto.randomUUID()}`,
            stream_id: item.id || null,
            role: message.role || 'assistant',
            content: text,
            content_type: 'text',
            is_final: Boolean(item.status === 'completed' || item.completed || message.stop_reason),
            stop_reason: message.stop_reason || null,
          },
        }));
      }
      return events;
    }
    if (itemType === 'user_message') {
      const message = item.message || item;
      const text = extractText(message.content ?? message.text ?? message.message);
      if (text) {
        events.push(createEvent({
          sessionId, agentType, sequencer,
          eventType: 'user_message',
          payload: { message_id: item.id || `m_${crypto.randomUUID()}`, role: 'user', content: text, content_type: 'text' },
        }));
      }
      return events;
    }
    if (itemType === 'command_execution' || itemType === 'local_shell_call') {
      events.push(createEvent({
        sessionId, agentType, sequencer,
        eventType: 'tool_call',
        payload: {
          tool_call_id: item.call_id || item.id || `tc_${crypto.randomUUID()}`,
          tool_name: item.name || 'Bash',
          input_preview: sanitizePreview(item.command || item.input || item.arguments || {}, 500),
          input_sensitive: false,
          status: item.status || 'running',
        },
      }));
      return events;
    }
    if (itemType === 'reasoning' || itemType === 'reasoning_text') {
      const text = item.text || item.summary || item.content;
      if (text) events.push(redactThinkingEvent({ sessionId, agentType, sequencer, originalText: String(text) }));
      return events;
    }
    if (itemType === 'error') {
      // 容器内 error 为非致命诊断（codex 同族实测语义，候选沿用）：turn 可能继续。
      events.push(createEvent({
        sessionId, agentType, sequencer,
        eventType: 'custom',
        payload: {
          custom_type: 'diagnostic',
          fallback_text: `TRAE CLI 诊断：${String(item.message || '未说明原因').slice(0, 500)}`,
          data: { item_id: item.id || null, message: String(item.message || '') },
        },
      }));
      return events;
    }
    // 容器内未知 item：custom 兜底，不猜测语义。
    events.push(createEvent({
      sessionId, agentType, sequencer,
      eventType: 'custom',
      payload: {
        custom_type: 'trae_raw',
        fallback_text: `TRAE CLI 事件：${typeof itemType === 'string' ? itemType : '未知'}`,
        data: { type: typeof itemType === 'string' ? itemType : null, id: item.id || null },
      },
    }));
    return events;
  }

  switch (raw.type) {
    case 'thread.started': {
      events.push(createEvent({
        sessionId, agentType, sequencer,
        eventType: 'custom',
        payload: {
          custom_type: 'system',
          system_subtype: 'thread_started',
          fallback_text: 'TRAE CLI 会话已启动',
          data: { thread_id: raw.thread_id || null },
        },
      }));
      break;
    }
    case 'turn.started': {
      events.push(createEvent({
        sessionId, agentType, sequencer,
        eventType: 'task_progress',
        payload: { task_id: `turn_${crypto.randomUUID()}`, title: 'TRAE CLI 执行中', current: 0, total: null, percent: null },
      }));
      break;
    }
    case 'turn.completed':
    case 'turn_complete':
    case 'result': {
      // 无用量帧文档：usage 恒空对象（无统计不伪造，§8.3）。
      events.push(createEvent({
        sessionId, agentType, sequencer,
        eventType: 'session_end',
        payload: {
          reason: raw.subtype === 'error' || raw.status === 'error' ? 'error' : 'completed',
          summary: sanitizePreview(raw.result || raw.summary || '会话结束', 1000),
          usage: {},
        },
      }));
      break;
    }
    case 'turn.failed': {
      events.push(createEvent({
        sessionId, agentType, sequencer,
        eventType: 'session_end',
        payload: {
          reason: 'error',
          summary: sanitizePreview(raw.message || 'TRAE CLI 执行失败', 1000),
          usage: {},
        },
      }));
      break;
    }
    case 'error': {
      const message = String(raw.message || raw.error?.message || 'TRAE CLI 错误').slice(0, 1000);
      events.push(createEvent({
        sessionId, agentType, sequencer,
        eventType: 'error',
        payload: {
          error_code: 'TRAE_CLI_ERROR',
          severity: 'fatal',
          message,
          recoverable: false,
        },
      }));
      break;
    }
    case 'message':
    case 'agent_message':
    case 'assistant_message': {
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
    default: {
      // 未知/未来新增帧（含 trae_event 自标识信封）：custom 兜底。
      events.push(createEvent({
        sessionId, agentType, sequencer,
        eventType: 'custom',
        payload: {
          custom_type: 'trae_raw',
          fallback_text: `TRAE CLI 事件：${typeof raw.type === 'string' ? raw.type : '未知'}`,
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
