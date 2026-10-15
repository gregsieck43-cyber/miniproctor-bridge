# miniproctor bridge

微信小程序「智能体遥知」的电脑端 Bridge。

## 最新技术预发行：v0.6.0-rc31

本次优先交付 **Codex、Claude Code、WorkBuddy、DSH、ZCode**。

- [下载 RC31 安装包](https://github.com/gregsieck43-cyber/miniproctor-bridge/releases/download/v0.6.0-rc31/miniproctor-bridge-v0.6.0-rc31.zip)
- [SHA-256 校验文件](https://github.com/gregsieck43-cyber/miniproctor-bridge/releases/download/v0.6.0-rc31/miniproctor-bridge-v0.6.0-rc31.zip.sha256)
- [发行清单](https://github.com/gregsieck43-cyber/miniproctor-bridge/releases/download/v0.6.0-rc31/manifest.json)
- [复制给电脑 Agent 的完整安装引导](https://github.com/gregsieck43-cyber/miniproctor-bridge/releases/download/v0.6.0-rc31/agent-prompt.txt)
- [版本说明](https://github.com/gregsieck43-cyber/miniproctor-bridge/releases/tag/v0.6.0-rc31)

需要已有 Node.js 22 或更高版本。先核对 ZIP 的 SHA-256，再解压到新的目录；
哈希不一致时不要解压或执行。ZIP 不含设备身份、用户配置、模型密钥或第三方 CLI。

校验值：`1accc5bd118297936f48b892b4ecb9a5d953116a11a935bfa9ead6ff16da2f67`。
ZIP 为 896819 字节，发行清单含 162 个文件；两次构建所得 ZIP 字节一致。

## 安装

在校验后解压出的目录，按照 `README-RELEASE.txt` 操作。
Windows 可运行发行包自带的安装器：

```powershell
powershell -NoProfile -File installer\setup.ps1
```

macOS/Linux 的通用 Bridge 安装入口：

```sh
sh installer/setup.sh
```

五款原生适配的验收基于固定 Windows 运行时；不宣称在其他平台全部通过。
若执行策略、权限或安全软件拒绝操作，立即停止并交由用户处理，
不要绕过策略、提升权限或换解释器重试。实际安装/升级在当前受限环境中未实测。
升级前保留原配置与设备数据，使用安装器的锁检查、暂存校验与原子切换保护；
不要在已有运行任务的目录直接强制覆盖解压。

## 模型路由与凭据

本轮路由使用 CommandCode Chat Completions，模型为
`deepseek/deepseek-v4.1-flash`。在本机准备私有 JSON：

```json
{
  "api_format": "chat-completions",
  "base_url": "https://api.commandcode.ai/provider/v1",
  "model": "deepseek/deepseek-v4.1-flash",
  "api_key_file": "<本机绝对路径>/provider-key.txt"
}
```

`provider-key.txt` 只保存用户自己的 API 密钥，并限制文件访问权限。
启动 Bridge 的进程环境变量 `MINIPROCTOR_CHAT_PROVIDER_CONFIG` 指向该 JSON
的绝对路径。不得将密钥写进 profile、命令行参数、项目仓库或小程序。
真实模型凭据仅由可信 Node 父进程读取；设备鉴权请求与模型凭据分离。
第三方 CLI、合法账号、匹配的固定版本运行时及模型额度由用户自行准备。

登记 profile、授权工作区并完成配对后，使用：

```sh
node src/main.js run --no-initial-session
```

该命令只启动任务接收服务，不自动运行默认 Agent；手机随后可以创建任务。
`status --offline` 仅查看本地配对记录和实例锁，不领取命令，
也不证明服务器绑定当前有效。新配对需本次真实服务端 bound 回执；
最终连通性请在小程序确认同一电脑在线，不能以进程运行代替。

## 验收范围与限制

五款已有正常 profile → 官方模拟器 SDK → 真云 → Bridge 的
文本创建、读取输出和活跃停止组合验收证据。
Claude Code、ZCode 沿用此前固定点证据，并非五款都在最终版本重新实测。
DSH 的停止证据为真实上游中止及 SDK shutdown，不宣称 Native turn-cancel。
文本路由的文件/命令工具关闭；这不是操作系统沙箱或任意工具执行的保证。

其他 23 款不属于本轮优先验收承诺。真机、第二用户及完整安装升级仍未实测。
本次发布只更新 Bridge 安装发行，不替代微信小程序最终人工发布与审核。
历史稳定版 v0.5.1、RC30 及已有标签和附件保持不变。

包内完整性检查：`node tools/verify-release.cjs --installed <目录>`。
此命令校验发行文件，不等同于实际安装或业务连通验收。
源码工作区固定提交：`3763ca01ab6c8c839c8aacd9bd295e7c61f96c8a`。
