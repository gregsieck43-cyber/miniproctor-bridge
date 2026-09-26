# 适配器统一接口规范（adapter-contract）

> 状态：**V12-09 冻结**（2026-09-25）。后续 10 个适配组照此实现；现有 `claude-code` / `codex` / `generic`
> 三个适配器为参照实现（代码事实以此为准，本文是它们的抽象）。
> 能力枚举权威：`xcx/protocol/schema.cjs`（CAPABILITY_KEYS / INTEGRATION_MODES /
> INITIAL_PROMPT_CHANNELS）；bridge 内字面常量镜像于 `src/adapters/capabilities.js`，漂移由
> `xcx/tests/protocol.test.cjs` 对拍强制。协议整体见 `xcx/docs/event-protocol.md` §14/§15。

## 0. 术语与目录布局

| 术语 | 定义 | 落点 |
|---|---|---|
| `agent_key` | 规范化产品名（ASCII slug，如 `qwen-code`）；LOGO/别名映射到目录，不由任意网络 URL 提供（§7.1） | catalog-entry `agent_key` |
| 适配器 | 把某 Agent 的原始输出帧翻译为 miniproctor 事件的模块；只做转换，不写云、不发命令、不改全局状态 | `src/adapters/<agent_key>.js` |
| catalog-entry | 随发行的可信静态目录条目；**不接受远端下发可执行代码**（§7.2） | `src/agents/catalog-entries/<agent_key>.json` |
| AgentProfile | 本机配置实例（bridge 生成 `profile_id` UUID；真实命令路径/凭据引用只在本机） | 本机持久文件，不上云（V12-11 接线） |
| integrationMode | 适配器与 Agent 宿主的集成方式 | `stdio` \| `acp` \| `local-api` \| `hook` \| `manual-report` |

新适配组落地时新增/修改的文件清单：

```text
bridge/src/adapters/<agent_key>.js            # 解析器（§3）
bridge/src/agents/catalog-entries/<agent_key>.json  # 目录条目（§1）
bridge/src/adapters/capabilities.js           # ADAPTER_CAPABILITIES + VERIFIED_CAPABILITIES 增行（§2）
bridge/test/<agent_key>-adapter.test.js       # 解析器 fixture 对拍（§3.4）
```

不改：`src/agent/session-manager.js`（经 `generic.js` 分发器自动路由）、`src/agent/runner.js`、云函数、小程序。

## 1. catalog-entry JSON schema

文件：`src/agents/catalog-entries/<agent_key>.json`（UTF-8，键序不敏感）。字段全表：

| 字段 | 类型 | 必填 | 约束 | 说明 |
|---|---|---|---|---|
| `schema_version` | number | ✅ | 整数 ≥1 | 目录条目自身版本；本文对应 `1` |
| `agent_key` | string | ✅ | `^[a-z0-9][a-z0-9_-]*$`，≤64 字符 | 规范化产品名，文件名必须等于该值 |
| `display_name` | string | ✅ | ≤100 字符 | 多语言显示名（仅展示，不做主键/不做匹配键） |
| `aliases` | string[] | ✅ | 每项同 `agent_key` 约束 | 别名/旧名归一表；用户输入经别名映射到 `agent_key` |
| `logo_asset` | string | ✅ | 仓内相对路径（如 `assets/agents/claude-code.png`） | **禁止网络 URL**（§7.1） |
| `lifecycle` | string | ✅ | `active` \| `deprecated` \| `unmaintained` \| `unknown` | 厂商产品生命周期摘要；UI 据此区分"未安装/已停更" |
| `adapter_id` | string | ✅ | `AGENT_TYPES` 之一（现为 `claude-code`/`codex`/`generic`） | 解析器路由键；新协议形态归入最接近的现有 adapter_id，**不逐产品新建分发分支** |
| `integration_mode` | string | ✅ | `INTEGRATION_MODES` 之一 | 与能力声明一致（§2） |
| `capabilities` | object | ✅ | 8 布尔键 = `CAPABILITY_KEYS` | 声明层能力（代码路径是否存在） |
| `initial_prompt_channel` | string\|null | ✅ | `stdin` \| `launch-args` \| `null` | 初始 prompt 注入通道 |
| `verification` | object | ✅ | 键 ⊆ `CAPABILITY_KEYS`，值 `{ status, evidence }` | `status ∈ verified\|pending\|unavailable`；`evidence` 为仓内证据路径 |
| `docs_ref` | string | ✅ | 仓内路径 | `xcx/docs/官方资料/` 本地快照首页（带来源 URL 头） |
| `probe` | object | ✅ | 见下 | 探测/版本检查声明（不承载任何可执行代码） |

