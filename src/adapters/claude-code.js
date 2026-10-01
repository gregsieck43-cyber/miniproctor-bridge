import crypto from 'node:crypto';
import { createEvent, getEventPolicy, redactThinkingEvent, sanitizePreview, truncateText } from '../lib/events.js';

const KNOWN_TYPES = new Set([
  'system', 'assistant', 'user', 'result', 'control_request', 'control_cancel_request',
  // V12-A01：--include-partial-messages 时的逐 token 增量帧（官方 headless 文档"Stream responses"）。
  // bridge 预设未开启该旗标（src/lib/config.js AGENT_PRESETS）；若用户显式开启，完整文本仍会随
  // assistant/result 帧到达，逐帧转发增量只会重复刷屏并灌爆 outbox（信封 7.5KB × 每 token 一帧），
  // 故识别后安全丢弃（见 mapClaudeRaw stream_event 分支），不落入 generic"未知 JSON 事件"兜底。
  'stream_event',
]);

export function isClaudeStreamType(raw) {
  return Boolean(raw && typeof raw === 'object' && KNOWN_TYPES.has(raw.type));
}

export function mapClaudeRaw(raw, { sessionId, agentType = 'claude-code', sequencer }) {
  if (!raw || typeof raw !== 'object') return [];
  const events = [];
  switch (raw.type) {
    case 'stream_event': {
      // V12-A01：见 KNOWN_TYPES 注释——增量帧识别后丢弃，最终内容以 assistant/result 帧为准。
      break;
    }
    case 'system': {
      // 2.1.286 每个思考 token 都可能发计数通知；没有可展示正文。真实长任务
      // 产生 1300+ 条，逐条上传挤占云调用/事件预算。最终 result.usage 保留统计。
      if (raw.subtype === 'thinking_tokens') break;
      // V12-A01：API 重试帧（官方 headless 文档"Handle API retries"：attempt/max_retries/
      // retry_delay_ms/error_status/error）。旧实现落通用 system 分支只显示"系统事件：api_retry"，
      // 手机端看不到重试进度与错误类别（§23.1：拒绝/过期/错误需准确反馈）。
      if (raw.subtype === 'api_retry') {
        events.push(createEvent({
          sessionId, agentType, sequencer,
          eventType: 'custom',
          payload: {
            custom_type: 'api_retry',
            fallback_text: `API 请求重试中（第 ${numberOrZero(raw.attempt)} 次 / 上限 ${numberOrZero(raw.max_retries)}）：${raw.error || 'unknown'}`,
            data: {
              attempt: numberOrZero(raw.attempt),
              max_retries: numberOrZero(raw.max_retries),
              retry_delay_ms: numberOrZero(raw.retry_delay_ms),
              error_status: raw.error_status ?? null,
              error: raw.error || 'unknown',
            },
          },
        }));
        break;
      }
      // V12-A01：权限拒绝帧（官方 headless 文档"With --output-format stream-json, denials appear
      // as permission_denied system messages"）。官方未给出该帧完整字段 schema，此处只透传可
      // 确认的 message/uuid，其余字段安全降级——区分"Agent 主动报错"与"权限被拒"（卡边界：拒绝）。
      if (raw.subtype === 'permission_denied') {
        const deniedText = typeof raw.message === 'string' && raw.message ? raw.message : '一次权限请求被拒绝';
        events.push(createEvent({
          sessionId, agentType, sequencer,
          eventType: 'custom',
          payload: {
            custom_type: 'permission_denied',
            fallback_text: `权限被拒绝：${deniedText}`.slice(0, 500),
            data: { message: deniedText, uuid: typeof raw.uuid === 'string' ? raw.uuid : null },
          },
        }));
        break;
      }
      events.push(createEvent({
        sessionId, agentType, sequencer,
        eventType: 'custom',
        payload: {
          custom_type: 'system',
          system_subtype: raw.subtype || 'unknown',
          fallback_text: raw.subtype === 'init' ? '会话已初始化' : `系统事件：${raw.subtype || 'unknown'}`,
          data: { model: raw.model || null, tools: Array.isArray(raw.tools) ? raw.tools.slice(0, 20) : [] },
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
          // TASK-019 ②①：thinking/sensitive 默认不上传正文（落实《隐私与数据清单》"默认
          // 不上传"承诺）——降级为脱敏占位事件（type 保留 + redacted/original_bytes）；
          // 仅当 config bridge.uploadThinking=true 显式开启时透传正文（createEvent 对
          // metadata.sensitive 事件还会做凭据形态二次清洗，双保险）。
          if (getEventPolicy().uploadThinking) {
            events.push(createEvent({
              sessionId, agentType, sequencer,
              eventType: 'custom',
              payload: {
                custom_type: 'thinking',
                fallback_text: item.thinking,
                data: { thinking: item.thinking },
              },
              metadata: { sensitive: true },
            }));
          } else {
            events.push(redactThinkingEvent({
              sessionId, agentType, sequencer, originalText: item.thinking,
            }));
          }
        } else if (item.type === 'tool_use') {
          events.push(createEvent({
            sessionId, agentType, sequencer,
            eventType: 'tool_call',
            payload: {
              tool_call_id: item.id || `tc_${crypto.randomUUID()}`,
              tool_name: item.name || 'unknown',
              input_preview: sanitizePreview(item.input ?? {}, 500),
              input_sensitive: false,
              status: 'running',
            },
          }));
          const fileEvent = fileChangeFromTool(item);
          if (fileEvent) {
            events.push(createEvent({
              sessionId, agentType, sequencer,
              eventType: 'file_change',
              payload: fileEvent,
            }));
          }
        }
      }
      break;
    }
    case 'user': {
      const message = raw.message || {};
      const content = message.content;
      // V12-A01 加固：stream-json 输入模式下工具结果以 user 帧回传（官方 subagent 文档：user
      // 消息携带 tool_result 块；bridge 预设还开了 --replay-user-messages）。旧实现把整块
      // content JSON.stringify 后伪装成 user_message 上行——工具结果常含文件内容/命令输出，
      // 既污染对话流又放大隐私面。现按块类型分派：tool_result → 协议 §3.4 tool_result 事件；
      // text → user_message；无法识别的块保留旧 JSON 兜底（不静默丢弃）。
      if (Array.isArray(content)) {
        let emitted = false;
        for (const item of content) {
          if (!item || typeof item !== 'object') continue;
          if (item.type === 'tool_result') {
            emitted = true;
            events.push(createEvent({
              sessionId, agentType, sequencer,
              eventType: 'tool_result',
              payload: {
                tool_call_id: item.tool_use_id || `tc_${crypto.randomUUID()}`,
                // tool_result 块不携带工具名；适配器为纯函数无状态，无法回查先前 tool_call——
                // 如实置 null（手机端 tool_result 卡只渲染 result_preview，不依赖 tool_name）。
                tool_name: null,
                status: item.is_error ? 'error' : 'success',
                result_preview: sanitizePreview(item.content ?? '', 500),
                result_sensitive: false,
              },
            }));
          } else if (item.type === 'text' && typeof item.text === 'string' && item.text) {
            emitted = true;
            events.push(createEvent({
              sessionId, agentType, sequencer,
              eventType: 'user_message',
              payload: {
                message_id: message.id || `m_${crypto.randomUUID()}`,
                role: 'user',
                content: item.text,
                content_type: 'text',
              },
            }));
          }
        }
        if (!emitted) {
          const text = JSON.stringify(content);
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
        }
      } else {
        const text = typeof content === 'string' ? content : JSON.stringify(content || {});
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
      }
      break;
    }
    case 'control_request': {
      const request = raw.request || {};
      if (request.subtype === 'can_use_tool') {
        events.push(createEvent({
          sessionId, agentType, sequencer,
          eventType: 'confirm_required',
          payload: {
            request_id: raw.request_id || `req_${crypto.randomUUID()}`,
            kind: 'tool_permission',
            title: `是否允许 ${request.tool_name || '工具'}？`,
            detail: sanitizePreview(request.input ?? {}, 500),
            context: {
              tool_name: request.tool_name || 'unknown',
              input_preview: sanitizePreview(request.input ?? {}, 500),
              cwd: null,
            },
            timeout_seconds: 120,
          },
          actions: [
            { action_id: 'approve', type: 'approve', label: '允许', style: 'primary' },
            { action_id: 'reject', type: 'reject', label: '拒绝', style: 'danger' },
          ],
        }));
      } else {
        events.push(createEvent({
          sessionId, agentType, sequencer,
          eventType: 'custom',
          payload: {
            custom_type: 'control_request',
            fallback_text: `控制请求：${request.subtype || 'unknown'}`,
            data: { request_id: raw.request_id || null, subtype: request.subtype || null },
          },
        }));
      }
      break;
    }
    case 'control_cancel_request': {
      events.push(createEvent({
        sessionId, agentType, sequencer,
        eventType: 'custom',
        payload: {
          custom_type: 'control_cancel_request',
          fallback_text: '审批请求已取消',
          data: { request_id: raw.request_id || null },
        },
      }));
      break;
    }
    case 'result': {
      const subtype = raw.subtype || 'completed';
      const usage = raw.usage || {};
      // V12-A01 加固：官方 headless 文档——运行内失败（如鉴权缺失）会把失败信息作为 result
      // 落到 stdout（携带 is_error 标记）。旧映射把一切非 success/error_max_turns 子类型归为
      // reason 'stopped'，失败终局会被当成正常停止展示（§23.1：错误需准确反馈）。现按
      // is_error/error 子类型显式归 error（协议 §3.10 reason 枚举：completed|stopped|error|timeout）。
      const isError = raw.is_error === true
        || subtype === 'error_during_execution'
        || subtype === 'error';
      const reason = isError ? 'error'
        : subtype === 'success' ? 'completed'
          : subtype === 'error_max_turns' ? 'timeout'
            : 'stopped';
      events.push(createEvent({
        sessionId, agentType, sequencer,
        eventType: 'session_end',
        payload: {
          reason,
          summary: typeof raw.result === 'string' ? raw.result.slice(0, 1000) : `会话结束（${subtype}）`,
          usage: {
            input_tokens: numberOrZero(usage.input_tokens),
            output_tokens: numberOrZero(usage.output_tokens),
            cache_read_input_tokens: numberOrZero(usage.cache_read_input_tokens),
            cache_creation_input_tokens: numberOrZero(usage.cache_creation_input_tokens),
          },
        },
      }));
      break;
    }
    default:
      break;
  }
  return events;
}

function fileChangeFromTool(item) {
  const editTools = new Set(['Edit', 'Write', 'NotebookEdit', 'MultiEdit']);
  if (!editTools.has(item.name) || !item.input || typeof item.input !== 'object') return null;
  const filePath = item.input.file_path || item.input.notebook_path || item.input.path;
  if (!filePath) return null;
  const oldText = typeof item.input.old_string === 'string' ? item.input.old_string : '';
  const newText = typeof item.input.new_string === 'string' ? item.input.new_string : '';
  const NL = String.fromCharCode(10);
  const CR = String.fromCharCode(13);
  const prefix = (text, mark) => {
    const clean = text.split(NL).map((line) => line.endsWith(CR) ? line.slice(0, -1) : line);
    return clean.map((line) => `${mark} ${line}`).join(NL);
  };
  const lines = [`--- ${filePath}`];
  if (oldText) lines.push(prefix(oldText, '-'));
  if (newText) lines.push(prefix(newText, '+'));
  // TASK-019 ②②：diff 预览上限从 8KB 收到 6KB——与信封 7.5KB 收敛上限协调，
  // file_change 事件整体不再触发信封级截断（原 8KB 预览 + 头部必然超 7.5KB）。
  const preview = truncateText(lines.join(NL), 6144);
  return {
    file_path: filePath,
    change_type: item.name === 'Write' ? 'created' : 'modified',
    summary: `${item.name} ${filePath}`,
    diff_preview: preview,
    diff_bytes: Buffer.byteLength(preview, 'utf8'),
    truncated: Buffer.byteLength(preview, 'utf8') >= 6144,
  };
}

function numberOrZero(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}
