import { createEvent } from '../lib/events.js';
import { isClaudeStreamType, mapClaudeRaw } from './claude-code.js';
import { isCodexStreamType, mapCodexRaw } from './codex.js';
import { isWindsurfStreamType, mapWindsurfRaw } from './windsurf.js';
// V12-A05/A11/A12（适配组3）：opencode/amp/auggie 探测与分发（契约 §3 授权的唯一接线点）。
import { isOpenCodeStreamType, mapOpenCodeRaw } from './opencode.js';
import { isGooseStreamType, mapGooseRaw } from './goose.js';
import { isContinueHeadlessOutput, mapContinueHeadlessOutput } from './continue.js';
import { mapAmpRaw, mapAmpTextLine } from './amp.js';
import { mapAuggieRaw, mapAuggieTextLine } from './auggie.js';
// V12-A07/A10/A13（适配组5）：cline NDJSON / droid exec JSON / kiro-cli 文本（契约 §3 授权的唯一接线点）。
import { isClineStreamType, mapClineRaw, isClineProfileOutput, mapClineProfileOutput } from './cline.js';
import { isFactoryDroidStreamType, mapFactoryDroidRaw } from './factory-droid.js';
import { mapKiroCliRaw, mapKiroCliTextLine } from './kiro-cli.js';
// V12-A25/A27（适配组10）：openhands --json JSONL / openclaw agent exec --json 稳定信封
// （契约 §3 授权的唯一接线点）。两者均为 fixture 级解析器（真实 CLI 往返未取证，能力声明全
// false），接线只保证「若 CLI 发帧则能解析」，不扩大任何能力（§5.2）。
import { isOpenhandsStreamType, mapOpenhandsRaw } from './openhands.js';
import { isOpenhandsSdkFrame, mapOpenhandsSdkFrame } from './openhands-sdk.js';
import { isOpenclawStreamType, mapOpenclawRaw } from './openclaw.js';
// V12-A19/A20/A21（适配组7）：qoder-cn / trae-cli / codearts-agent 探测与分发（契约 §3 唯一接线点）。
// 三产品输出帧 schema 均无官方文档（快照 A19a/A20b/A21 缺口已如实登记），探测器只认「显式自报
// 标记」（顶层 agent/agent_key/adapter/adapter_id/cli ∈ 产品名）或产品特异自标识信封（qoder_event/
// trae_event/codearts_event、codearts ses_ 前缀会话 ID），不按帧形猜测——故必须置于一切按帧形
// 探测的分支（droid/claude/codex 等）之前：同形帧（如 claude 同族 assistant/result、codex 同族
// thread.*）若先入按帧形分支会被硬编码 agent_type 产品错标；自报字段属不可信输入，仅用于选择
// 解析器，不写权限、不扩大能力（§7.1）。无标记帧继续走后续 droid→claude→codex→generic 兜底。
import { isQoderCnStreamType, mapQoderCnRaw } from './qoder-cn.js';
import { isTraeCliStreamType, mapTraeCliRaw } from './trae-cli.js';
import { isCodeartsAgentStreamType, mapCodeartsAgentRaw } from './codearts-agent.js';
// V12-A16/A17（适配组6）：kimi Wire JSON-RPC / codebuddy headless stream-json（契约 §3 授权的唯一接线点）。
// kimi 帧为 JSON-RPC 2.0 信封（jsonrpc/method/id），与现有全部探测器零重叠，无条件认领；
// codebuddy init/assistant/result 与 claude stream-json 同形（官方声明对齐 CC v2.1.88），仅在
// generic 桶内认领「官方文档化 cbc 专属标记」（_requestId/_meta 会话请求 ID/rewind 扩展字段）
// 的帧——无标记同形帧仍走 claude 分支（归属局限已在适配器头注释与证据卡如实登记，待 V03 取证修订）。
// 两产品事件 agent_type 固定 'generic'（AGENT_TYPES 白名单未扩，身份由 catalog agent_key 承载）。
// qoder（V12-A18）官方快照未提供帧 schema，探测器为空集，刻意不加分支（见 src/adapters/qoder.js）。
import { isKimiCodeStreamType, mapKimiCodeRaw } from './kimi-code.js';
import { isCodebuddyStreamType, mapCodebuddyRaw } from './codebuddy.js';
// V12-A03/A15（适配组2）：gemini-cli / qwen-code stream-json 解析（契约 §3 授权的唯一接线点）。
import { isGeminiStreamType, mapGeminiRaw } from './gemini-cli.js';
import { isQwenStreamType, mapQwenRaw } from './qwen-code.js';
// V12-A04（适配组4）：cursor-cli print/stream-json 探测与分发（契约 §3 授权的唯一接线点）。
import { isCursorCliStreamType, mapCursorCliRaw } from './cursor-cli.js';

