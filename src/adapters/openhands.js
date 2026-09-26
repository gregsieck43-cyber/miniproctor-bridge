import { createEvent, sanitizePreview, sanitizeSensitiveText } from '../lib/events.js';

// OpenHands（V12-A25）解析器——纯函数零 IO，只做帧翻译（adapter-contract.md §3）。
//
// 官方资料：xcx/docs/官方资料/A25-openhands-cli-headless.md（docs.openhands.dev/openhands/usage/cli/headless，
// 快照 2026-09-25）。`openhands --headless --json -t "<任务>"` 输出 JSONL，官方文档仅记载三类帧形：
//   {"type": "action",      "action": "write", "path": "app.py", ...}
//   {"type": "observation", "content": "File created successfully", ...}
//   {"type": "action",      "action": "run",   "command": "python app.py", ...}
//
// 权限边界（V12-A25 核验结论；2026-09-26 在线复核与快照一致）：
//   headless 模式强制 always-approve（官方原文 "Headless mode always runs in always-approve mode ...
//   cannot be changed—--llm-approve is not available in headless mode"），该页未记载受限 sandbox 或
//   正式取消接口——唯一非交互通路对任意动作（写文件/执行命令）全自动批准，不符合最小权限，
//   不作为默认实现；本解析器仅为 L1 fixture 级证据，create 通路保持 BLOCKED，能力声明一律 false
//   （§5.2 catalog-known 不算已支持）。
//
// 最终回复：官方 CLI 快照未记载最终回复帧形状（SDK 事件类模型 MessageEvent/llm_message 与 CLI
// JSONL 形状不可混用，不得编造接口）——未记载帧一律 custom 兜底（§3.3），真实帧流待 V03 取证。
//
// 最小化（§3.5）：action 帧的 content 类字段（写文件全文等）不进预览——预览只取 command/path；
// 未知动作只展示动作名与字段名清单；observation 内容过凭据形态清洗后再预览。

export function isOpenhandsStreamType(raw) {
  // 只认官方文档记载的两类帧；其余形态（含可能的 message 类）不劫持，交给 generic
  // 兜底或本映射的 custom 分支，避免把未验证形状当已验证翻译。
  return Boolean(
    raw && typeof raw === 'object'
    && (raw.type === 'action' || raw.type === 'observation'),
  );
}

export function mapOpenhandsRaw(raw, { sessionId, agentType = 'generic', sequencer }) {
  if (!isOpenhandsStreamType(raw)) return [];

  if (raw.type === 'action') {
    const action = typeof raw.action === 'string' && raw.action ? raw.action : 'unknown';
    // 预览来源只取命令/路径等标量字段；绝不透传 content（写文件全文）。
    let previewSource;
    if (typeof raw.command === 'string' && raw.command) previewSource = raw.command;
    else if (typeof raw.path === 'string' && raw.path) previewSource = raw.path;
    else previewSource = { action, fields: Object.keys(raw).filter((k) => k !== 'type').slice(0, 16) };
    return [createEvent({
      sessionId, agentType, sequencer,
      eventType: 'tool_call',
      payload: {
        tool_call_id: firstString(raw.tool_call_id, raw.id) || `tc_${crypto.randomUUID()}`,
        tool_name: action,
        input_preview: sanitizeSensitiveText(sanitizePreview(previewSource, 500)),
        input_sensitive: false,
        status: 'running',
      },
    })];
  }

  // observation 帧 → tool_result（官方示例 {"type":"observation","content":"..."}）。
  // 无 content 的观察帧不猜测成功/失败语义，落入 custom 兜底。
  if (typeof raw.content === 'string' && raw.content) {
    return [createEvent({
      sessionId, agentType, sequencer,
      eventType: 'tool_result',
      payload: {
        tool_call_id: firstString(raw.tool_call_id, raw.id) || `tc_${crypto.randomUUID()}`,
        tool_name: firstString(raw.tool_name) || 'unknown',
        status: 'success',
        result_preview: sanitizeSensitiveText(sanitizePreview(raw.content, 500)),
        result_sensitive: false,
      },
    })];
  }

  return [createEvent({
    sessionId, agentType, sequencer,
    eventType: 'custom',
    payload: {
      custom_type: 'openhands_raw',
      fallback_text: `OpenHands 事件：${typeof raw.type === 'string' ? raw.type : 'unknown'}（官方未记载该帧形状，原文未透传）`,
      data: { type: typeof raw.type === 'string' ? raw.type : null, fields: Object.keys(raw).slice(0, 16) },
    },
  })];
}

function firstString(...values) {
  for (const v of values) {
    if (typeof v === 'string' && v) return v;
  }
  return null;
}
