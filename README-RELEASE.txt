miniproctor bridge 发行包
==========================
要求：Node.js >= 22（建议 v24；bridge 语音识别另需 node tools/setup-asr.cjs 下载模型，本包不含）。

包结构：扁平——package.json / src/ / tools/ 直接位于解压目录根部。
安全边界：本包不含 config.json、device.json、data/、.env、node_modules
（设备身份与配置永不随包分发；升级安装会原样保留它们）。

一键安装（推荐；自动定位包内容，默认装到用户主目录 miniproctor-bridge）：
  Windows PowerShell：powershell -NoProfile -ExecutionPolicy Bypass -File installer\setup.ps1
  macOS / Linux / Git Bash：sh installer/setup.sh
  升级保护（原子升级）：先建暂存目录并按 RELEASE-MANIFEST.json 校验完整性，通过才切换；
  目标已有的 config.json / device.json / data/（outbox/inbox）一律保留，config.json 仅补齐缺失字段；
  切换时旧目录整体改名 <安装目录>.old-<时间戳>（完整配置/数据备份，可改名回去回滚），
  切换失败自动还原，旧版照常可运行；检测到 bridge 正在运行（data/bridge.lock）会提示
  先等待任务结束或明确停止任务，不能偷偷中断。

手动安装（也可解压到任意目录后逐步执行）：
  1. node tools/setup-wizard.cjs   # 交互式配置（endpoint 模式无需任何密钥）
  2. node src/main.js doctor       # 自检
  3. node src/main.js workspace add <工作区路径>    # 授权手机可创建任务的目录
  4. node src/main.js profiles register --agent-key <产品键> --command <CLI> --cwd <工作区路径>
     # 在电脑上登记 Agent 配置；路径和命令不会发到手机
  5. node src/main.js pair         # 生成 6 位配对码，到小程序输入完成绑定
  6. node src/main.js run --no-initial-session  # 驻留接收手机任务，不启动默认 Agent
  （可另配语音识别：node tools/setup-asr.cjs）

OpenHands Agent SDK（可选；Windows Python 3.14 本机通路已验）：
  node tools/setup-openhands.cjs --workspace <Agent 项目目录> --python <Python 3.14 路径>
  # 依赖安装到 <Agent 项目目录>/.deps/openhands-v12，缓存与临时文件也在该项目内。
  # 将该虚拟环境的 .deps/openhands-v12/Scripts/python.exe 用作 OpenHands profile 的 --command。
  # 启动 bridge 前在本机进程环境设置 OPENHANDS_LLM_MODEL 与 OPENHANDS_LLM_API_KEY，
  # 自定义 API 还需 OPENHANDS_LLM_BASE_URL；不要把密钥放进小程序、profile 或命令行。
  # 工具动作使用 AlwaysConfirm，经小程序审批后才执行；未完成逐产品手机/真云验收，
  # 当前发行包仍为技术预发行，不代表 25 款首发 Agent 全量发布放行。

发行完整性：
  node tools/verify-release.cjs --installed <安装目录>
  （按包内 RELEASE-MANIFEST.json 逐文件校验 sha256；下载侧校验见发布页 sha256 / 接入提示词）

installer/ 内是一键脚本（setup.ps1 = Windows，setup.sh = macOS/Linux），
miniproctor-doctor.sh 是只读体检脚本。
安全：config.json / data/ 含本机身份，勿分享。请求经 ed25519 签名，服务器只存公钥。