const PROFILE_PARSERS = Object.freeze({
  'claude-code': Object.freeze({ accepts: isClaudeStreamType, map: mapClaudeRaw, agentType: 'claude-code' }),
  codex: Object.freeze({ accepts: isCodexStreamType, map: mapCodexRaw, agentType: 'codex' }),
  opencode: Object.freeze({ accepts: isOpenCodeStreamType, map: mapOpenCodeRaw, agentType: 'generic' }),
  goose: Object.freeze({ accepts: isGooseStreamType, map: mapGooseRaw, agentType: 'generic' }),
  continue: Object.freeze({ accepts: isContinueHeadlessOutput, map: mapContinueHeadlessOutput, agentType: 'generic' }),
  cline: Object.freeze({ accepts: isClineProfileOutput, map: mapClineProfileOutput, agentType: 'generic' }),
  'qwen-code': Object.freeze({ accepts: isQwenStreamType, map: mapQwenRaw, agentType: 'generic' }),
  openhands: Object.freeze({ accepts: isOpenhandsSdkFrame, map: mapOpenhandsSdkFrame, agentType: 'generic' }),
});

export function lineToEvent(line, { sessionId, agentType = 'generic', agentKey = null, sequencer }) {
  if (!line) return [];
  let raw = null;
  try { raw = JSON.parse(line); } catch { raw = null; }
  // Profile 启动时产品身份已经冻结；同形 JSON 不能再由其他产品的探测器认领。
  // 未知帧只产生有限诊断，不把原始 stdout 或异产品 result 伪装为最终答复。
  const hasProfileKey = typeof agentKey === 'string' && agentKey.length > 0;
  const profileParser = hasProfileKey && Object.hasOwn(PROFILE_PARSERS, agentKey)
    ? PROFILE_PARSERS[agentKey] : null;
  if (hasProfileKey) {
    if (profileParser?.accepts(raw, line)) {
      return profileParser.map(raw, { sessionId, agentType: profileParser.agentType, sequencer, line });
    }
    return [createEvent({
      sessionId, agentType: profileParser?.agentType || 'generic', sequencer,
      eventType: 'custom',
      payload: {
        custom_type: 'unrecognized_product_output',
        fallback_text: '已绑定产品输出未识别，请检查本机 CLI 版本与日志',
        data: { agent_key: agentKey, output_format: raw && typeof raw === 'object' ? 'json' : 'text' },
      },
    })];
  }
  // V12-A19/A20/A21：自报标记/产品特异信封优先甄别（理由见上方 import 处注释）。
  if (isQoderCnStreamType(raw)) {
    return mapQoderCnRaw(raw, { sessionId, agentType, sequencer });
  }
  if (isTraeCliStreamType(raw)) {
    return mapTraeCliRaw(raw, { sessionId, agentType, sequencer });
  }
  if (isCodeartsAgentStreamType(raw)) {
    return mapCodeartsAgentRaw(raw, { sessionId, agentType, sequencer });
  }
  // V12-A16：kimi Wire JSON-RPC 2.0 信封独有（jsonrpc='2.0' + method/id），先于一切按帧形
  // 探测的分支；事件 agent_type 固定 'generic'（白名单未扩）。
  if (isKimiCodeStreamType(raw)) {
    return mapKimiCodeRaw(raw, { sessionId, agentType: 'generic', sequencer });
  }
  // V12-A17：cbc 标记帧是 claude 家族形状的子集，必须先于 claude/droid 认领；仅 generic 桶
  // 生效（与 gemini/qwen/cursor 同守卫），claude-code/codex 会话零回归。
  if (agentType === 'generic' && isCodebuddyStreamType(raw)) {
    return mapCodebuddyRaw(raw, { sessionId, agentType: 'generic', sequencer });
  }
  // V12-A10：Droid result 帧必须先于 claude 甄别——Factory 沿用了 Claude 的 result 格式
  // （同形帧），isFactoryDroidStreamType 以「缺 usage/费用键 + Droid 文档化字段齐备」排除
  // Claude 真帧；agentType 固定 'generic'（AGENT_TYPES 白名单未扩，身份由 session_meta 承载）。
  if (isFactoryDroidStreamType(raw)) {
    return mapFactoryDroidRaw(raw, { sessionId, agentType: 'generic', sequencer });
  }
  // V12-A03/A15：gemini-cli/qwen-code 探测只对 generic 桶生效。qwen 帧型（system/
  // assistant/result）与 claude stream-json 高度同源、gemini result 帧也同形——不先于
  // claude 探测就会被吞并到硬编码 'claude-code' 标签；带 agentType==='generic' 守卫后，
  // claude-code/codex 会话（agentType 为各自 adapter_id）完全不经过本分支，既有路由零回归。
  // 认领范围已避开 Droid（result 文档化签名含 num_turns，探测在前）、opencode（tool_use/
  // 结构化 error 实测帧）、codex（扁平 error）的既有证据链；两类目录条目 adapter_id 均归
  // generic（契约 §1 不逐产品新建 adapter_id），事件 agent_type 以 generic 上行不冒用他品。
  if (agentType === 'generic') {
    if (isGeminiStreamType(raw)) {
      return mapGeminiRaw(raw, { sessionId, agentType: 'generic', sequencer });
    }
    if (isQwenStreamType(raw)) {
      return mapQwenRaw(raw, { sessionId, agentType: 'generic', sequencer });
    }
    // V12-A04（cursor-cli）：分支置于 claude 之前——cursor stream-json 与 claude-code
    // 共享 assistant/result 顶层类型名，claude 分支（按类型名认领、agentType 硬标
    // 'claude-code'）会把 cursor assistant 帧整体丢弃（cursor 内容项无 type 字段）并
    // 污染事件产品归属（任务卡 A04「显示 CLI 宿主」）。isCursorCliStreamType 只认领
    // cursor 官方 Headless 文档专属形状：tool_call 顶层类型（claude/droid/gemini/qwen
    // 均无）、assistant 携带官方标记 timestamp_ms/model_call_id（claude 同族帧无此二
    // 标记）；已核对前序探测器（droid 严格签名 / gemini init·message·tool_result /
    // qwen uuid 标记）均不认领上述形状。result 共享形状仅在 generic 会话认领且要求
    // 「无 subtype + duration_ms」（cursor 官方示例形态；claude/droid/gemini/qwen 同族
    // result 帧携带 subtype 或 uuid/usage/stats 标记，不受影响）。system/init 与 claude
    // 同构且无专属标记，不认领（由 claude 分支兜底渲染——已知外观局限，见
    // xcx/docs/release/v1.2/agents/cursor-cli.md）。
    if (isCursorCliStreamType(raw)
      || (raw && typeof raw === 'object'
        && raw.type === 'result'
        && Number.isFinite(raw.duration_ms)
        && !('subtype' in raw))) {
      return mapCursorCliRaw(raw, { sessionId, agentType: 'generic', sequencer });
    }
  }
  if (isClaudeStreamType(raw)) {
    return mapClaudeRaw(raw, { sessionId, agentType: 'claude-code', sequencer });
  }
  // V12-A05：opencode 分支必须先于 codex——两家的顶层 error 帧形状重叠（opencode 带结构化
  // error{name,data}+sessionID+timestamp，codex 为扁平 {type:'error',message}），而 codex
  // 探测对任意 {type:'error'} 一律接单，放后面会吞掉 OpenCode 的流错误帧。
  if (isOpenCodeStreamType(raw)) {
    return mapOpenCodeRaw(raw, { sessionId, agentType, sequencer });
  }
  if (isCodexStreamType(raw)) {
    return mapCodexRaw(raw, { sessionId, agentType: 'codex', sequencer });
  }
  // V12-A07：Cline --json NDJSON（官方 jq 示例形状 {type:'agent_event',event:{...}}），
  // 与 claude/codex/opencode 帧形状无重叠；未记载子结构落 mapClineRaw 内 custom 兜底。
  if (isClineStreamType(raw)) {
    return mapClineRaw(raw, { sessionId, agentType: 'generic', sequencer });
  }
  // V12-A25：openhands --headless --json 官方记载帧形 {type:'action'|'observation'}，与
  // claude/codex/droid/opencode/cline 帧形无重叠；未记载帧（如最终回复帧形状官方未定义）
  // 不认领，落 raw_json 兜底。能力全 false（headless 强制 always-approve 非合规，V12-A25）。
  if (isOpenhandsStreamType(raw)) {
    return mapOpenhandsRaw(raw, { sessionId, agentType, sequencer });
  }
  // V12-A27：openclaw agent exec --json 稳定信封（布尔 ok + status/final/payloads/error），
  // 布尔 ok 判别与全部 type 帧产品无重叠；plain 模式（stdout 纯文本）不认领，落文本兜底。
  // 能力全 false（真实 CLI 往返未取证，V12-A27）。
  if (isOpenclawStreamType(raw)) {
    return mapOpenclawRaw(raw, { sessionId, agentType, sequencer });
  }
  // V12-A14：Windsurf/Cascade hook 观察帧（顶层 agent_action_name，无 type 字段）。
  // agentType 固定 'generic'——'windsurf' 不在 AGENT_TYPES 白名单（events.js:34），
  // 能力全 false（仅 hooks，无控制通道 BLOCKED），此处只保证观察帧可翻译不乱落文本兜底。
  // iFlow / Comate（V12-A22/A23）协议未验证，刻意不加探测分支（不伪造探测器）。
  if (isWindsurfStreamType(raw)) {
    return mapWindsurfRaw(raw, { sessionId, agentType: 'generic', sequencer });
  }
  // V12-A11/A12：amp / auggie 为文本产品（官方 execute / print 模式 stdout 纯文本，无 JSON
  // 事件流），按会话 agent_key 分流——放在全部 JSON 帧探测器之后，只接非 JSON 文本行，
  // 不抢任何帧协议产品的 JSON 行；JSON 行（版本漂移/异常）落各自 custom 兜底，不伪造
  // 工具/审批事件。agentType 即 agent_key（session-manager 传会话规格值）。
  if (agentType === 'amp') {
    // 注意 JSON.parse('123')/('true') 会得到非对象标量：这些是纯文本行，须走文本分支而非 JSON 兜底。
    const isJsonObject = raw !== null && typeof raw === 'object';
    return isJsonObject
      ? mapAmpRaw(raw, { sessionId, agentType, sequencer })
      : mapAmpTextLine(line, { sessionId, agentType, sequencer });
  }
  if (agentType === 'auggie') {
    const isJsonObject = raw !== null && typeof raw === 'object';
    return isJsonObject
      ? mapAuggieRaw(raw, { sessionId, agentType, sequencer })
      : mapAuggieTextLine(line, { sessionId, agentType, sequencer });
  }
  // V12-A13：kiro-cli 为文本产品（官方仅记载文本输出，无结构化帧声明），与 amp/auggie
  // 同模式按会话 agent_key 分流——放在全部 JSON 帧探测器之后，只接非 JSON 文本行；
  // JSON 行（版本漂移/异常）落 custom 观察兜底，不伪造工具/审批事件。
  if (agentType === 'kiro-cli') {
    const isJsonObject = raw !== null && typeof raw === 'object';
    return isJsonObject
      ? mapKiroCliRaw(raw, { sessionId, agentType, sequencer })
      : mapKiroCliTextLine(line, { sessionId, agentType, sequencer });
  }
  if (raw && raw.type) {
    return [createEvent({
      sessionId, agentType, sequencer,
      eventType: 'custom',
      payload: {
        custom_type: 'raw_json',
        fallback_text: `未知 JSON 事件：${raw.type}`,
        data: { type: raw.type },
      },
    })];
  }
  return [createEvent({
    sessionId, agentType, sequencer,
    eventType: 'agent_message',
    payload: {
      message_id: `m_line_${sequencer.next()}`,
      role: 'assistant',
      content: line,
      content_type: 'text',
      is_final: true,
    },
  })];
}
