#!/usr/bin/env node
/**
 * make-release：打 bridge 发行 zip + sha256 + 生成「Agent 自装」用户提示词。
 *
 * 产物（xcx/.tmp/release/，git 忽略）：
 *   - miniproctor-bridge-vX.Y.Z.zip   （源码+安装器，不含密钥/数据/模型/node_modules）
 *   - miniproctor-bridge-vX.Y.Z.zip.sha256
 *   - agent-prompt.txt                （整段提示词：多镜像下载+sha256 校验+自装+配对）
 *
 * 用法：node bridge/tools/make-release.cjs [--version 0.4.0] [--url <zip直链> ...]
 *   --url 可给多条（主链接+镜像），未给时提示词留占位符由上传后回填。
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execSync } = require('node:child_process');

const root = path.resolve(__dirname, '..', '..'); // xcx/
const bridgeDir = path.join(root, 'bridge');
const outDir = path.join(root, '.tmp', 'release');

function args(argv) {
  const out = { urls: [] };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--version') out.version = argv[++i];
    if (argv[i] === '--url') out.urls.push(argv[++i]);
  }
  return out;
}

function sha256File(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

/** 递归收集待打包文件（排除密钥/数据/模型/临时物）。 */
function collectFiles(dir, base = '') {
  const EXCLUDE_DIR = new Set(['node_modules', 'data', 'asr', '.tmp', 'test', 'dist']);
  const EXCLUDE_FILE = new Set(['config.json', 'device.json', 'package-lock.json']);
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!EXCLUDE_DIR.has(entry.name)) out.push(...collectFiles(path.join(dir, entry.name), path.join(base, entry.name)));
    } else if (!EXCLUDE_FILE.has(entry.name)) {
      out.push({ abs: path.join(dir, entry.name), rel: path.join('miniproctor-bridge', base, entry.name) });
    }
  }
  return out;
}

function makeZip(files, zipPath) {
  // Windows 10+ 自带 tar 可产 zip；Git Bash 下用 powershell Compress-Archive 更稳。
  const staging = path.join(outDir, 'staging');
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  for (const f of files) {
    const dest = path.join(staging, f.rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(f.abs, dest);
  }
  // 写入发行说明，让拿到包的人/Agent 不猜
  fs.writeFileSync(path.join(staging, 'miniproctor-bridge', 'README-RELEASE.txt'), RELEASE_README, 'utf8');
  fs.rmSync(zipPath, { force: true });
  execSync(`powershell -NoProfile -Command "Compress-Archive -Path '${staging.replace(/\//g, '\\')}\\miniproctor-bridge' -DestinationPath '${zipPath.replace(/\//g, '\\')}' -Force"`, { stdio: 'inherit' });
  fs.rmSync(staging, { recursive: true, force: true });
}

const RELEASE_README = `miniproctor bridge 发行包
==========================
要求：Node.js >= 22（bridge 语音识别另需 setup-asr 下载模型，本包不含）。

安装：
  1. node tools/setup-wizard.cjs   # 交互式配置（endpoint 模式无需任何密钥）
  2. node src/main.js doctor       # 自检
  3. node src/main.js pair         # 生成 6 位配对码，到小程序输入完成绑定
  4. node src/main.js run          # 启动（可另配语音识别：node tools/setup-asr.cjs）

安全：config.json / data/ 含本机身份，勿分享。请求经 ed25519 签名，服务器只存公钥。
`;

function makePrompt(version, zipName, sha256, urls) {
  const urlsBlock = urls.length
    ? urls.map((u, i) => `   ${i + 1}. ${u}`).join('\n')
    : '   1. {{下载地址1：发布后回填}}\n   2. {{镜像地址2}}\n   3. {{镜像地址3}}';
  return `请帮我安装并启动 miniproctor bridge（小程序「智能体遥知」的电脑端，v${version}）。步骤：

1. 下载安装包（${zipName}）。按顺序尝试以下地址，成功一个即停：
${urlsBlock}
   下载后计算文件的 SHA256，必须等于 ${sha256}；不符则换下一个地址重试，全部不符则停止并告诉我。

2. 解压到 %USERPROFILE%\\miniproctor-bridge（不要放 C:\\Program Files）。

3. 在解压目录运行：node tools/setup-wizard.cjs
   配置向导选 endpoint 模式，接入地址填：{{小程序设置页展示的接入地址}}
   （endpoint 模式不需要任何密钥。）

4. 运行：node src/main.js doctor 自检，确认 Node 版本与网络连通。

5. 运行：node src/main.js pair 启动配对。终端会显示 6 位配对码，请原样告诉我，
   我会在手机小程序里输入完成绑定。配对完成后保持窗口运行。

6. 绑定成功后运行：node src/main.js run 保持在线。

注意：不要把 config.json 或 data/ 目录内容发到任何地方；网络失败先重试下一个下载地址。`;
}

async function main() {
  const opts = args(process.argv.slice(2));
  const pkg = JSON.parse(fs.readFileSync(path.join(bridgeDir, 'package.json'), 'utf8'));
  const version = opts.version || pkg.version || '0.0.0';
  fs.mkdirSync(outDir, { recursive: true });

  const zipName = `miniproctor-bridge-v${version}.zip`;
  const zipPath = path.join(outDir, zipName);
  const files = collectFiles(bridgeDir);
  console.log(`[make-release] 打包 ${files.length} 个文件 → ${zipName}`);
  makeZip(files, zipPath);

  const sha256 = sha256File(zipPath);
  const shaPath = `${zipPath}.sha256`;
  fs.writeFileSync(shaPath, `${sha256}  ${zipName}\n`, 'utf8');

  const promptPath = path.join(outDir, 'agent-prompt.txt');
  fs.writeFileSync(promptPath, makePrompt(version, zipName, sha256, opts.urls), 'utf8');

  console.log(`[make-release] zip: ${zipPath}`);
  console.log(`[make-release] sha256: ${sha256}`);
  console.log(`[make-release] 提示词: ${promptPath}（--url 未传时含占位符，上传后重跑可回填）`);
}

main().catch((e) => { console.error('[make-release] 失败：', e.message); process.exitCode = 1; });
