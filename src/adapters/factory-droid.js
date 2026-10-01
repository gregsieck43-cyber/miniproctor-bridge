import { createEvent, sanitizeSensitiveText } from '../lib/events.js';

// Factory Droid（V12-A10）`droid exec` JSON 输出适配器。
//
// 官方资料事实（xcx/docs/官方资料/A10-factory-droid-exec-overview.md，快照 2026-09-25，来源
// https://docs.factory.ai/droid-exec/overview）：
//   - 调用形态：`droid exec [options] [prompt]` 一次性任务（「single non-interactive pass」），
//     prompt 为位置参数 → 初始 prompt 通道 launch-args；另有 -f <file> 与管道 stdin 两种喂入；
//   - 文档化结构化输出（「json」节）为单个 result 对象：
//       { "type":"result", "subtype":"success", "is_error":false, "duration_ms":5657,
//         "num_turns":1, "result":"...", "session_id":"8af22e0a-d222-42c6-8c7e-7a059e391b0b" }
//     （快照仅记载此一种结构化输出帧；流式 JSONL 帧形状未记载）；
//   - 权限：exec 默认只读 spec 模式（「Read-only by default with explicit opt-in」），
//     提权需显式 --auto low|medium|high；--skip-permissions-unsafe 仅限一次性容器。
//     桥接默认不追加任何 --auto / --skip-permissions-unsafe（安全默认，主方案 §6 A10）；
//   - 退出语义：「exits 0 on success and non-zero on failure (permission violation, tool
//     error, unmet objective)」——非零退出/超时终态由 runner 的 session_exit 承载；
//   - resume：CLI 有 --session-id / --fork 通道（快照「Sessions, tagging, and logs」），
//     但 bridge 无恢复实现路径 → 声明 false；
//   - approve：双向 stream-jsonrpc 协议有 droid.request_permission 服务端请求（快照
//     「Build custom flows on raw JSON-RPC」），本项目未实现该协议 → 声明 false。
//
// 2026-09-28 Windows 0.174.0 未登录实测：result/failure 帧新增 usage 四种 token 计数。
// 2026-10-01 官方 BYOK 经既有后端真实返回 12701；绑定 ManagedSession 映射最终
// 18677/completed/usage/exit 0，运行中 stop 的原生两 PID 退出。0.174.0 的
// hooksDisabled=true 在用户和 runtime 配置下均未阻止 SessionStart hook，
// 固定 0.230.0 同样失败，runtime allowManagedHooksOnly 也未阻止自有用户 hook；
// 安全配方与正常 profile/真云仍未验，create/read/stop 能力保持关闭。
// 设计立场与已知取舍：
//   - 绑定 profile 的成功 result 将最终文本映射 agent_message + session_end；未绑定分支
//     保持原 session_end 语义，避免同形帧改变其他产品行为；失败帧仅 session_end；
//     usage 仅接受真实帧的非负安全整数，缺失时 {}（无统计不伪造 §8.3）；
//   - result 帧与 Claude Code result 帧高度同形（Factory 沿用了该格式），且 gemini/qwen
//     （stream-json 同源族）亦有 result 形帧。分发上本探测分支排在 claude 之前（generic.js
//     唯一接线点），靠「缺少 usage / total_cost_usd / cost_usd / duration_api_ms 键」排除
//     Claude 真帧（Claude result 帧恒带 usage 与费用字段，mapClaudeRaw 直接读取 raw.usage）；
//     不符合 Droid 签名的 result 族帧回落同形族分支（gemini/qwen/claude）按其签名归属——
//     各分支对 result 的映射语义一致（session_end），该取舍记录于证据卡与任务报告；
//   - agentType 固定 'generic'——AGENT_TYPES 白名单未扩（events.js:34 / protocol/schema.cjs:130
//     禁改），会话身份由 session_meta agent_key 承载。
// 原生单项不等于正常 profile 通过，详见 docs/release/v1.2/agents/factory-droid.md。

// Claude result 帧特有、Droid 文档化 result 帧没有的键（用于同形帧甄别）。
const CLAUDE_ONLY_RESULT_KEYS = Object.freeze(['usage', 'total_cost_usd', 'cost_usd', 'duration_api_ms']);

export function isFactoryDroidStreamType(raw) {
  // Droid 文档化 result 签名：type=result + is_error 布尔 + duration_ms/num_turns 数值
  // + session_id/result 字符串；再排除 Claude 同形真帧。对 null/数组/非对象安全。
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  if (raw.type !== 'result') return false;
  if (!(raw.is_error === true || raw.is_error === false)) return false;
  if (!Number.isFinite(raw.duration_ms) || !Number.isFinite(raw.num_turns)) return false;
  if (typeof raw.session_id !== 'string' || !raw.session_id) return false;
  if (typeof raw.result !== 'string') return false;
  if (CLAUDE_ONLY_RESULT_KEYS.some((k) => k in raw)) return false;
  return true;
}

/** 绑定 profile 后，产品身份由启动规格给出；0.174.0 的 result 可包含 usage。 */
export function isFactoryDroidProfileOutput(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  return raw.type === 'result'
    && typeof raw.is_error === 'boolean'
    && Number.isFinite(raw.duration_ms)
    && Number.isFinite(raw.num_turns)
    && typeof raw.session_id === 'string' && raw.session_id.length > 0
    && typeof raw.result === 'string';
}

function mapUsage(rawUsage) {
  if (!rawUsage || typeof rawUsage !== 'object' || Array.isArray(rawUsage)) return {};
  const usage = {};
  for (const key of ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens']) {
    const value = rawUsage[key];
    if (Number.isSafeInteger(value) && value >= 0) usage[key] = value;
  }
  return usage;
}

export function mapFactoryDroidRaw(raw, { sessionId, agentType = 'generic', sequencer, profileBound = false }) {
  if (!isFactoryDroidProfileOutput(raw)) return [];
  const failed = raw.is_error || raw.subtype === 'error' || raw.subtype === 'failure';
  const result = sanitizeSensitiveText(raw.result);
  const events = [];
  if (profileBound && !failed && result) events.push(createEvent({
    sessionId, agentType, sequencer,
    eventType: 'agent_message',
    payload: {
      message_id: `m_droid_${sequencer.next()}`, stream_id: null, role: 'assistant',
      content: result, content_type: 'text', is_final: true, stop_reason: null,
    },
  }));
  events.push(createEvent({
    sessionId, agentType, sequencer,
    eventType: 'session_end',
    payload: {
      reason: failed ? 'error' : 'completed',
      summary: result.slice(0, 1000),
      usage: mapUsage(raw.usage),
    },
  }));
  return events;
}
