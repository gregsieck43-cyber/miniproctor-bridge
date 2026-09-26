#!/usr/bin/env node
/**
 * make-release：打 bridge 发行 zip + sha256 + manifest + 「Agent 自装」用户提示词。
 *
 * 产物（xcx/.tmp/release/，git 忽略）：
 *   - miniproctor-bridge-vX.Y.Z.zip        （扁平结构：package.json/src/tools 直接在 zip 根，
 *                                           不含密钥/数据/模型/node_modules/config.json/device.json）
 *   - miniproctor-bridge-vX.Y.Z.zip.sha256 （下载校验用 sidecar）
 *   - manifest.json                        （构建侧全量清单：zip sha256 + 逐文件 sha256 + 版本 + 构建时间 + 源 commit；
 *                                           verify-release.cjs 的 zip 模式以此为准）
 *   - agent-prompt.txt                     （整段提示词：与小程序端 services/agent-prompt.js 同源生成）
 *
 * 包内还会写入 RELEASE-MANIFEST.json（逐文件 sha256，不含自身）：
 *   安装脚本据此对「安装后的文件」做完整性校验（node tools/verify-release.cjs --installed <dir>）。
 *
 * 用法：node bridge/tools/make-release.cjs [--version 0.5.0] [--url <zip直链> ...] [--out-dir <目录>]
 *   --url 可给多条（主链接+镜像），未给时按 GitHub release 规范式自动生成。
 *   --out-dir 改变产物目录（缺省 xcx/.tmp/release/）；scripts/ci.mjs --release 门禁
 *   用它把「门禁验证构建」隔离到 xcx/.tmp/release-gate/，不触碰正式发布产物目录。
 *
 * 跨平台要点：
 *   - 打包用 bsdtar（Windows 10 1803+ 自带 / macOS 自带；Linux 的 GNU tar 不能写 zip，
 *     需 libarchive-tools 的 bsdtar）。PS 5.1 Compress-Archive 产出的反斜杠条目 zip 在
 *     macOS/Linux 会解出一批带 `\` 的扁平文件（v0.4.2 实测损坏），禁止回退。
 *   - zip 条目一律正斜杠、扁平结构（TASK-021/E20：安装脚本按 package.json 所在目录定位，
 *     兼容「bridge/」子目录布局）。
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..', '..'); // xcx/
const bridgeDir = path.join(root, 'bridge');
const installerDir = path.join(root, 'installer');
const DEFAULT_OUT_DIR = path.join(root, '.tmp', 'release');
const REPO = 'gregsieck43-cyber/miniproctor-bridge';
const IN_PACKAGE_MANIFEST = 'RELEASE-MANIFEST.json';
// zip 条目固定 mtime（2020-01-01T00:00:00Z）：同一内容构建出逐字节相同的 zip，sha256 可回填收敛
const FIXED_MTIME_MS = 1577836800000;

function args(argv) {
  const out = { urls: [] };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--version') out.version = argv[++i];
    if (argv[i] === '--url') out.urls.push(argv[++i]);
    if (argv[i] === '--out-dir') out.outDir = argv[++i];
  }
  return out;
}

function sha256File(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

function sha256Buf(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/** 源 commit（只读 rev-parse；失败时 unknown，不阻断构建）。 */
function gitCommit() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

/** 递归收集待打包文件（排除密钥/数据/模型/临时物/点文件/本机日志）。rel 一律正斜杠。 */
function collectFiles(dir, base = '') {
  const EXCLUDE_DIR = new Set(['node_modules', 'data', 'asr', '.tmp', 'test', 'dist']);
  const EXCLUDE_FILE = new Set([
    'config.json', 'device.json', 'package-lock.json',
    'pair.log', 'run.log', 'audit.log', IN_PACKAGE_MANIFEST,
  ]);
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue; // .tmp-*.mjs 等调试残留不进发行包
    if (entry.isDirectory()) {
      if (!EXCLUDE_DIR.has(entry.name)) out.push(...collectFiles(path.join(dir, entry.name), base ? `${base}/${entry.name}` : entry.name));
    } else if (!EXCLUDE_FILE.has(entry.name)) {
      out.push({ abs: path.join(dir, entry.name), rel: base ? `${base}/${entry.name}` : entry.name });
    }
  }
  return out;
}

