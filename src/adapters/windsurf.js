import { createEvent, sanitizePreview } from '../lib/events.js';

// Windsurf / Cascade（V12-A14）观察模式解析器骨架——状态 BLOCKED（仅 hooks，无外部控制通道）。
//
// 官方资料事实（xcx/docs/官方资料/A14-windsurf-cascade-hooks.md，快照 2026-09-25）：
//   - 官方入口 docs.windsurf.com/windsurf/cascade/hooks 访问时已重定向至
//     docs.devin.ai/desktop/cascade/hooks（Devin Desktop 承接，legacy Windsurf 路径回退）；
//   - Cascade Hooks 是「Cascade 自身在动作节点拉起的 shell 命令」，经 stdin 收 JSON
//     （agent_action_name / trajectory_id / execution_id / timestamp / model_name / tool_info），
//     以退出码 0/2 回告放行/阻断——是 hook 脚本对 Cascade 的协议，不是任务生命周期协议；
//   - hook 是 Agent 侧主动触发、不保证触发（任务卡边界情况），且 Restricted Mode 下不加载；
//   - 未发现任何官方 headless CLI / create / read / stop 外部接口；本机探测
//     `command -v windsurf` 未安装（2026-09-26，见 docs/release/v1.2/agents/windsurf.md）。
//
// 能力口径（§5.2：仅 hooks 不算 create/read/stop，catalog 与 capabilities.js 保持全 false）：
//   create=false（无进程可拉）、read=false（hook 不保证触发、非输出流）、stop=false
//   （hook 进程归 Cascade 所有，bridge 无进程树可停）、append/resume/approve=false、
//   fileChanges/usage=false（hook 帧含写入信息但未实测、不伪造）。
//   integrationMode='hook'；initialPromptChannel=null。
//
// 本文件只做「若观察管道日后落地则能翻译 hook 帧」的 L1 解析（adapter-contract.md §2.3）：
//   - 只输出观察类事件（user_message / agent_message / custom），绝不伪造
//     tool_call / confirm_required / session_end（观察模式无控制语义）；
//   - agentType 固定 'generic'——AGENT_TYPES 白名单未扩（events.js:34），不擅改公共协议。

const KNOWN_HOOK_ACTIONS = new Set([
  // 用户可见内容帧（官方 §Hook Events 文档形态）
  'pre_user_prompt',
  'post_cascade_response',
  'post_cascade_response_with_transcript',
  // 其余官方 hook 动作：只做脱敏预览观察，不映射为工具/文件/审批事件
  'pre_read_code', 'post_read_code',
  'pre_write_code', 'post_write_code',
  'pre_run_command', 'post_run_command',
  'pre_mcp_tool_use', 'post_mcp_tool_use',
  'post_setup_worktree',
]);

export function isWindsurfStreamType(raw) {
  // hook 帧唯一稳定特征：顶层 agent_action_name 字符串（官方 Common Input Structure）。
  // 不要求 type 字段（hook 帧没有）；对 null/非对象安全，不会误吞 claude-code/codex 帧
  // （两者均有顶层 type 且形状不同，claude/codex 探测分支先于本适配器命中）。
  return Boolean(
    raw && typeof raw === 'object'
    && typeof raw.agent_action_name === 'string'
    && raw.agent_action_name,
  );
}

export function mapWindsurfRaw(raw, { sessionId, agentType = 'generic', sequencer }) {
  if (!isWindsurfStreamType(raw)) return [];
  const action = raw.agent_action_name;
  const toolInfo = (raw.tool_info && typeof raw.tool_info === 'object') ? raw.tool_info : null;
  const events = [];

  switch (action) {
    case 'pre_user_prompt': {
      // 用户 prompt 观察帧：官方 tool_info.user_prompt（字符串）。
      const prompt = typeof toolInfo?.user_prompt === 'string' ? toolInfo.user_prompt : '';
      if (prompt) {
        events.push(createEvent({
          sessionId, agentType, sequencer,
          eventType: 'user_message',
          payload: {
            message_id: `m_ws_${raw.execution_id || 'unknown'}`,
            role: 'user',
            content: prompt,
            content_type: 'text',
          },
        }));
        return events;
      }
      break; // 缺字段 → 落入兜底观察事件，不静默丢弃
    }
    case 'post_cascade_response': {
      // 最终回复观察帧：官方 tool_info.response = 自上次用户输入以来的完整响应
      // （markdown）。这是本适配器唯一的「最终回复」解析路径——注意它由 Cascade
      // 异步触发、不保证送达，不等于 read 能力已验证。
      const response = typeof toolInfo?.response === 'string' ? toolInfo.response : '';
      if (response) {
        events.push(createEvent({
          sessionId, agentType, sequencer,
          eventType: 'agent_message',
          payload: {
            message_id: `m_ws_${raw.execution_id || 'unknown'}`,
            stream_id: raw.trajectory_id || null,
            role: 'assistant',
            content: response,
            content_type: 'text',
            is_final: true, // post_cascade_response 语义即「本轮响应已完结」
          },
        }));
        return events;
      }
      break;
    }
    case 'post_cascade_response_with_transcript': {
      // 转写文件观察帧：只上报路径（截断 + 预览），绝不读取文件内容——
      // 解析器零 IO（契约 §3.1），且官方明示转写含敏感代码/对话数据。
      const transcriptPath = typeof toolInfo?.transcript_path === 'string' ? toolInfo.transcript_path : '';
      events.push(createEvent({
        sessionId, agentType, sequencer,
        eventType: 'custom',
        payload: {
          custom_type: 'windsurf_hook',
          fallback_text: 'Cascade 已生成完整转写文件（内容不读取、不上传）',
          data: {
            action_name: action,
            transcript_path: sanitizePreview(transcriptPath || null, 300),
            trajectory_id: sanitizePreview(raw.trajectory_id || null, 128),
          },
        },
      }));
      return events;
    }
    default:
      break;
  }

  if (KNOWN_HOOK_ACTIONS.has(action)) {
    // 其余观察动作：统一 custom 观察事件（tool_info 只做脱敏预览，不解释为工具调用）。
    events.push(createEvent({
      sessionId, agentType, sequencer,
      eventType: 'custom',
      payload: {
        custom_type: 'windsurf_hook',
        fallback_text: `Cascade hook 观察：${action}`,
        data: {
          action_name: action,
          tool_info_preview: sanitizePreview(toolInfo, 500),
          trajectory_id: sanitizePreview(raw.trajectory_id || null, 128),
          execution_id: sanitizePreview(raw.execution_id || null, 128),
          model_name: sanitizePreview(raw.model_name || null, 100),
        },
      },
    }));
    return events;
  }

  // 未知/畸形动作名兜底（契约 §3.3：不抛出，custom 兜底）。
  events.push(createEvent({
    sessionId, agentType, sequencer,
    eventType: 'custom',
    payload: {
      custom_type: 'windsurf_hook_unknown',
      fallback_text: `未知 Windsurf hook 事件：${sanitizePreview(action, 100)}`,
      data: { action_name: sanitizePreview(action, 100) },
    },
  }));
  return events;
}
