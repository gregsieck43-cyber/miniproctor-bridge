miniproctor bridge 发行包
==========================
要求：Node.js >= 22（bridge 语音识别另需 setup-asr 下载模型，本包不含）。

安装：
  1. node tools/setup-wizard.cjs   # 交互式配置（endpoint 模式无需任何密钥）
  2. node src/main.js doctor       # 自检
  3. node src/main.js pair         # 生成 6 位配对码，到小程序输入完成绑定
  4. node src/main.js run          # 启动（可另配语音识别：node tools/setup-asr.cjs）

安全：config.json / data/ 含本机身份，勿分享。请求经 ed25519 签名，服务器只存公钥。