/** 遍历 staging 目录，产出逐文件 {path, sha256, bytes}（path 正斜杠）。 */
function walkStaged(staging) {
  const out = [];
  const walk = (dir, base = '') => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = base ? `${base}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path.join(dir, entry.name), rel);
      else {
        const buf = fs.readFileSync(path.join(dir, entry.name));
        out.push({ path: rel, sha256: sha256Buf(buf), bytes: buf.length });
      }
    }
  };
  walk(staging);
  return out;
}

const RELEASE_README = `miniproctor bridge 发行包
==========================
要求：Node.js >= 22（建议 v24；bridge 语音识别另需 node tools/setup-asr.cjs 下载模型，本包不含）。

包结构：扁平——package.json / src/ / tools/ 直接位于解压目录根部。
安全边界：本包不含 config.json、device.json、data/、.env、node_modules
（设备身份与配置永不随包分发；升级安装会原样保留它们）。

一键安装（推荐；自动定位包内容，默认装到用户主目录 miniproctor-bridge）：
  Windows PowerShell：powershell -NoProfile -ExecutionPolicy Bypass -File installer\\setup.ps1
  macOS / Linux / Git Bash：sh installer/setup.sh
  升级保护（原子升级）：先建暂存目录并按 RELEASE-MANIFEST.json 校验完整性，通过才切换；
  目标已有的 config.json / device.json / data/（outbox/inbox）一律保留，config.json 仅补齐缺失字段；
  切换时旧目录整体改名 <安装目录>.old-<时间戳>（完整配置/数据备份，可改名回去回滚），
  切换失败自动还原，旧版照常可运行；检测到 bridge 正在运行（data/bridge.lock）会提示
  先等待任务结束或明确停止任务，不能偷偷中断。

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
`;

function makeZip(files, zipPath, meta, outDir = DEFAULT_OUT_DIR) {
  const staging = path.join(outDir, 'staging');
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  for (const f of files) {
    const dest = path.join(staging, ...f.rel.split('/'));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(f.abs, dest);
  }
  // installer 一并进包（posix 用户没有 setup.sh 就只能裸敲 node 命令）
  if (fs.existsSync(installerDir)) {
    fs.cpSync(installerDir, path.join(staging, 'installer'), { recursive: true });
  }
  fs.writeFileSync(path.join(staging, 'README-RELEASE.txt'), RELEASE_README.replace('{version}', meta.version), 'utf8');

  // 包内清单：先按当前 staging 计算逐文件哈希（此时还没有 RELEASE-MANIFEST.json，
  // 其自身因此天然不在清单内），写包内清单，再全量重算供构建侧 manifest 使用。
  // 包内清单刻意不含构建时间——配合固定 mtime，同一 commit 的构建逐字节可复现，
  // 这样 config.js 回填 sha256 后重建不会漂移。
  const packageFiles = walkStaged(staging);
  fs.writeFileSync(path.join(staging, IN_PACKAGE_MANIFEST), `${JSON.stringify({
    manifest_version: 1,
    package: 'miniproctor-bridge',
    version: meta.version,
    commit: meta.commit,
    files: packageFiles,
  }, null, 2)}\n`, 'utf8');
  const allFiles = walkStaged(staging);

  // 固定全部条目 mtime：zip 字节级可复现（sha256 只取决于内容，不取决于构建时刻）
  const fixed = new Date(FIXED_MTIME_MS);
  const fixMtimes = (dir) => {
    fs.utimesSync(dir, fixed, fixed);
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) fixMtimes(p);
      else fs.utimesSync(p, fixed, fixed);
    }
  };
  fixMtimes(staging);
  // Windows：bsdtar 的 zip UT 扩展字段还包含 ctime（创建时间），utimesSync 改不了——
  // 用 PowerShell 把 CreationTimeUtc 一并固定，否则同一内容两次构建 sha256 漂移。
  if (process.platform === 'win32') {
    execFileSync('powershell.exe', [
      '-NoProfile', '-Command',
      `$d='${staging.replace(/'/g, "''")}'; (Get-Item -LiteralPath $d -Force).CreationTimeUtc='2020-01-01T00:00:00Z'; Get-ChildItem -LiteralPath $d -Recurse -Force | ForEach-Object { $_.CreationTimeUtc='2020-01-01T00:00:00Z' }`,
    ], { stdio: 'ignore' });
  }

  fs.rmSync(zipPath, { force: true });
  // bsdtar -a 按扩展名产 zip：条目正斜杠；显式列出全部"文件"条目（扁平结构，无包装目录）。
  // 刻意不写目录条目：tar 遍历会触碰目录 atime/ctime，导致同一内容两次构建 zip 字节漂移；
  // 解压器（tar/unzip/Expand-Archive）都会按文件路径隐式创建父目录，功能不受影响。
  const tarBin = process.platform === 'win32' ? 'C:\\Windows\\System32\\tar.exe' : 'tar';
  const filePaths = [];
  const listFiles = (dir, base = '') => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = base ? `${base}/${entry.name}` : entry.name;
      if (entry.isDirectory()) listFiles(path.join(dir, entry.name), rel);
      else filePaths.push(rel);
    }
  };
  listFiles(staging);
  try {
    execFileSync(tarBin, ['-a', '-cf', zipPath, '-C', staging, ...filePaths], { stdio: 'inherit' });
  } catch (e) {
    throw new Error(`打 zip 失败（需要 bsdtar：Windows/macOS 自带；Linux 请安装 libarchive-tools）：${e.message}`);
  }
  fs.rmSync(staging, { recursive: true, force: true });
  return allFiles;
}

