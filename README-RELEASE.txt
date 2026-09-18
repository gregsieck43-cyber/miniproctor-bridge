miniproctor bridge 发行包
==========================
要求：Node.js >= 22（建议 v24；bridge 语音识别另需 node tools/setup-asr.cjs 下载模型，本包不含）。

包结构：扁平——package.json / src/ / tools/ 直接位于解压目录根部。
安全边界：本包不含 config.json、device.json、data/、.env、node_modules
（设备身份与配置永不随包分发；升级安装会原样保留它们）。

一键安装（推荐；自动定位包内容，默认装到用户主目录 miniproctor-bridge）：
  Windows PowerShell：powershell -NoProfile -ExecutionPolicy Bypass -File installer\setup.ps1
  macOS / Linux / Git Bash：sh installer/setup.sh
  升级保护：目标已有的 config.json / device.json / data/（outbox/inbox）一律保留，
  config.json 仅补齐缺失字段。

手动安装（也可解压到任意目录后逐步执行）：
  1. node tools/setup-wizard.cjs   # 交互式配置（endpoint 模式无需任何密钥）
  2. node src/main.js doctor       # 自检
  3. node src/main.js pair         # 生成 6 位配对码，到小程序输入完成绑定
  4. node src/main.js run          # 启动（可另配语音识别：node tools/setup-asr.cjs）

发行完整性：
  node tools/verify-release.cjs --installed <安装目录>
  （按包内 RELEASE-MANIFEST.json 逐文件校验 sha256；下载侧校验见发布页 sha256 / 接入提示词）

installer/ 内是一键脚本（setup.ps1 = Windows，setup.sh = macOS/Linux），
miniproctor-doctor.sh 是只读体检脚本。
安全：config.json / data/ 含本机身份，勿分享。请求经 ed25519 签名，服务器只存公钥。