`probe` 对象：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `version_args` | string[] | ✅ | 版本探测参数，如 `["--version"]`；只允许旗标，不允许任意命令 |
| `timeout_ms` | number | ✅ | 探测超时（建议 ≤10000，§7.1"设置超时/输出大小"） |
| `output_max_bytes` | number | ✅ | 探测输出截断上限（建议 ≤8192） |

规则：

1. catalog 只随发行更新，运行时只读；云端/手机**不得**写入或下发（§7.2）。
2. `display_name` 多语言自由；`agent_key`/`aliases` 一律 ASCII——目录多语言边界。
3. `verification.status = verified` 必须给 `evidence`（测试文件或探针记录路径）；无证据 = `pending`。

## 2. 能力声明与守卫（src/adapters/capabilities.js）

### 2.1 能力键（V12-09 拆分，8 布尔）

`create`（拉起新会话）、`read`（解析输出流）、`stop`（受控停止）、`append`（会话中途追加输入；
v0.2 的 `send` 更名——初始输入与追加输入是两个独立能力）、`resume`（恢复既有会话）、
`approve`（回写审批决议）、`fileChanges`（上报文件变更）、`usage`（上报 token 用量；
无统计不得伪造，§8.3）。非布尔维度：`integrationMode`、`initialPromptChannel`。

### 2.2 两层视图

- **声明层 `ADAPTER_CAPABILITIES`**：代码路径是否存在。session-manager 执行门禁依据
  （不支持 → `capability-unsupported` 零进程拒绝，E13 立场不变）。
- **验证层 `VERIFIED_CAPABILITIES`**：已有真实证据的能力。
- **开放视图 `openCapabilitiesFor(agentType)`** = 声明 ∩ 验证，**守卫规则**：
  1. 未经真实验证的能力不得开放（对外宣称 = 开放视图；session_meta capabilities /
     UI 能力摘要 / 云端 capability_snapshot 一律取开放视图）；
  2. 未知/未登记 agent 类型 fail-closed：只读文本 + 受控停止（read+stop，generic 底线；
     不含 create——未知规格不得替用户拉新进程）；
  3. `initialPromptChannel` 开放前提 = `create`+`read` 已验证；
  4. 开放视图与执行门禁分离：能力翻入验证层需附证据路径（下条）。

### 2.3 验证分层与回收流程

| 层级 | 证据形态 | 当前实例 |
|---|---|---|
| L1 fixture | 解析器 fixture 对拍（证明"若 CLI 发帧则能解析"） | claude-code/codex 的 fileChanges、usage |
| L2 演示宿主往返 | CI 内真实子进程 + 演示帧端到端 | claude-code/codex 的 read/stop/create；claude-code 的 append/approve |
| L3 真实 CLI 往返 | 真实官方 CLI 全链路（挂 V03 验证队列） | 暂无——append/approve/fileChanges/usage 因此不开放 |

V03 逐项回收后由对应任务把能力翻入 `VERIFIED_CAPABILITIES`（附证据路径），并同步本文件与
catalog-entry 的 `verification`。**开放视图当前取 L2**（bridge 自有能力，CI 持续验证）；L3 只升级
证据等级、不改变"未经真实验证不得开放"的底线（V03 完成前 CLI 依赖能力一律不开放）。

## 3. 解析器接口（src/adapters/<agent_key>.js）

参照实现：`src/adapters/claude-code.js`（isClaudeStreamType/mapClaudeRaw）。

1. **纯函数、零 IO**：不访问 fs/network/环境变量，不写云、不发命令、不改全局状态。
2. 导出两个命名函数（ESM）：
   - `is<Agent>StreamType(raw: unknown): boolean` —— 帧形状探测，供 `generic.js` 分发器路由；
     必须对 `null`/非对象安全。
   - `map<Agent>Raw(raw: object, ctx: { sessionId, agentType, sequencer }): Event[]` —— 帧翻译。
3. **不得抛出**：任何未知/畸形帧一律落入 `custom` 兜底事件（`custom_type` 自定 +
   `fallback_text` 一句话），返回数组（可为空，不为 null）。
4. 事件构造只用 `src/lib/events.js` 的 `createEvent`：事件类型必须在 `EVENT_TYPES` 白名单内；
   预览字段过 `sanitizePreview`/`truncateText`（单事件信封收敛 ≤7.5KB 目标 / 8KB 硬上限）。
5. 敏感过滤：凭据形态（token/key/secret）经 events.js 红名单脱敏为 `***`；不透传完整代码/文件内容。
6. fixture 对拍测试：每个事件类型至少 1 正例 + 1 未知帧兜底反例（参照 `test/codex-adapter.test.js`）。