/**
 * 提示词与小程序端同源：清掉 require 缓存后覆写 config.BRIDGE_RELEASE（仅内存），
 * 调用小程序端 services/agent-prompt.js 的共用生成器。
 * 同源验证：连续两次独立加载并生成，逐字节一致才通过（防止生成器读到外部可变状态/模板漂移）。
 */
function makePrompt(version, zipName, sha256, urls) {
  const configPath = path.join(root, 'miniprogram', 'config.js');
  const promptModulePath = path.join(root, 'miniprogram', 'services', 'agent-prompt.js');
  const tag = `v${version}`;
  const canonical = `https://github.com/${REPO}/releases/download/${tag}/${zipName}`;
  const release = {
    version: tag,
    zip: zipName,
    sha256,
    urls: urls.length ? urls : [canonical, `https://ghfast.top/${canonical}`, `https://ghproxy.net/${canonical}`],
  };

  const generate = () => {
    delete require.cache[configPath];
    delete require.cache[promptModulePath];
    const mpConfig = require(configPath);
    const original = mpConfig.BRIDGE_RELEASE;
    const staleVersion = original && original.version !== tag;
    mpConfig.BRIDGE_RELEASE = release;
    const { buildFullSetupPrompt } = require(promptModulePath);
    const text = buildFullSetupPrompt();
    mpConfig.BRIDGE_RELEASE = original;
    return { text, staleVersion, configVersion: original ? original.version : null };
  };

  const first = generate();
  const second = generate();
  if (first.text !== second.text) {
    throw new Error('同源提示词两次生成结果不一致（生成器含非确定逻辑），构建失败。');
  }
  // 逐项断言：提示词必须内嵌本次发行的全部事实（防模板与数据漂移）
  const mustContain = [release.zip, release.sha256, release.version, ...release.urls];
  for (const s of mustContain) {
    if (!first.text.includes(s)) throw new Error(`同源提示词缺少发行事实「${s}」，构建失败。`);
  }
  if (first.staleVersion) {
    console.warn(`[make-release] 警告：miniprogram/config.js 的 BRIDGE_RELEASE.version=${first.configVersion} 与本次构建 ${tag} 不一致。`);
    console.warn('[make-release] 请把新构建的 sha256/urls 同步回 config.js 后再次构建，保证小程序端提示词与发行包一致。');
  }
  return first.text;
}

async function main() {
  const opts = args(process.argv.slice(2));
  const pkg = JSON.parse(fs.readFileSync(path.join(bridgeDir, 'package.json'), 'utf8'));
  const version = opts.version || pkg.version || '0.0.0';
  const outDir = opts.outDir ? path.resolve(opts.outDir) : DEFAULT_OUT_DIR;
  fs.mkdirSync(outDir, { recursive: true });

  const zipName = `miniproctor-bridge-v${version}.zip`;
  const zipPath = path.join(outDir, zipName);
  const files = collectFiles(bridgeDir);
  const meta = { version, buildTime: new Date().toISOString(), commit: gitCommit() };
  console.log(`[make-release] 打包 ${files.length} 个文件 + installer → ${zipName}（commit ${meta.commit.slice(0, 12)}，产物目录 ${outDir}）`);
  const allFiles = makeZip(files, zipPath, meta, outDir);

  const sha256 = sha256File(zipPath);
  const shaPath = `${zipPath}.sha256`;
  fs.writeFileSync(shaPath, `${sha256}  ${zipName}\n`, 'utf8');

  const manifest = {
    manifest_version: 1,
    package: 'miniproctor-bridge',
    version,
    buildTime: meta.buildTime,
    commit: meta.commit,
    zip: { name: zipName, sha256, bytes: fs.statSync(zipPath).size },
    files: allFiles,
  };
  const manifestPath = path.join(outDir, 'manifest.json');
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  const promptPath = path.join(outDir, 'agent-prompt.txt');
  fs.writeFileSync(promptPath, makePrompt(version, zipName, sha256, opts.urls), 'utf8');

  console.log(`[make-release] zip: ${zipPath}`);
  console.log(`[make-release] sha256: ${sha256}`);
  console.log(`[make-release] manifest: ${manifestPath}（${allFiles.length} 个文件）`);
  console.log(`[make-release] 提示词: ${promptPath}（与小程序端 services/agent-prompt.js 同源，三平台口径）`);
}

if (require.main === module) {
  main().catch((e) => { console.error('[make-release] 失败：', e.message); process.exitCode = 1; });
}

module.exports = { collectFiles, walkStaged, makePrompt, makeZip, args, IN_PACKAGE_MANIFEST };
