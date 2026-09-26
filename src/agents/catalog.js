// 本文件由 bridge/tools/gen-catalog.cjs 从 src/agents/catalog-entries/*.json 同源生成——勿手改。
// 重新生成：cd xcx/bridge && node tools/gen-catalog.cjs
// 契约：src/agents/adapter-contract.md §1（V12-09 冻结）。目录只随发行更新、运行时只读、
// 不接受远端下发可执行代码（主方案 §7.2）；unknown 一律 fail-closed，绝不回退 claude-code（T12）。

export const CATALOG_SCHEMA_VERSION = 1;

/** 全量目录条目（28 个：A01–A27 首发 key + roo-code 停服历史条目）。 */
export const CATALOG_ENTRIES = Object.freeze(  [
    {
      "schema_version": 1,
      "agent_key": "aider",
      "display_name": "Aider",
      "aliases": [],
      "logo_asset": "assets/agents/aider.png",
      "lifecycle": "active",
      "adapter_id": "generic",
      "integration_mode": "stdio",
      "capabilities": {
        "create": true,
        "read": true,
        "stop": true,
        "append": false,
        "resume": false,
        "approve": false,
        "fileChanges": false,
        "usage": false
      },
      "initial_prompt_channel": "launch-args",
      "verification": {
        "create": {
          "status": "verified",
          "evidence": "Windows 本机 Aider 0.86.2 + DeepSeek Flash：--message 真实执行得到 bridgepong 最终回复且 exit=0；只开放 aider agent_key，手机/真云闭环未验，见 V12-A09 证据卡"
        },
        "read": {
          "status": "verified",
          "evidence": "真实 CLI stdout 经有界回合聚合器过滤启动信息与 THINKING 后，ManagedSession 产生 agent_message(bridgepong) 与 session_end(completed)；手机可见未验，见 V12-A09 证据卡"
        },
        "stop": {
          "status": "verified",
          "evidence": "真实 Aider 进程 PID 4032 活跃时 stop：exited=true、taskkill_exit_code=0、无伪造最终回复；手机 stop 未验，见 V12-A09 证据卡"
        },
        "append": {
          "status": "unavailable",
          "evidence": "官方 CLI 一次性任务（--message）处理回复即退出，无会话中途追加输入通道（A09 快照，声明 false）"
        },
        "resume": {
          "status": "unavailable",
          "evidence": "无实现路径（声明 false）"
        },
        "approve": {
          "status": "unavailable",
          "evidence": "官方快照无审批回写协议文档（--yes 自动放行被禁作默认，声明 false）"
        },
        "fileChanges": {
          "status": "unavailable",
          "evidence": "官方快照无结构化文件变更事件文档，文本型产品不伪造工具事件（声明 false）"
        },
        "usage": {
          "status": "unavailable",
          "evidence": "官方快照无用量统计文档，无统计不伪造（声明 false）"
        }
      },
      "probe": {
        "version_args": [
          "--version"
        ],
        "timeout_ms": 10000,
        "output_max_bytes": 8192
      },
      "docs_ref": "xcx/docs/官方资料/A09-aider-scripting.md"
    },
    {
      "schema_version": 1,
      "agent_key": "amp",
      "display_name": "Amp",
      "aliases": [],
      "logo_asset": "assets/agents/amp.png",
      "lifecycle": "active",
      "adapter_id": "generic",
      "integration_mode": "stdio",
      "capabilities": {
        "create": true,
        "read": true,
        "stop": true,
        "append": false,
        "resume": false,
        "approve": false,
        "fileChanges": false,
        "usage": false
      },
      "initial_prompt_channel": "launch-args",
      "verification": {
        "create": {
          "status": "pending",
          "evidence": "官方 execute 模式（amp -x \"<prompt>\" 发消息→等回合结束→打印最终消息→退出，A11 快照）+ runner 通用 spawn 路径；CLI 本机未安装，真实往返未取证（V12-A11，2026-09-25）"
        },
        "read": {
          "status": "pending",
          "evidence": "解析器 bridge/src/adapters/amp.js（execute stdout 纯文本行→agent_message）+ fixture 对拍 bridge/test/adapters/amp-adapter.test.js（官方示例语义构造，synthetic）；CLI 未安装，真实输出未取证"
        },
        "stop": {
          "status": "pending",
          "evidence": "runner 进程树终止为 bridge 自有能力（bridge/test/runner*.test.js 覆盖通用路径）；Amp 实机 stop→子进程退出未取证（CLI 未安装）"
        },
        "append": {
          "status": "unavailable",
          "evidence": "execute 模式为单次运行（发消息→回合结束→退出），官方无中途追加输入通道（A11 快照，V12-A11）"
        },
        "resume": {
          "status": "unavailable",
          "evidence": "execute 模式无会话恢复旗标证据，未实测能力一律 false（A11 快照，V12-A11）"
        },
        "approve": {
          "status": "unavailable",
          "evidence": "execute 模式无审批回写通道证据（A11 快照，V12-A11）"
        },
        "fileChanges": {
          "status": "unavailable",
          "evidence": "无文件变更输出证据，不伪造工具事件（A11 快照，V12-A11）"
        },
        "usage": {
          "status": "unavailable",
          "evidence": "无 token/费用统计输出证据，无统计不伪造（§8.3，A11 快照，V12-A11）"
        }
      },
      "probe": {
        "version_args": [
          "--version"
        ],
        "timeout_ms": 10000,
        "output_max_bytes": 8192
      },
      "docs_ref": "xcx/docs/官方资料/A11-amp-cli-execute-mode.md"
    },
    {
      "schema_version": 1,
      "agent_key": "auggie",
      "display_name": "Auggie",
      "aliases": [],
      "logo_asset": "assets/agents/auggie.png",
      "lifecycle": "active",
      "adapter_id": "generic",
      "integration_mode": "stdio",
      "capabilities": {
        "create": true,
        "read": true,
        "stop": true,
        "append": false,
        "resume": false,
        "approve": false,
        "fileChanges": false,
        "usage": false
      },
      "initial_prompt_channel": "launch-args",
      "verification": {
        "create": {
          "status": "pending",
          "evidence": "官方 print 模式（auggie --print \"<instruction>\" 单次运行打印 stdout，A12 快照）+ runner 通用 spawn 路径；CLI 本机未安装，真实往返未取证（V12-A12，2026-09-25）"
        },
        "read": {
          "status": "pending",
          "evidence": "解析器 bridge/src/adapters/auggie.js（print stdout 纯文本行→agent_message）+ fixture 对拍 bridge/test/adapters/auggie-adapter.test.js（官方示例语义构造，synthetic）；CLI 未安装，真实输出未取证"
        },
        "stop": {
          "status": "pending",
          "evidence": "runner 进程树终止为 bridge 自有能力（bridge/test/runner*.test.js 覆盖通用路径）；Auggie 实机 stop→子进程退出未取证（CLI 未安装）"
        },
        "append": {
          "status": "unavailable",
          "evidence": "print 模式单次运行无中途追加输入通道证据（A12 快照，V12-A12）"
        },
        "resume": {
          "status": "unavailable",
          "evidence": "print 模式无会话恢复旗标证据，未实测能力一律 false（A12 快照，V12-A12）"
        },
        "approve": {
          "status": "unavailable",
          "evidence": "print 模式无审批回写通道证据（A12 快照，V12-A12）"
        },
        "fileChanges": {
          "status": "unavailable",
          "evidence": "print 模式无文件变更输出证据，不伪造工具事件（A12 快照，V12-A12）"
        },
        "usage": {
          "status": "unavailable",
          "evidence": "无 token 统计输出证据，无统计不伪造（§8.3，A12 快照，V12-A12）"
        }
      },
      "probe": {
        "version_args": [
          "--version"
        ],
        "timeout_ms": 10000,
        "output_max_bytes": 8192
      },
      "docs_ref": "xcx/docs/官方资料/A12-auggie-readme.md"
    },
    {
      "schema_version": 1,
      "agent_key": "claude-code",
      "display_name": "Claude Code",
      "aliases": [
        "claude",
        "claude-cli"
      ],
      "logo_asset": "assets/agents/claude-code.png",
      "lifecycle": "active",
      "adapter_id": "claude-code",
      "integration_mode": "stdio",
      "capabilities": {
        "create": true,
        "read": true,
        "stop": true,
        "append": true,
        "resume": false,
        "approve": true,
        "fileChanges": true,
        "usage": true
      },
      "initial_prompt_channel": "stdin",
      "verification": {
        "read": {
          "status": "verified",
          "evidence": "bridge/test/adapters/claude-code-adapter.test.js + bridge/test/claude-adapter.test.js（解析 fixture 对拍）+ bridge/test/approval-lifecycle.test.js（演示宿主往返）；真实 CLI 往返挂 V03（本机未装 claude，见 docs/release/v1.2/agents/claude-code.md）"
        },
        "stop": {
          "status": "verified",
          "evidence": "bridge/test/runner.test.js / runner-windows.test.js（进程树终止）"
        },
        "create": {
          "status": "verified",
          "evidence": "bridge/test/approval-lifecycle.test.js（演示宿主 spawn 往返）；真实 CLI 往返挂 V03"
        },
        "append": {
          "status": "pending",
          "evidence": "仅演示宿主 stdin 往返；真实 CLI 往返挂 V03 验证队列（本机未装 claude，V12-A01 未取证）"
        },
        "resume": {
          "status": "unavailable",
          "evidence": "无实现路径（声明 false）"
        },
        "approve": {
          "status": "pending",
          "evidence": "仅演示宿主 control_request→control_response 往返；真实 CLI 往返挂 V03（审批协议单独取证，不以禁用权限检查达成远程控制）"
        },
        "fileChanges": {
          "status": "pending",
          "evidence": "仅解析 fixture（bridge/test/adapters/claude-code-adapter.test.js Edit→file_change）；真实 CLI 是否发帧未验证"
        },
        "usage": {
          "status": "pending",
          "evidence": "仅解析 fixture（result.usage 映射，bridge/test/adapters/claude-code-adapter.test.js）；真实 CLI 未验证"
        }
      },
      "probe": {
        "version_args": [
          "--version"
        ],
        "timeout_ms": 10000,
        "output_max_bytes": 8192
      },
      "docs_ref": "xcx/docs/官方资料/A01-claude-code-headless.md"
    },
    {
      "schema_version": 1,
      "agent_key": "cline",
      "display_name": "Cline CLI",
      "aliases": [],
      "logo_asset": "assets/agents/cline.png",
      "lifecycle": "active",
      "adapter_id": "generic",
      "integration_mode": "stdio",
      "capabilities": {
        "create": false,
        "read": false,
        "stop": false,
        "append": false,
        "resume": false,
        "approve": false,
        "fileChanges": false,
        "usage": false
      },
      "initial_prompt_channel": null,
      "verification": {
        "create": {
          "status": "pending",
          "evidence": "解析器+fixture 就绪（bridge/test/adapters/cline-adapter.test.js + test/fixtures/cline/）；真实 CLI 往返未取证（2026-09-26 本机 command -v cline 未安装）；capabilities.js 无声明层行（V12 简报禁改），AdapterFactory 现阶段 fail-closed 拒绝实例化。文档化初始 prompt 通道为 launch-args（--json 非交互需位置 prompt），create 验证前不开放"
        },
        "read": {
          "status": "pending",
          "evidence": "仅解析 fixture（--json agent_event.text→agent_message，bridge/test/adapters/cline-adapter.test.js + test/fixtures/cline/ndjson-samples.jsonl）；官方 NDJSON 帧证据仅 README jq 示例一处（docs_ref A07）；真实 CLI 往返未取证（CLI 未安装）"
        },
        "stop": {
          "status": "pending",
          "evidence": "bridge runner 进程树终止为公共能力（test/runner*.test.js）；真实 CLI 下受控停止未验证（cline 未安装）"
        },
        "append": {
          "status": "unavailable",
          "evidence": "官方 --json 为单发非交互模式，快照未记载中途追加输入通道（docs_ref A07）"
        },
        "resume": {
          "status": "unavailable",
          "evidence": "cline history 命令存在但快照未记载恢复到 --json 会话的通道；bridge 无恢复实现路径"
        },
        "approve": {
          "status": "unavailable",
          "evidence": "非 TTY 下 --auto-approve false 直接拒绝（快照「required-approval calls are denied in terminal mode」），无 NDJSON 审批回写通道；desktop file-IPC（CLINE_TOOL_APPROVAL_MODE=desktop）未取证、未实现"
        },
        "fileChanges": {
          "status": "unavailable",
          "evidence": "官方快照未记载文件变更帧；不伪造工具事件"
        },
        "usage": {
          "status": "unavailable",
          "evidence": "官方快照未记载 token 统计帧；无统计不伪造（§8.3）"
        }
      },
      "probe": {
        "version_args": [
          "--version"
        ],
        "timeout_ms": 10000,
        "output_max_bytes": 8192
      },
      "docs_ref": "xcx/docs/官方资料/A07-cline-cli-readme.md"
    },
    {
      "schema_version": 1,
      "agent_key": "codearts-agent",
      "display_name": "CodeArts Agent",
      "aliases": [
        "codearts",
        "codeartsagent"
      ],
      "logo_asset": "assets/agents/codearts-agent.png",
      "lifecycle": "active",
      "adapter_id": "generic",
      "integration_mode": "stdio",
      "capabilities": {
        "create": false,
        "read": true,
        "stop": true,
        "append": false,
        "resume": false,
        "approve": false,
        "fileChanges": false,
        "usage": false
      },
      "initial_prompt_channel": "launch-args",
      "verification": {
        "create": {
          "status": "unavailable",
          "evidence": "官方存在 run 非交互入口（A21：codearts run [message]，--format default|json；--auto/--sandbox 为 Bash 工具模式须按本机策略授权），但 bridge 拉起参数模板未接线且真实 CLI 未验证——声明 false；模式冻结：仅 run（stdio），serve/attach（local-api）不声明不实现（官方明示非标准云服务、不得暴露公网）"
        },
        "read": {
          "status": "pending",
          "evidence": "L1 解析 fixture：bridge/test/adapters/codearts-agent-adapter.test.js（候选契约对拍；官方快照 A21 未记载 run --format json 事件帧 schema，真实 CLI 帧未取证，本机未安装 codearts）"
        },
        "stop": {
          "status": "pending",
          "evidence": "bridge 进程树终止为 agent 无关代码路径（bridge/test/runner.test.js、runner-windows.test.js）；产品级真实停止未取证（CLI 未安装）"
        },
        "append": {
          "status": "unavailable",
          "evidence": "官方无 run 中途追加输入通道文档（A21），无实现路径（声明 false）"
        },
        "resume": {
          "status": "unavailable",
          "evidence": "官方存在 run --sessionID <id>/--continue 恢复通道与 export/import 会话 JSON（A21），但适配器未实现恢复映射路径且真实 CLI 未验证——声明 false"
        },
        "approve": {
          "status": "unavailable",
          "evidence": "官方 CLI ask/审批交互无外部回写协议文档（A21）；适配器将 control_request 候选帧降级为诊断事件，不映射 confirm_required——ask 自动拒绝不可显示可远程批准（A21 卡要求，§5.2）"
        },
        "fileChanges": {
          "status": "unavailable",
          "evidence": "无官方文件变更帧文档；无 file_change 映射路径（声明 false）"
        },
        "usage": {
          "status": "unavailable",
          "evidence": "无官方用量帧文档（codearts stats 是独立查询命令，不构成事件流用量帧）；session_end.usage 恒空对象（无统计不伪造，§8.3）"
        }
      },
      "probe": {
        "version_args": [
          "--version"
        ],
        "timeout_ms": 10000,
        "output_max_bytes": 8192
      },
      "docs_ref": "xcx/docs/官方资料/A21-codeartsagent-cli.md"
    },
    {
      "schema_version": 1,
      "agent_key": "codebuddy",
      "display_name": "CodeBuddy CLI",
      "aliases": [],
      "logo_asset": "assets/agents/codebuddy.png",
      "lifecycle": "active",
      "adapter_id": "generic",
      "integration_mode": "stdio",
      "capabilities": {
        "create": false,
        "read": true,
        "stop": true,
        "append": true,
        "resume": false,
        "approve": false,
        "fileChanges": true,
        "usage": true
      },
      "initial_prompt_channel": "launch-args",
      "verification": {
        "create": {
          "status": "unavailable",
          "evidence": "无产品专属拉起路径（无启动预设；AdapterFactory 对 adapter_id=generic 拒绝新会话，fail-closed）；官方 headless 形态为 codebuddy -p \"<prompt>\"（launch-args 通道），待 V03 真实 CLI 往返接通"
        },
        "read": {
          "status": "pending",
          "evidence": "L1 fixture：bridge/test/adapters/codebuddy-adapter.test.js + bridge/test/fixtures/codebuddy/（官方无头模式文档示例帧对拍：init/assistant/result/task_*/control_response/畸形帧隔离）；探测仅认领带 cbc 专属标记（_requestId 等）的帧，真实 CLI 往返未取证（V12-A17：本机未安装 codebuddy/cbc，command -v/where.exe 双确认，2026-09-26）"
        },
        "stop": {
          "status": "pending",
          "evidence": "runner 进程树终止为 bridge 自有能力（bridge/test/runner.test.js / runner-windows.test.js 同源路径）；codebuddy 真实进程停止未验（CLI 未安装，V12-A17）"
        },
        "append": {
          "status": "pending",
          "evidence": "L1 fixture：buildCodebuddyUserFrame 对拍（官方 stream-json 输入多轮 user 帧含 _meta.codebuddy.ai/conversationRequestId）；session-manager 写入接线与真实 CLI 多轮未验（V12-A17）"
        },
        "resume": {
          "status": "unavailable",
          "evidence": "--resume/--continue 为官方 CLI flag（A17 文档），bridge 无恢复重拉代码路径，不声明；待 V03 单独取证"
        },
        "approve": {
          "status": "unavailable",
          "evidence": "官方 headless 无双向审批回调：--permission-prompt-tool 明确不支持（A17 文档），-p 模式需 -y 才执行授权操作否则被阻止——不伪造审批通道；ACP/SDK 通道未实现"
        },
        "fileChanges": {
          "status": "pending",
          "evidence": "L1 fixture：Edit/Write tool_use → file_change 映射对拍（官方声明消息模式对齐 Claude Code v2.1.88）；真实 CLI 是否发帧未验（V12-A17）"
        },
        "usage": {
          "status": "pending",
          "evidence": "L1 fixture：result 统计 + system/task_progress.usage{total_tokens,tool_uses,duration_ms}（官方示例帧）映射对拍；真实 CLI 未验（V12-A17）"
        }
      },
      "probe": {
        "version_args": [
          "--version"
        ],
        "timeout_ms": 10000,
        "output_max_bytes": 8192
      },
      "docs_ref": "xcx/docs/官方资料/A17-codebuddy-cli-headless.md"
    },
    {
      "schema_version": 1,
      "agent_key": "codex",
      "display_name": "Codex CLI",
      "aliases": [
        "codex-cli",
        "openai-codex"
      ],
      "logo_asset": "assets/agents/codex.png",
      "lifecycle": "active",
      "adapter_id": "codex",
      "integration_mode": "stdio",
      "capabilities": {
        "create": true,
        "read": true,
        "stop": true,
        "append": false,
        "resume": false,
        "approve": false,
        "fileChanges": false,
        "usage": false
      },
      "initial_prompt_channel": "launch-args",
      "verification": {
        "read": {
          "status": "verified",
          "evidence": "bridge/test/adapters/codex-adapter.test.js + bridge/test/codex-adapter.test.js（解析 fixture 对拍）+ bridge/test/approval-lifecycle.test.js（演示宿主往返）+ 0.155.1 真实启动帧实测（docs/release/v1.2/agents/codex.md）"
        },
        "stop": {
          "status": "verified",
          "evidence": "bridge/test/runner.test.js / runner-windows.test.js（进程树终止）；0.155.1 实测网络阻塞时 CLI 不发错误帧，强杀为唯一恢复通道（roundtrip-2）"
        },
        "create": {
          "status": "verified",
          "evidence": "bridge/test/approval-lifecycle.test.js（codex 携带 prompt 经 launch-args 真实 spawn）+ 0.155.1 真实启动帧实测 thread.started/turn.started（roundtrip-2，最终回复因 chatgpt.com 不可达未取得，挂 V03）"
        },
        "append": {
          "status": "unavailable",
          "evidence": "官方无中途追加输入通道（stdin 追加为 <stdin> block，实测挂起，CLOSE-007；V12-A02 探针复测 stdin 未 EOF 同样挂起）"
        },
        "resume": {
          "status": "unavailable",
          "evidence": "官方有 codex exec resume 子命令（noninteractive 文档），bridge 无实现路径（声明 false），未实测"
        },
        "approve": {
          "status": "unavailable",
          "evidence": "审批策略回调未实现（E13：统一 Claude 输入帧不适用）"
        },
        "fileChanges": {
          "status": "unavailable",
          "evidence": "官方 item 流含 file_change 条目（noninteractive 文档），bridge 声明层冻结 false 无映射路径，解析层如实落 codex_raw 显示（bridge/test/adapters/codex-adapter.test.js 畸形流用例）"
        },
        "usage": {
          "status": "unavailable",
          "evidence": "官方 turn.completed 帧携带 usage（noninteractive 文档），bridge 声明层冻结 false，session_end.usage 恒空对象不伪造（§8.3，bridge/test/adapters/codex-adapter.test.js）；V03 回收时随声明层一并翻入"
        }
      },
      "probe": {
        "version_args": [
          "--version"
        ],
        "timeout_ms": 10000,
        "output_max_bytes": 8192
      },
      "docs_ref": "xcx/docs/官方资料/A02-codex-noninteractive.md"
    },
    {
      "schema_version": 1,
      "agent_key": "comate",
      "display_name": "Comate",
      "aliases": [],
      "logo_asset": "assets/agents/comate.png",
      "lifecycle": "active",
      "adapter_id": "generic",
      "integration_mode": "manual-report",
      "capabilities": {
        "create": false,
        "read": false,
        "stop": false,
        "append": false,
        "resume": false,
        "approve": false,
        "fileChanges": false,
        "usage": false
      },
      "initial_prompt_channel": null,
      "verification": {
        "create": {
          "status": "unavailable",
          "evidence": "Zulu 为 IDE 内 MCP 客户端，MCP 客户端能力≠外部可控制（§6 A23）；快照无 headless CLI/受控新建接口（xcx/docs/官方资料/A23-comate-zulu-mcp.md，2026-09-25）；解析器骨架 xcx/bridge/src/adapters/comate.js（探测恒 false）；本机 command -v comate/zulu 未安装（2026-09-26）；证据卡 xcx/docs/release/v1.2/agents/comate.md（BLOCKED 待产品决策）"
        },
        "read": {
          "status": "unavailable",
          "evidence": "无外部事件流/报告通道文档；解析器骨架 xcx/bridge/src/adapters/comate.js 防御式 custom 兜底；文本行最终回复经 generic 兜底通路（test/adapters/comate-adapter.test.js，L1 对拍）；证据卡 xcx/docs/release/v1.2/agents/comate.md（BLOCKED）"
        },
        "stop": {
          "status": "unavailable",
          "evidence": "官方无受控停止/取消接口文档；证据卡 xcx/docs/release/v1.2/agents/comate.md（BLOCKED 待产品决策）"
        },
        "append": {
          "status": "unavailable",
          "evidence": "无追加输入通道文档；证据卡 xcx/docs/release/v1.2/agents/comate.md"
        },
        "resume": {
          "status": "unavailable",
          "evidence": "无会话恢复接口文档；证据卡 xcx/docs/release/v1.2/agents/comate.md"
        },
        "approve": {
          "status": "unavailable",
          "evidence": "MCP 工具批准为 IDE 内弹窗交互，无外部回写通道；证据卡 xcx/docs/release/v1.2/agents/comate.md"
        },
        "fileChanges": {
          "status": "unavailable",
          "evidence": "无文件变更事件通道文档；证据卡 xcx/docs/release/v1.2/agents/comate.md"
        },
        "usage": {
          "status": "unavailable",
          "evidence": "无 token/用量统计字段文档；无统计不伪造（§8.3）；证据卡 xcx/docs/release/v1.2/agents/comate.md"
        }
      },
      "probe": {
        "version_args": [
          "--version"
        ],
        "timeout_ms": 10000,
        "output_max_bytes": 8192
      },
      "docs_ref": "xcx/docs/官方资料/A23-comate-zulu-mcp.md"
    },
    {
      "schema_version": 1,
      "agent_key": "continue",
      "display_name": "Continue CLI",
      "aliases": [
        "cn"
      ],
      "logo_asset": "assets/agents/continue.png",
      "lifecycle": "active",
      "adapter_id": "generic",
      "integration_mode": "stdio",
      "capabilities": {
        "create": true,
        "read": true,
        "stop": true,
        "append": false,
        "resume": false,
        "approve": false,
        "fileChanges": false,
        "usage": false
      },
      "initial_prompt_channel": "launch-args",
      "verification": {
        "create": {
          "status": "pending",
          "evidence": "官方 headless 模式（cn -p \"<prompt>\" 单任务执行后打印响应退出，A08 快照 + 官网 2026-09-25 核对一致）+ runner 通用 spawn 路径；本机未安装 cn（where/command -v 双探测），真实往返未取证（V12-A08，2026-09-26）"
        },
        "read": {
          "status": "pending",
          "evidence": "解析器 bridge/src/adapters/continue.js（官方未记载 --format json 的 JSON schema，fail-closed：文本行走 generic 兜底 agent_message，JSON 行落 custom 观察兜底）+ fixture 对拍 bridge/test/adapters/continue-adapter.test.js（synthetic）；CLI 未安装，真实输出未取证"
        },
        "stop": {
          "status": "pending",
          "evidence": "runner 进程树终止为 bridge 自有能力（bridge/test/runner*.test.js 覆盖通用路径）；Continue 实机 stop→子进程退出未取证（CLI 未安装）"
        },
        "append": {
          "status": "unavailable",
          "evidence": "headless 模式为单任务执行（-p），官方无中途追加输入通道（A08 快照，V12-A08）"
        },
        "resume": {
          "status": "pending",
          "evidence": "官方记载 headless 恢复（cn -p --resume 重放上一会话历史，A08 快照），但适配器未实现恢复路径且真实 CLI 未验证——能力保持 false，待 V03 取证后评估"
        },
        "approve": {
          "status": "unavailable",
          "evidence": "headless 下 ask 权限工具被自动排除（官方：there's no one to approve them），无审批回传通道——权限不足显示实际拒绝/退出码而非挂起等待；本适配器从不产生 confirm_required 事件，不生成无法送回 CLI 的审批卡；bridge 默认不添加 --allow（A08 快照，V12-A08）"
        },
        "fileChanges": {
          "status": "unavailable",
          "evidence": "无文件变更输出证据，不伪造工具事件（A08 快照，V12-A08）"
        },
        "usage": {
          "status": "unavailable",
          "evidence": "无 token/费用统计输出证据，无统计不伪造（§8.3，V12-A08）"
        }
      },
      "probe": {
        "version_args": [
          "--version"
        ],
        "timeout_ms": 10000,
        "output_max_bytes": 8192
      },
      "docs_ref": "xcx/docs/官方资料/A08-continue-cli-headless-mode.md"
    },
    {
      "schema_version": 1,
      "agent_key": "copilot-cli",
      "display_name": "GitHub Copilot CLI",
      "aliases": [
        "copilot"
      ],
      "logo_asset": "assets/agents/copilot-cli.png",
      "lifecycle": "active",
      "adapter_id": "generic",
      "integration_mode": "stdio",
      "capabilities": {
        "create": true,
        "read": true,
        "stop": true,
        "append": false,
        "resume": false,
        "approve": false,
        "fileChanges": false,
        "usage": false
      },
      "initial_prompt_channel": "launch-args",
      "verification": {
        "create": {
          "status": "pending",
          "evidence": "官方程序化模式（copilot -p \"<prompt>\" 单次执行后退出，A06 快照）+ runner 通用 spawn 路径；本机未安装 copilot（where/command -v 双探测），真实往返未取证（V12-A06，2026-09-26）"
        },
        "read": {
          "status": "pending",
          "evidence": "解析器 bridge/src/adapters/copilot-cli.js（官方未记载机器可读帧结构，fail-closed：文本行走 generic 兜底 agent_message，JSON 行落 custom 观察兜底）+ fixture 对拍 bridge/test/adapters/copilot-cli-adapter.test.js（synthetic）；CLI 未安装，真实输出未取证"
        },
        "stop": {
          "status": "pending",
          "evidence": "runner 进程树终止为 bridge 自有能力（bridge/test/runner*.test.js 覆盖通用路径）；Copilot 实机 stop→子进程退出未取证（CLI 未安装）"
        },
        "append": {
          "status": "unavailable",
          "evidence": "程序化模式为单次执行（-p 完成即退出），官方无中途追加输入通道（A06 快照，V12-A06）"
        },
        "resume": {
          "status": "unavailable",
          "evidence": "A06 快照与参考页均无 headless 会话恢复旗标记载，未实测能力一律 false（V12-A06）"
        },
        "approve": {
          "status": "unavailable",
          "evidence": "程序化模式无审批回写通道记载；工具授权靠本机策略旗标（--allow-tool/--deny-tool），bridge 默认绝不添加 --allow-all-tools（A06 快照 Security considerations；权限拒绝由退出码/文本与 session_exit 承载，V12-A06）"
        },
        "fileChanges": {
          "status": "unavailable",
          "evidence": "无文件变更输出证据，不伪造工具事件（A06 快照，V12-A06）"
        },
        "usage": {
          "status": "unavailable",
          "evidence": "官方记载 credits 按 token 计费但无输出用量帧记载，无统计不伪造（§8.3，V12-A06）"
        }
      },
      "probe": {
        "version_args": [
          "--version"
        ],
        "timeout_ms": 10000,
        "output_max_bytes": 8192
      },
      "docs_ref": "xcx/docs/官方资料/A06-copilot-cli-about.md"
    },
    {
      "schema_version": 1,
      "agent_key": "cursor-cli",
      "display_name": "Cursor CLI",
      "aliases": [
        "cursor-agent"
      ],
      "logo_asset": "assets/agents/cursor-cli.png",
      "lifecycle": "active",
      "adapter_id": "generic",
      "integration_mode": "stdio",
      "capabilities": {
        "create": true,
        "read": true,
        "stop": true,
        "append": false,
        "resume": false,
        "approve": false,
        "fileChanges": false,
        "usage": false
      },
      "initial_prompt_channel": "launch-args",
      "verification": {
        "create": {
          "status": "pending",
          "evidence": "官方 print 模式（agent -p \"<prompt>\" 非交互执行，A04 快照 + 官网 2026-09-25 核对）+ runner 通用 spawn 路径；本机未安装 cursor-agent/agent（command -v 探测，cursor 命令为 IDE 启动器），真实往返未取证（V12-A04，2026-09-26）"
        },
        "read": {
          "status": "pending",
          "evidence": "解析器 bridge/src/adapters/cursor-cli.js（官方 Headless 文档记载的 stream-json 帧形：tool_call/assistant 标记帧/result）+ fixture 对拍 bridge/test/adapters/cursor-cli-adapter.test.js（官方示例语义构造，synthetic）；CLI 未安装，真实输出未取证"
        },
        "stop": {
          "status": "pending",
          "evidence": "runner 进程树终止为 bridge 自有能力（bridge/test/runner*.test.js 覆盖通用路径）；Cursor 实机 stop→子进程退出未取证（CLI 未安装）"
        },
        "append": {
          "status": "unavailable",
          "evidence": "print 模式为一次性非交互执行（-p），官方无中途追加输入通道（A04 快照，V12-A04）"
        },
        "resume": {
          "status": "pending",
          "evidence": "官方记载 --resume/--continue/agent resume（A04 快照 Sessions 节），但适配器未实现恢复路径且真实 CLI 未验证——能力保持 false，待 V03 取证后评估"
        },
        "approve": {
          "status": "unavailable",
          "evidence": "print 模式无审批回写协议记载；文件修改靠 --force 旗标（不作为 bridge 默认），绝不生成无法送回 CLI 的审批卡（A04 快照，V12-A04）"
        },
        "fileChanges": {
          "status": "unavailable",
          "evidence": "官方 tool_call 帧仅映射 tool_call 事件（write/read 工具+路径，无 diff 载荷），无 file_change 事件通道证据，不伪造（V12-A04）"
        },
        "usage": {
          "status": "unavailable",
          "evidence": "官方 result 帧样例仅记载 duration_ms，无 token/费用统计输出证据，无统计不伪造（§8.3，V12-A04）"
        }
      },
      "probe": {
        "version_args": [
          "--version"
        ],
        "timeout_ms": 10000,
        "output_max_bytes": 8192
      },
      "docs_ref": "xcx/docs/官方资料/A04-cursor-cli-overview.md"
    },
    {
      "schema_version": 1,
      "agent_key": "factory-droid",
      "display_name": "Factory Droid",
      "aliases": [
        "droid"
      ],
      "logo_asset": "assets/agents/factory-droid.png",
      "lifecycle": "active",
      "adapter_id": "generic",
      "integration_mode": "stdio",
      "capabilities": {
        "create": false,
        "read": false,
        "stop": false,
        "append": false,
        "resume": false,
        "approve": false,
        "fileChanges": false,
        "usage": false
      },
      "initial_prompt_channel": null,
      "verification": {
        "create": {
          "status": "pending",
          "evidence": "解析器+fixture 就绪（bridge/test/adapters/factory-droid-adapter.test.js + test/fixtures/factory-droid/）；真实 CLI 往返未取证（2026-09-26 本机 command -v droid 未安装，且需 FACTORY_API_KEY 账号）；capabilities.js 无声明层行（V12 简报禁改），AdapterFactory 现阶段 fail-closed 拒绝实例化。文档化初始 prompt 通道为 launch-args（exec 位置参数），create 验证前不开放；桥接默认不追加 --auto/--skip-permissions-unsafe（exec 默认只读 spec 模式）"
        },
        "read": {
          "status": "pending",
          "evidence": "仅解析 fixture（--output-format json 的 result 帧→session_end，bridge/test/adapters/factory-droid-adapter.test.js + test/fixtures/factory-droid/output-samples.jsonl）；帧形状证据为快照「json」节样例（docs_ref A10）；真实 CLI 往返未取证"
        },
        "stop": {
          "status": "pending",
          "evidence": "bridge runner 进程树终止为公共能力（test/runner*.test.js）；真实 CLI 下受控停止未验证（droid 未安装）"
        },
        "append": {
          "status": "unavailable",
          "evidence": "droid exec 为一次性任务（快照「single non-interactive pass」），中途追加输入仅在双向 stream-jsonrpc 协议存在且本项目未实现"
        },
        "resume": {
          "status": "unavailable",
          "evidence": "CLI 有 --session-id/--fork 文档化通道（快照「Sessions, tagging, and logs」），但 bridge 无恢复实现路径，声明 false"
        },
        "approve": {
          "status": "unavailable",
          "evidence": "stream-jsonrpc 协议有 droid.request_permission 服务端请求（快照「Build custom flows on raw JSON-RPC」），本项目未实现该协议，声明 false"
        },
        "fileChanges": {
          "status": "unavailable",
          "evidence": "官方快照未记载文件变更帧；result 帧字段不含文件变更（docs_ref A10）"
        },
        "usage": {
          "status": "unavailable",
          "evidence": "文档化 result 帧无 token 统计字段（仅 duration_ms/num_turns），usage 恒空对象（无统计不伪造 §8.3）"
        }
      },
      "probe": {
        "version_args": [
          "--version"
        ],
        "timeout_ms": 10000,
        "output_max_bytes": 8192
      },
      "docs_ref": "xcx/docs/官方资料/A10-factory-droid-exec-overview.md"
    },
    {
      "schema_version": 1,
      "agent_key": "gemini-cli",
      "display_name": "Gemini CLI",
      "aliases": [
        "gemini"
      ],
      "logo_asset": "assets/agents/gemini-cli.png",
      "lifecycle": "active",
      "adapter_id": "generic",
      "integration_mode": "stdio",
      "capabilities": {
        "create": false,
        "read": true,
        "stop": true,
        "append": false,
        "resume": false,
        "approve": false,
        "fileChanges": false,
        "usage": true
      },
      "initial_prompt_channel": "launch-args",
      "verification": {
        "create": {
          "status": "unavailable",
          "evidence": "无 create 代码路径：adapter_id 归 generic 且 AdapterFactory verified create 双闸门（catalog verification + openCapabilitiesFor）均未过；真实 CLI create/read/stop 往返挂 V03"
        },
        "read": {
          "status": "pending",
          "evidence": "解析器已实现（bridge/src/adapters/gemini-cli.js）+ fixture 对拍（bridge/test/adapters/gemini-cli-adapter.test.js，L1）；真实 CLI 帧形未取证（V03），不进开放视图"
        },
        "stop": {
          "status": "pending",
          "evidence": "runner 进程树停止为 bridge 自有能力（bridge/test/runner.test.js / runner-windows.test.js，adapter 无关）；gemini 真实 CLI 会话停止未取证（V03）"
        },
        "append": {
          "status": "unavailable",
          "evidence": "官方 headless 文档（A03 快照）无会话中途追加输入通道；无实现路径（声明 false）"
        },
        "resume": {
          "status": "unavailable",
          "evidence": "A03 快照 headless 章节无 resume/continue 通道记载；无实现路径（声明 false）"
        },
        "approve": {
          "status": "unavailable",
          "evidence": "A03 快照无 headless 审批回写通道记载；无实现路径（声明 false）"
        },
        "fileChanges": {
          "status": "unavailable",
          "evidence": "A03 快照未定义文件变更帧；无 file_change 映射路径，不伪造（声明 false）"
        },
        "usage": {
          "status": "pending",
          "evidence": "仅 fixture 证据（result.stats → session_end.usage 映射，bridge/test/adapters/gemini-cli-adapter.test.js）；官方仅描述 stats 含 token 用量、内部字段未实测（V03）"
        }
      },
      "probe": {
        "version_args": [
          "--version"
        ],
        "timeout_ms": 10000,
        "output_max_bytes": 8192
      },
      "docs_ref": "xcx/docs/官方资料/A03-gemini-cli-headless.md"
    },
    {
      "schema_version": 1,
      "agent_key": "goose",
      "display_name": "Goose",
      "aliases": [],
      "logo_asset": "assets/agents/goose.png",
      "lifecycle": "active",
      "adapter_id": "generic",
      "integration_mode": "stdio",
      "capabilities": {
        "create": false,
        "read": false,
        "stop": false,
        "append": false,
        "resume": false,
        "approve": false,
        "fileChanges": false,
        "usage": false
      },
      "initial_prompt_channel": null,
      "verification": {
        "create": {
          "status": "pending",
          "evidence": "解析器 fixture 对拍（bridge/test/adapters/goose-adapter.test.js）；真实 CLI 往返未取证（本机未安装 goose，V12-A24 探测 2026-09-26），工厂 verified create 门槛未过"
        },
        "read": {
          "status": "pending",
          "evidence": "文本行经 generic 兜底呈现 + 畸形输入隔离 fixture（bridge/test/adapters/goose-adapter.test.js）；真实 CLI 往返未取证（本机未安装 goose，V12-A24 探测 2026-09-26）"
        },
        "stop": {
          "status": "pending",
          "evidence": "进程树终止为 generic 既有能力（runner*.test.js）；goose 真实进程未实测，V12-A24 探测 2026-09-26"
        },
        "append": {
          "status": "unavailable",
          "evidence": "官方快照（aaif-goose/goose README）未提供任何会话输入通道文档（声明 false）"
        },
        "resume": {
          "status": "unavailable",
          "evidence": "无实现路径（声明 false）"
        },
        "approve": {
          "status": "unavailable",
          "evidence": "官方快照无审批回写协议文档（声明 false）"
        },
        "fileChanges": {
          "status": "unavailable",
          "evidence": "官方快照无结构化文件变更事件文档，文本型产品不伪造工具事件（声明 false）"
        },
        "usage": {
          "status": "unavailable",
          "evidence": "官方快照无用量统计文档，无统计不伪造（声明 false）"
        }
      },
      "probe": {
        "version_args": [
          "--version"
        ],
        "timeout_ms": 10000,
        "output_max_bytes": 8192
      },
      "docs_ref": "xcx/docs/官方资料/A24-goose-readme.md"
    },
    {
      "schema_version": 1,
      "agent_key": "iflow",
      "display_name": "iFlow CLI",
      "aliases": [
        "iflow-cli"
      ],
      "logo_asset": "assets/agents/iflow.png",
      "lifecycle": "active",
      "adapter_id": "generic",
      "integration_mode": "stdio",
      "capabilities": {
        "create": true,
        "read": true,
        "stop": true,
        "append": false,
        "resume": false,
        "approve": false,
        "fileChanges": false,
        "usage": false
      },
      "initial_prompt_channel": "launch-args",
      "verification": {
        "create": {
          "status": "verified",
          "evidence": "Windows 本机 iFlow CLI 0.5.19：官方 --prompt 非交互入口、--default 人工审批，DeepSeek Flash 自定义 API 真实回复 iflowpong、退出码 0；仅本产品本机开放，手机/真云未验，见 A22 证据卡"
        },
        "read": {
          "status": "verified",
          "evidence": "真实 0.5.19 stdout=iflowpong、stderr Execution Info assistantRounds=1；产品聚合器仅成功退出且完成标记有效时发最终 agent_message；手机可见未验，见 A22 证据卡"
        },
        "stop": {
          "status": "verified",
          "evidence": "真实 iFlow CLI .cmd 进程 PID 49688 活跃时 ManagedSession.stop 返回 exited=true/taskkill_exit_code=0，无假最终回复；手机 stop 未验，见 A22 证据卡"
        },
        "append": {
          "status": "unavailable",
          "evidence": "--prompt 单次任务启动参数通道，未接入追加输入；证据卡 xcx/docs/release/v1.2/agents/iflow.md"
        },
        "resume": {
          "status": "unavailable",
          "evidence": "会话恢复接口未文档化；证据卡 xcx/docs/release/v1.2/agents/iflow.md"
        },
        "approve": {
          "status": "unavailable",
          "evidence": "--default 要求人工审批，但 bridge 尚未对接 iFlow 审批回写；yolo 不采用，证据卡 xcx/docs/release/v1.2/agents/iflow.md"
        },
        "fileChanges": {
          "status": "unavailable",
          "evidence": "无文件变更事件协议记载；证据卡 xcx/docs/release/v1.2/agents/iflow.md"
        },
        "usage": {
          "status": "unavailable",
          "evidence": "无 token/用量统计字段记载；无统计不伪造（§8.3）；证据卡 xcx/docs/release/v1.2/agents/iflow.md"
        }
      },
      "probe": {
        "version_args": [
          "--version"
        ],
        "timeout_ms": 10000,
        "output_max_bytes": 8192
      },
      "docs_ref": "xcx/docs/官方资料/A22-iflow-cli-quickstart.md"
    },
    {
      "schema_version": 1,
      "agent_key": "junie",
      "display_name": "Junie",
      "aliases": [],
      "logo_asset": "assets/agents/junie.png",
      "lifecycle": "active",
      "adapter_id": "generic",
      "integration_mode": "stdio",
      "capabilities": {
        "create": false,
        "read": false,
        "stop": false,
        "append": false,
        "resume": false,
        "approve": false,
        "fileChanges": false,
        "usage": false
      },
      "initial_prompt_channel": null,
      "verification": {
        "create": {
          "status": "pending",
          "evidence": "解析器 fixture 对拍（bridge/test/adapters/junie-adapter.test.js）；真实 CLI 往返未取证（本机未安装 junie，V12-A26 探测 2026-09-26），工厂 verified create 门槛未过；CLI 官方标 EAP，版本锁定待定"
        },
        "read": {
          "status": "pending",
          "evidence": "文本行经 generic 兜底呈现 + 畸形输入隔离 fixture（bridge/test/adapters/junie-adapter.test.js）；真实 CLI 往返未取证（本机未安装 junie，V12-A26 探测 2026-09-26）"
        },
        "stop": {
          "status": "pending",
          "evidence": "进程树终止为 generic 既有能力（runner*.test.js）；junie 真实进程未实测，V12-A26 探测 2026-09-26"
        },
        "append": {
          "status": "unavailable",
          "evidence": "官方 headless 快照仅一次性位置参数提示，无会话中途追加输入通道文档（声明 false）"
        },
        "resume": {
          "status": "unavailable",
          "evidence": "无实现路径（声明 false）；headless 与 JetBrains IDE 旧对话不互通（卡面 A26）"
        },
        "approve": {
          "status": "unavailable",
          "evidence": "官方快照无审批回写协议文档（声明 false）"
        },
        "fileChanges": {
          "status": "unavailable",
          "evidence": "官方快照无结构化文件变更事件文档，文本型产品不伪造工具事件（声明 false）"
        },
        "usage": {
          "status": "unavailable",
          "evidence": "官方快照无用量统计文档，无统计不伪造（声明 false）"
        }
      },
      "probe": {
        "version_args": [
          "--version"
        ],
        "timeout_ms": 10000,
        "output_max_bytes": 8192
      },
      "docs_ref": "xcx/docs/官方资料/A26-junie-headless.md"
    },
    {
      "schema_version": 1,
      "agent_key": "kimi-code",
      "display_name": "Kimi Code",
      "aliases": [
        "kimi"
      ],
      "logo_asset": "assets/agents/kimi-code.png",
      "lifecycle": "active",
      "adapter_id": "generic",
      "integration_mode": "stdio",
      "capabilities": {
        "create": false,
        "read": true,
        "stop": true,
        "append": true,
        "resume": false,
        "approve": true,
        "fileChanges": true,
        "usage": true
      },
      "initial_prompt_channel": "stdin",
      "verification": {
        "create": {
          "status": "unavailable",
          "evidence": "无产品专属拉起路径（无启动预设；AdapterFactory 对 adapter_id=generic 拒绝新会话，fail-closed）；初始 prompt 经 Wire prompt 请求（stdin）编码器已实现（bridge/src/adapters/kimi-code.js buildKimiPromptFrame），待 V03 真实 CLI 往返接通"
        },
        "read": {
          "status": "pending",
          "evidence": "L1 fixture：bridge/test/adapters/kimi-code-adapter.test.js + bridge/test/fixtures/kimi-code/（官方 Wire 文档示例帧对拍：TurnBegin→ContentPart→TurnEnd/审批/JSON-RPC 错误/畸形帧隔离）；真实 CLI 往返未取证（V12-A16：本机未安装 kimi，command -v/where.exe 双确认，2026-09-26）"
        },
        "stop": {
          "status": "pending",
          "evidence": "runner 进程树终止为 bridge 自有能力（bridge/test/runner.test.js / runner-windows.test.js 同源路径）；kimi --wire 真实进程停止未验（CLI 未安装，V12-A16）"
        },
        "append": {
          "status": "pending",
          "evidence": "L1 fixture：buildKimiPromptFrame/buildKimiSteerFrame 编码器对拍（官方文档：prompt/steer 为官方中途追加通道）；session-manager 写入接线与真实 CLI 未验（V12-A16）"
        },
        "resume": {
          "status": "unavailable",
          "evidence": "无恢复代码路径：Wire replay 仅本会话历史重放（A16a），非跨进程恢复；CLI -C/--session 会话恢复待 V03 单独取证"
        },
        "approve": {
          "status": "pending",
          "evidence": "L1 fixture：buildKimiApprovalResponse 对拍（官方 ApprovalRequest→response: approve|reject[+feedback] 逐字段）；ApprovalRequest→confirm_required 映射对拍；真实 CLI 审批往返未验（V12-A16）"
        },
        "fileChanges": {
          "status": "pending",
          "evidence": "L1 fixture：ToolResult.return_value.display[diff]（官方 DisplayBlock.diff）→ file_change 映射对拍；真实 CLI 是否发 diff 块未验（V12-A16）"
        },
        "usage": {
          "status": "pending",
          "evidence": "L1 fixture：StatusUpdate.token_usage（官方 TokenUsage：input_other/output/input_cache_read/input_cache_creation）→ usage 数据路径对拍；真实 CLI 未验（V12-A16）"
        }
      },
      "probe": {
        "version_args": [
          "--version"
        ],
        "timeout_ms": 10000,
        "output_max_bytes": 8192
      },
      "docs_ref": "xcx/docs/官方资料/A16b-kimi-code-getting-started.md"
    },
    {
      "schema_version": 1,
      "agent_key": "kiro-cli",
      "display_name": "Kiro CLI",
      "aliases": [],
      "logo_asset": "assets/agents/kiro-cli.png",
      "lifecycle": "active",
      "adapter_id": "generic",
      "integration_mode": "stdio",
      "capabilities": {
        "create": false,
        "read": false,
        "stop": false,
        "append": false,
        "resume": false,
        "approve": false,
        "fileChanges": false,
        "usage": false
      },
      "initial_prompt_channel": null,
      "verification": {
        "create": {
          "status": "pending",
          "evidence": "解析器+fixture 就绪（bridge/test/adapters/kiro-cli-adapter.test.js + test/fixtures/kiro-cli/）；真实 CLI 往返未取证（2026-09-26 本机 command -v kiro-cli 未安装，且需 KIRO_API_KEY）；capabilities.js 无声明层行（V12 简报禁改），AdapterFactory 现阶段 fail-closed 拒绝实例化。文档化初始 prompt 通道为 launch-args（--no-interactive 必须携带位置 prompt），create 验证前不开放"
        },
        "read": {
          "status": "pending",
          "evidence": "仅解析 fixture（文本行→agent_message，bridge/test/adapters/kiro-cli-adapter.test.js + test/fixtures/kiro-cli/text-sample.txt）；官方快照仅记载文本输出、无结构化帧格式（docs_ref A13），解析走文本路径不伪造工具事件；真实 CLI 往返未取证"
        },
        "stop": {
          "status": "pending",
          "evidence": "bridge runner 进程树终止为公共能力（test/runner*.test.js）；真实 CLI 下受控停止未验证（kiro-cli 未安装）"
        },
        "append": {
          "status": "unavailable",
          "evidence": "官方 Limitations 明确「No mid-session user input is possible」（docs_ref A13）"
        },
        "resume": {
          "status": "unavailable",
          "evidence": "官方快照未记载 headless 会话恢复通道；无实现路径"
        },
        "approve": {
          "status": "unavailable",
          "evidence": "--trust-all-tools/--trust-tools 为预先放行而非双向审批通道（docs_ref A13）；桥接默认不追加 --trust-all-tools，headless 下无批准交互"
        },
        "fileChanges": {
          "status": "unavailable",
          "evidence": "官方快照未记载文件变更帧；不伪造工具事件"
        },
        "usage": {
          "status": "unavailable",
          "evidence": "官方快照未记载 token 统计输出；无统计不伪造（§8.3）"
        }
      },
      "probe": {
        "version_args": [
          "--version"
        ],
        "timeout_ms": 10000,
        "output_max_bytes": 8192
      },
      "docs_ref": "xcx/docs/官方资料/A13-kiro-cli-headless.md"
    },
    {
      "schema_version": 1,
      "agent_key": "openclaw",
      "display_name": "OpenClaw",
      "aliases": [],
      "logo_asset": "assets/agents/openclaw.png",
      "lifecycle": "active",
      "adapter_id": "generic",
      "integration_mode": "stdio",
      "capabilities": {
        "create": false,
        "read": false,
        "stop": false,
        "append": false,
        "resume": false,
        "approve": false,
        "fileChanges": false,
        "usage": false
      },
      "initial_prompt_channel": null,
      "verification": {
        "create": {
          "status": "pending",
          "evidence": "合规通路已核验（官方资料 A27 快照）：openclaw agent exec（无 gateway、一次性嵌入执行，默认临时状态目录用后即清，--isolated 可忽略本机 ambient 配置）；未实测——本机未安装 CLI（command -v openclaw 无结果），真实 create 往返未取证（V12-A27）"
        },
        "read": {
          "status": "pending",
          "evidence": "L1 fixture 对拍已实现（官方 --json 稳定信封 ok/status/final/payloads/usage/error{message,kind}）：xcx/bridge/test/adapters/openclaw-adapter.test.js + test/fixtures/openclaw/；真实 CLI 信封未取证（本机未安装）"
        },
        "stop": {
          "status": "pending",
          "evidence": "停止=runner 只终止本次 spawn 的进程树（adapter-contract §4），绝不调用 openclaw gateway stop（避免关闭其他 gateway 会话，V12-A27 边界）；真实往返未取证；runner 通用进程树终止 CI 验证 bridge/test/runner.test.js"
        },
        "append": {
          "status": "unavailable",
          "evidence": "agent exec 为一次性执行，官方快照无中途追加输入接口记载（--state-dir 会话保持语义未核验）"
        },
        "resume": {
          "status": "unavailable",
          "evidence": "官方快照未记载 exec 恢复既有会话接口（--session-id 属 gateway 命令语义，未核验）"
        },
        "approve": {
          "status": "unavailable",
          "evidence": "官方快照未记载审批回写通道；适配器绝不伪造审批按钮（fixture 断言 actions 为空）"
        },
        "fileChanges": {
          "status": "unavailable",
          "evidence": "--json 信封仅含聚合 toolSummary（调用计数/工具名列表），无逐文件变更结构；不从聚合计数伪造工具事件（fixture 断言无 tool_call）"
        },
        "usage": {
          "status": "pending",
          "evidence": "L1 fixture：官方信封 usage{input,output,total} 映射为 session_end.usage{input_tokens,output_tokens}（协议 §3.10 形状），xcx/bridge/test/adapters/openclaw-adapter.test.js；真实信封未取证（本机未安装），不进入开放视图"
        }
      },
      "probe": {
        "version_args": [
          "--version"
        ],
        "timeout_ms": 10000,
        "output_max_bytes": 8192
      },
      "docs_ref": "xcx/docs/官方资料/A27-openclaw-cli-agent.md"
    },
    {
      "schema_version": 1,
      "agent_key": "opencode",
      "display_name": "OpenCode",
      "aliases": [],
      "logo_asset": "assets/agents/opencode.png",
      "lifecycle": "active",
      "adapter_id": "generic",
      "integration_mode": "stdio",
      "capabilities": {
        "create": true,
        "read": true,
        "stop": true,
        "append": false,
        "resume": false,
        "approve": false,
        "fileChanges": false,
        "usage": true
      },
      "initial_prompt_channel": "launch-args",
      "verification": {
        "create": {
          "status": "verified",
          "evidence": "2026-09-26 win32/OpenCode 1.18.20：真实 AgentRunner 与 SessionManager profile 初始 prompt→最终回复→进程退出；stdin EOF 回归见 bridge/test/agents-profile-routing.test.js，详情 docs/release/v1.2/agents/opencode.md；手机验收仍待 V12-26"
        },
        "read": {
          "status": "verified",
          "evidence": "2026-09-26 真实 bridge profile 收到 step_start/text/step_finish，映射 task_progress/agent_message/session_end；fixtures 对拍见 bridge/test/adapters/opencode-adapter.test.js，详情 docs/release/v1.2/agents/opencode.md"
        },
        "stop": {
          "status": "verified",
          "evidence": "2026-09-26 真实 OpenCode 活跃步骤由 AgentRunner.stop 与 SessionManager stop_session 定向终止，taskkill_exit_code=0、exited=true，独立进程保持存活；详情 docs/release/v1.2/agents/opencode.md；手机验收仍待 V12-26"
        },
        "append": {
          "status": "unavailable",
          "evidence": "run 非交互单次模式无中途追加输入通道证据（A05 快照，V12-A05）"
        },
        "resume": {
          "status": "unavailable",
          "evidence": "官方 run --continue/--session 恢复旗标存在但未实测，未实测能力一律 false（A05 快照，V12-A05）"
        },
        "approve": {
          "status": "unavailable",
          "evidence": "无审批回写通道证据（未用 --auto 全放行；权限请求在非交互模式的回写协议未取证，A05 快照，V12-A05）"
        },
        "fileChanges": {
          "status": "unavailable",
          "evidence": "真实往返仅见 text/tool_use 帧，无文件变更 diff 帧证据，不伪造（V12-A05 实测）"
        },
        "usage": {
          "status": "verified",
          "evidence": "2026-09-26 真实 bridge profile session_end.usage 收到 input_tokens=192/output_tokens=2；映射回归见 bridge/test/adapters/opencode-adapter.test.js，详情 docs/release/v1.2/agents/opencode.md"
        }
      },
      "probe": {
        "version_args": [
          "--version"
        ],
        "timeout_ms": 10000,
        "output_max_bytes": 8192
      },
      "docs_ref": "xcx/docs/官方资料/A05-opencode-cli.md"
    },
    {
      "schema_version": 1,
      "agent_key": "openhands",
      "display_name": "OpenHands",
      "aliases": [],
      "logo_asset": "assets/agents/openhands.png",
      "lifecycle": "active",
      "adapter_id": "generic",
      "integration_mode": "stdio",
      "capabilities": {
        "create": false,
        "read": false,
        "stop": false,
        "append": false,
        "resume": false,
        "approve": false,
        "fileChanges": false,
        "usage": false
      },
      "initial_prompt_channel": null,
      "verification": {
        "create": {
          "status": "unavailable",
          "evidence": "无合规可控通路（V12-A25 核验，2026-09-26）：官方 headless 模式强制 always-approve（官方原文 cannot be changed—--llm-approve is not available in headless mode），对任意动作全自动批准且该页未记载受限 sandbox/正式取消接口，不符合最小权限，不作为默认实现（docs_ref 快照 + 在线复核）"
        },
        "read": {
          "status": "pending",
          "evidence": "L1 fixture 对拍已实现（官方记载的 action/observation 帧）：xcx/bridge/test/adapters/openhands-adapter.test.js + test/fixtures/openhands/；真实 CLI JSONL 帧流未取证（本机未安装 CLI），最终回复帧形状官方快照未记载（SDK 事件类模型与 CLI JSONL 形状不可混用）"
        },
        "stop": {
          "status": "pending",
          "evidence": "bridge 通用进程树终止能力（runner）CI 持续验证 bridge/test/runner.test.js / runner-windows.test.js；因 create 无合规通路，本产品真实 create/read/stop 往返未取证"
        },
        "append": {
          "status": "unavailable",
          "evidence": "官方 headless 为一次性任务执行（--task/--file），无中途追加输入接口记载"
        },
        "resume": {
          "status": "unavailable",
          "evidence": "官方快照未记载恢复既有会话接口"
        },
        "approve": {
          "status": "unavailable",
          "evidence": "headless 强制 always-approve 且 --llm-approve 不可用（官方原文），无审批回写通道；适配器绝不伪造审批按钮（fixture 断言 actions 为空）"
        },
        "fileChanges": {
          "status": "unavailable",
          "evidence": "官方帧文档未记载文件变更事件结构（write action 仅含 path，入工具预览）；无已实现 file_change 映射路径"
        },
        "usage": {
          "status": "unavailable",
          "evidence": "官方 headless --json 输出未记载 token 用量字段，无统计不伪造（§8.3）"
        }
      },
      "probe": {
        "version_args": [
          "--version"
        ],
        "timeout_ms": 10000,
        "output_max_bytes": 8192
      },
      "docs_ref": "xcx/docs/官方资料/A25-openhands-cli-headless.md"
    },
    {
      "schema_version": 1,
      "agent_key": "qoder-cn",
      "display_name": "Qoder CN",
      "aliases": [
        "qodercn",
        "qoderclicn",
        "lingma"
      ],
      "logo_asset": "assets/agents/qoder-cn.png",
      "lifecycle": "active",
      "adapter_id": "generic",
      "integration_mode": "stdio",
      "capabilities": {
        "create": false,
        "read": true,
        "stop": true,
        "append": false,
        "resume": false,
        "approve": false,
        "fileChanges": false,
        "usage": false
      },
      "initial_prompt_channel": "launch-args",
      "verification": {
        "create": {
          "status": "unavailable",
          "evidence": "官方存在 headless 入口（A19a：qodercn -p '<提示词>'），但 bridge 拉起参数模板未接线（AGENT_PRESETS/capabilities.js 属编排层统一处理）且真实 CLI 未验证——声明 false；V03 取证后按 adapter-contract §2.3 翻层"
        },
        "read": {
          "status": "pending",
          "evidence": "L1 解析 fixture：bridge/test/adapters/qoder-cn-adapter.test.js（候选契约对拍；官方快照 A19a 未记载 headless 输出帧 schema，真实 CLI 帧未取证，本机未安装 qodercn/qoderclicn）"
        },
        "stop": {
          "status": "pending",
          "evidence": "bridge 进程树终止为 agent 无关代码路径（bridge/test/runner.test.js、runner-windows.test.js）；产品级真实停止未取证（CLI 未安装）"
        },
        "append": {
          "status": "unavailable",
          "evidence": "官方无 headless 中途追加输入通道文档（A19a），无实现路径（声明 false）"
        },
        "resume": {
          "status": "unavailable",
          "evidence": "A19a /resume 仅 TUI 命令，无 headless 恢复通道文档；无实现路径（声明 false）"
        },
        "approve": {
          "status": "unavailable",
          "evidence": "官方无审批帧/回写协议文档（A19a）；适配器将 control_request 候选帧降级为诊断事件，不映射 confirm_required（手机端不出现虚假审批按钮，§5.2）"
        },
        "fileChanges": {
          "status": "unavailable",
          "evidence": "无官方文件变更帧文档；候选 assistant.tool_use 帧仅映射 tool_call，不衍生 file_change（不伪造）"
        },
        "usage": {
          "status": "unavailable",
          "evidence": "无官方用量帧文档；session_end.usage 恒空对象（无统计不伪造，§8.3）"
        }
      },
      "probe": {
        "version_args": [
          "--version"
        ],
        "timeout_ms": 10000,
        "output_max_bytes": 8192
      },
      "docs_ref": "xcx/docs/官方资料/A19a-qoder-cn-commands.md"
    },
    {
      "schema_version": 1,
      "agent_key": "qoder",
      "display_name": "Qoder",
      "aliases": [],
      "logo_asset": "assets/agents/qoder.png",
      "lifecycle": "active",
      "adapter_id": "generic",
      "integration_mode": "stdio",
      "capabilities": {
        "create": false,
        "read": true,
        "stop": true,
        "append": false,
        "resume": false,
        "approve": false,
        "fileChanges": false,
        "usage": false
      },
      "initial_prompt_channel": "launch-args",
      "verification": {
        "create": {
          "status": "unavailable",
          "evidence": "无产品专属拉起路径（无启动预设；AdapterFactory 对 adapter_id=generic 拒绝新会话，fail-closed）；官方 headless 形态为 qoder -p \"<prompt>\"（launch-args 通道，A18a），待 V03 真实 CLI 往返接通"
        },
        "read": {
          "status": "pending",
          "evidence": "文本输出（官方 text 默认格式）经 generic 行流路径读取（bridge/test/adapters/qoder-adapter.test.js fixture 对拍）；官方快照未给出 json/stream-json 帧 schema——探测为空集、不伪造结构化事件；真实 CLI 往返未取证（V12-A18：本机未安装 qoder，command -v/where.exe 双确认，2026-09-26）"
        },
        "stop": {
          "status": "pending",
          "evidence": "runner 进程树终止为 bridge 自有能力（bridge/test/runner.test.js / runner-windows.test.js 同源路径）；qoder 真实进程停止未验（CLI 未安装，V12-A18）"
        },
        "append": {
          "status": "unavailable",
          "evidence": "官方仅述及 --input-format stream-json 存在（A18a），未给出 Structured Messages 的消息 schema——无编码路径，不声明；待 V03 取证"
        },
        "resume": {
          "status": "unavailable",
          "evidence": "--session-id 为官方 CLI flag（A18a），bridge 无恢复重拉代码路径，不声明；待 V03 单独取证"
        },
        "approve": {
          "status": "unavailable",
          "evidence": "headless（-p）下任何 ask 一律自动拒绝（A18a/A18b 官方文档化行为）；SDK canUseTool 回调与 ACP requestPermission 为其他集成模式（A18b），本卡未实现，不混合宣传"
        },
        "fileChanges": {
          "status": "unavailable",
          "evidence": "无帧 schema，无 file_change 映射路径（generic 式文本产品不伪造工具事件）"
        },
        "usage": {
          "status": "unavailable",
          "evidence": "json 输出含 Metadata 但字段未文档化（A18a），无统计路径——无统计不伪造（§8.3）"
        }
      },
      "probe": {
        "version_args": [
          "--version"
        ],
        "timeout_ms": 10000,
        "output_max_bytes": 8192
      },
      "docs_ref": "xcx/docs/官方资料/A18a-qoder-run-in-scripts.md"
    },
    {
      "schema_version": 1,
      "agent_key": "qwen-code",
      "display_name": "Qwen Code",
      "aliases": [
        "qwen"
      ],
      "logo_asset": "assets/agents/qwen-code.png",
      "lifecycle": "active",
      "adapter_id": "generic",
      "integration_mode": "stdio",
      "capabilities": {
        "create": true,
        "read": true,
        "stop": true,
        "append": false,
        "resume": false,
        "approve": false,
        "fileChanges": false,
        "usage": true
      },
      "initial_prompt_channel": "launch-args",
      "verification": {
        "create": {
          "status": "verified",
          "evidence": "2026-09-26 Windows：@qwen-code/qwen-code 0.24.6（项目内隔离安装），bridge ManagedSession 调用本机 qwen.cmd，--bare/--approval-mode default/stream-json/--prompt 创建真实会话；DeepSeek OpenAI-compatible 凭据仅进进程环境；见 docs/release/v1.2/agents/qwen-code.md"
        },
        "read": {
          "status": "verified",
          "evidence": "同次真实 bridge→Qwen 0.24.6 往返，收到 assistant『桥接器实测成功』、result completed、session_exit ended；profile 产品路由与 system/init 帧已接线，见 qwen-code.md"
        },
        "stop": {
          "status": "verified",
          "evidence": "同次第二个真实 CLI 会话，在 system/init 后调用 ManagedSession.stop，runner 返回 stopped=true、exited=true、force-killed、taskkill_exit_code=0，session_exit ended；见 qwen-code.md"
        },
        "append": {
          "status": "unavailable",
          "evidence": "0.24.6 已暴露 --input-format stream-json，但 bridge 尚未实现 Qwen 会话中途追加；headless --prompt 配方只支持单次初始输入"
        },
        "resume": {
          "status": "unavailable",
          "evidence": "官方 --continue/--resume 旗标存在（A15 快照），但 bridge 无 resume 会话实现路径（声明 false）；未实测不开放"
        },
        "approve": {
          "status": "unavailable",
          "evidence": "A15 快照无 headless 审批回写通道记载（--yolo 为自动批准、不提供手机端决议回写）；无实现路径（声明 false）"
        },
        "fileChanges": {
          "status": "unavailable",
          "evidence": "A15 快照未定义 file_change 帧（tool_result 仅 64KB 预览上限记载）；无映射路径，不伪造（声明 false）"
        },
        "usage": {
          "status": "verified",
          "evidence": "真实 Qwen 0.24.6 result.usage 经 bridge session_end 上行 input_tokens=7583、output_tokens=5（测试模型 DeepSeek）；见 qwen-code.md"
        }
      },
      "probe": {
        "version_args": [
          "--version"
        ],
        "timeout_ms": 10000,
        "output_max_bytes": 8192
      },
      "docs_ref": "xcx/docs/官方资料/A15-qwen-code-headless.md"
    },
    {
      "schema_version": 1,
      "agent_key": "roo-code",
      "display_name": "Roo Code",
      "aliases": [
        "roo"
      ],
      "logo_asset": "assets/agents/roo-code.png",
      "lifecycle": "deprecated",
      "adapter_id": "generic",
      "integration_mode": "manual-report",
      "capabilities": {
        "create": false,
        "read": false,
        "stop": false,
        "append": false,
        "resume": false,
        "approve": false,
        "fileChanges": false,
        "usage": false
      },
      "initial_prompt_channel": null,
      "verification": {
        "create": {
          "status": "unavailable",
          "evidence": "官方扩展已停服（docs_ref 停服说明）；无适配器实现，不推荐新安装（§6 历史兼容登记）"
        },
        "read": {
          "status": "unavailable",
          "evidence": "官方扩展已停服（docs_ref 停服说明）；无适配器实现，不推荐新安装（§6 历史兼容登记）"
        },
        "stop": {
          "status": "unavailable",
          "evidence": "官方扩展已停服（docs_ref 停服说明）；无适配器实现，不推荐新安装（§6 历史兼容登记）"
        },
        "append": {
          "status": "unavailable",
          "evidence": "官方扩展已停服（docs_ref 停服说明）；无适配器实现，不推荐新安装（§6 历史兼容登记）"
        },
        "resume": {
          "status": "unavailable",
          "evidence": "官方扩展已停服（docs_ref 停服说明）；无适配器实现，不推荐新安装（§6 历史兼容登记）"
        },
        "approve": {
          "status": "unavailable",
          "evidence": "官方扩展已停服（docs_ref 停服说明）；无适配器实现，不推荐新安装（§6 历史兼容登记）"
        },
        "fileChanges": {
          "status": "unavailable",
          "evidence": "官方扩展已停服（docs_ref 停服说明）；无适配器实现，不推荐新安装（§6 历史兼容登记）"
        },
        "usage": {
          "status": "unavailable",
          "evidence": "官方扩展已停服（docs_ref 停服说明）；无适配器实现，不推荐新安装（§6 历史兼容登记）"
        }
      },
      "probe": {
        "version_args": [
          "--version"
        ],
        "timeout_ms": 10000,
        "output_max_bytes": 8192
      },
      "docs_ref": "xcx/docs/官方资料/HIST-roocode-sunset.md"
    },
    {
      "schema_version": 1,
      "agent_key": "trae-cli",
      "display_name": "TRAE CLI",
      "aliases": [
        "trae",
        "traecli"
      ],
      "logo_asset": "assets/agents/trae-cli.png",
      "lifecycle": "active",
      "adapter_id": "generic",
      "integration_mode": "stdio",
      "capabilities": {
        "create": false,
        "read": true,
        "stop": true,
        "append": false,
        "resume": false,
        "approve": false,
        "fileChanges": false,
        "usage": false
      },
      "initial_prompt_channel": "launch-args",
      "verification": {
        "create": {
          "status": "unavailable",
          "evidence": "官方存在 exec 非交互入口（A20b：traecli exec [选项] [PROMPT]，--sandbox read-only|workspace-write|danger-full-access 按本机 profile 策略授权），但 bridge 拉起参数模板未接线且真实 CLI 未验证——声明 false；禁用 danger-full-access/--yolo 作默认（简报禁止照抄官方危险参数）"
        },
        "read": {
          "status": "pending",
          "evidence": "L1 解析 fixture：bridge/test/adapters/trae-cli-adapter.test.js（候选契约对拍；官方快照 A20b 仅记载 exec --json 输出 JSONL 事件流、未记载帧 schema，真实 CLI 帧未取证，本机未安装 traecli/trae）"
        },
        "stop": {
          "status": "pending",
          "evidence": "bridge 进程树终止为 agent 无关代码路径（bridge/test/runner.test.js、runner-windows.test.js）；产品级真实停止未取证（CLI 未安装）"
        },
        "append": {
          "status": "unavailable",
          "evidence": "官方无 exec 中途追加输入通道文档（A20b；TUI 交互选项不构成非交互追加通道），无实现路径（声明 false）"
        },
        "resume": {
          "status": "unavailable",
          "evidence": "官方存在 traecli resume [SESSION_ID]/--resume 子命令（A20b），但适配器未实现恢复映射路径且真实 CLI 未验证——声明 false"
        },
        "approve": {
          "status": "unavailable",
          "evidence": "官方有 --ask-for-approval 旗标，但无外部客户端回写审批决议的帧协议文档（A20b）；不映射 confirm_required（手机端不出现虚假审批按钮，§5.2）"
        },
        "fileChanges": {
          "status": "unavailable",
          "evidence": "无官方文件变更帧文档；无 file_change 映射路径（声明 false）"
        },
        "usage": {
          "status": "unavailable",
          "evidence": "无官方用量帧文档；session_end.usage 恒空对象（无统计不伪造，§8.3）"
        }
      },
      "probe": {
        "version_args": [
          "--version"
        ],
        "timeout_ms": 10000,
        "output_max_bytes": 8192
      },
      "docs_ref": "xcx/docs/官方资料/A20a-trae-cli2-get-started.md"
    },
    {
      "schema_version": 1,
      "agent_key": "windsurf",
      "display_name": "Windsurf",
      "aliases": [],
      "logo_asset": "assets/agents/windsurf.png",
      "lifecycle": "active",
      "adapter_id": "generic",
      "integration_mode": "hook",
      "capabilities": {
        "create": false,
        "read": false,
        "stop": false,
        "append": false,
        "resume": false,
        "approve": false,
        "fileChanges": false,
        "usage": false
      },
      "initial_prompt_channel": null,
      "verification": {
        "create": {
          "status": "unavailable",
          "evidence": "无官方外部新建通道：官方 hooks 入口跳转 Devin 文档，仅 hooks≠create/read/stop（§5.2）；观察解析器骨架 xcx/bridge/src/adapters/windsurf.js（hook 帧翻译，L1 对拍 test/adapters/windsurf-adapter.test.js）；本机 command -v windsurf 未安装（2026-09-26）；证据卡 xcx/docs/release/v1.2/agents/windsurf.md（BLOCKED）"
        },
        "read": {
          "status": "unavailable",
          "evidence": "hook 由 Cascade 主动触发且不保证触发（任务卡边界），非稳定输出流；解析器骨架 xcx/bridge/src/adapters/windsurf.js（post_cascade_response→agent_message 为 L1 路径）；真实触发未取证；证据卡 xcx/docs/release/v1.2/agents/windsurf.md（BLOCKED）"
        },
        "stop": {
          "status": "unavailable",
          "evidence": "hook 进程归 Cascade 所有，bridge 无进程树可停；官方无受控停止接口；证据卡 xcx/docs/release/v1.2/agents/windsurf.md（BLOCKED）"
        },
        "append": {
          "status": "unavailable",
          "evidence": "hooks 为单向观察，无追加输入通道；证据卡 xcx/docs/release/v1.2/agents/windsurf.md"
        },
        "resume": {
          "status": "unavailable",
          "evidence": "无会话恢复接口（trajectory_id 仅出现在 hook 载荷，无外部恢复 API）；证据卡 xcx/docs/release/v1.2/agents/windsurf.md"
        },
        "approve": {
          "status": "unavailable",
          "evidence": "hook 退出码 0/2 是 hook 脚本对 Cascade 的协议（pre-hook 阻断动作），非外部审批回写通道；证据卡 xcx/docs/release/v1.2/agents/windsurf.md"
        },
        "fileChanges": {
          "status": "unavailable",
          "evidence": "pre/post_write_code hook 帧含 edits 形态（解析器仅观察），但触发不保证且未实测——不伪造文件变更能力；证据卡 xcx/docs/release/v1.2/agents/windsurf.md"
        },
        "usage": {
          "status": "unavailable",
          "evidence": "官方 hook 载荷无 token/用量统计字段；无统计不伪造（§8.3）；证据卡 xcx/docs/release/v1.2/agents/windsurf.md"
        }
      },
      "probe": {
        "version_args": [
          "--version"
        ],
        "timeout_ms": 10000,
        "output_max_bytes": 8192
      },
      "docs_ref": "xcx/docs/官方资料/A14-windsurf-cascade-hooks.md"
    }
  ].map((entry) => Object.freeze({
  ...entry,
  aliases: Object.freeze([...entry.aliases]),
  capabilities: Object.freeze({ ...entry.capabilities }),
  verification: Object.freeze(Object.fromEntries(Object.entries(entry.verification).map(([k, v]) => [k, Object.freeze({ ...v })]))),
  probe: Object.freeze({ ...entry.probe }),
})));

const KEY_INDEX = new Map(CATALOG_ENTRIES.map((entry) => [entry.agent_key, entry]));
const ALIAS_INDEX = new Map(CATALOG_ENTRIES.flatMap((entry) => entry.aliases.map((alias) => [alias, entry.agent_key])));

/**
 * 名称 → 规范化 agent_key：先精确 key，再别名表；未知返回 null。
 * 识别优先级最低为 unknown（§7.1）——绝不猜 Claude、绝不回退 'claude-code'（T12）。
 */
export function resolveAgentKey(name) {
  const normalized = String(name ?? '').trim().toLowerCase();
  if (!normalized) return null;
  if (KEY_INDEX.has(normalized)) return normalized;
  return ALIAS_INDEX.get(normalized) ?? null;
}

/** 按 agent_key 取目录条目；未知返回 null（调用方按 unknown fail-closed 处理）。 */
export function getCatalogEntry(agentKey) {
  return KEY_INDEX.get(String(agentKey ?? '').trim().toLowerCase()) ?? null;
}

/** 全量条目（只读视图；数组与条目均已冻结）。 */
export function listCatalogEntries() {
  return CATALOG_ENTRIES;
}
