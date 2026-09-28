import { AGENT_TYPES, createEvent, sanitizePreview } from '../lib/events.js';

// Auggie 适配器（V12-A12，任务卡 §23.1 + 官方快照 xcx/docs/官方资料/A12-auggie-readme.md）。
//
// 候选模式：0.36.0 的 `--print --quiet --ask`；新版还提供 JSON 输出和 ACP。
// 当前仅旧 print 文本解析器与测试辅助参数，尚无产品 runtime；CLI 已安装，但用户无账号，
// 模型输出、工作区索引授权与权限负向探针均未验。真实能力保持关闭。
//
// 因此（generic 式文本产品，不伪造工具事件）：
//   - isAuggieStreamType 恒 false：本解析器只处理候选 text 模式，不与其他产品的
//     JSON 分发抢帧（generic.js 对 auggie 会话按 agentType 分流文本行）；
//   - mapAuggieTextLine：单行文本 → agent_message（行级纯函数无跨行聚合状态，
//     进程退出由 runner 终态承载）；
//   - mapAuggieRaw：万一收到 JSON 行（版本漂移/异常），只落 custom 兜底，不伪造工具/审批帧。
//
// 能力口径（如实拆分，未实测一律 false；CLI 已装但未登录，真实往返未取证——权威执行门禁
// 在 capabilities.js，本卡按简报不修改该文件，运行时 fail-closed 到 generic 底线）：
//   create/read/stop=true（print 一次性任务拉起 + stdout 文本解析 + runner 进程树终止，
//   均待装机真实验证）；append=false（print 单次运行无中途追加）；resume=false（未实测）；
//   approve=false（无审批回写通道证据）；fileChanges=false（print 无文件变更输出证据）；
//   usage=false（无 token 统计输出证据，无统计不伪造 §8.3）。

function normalizeAgentType(agentType) {
  return AGENT_TYPES.includes(agentType) ? agentType : 'generic';
}

export function isAuggieStreamType(raw) {
  // 候选 print 文本解析器不接新版 JSON/ACP；恒 false，
  // 保持与契约 §3.2 的接口形态一致（对 null/非对象安全）。
  return false;
}

/** print 模式纯文本行 → agent_message；空行/纯空白行不产生事件。 */
export function mapAuggieTextLine(line, { sessionId, agentType, sequencer }) {
  const at = normalizeAgentType(agentType);
  const text = String(line ?? '').replace(/\r$/, '').trimEnd();
  if (!text.trim()) return [];
  return [createEvent({
    sessionId, agentType: at, sequencer,
    eventType: 'agent_message',
    payload: {
      message_id: `m_auggie_${crypto.randomUUID()}`,
      role: 'assistant',
      content: text,
      content_type: 'text',
      is_final: true,
    },
  })];
}

/** JSON 行兜底：当前文本解析器不认新版结构化输出，未知对象一律 custom。 */
export function mapAuggieRaw(raw, { sessionId, agentType, sequencer }) {
  const at = normalizeAgentType(agentType);
  if (!raw || typeof raw !== 'object') return [];
  return [createEvent({
    sessionId, agentType: at, sequencer,
    eventType: 'custom',
    payload: {
      custom_type: 'auggie_raw',
      fallback_text: sanitizePreview('Auggie 未识别输出（print 模式官方为纯文本）：未知 JSON 事件', 200),
      data: { type: typeof raw.type === 'string' ? raw.type : null },
    },
  })];
}

/**
 * 安全启动参数模板（launch-args 初始 prompt 通道；AdapterFactory launchArgsResolver 注入消费）。
 * 候选 print 文本模式：只读 Ask + 显式禁用写入/进程工具；prompt 数组直传 spawn，
 * 无 shell 无拼接。0.36.0 的 tools list 已读回禁用状态，但未登录、未做模型负向探针；
 * --print 跳过索引确认，正式 runtime 仍须解决工作区索引授权，不能仅凭本模板开放。
 */
export function buildAuggieLaunchArgs(prompt) {
  if (typeof prompt !== 'string' || !prompt.trim()) throw new TypeError('auggie 初始 prompt 必须是非空字符串');
  return [
    '--print', '--quiet', '--ask', '--no-discover-workspaces', '--dont-save-session',
    ...['remove-files', 'save-file', 'apply_patch', 'str-replace-editor',
      'launch-process', 'kill-process', 'write-process'].flatMap((tool) => ['--remove-tool', tool]),
    ...['terminal:deny', 'edit:deny', 'write:deny'].flatMap((rule) => ['--permission', rule]),
    prompt,
  ];
}