分发：`src/adapters/generic.js` 的 `lineToEvent` 按 `is<Agent>StreamType` 探测路由；新适配器只需
在 generic.js 增一行探测分支（该文件是唯一允许的接线点）。

## 4. 会话生命周期接口（session-manager ↔ runner）

适配器本身不管理进程；进程由 `src/agent/runner.js`（AgentRunner）承载，session-manager 编排：

- **构造参数（冻结 spec，V12-11 按 profile 生成）**：`{ sessionId, agentType, command, args, cwd,
  correlationId }`。`command/args` 只能来自本机 profile 冻结规格或用户显式 config——**手机端任意
  command/args/env/path 一律不接受**（§7.1）。`args` 数组直传 spawn，无 shell、无拼接。
- **start**：`cwd` 必先过 `authorizeWorkspace`（绝对路径 → stat 目录 → realpath 前后授权根前缀
  双重判断，防符号链接逃逸）；拒绝 = 零进程 + 最小审计行（时间/cwd/原因，不含 prompt）。
- **初始 prompt 注入**：按 `initialPromptChannel`——`launch-args` = 末位位置参数（codex exec）；
  `stdin` = 会话启动后 `sendText`（claude-code 输入帧）；`null` = 拒绝（能力检查前置拦截）。
- **stop**：`runner.stop()` 先优雅（stopGraceMs）后强杀；只终止**本次 spawn 拥有的进程树**
  （§8.3：验证创建时间/实例 ID 防 PID 复用；不按进程名杀用户其他会话）。接纳命令与真实退出
  分开：退出证据（exited/code/signal）随 `session_stop_result` 事件回流，未确认退出 ACK 如实 failed。
- **终态**：`result` 帧 → `session_end`（turn 完成）；进程退出 → `session_exit`
  （`status ∈ ended|failed`，`code`，脱敏 stderr 尾部）。自然退出与 stop 同时到达只生成一个终态
  （`_exitHandled` 单次门闩）。exit 后会话即时自 sessions Map 移除（资源释放）。

## 5. 错误与终态语义

| 场景 | 语义 |
|---|---|
| 能力不支持 | `error` 事件 `code='capability-unsupported'`（`capability` 字段 = 能力键名）+ 命令拒绝，零进程、零帧（E13） |
| 解析崩溃 | 单帧隔离，只影响本会话；supervisor/其他 Agent/审批不受影响（§8.3） |
| stdin 写失败 | 会话 `failed`（`code='stdin-error'`，fatal）——命令可能未送达，不悬挂 |
| spawn 失败 | `session_exit(failed)` + 脱敏诊断（`sanitizeDiagnosticText`） |
| 审批超时 | 默认 deny 真实发给 Agent（按适配器 deny 编码）+ 终态事件 + 清 pendingInputs |
| ACK 结果 | `succeeded \| failed \| unknown`；unknown = 崩溃窗口结果未知，不盲目重放（§10） |

## 6. 审批与输入编码

- 审批决议帧（如 claude-code `control_response`）由适配器组提供编码函数（现内联于 session-manager
  `forwardDecision`）；`approve`/`deny` 两行为必备，`cancel` 映射 deny 语义或由适配器声明不支持。
- `append=false` 的适配器（codex/generic）绝不向 stdin 写帧；其会话 stdin 在启动后立即 EOF
  （CLOSE-007 实测裁决，见 session-manager.js 注释）——消除整类"等待输入"挂起。

## 7. 新适配组落地清单（按序执行）

1. 读 `xcx/docs/官方资料/` 对应 agent 快照，确认官方 CLI 调用形态/事件帧/审批与恢复通道；
   官方资料缺口如实登记，不编造接口。
2. 写 `catalog-entries/<agent_key>.json`（§1；`verification` 全部 `pending`）。
3. 写解析器 `src/adapters/<agent_key>.js`（§3）+ fixture 测试（§3.6）。
4. `capabilities.js` 增声明层行（只声明**已实现代码路径**）+ 验证层行（初始只有 read/stop，
   若第 3 步同时实现了 create 拉起并配了演示宿主测试则含 create）。
5. `generic.js` 增一行探测分支。
6. 跑 `cd bridge && node --test test/<agent_key>-adapter.test.js`（自测）；
   提交前由编排层跑门禁（勿自行全量）。
7. 真实 CLI 往返（V03）完成后按 §2.3 回收升级，翻 `VERIFIED_CAPABILITIES` 与 catalog
   `verification`，附证据路径。
