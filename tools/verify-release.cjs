#!/usr/bin/env node
/**
 * verify-release：发行包完整性校验（零依赖本地工具，随包分发）。
 *
 * 模式一（构建/发布侧，对 zip 整体）：
 *   node bridge/tools/verify-release.cjs <zip> [--manifest <manifest.json>]
 *   校验项：
 *     1) zip 文件 sha256 与 manifest.zip.sha256 一致；
 *     2) 全部条目名为正斜杠、无路径穿越（../）、无绝对路径；
 *     3) 禁止物断言：config.json / device.json / .env / node_modules / data/ / asr/ / .tmp/ /
 *        任意点文件（.env、.tmp-* 调试残留等隐藏条目）/ 根级 *.log 一律不得出现；
 *     4) zip 内文件集合与 manifest.files 完全一致（无缺失、无多余）；
 *     5) 解压后逐文件 sha256 + 字节数与 manifest 一致。
 *   manifest 缺省取 zip 同目录的 manifest.json（make-release 构建产物）。
 *
 * 模式二（安装侧，对已安装目录）：
 *   node tools/verify-release.cjs --installed <安装目录>
 *   按包内 RELEASE-MANIFEST.json 逐文件校验发行文件 sha256+字节数；
 *   安装后新增的 config.json / data/（outbox/inbox/device.json）属用户数据，不参与比对、绝不报错。
 *
 * 退出码：0 = 全部通过；1 = 任一校验失败（调用方应中止并提示重新下载/安装）。
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const FORBIDDEN_BASENAMES = new Set(['config.json', 'device.json', '.env']);
// asr/（本机语音模型）、.tmp/（构建/调试残留）与 make-release collectFiles 的排除目录对齐（CLOSE-015）
const FORBIDDEN_SEGMENTS = new Set(['node_modules', 'data', 'asr', '.tmp']);

function sha256File(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

/**
 * 纯函数：检查 zip 条目名（make-release/测试共用）。
 * 返回问题列表；空数组 = 通过。
 */
function checkZipEntryNames(names) {
  const problems = [];
  for (const raw of names) {
    const name = String(raw).replace(/^\.\//, '');
    if (!name) continue;
    if (name.endsWith('/')) continue; // 目录条目
    if (name.includes('\\')) problems.push(`条目含反斜杠（会在 POSIX 解出畸形文件名）：${name}`);
    if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) problems.push(`条目为绝对路径：${name}`);
    const parts = name.split('/');
    if (parts.includes('..')) problems.push(`条目含路径穿越（..）：${name}`);
    if (parts.some((seg) => seg.startsWith('.'))) problems.push(`点文件/隐藏条目不得打包（.env/.tmp-* 等调试残留）：${name}`);
    if (FORBIDDEN_BASENAMES.has(parts[parts.length - 1])) problems.push(`禁止打包的本机文件出现在包内：${name}`);
    if (parts.some((seg) => FORBIDDEN_SEGMENTS.has(seg))) problems.push(`禁止打包的目录出现在包内：${name}`);
    if (parts.length === 1 && /\.log$/i.test(name)) problems.push(`禁止打包的本机日志出现在包内：${name}`);
  }
  return problems;
}

/** 纯函数：zip 文件集合 vs manifest 文件集合。返回问题列表。 */
function compareFileSets(expectedPaths, actualPaths) {
  const expected = new Set(expectedPaths);
  const actual = new Set(actualPaths);
  const problems = [];
  for (const p of expected) if (!actual.has(p)) problems.push(`包内缺失 manifest 声明的文件：${p}`);
  for (const p of actual) if (!expected.has(p)) problems.push(`包内出现 manifest 未声明的文件：${p}`);
  return problems;
}

/** 列出 zip 条目名（bsdtar 优先；Linux GNU tar 读不了 zip 时回退 unzip）。 */
function listZipEntries(zipPath) {
  const isWin = process.platform === 'win32';
  try {
    const tarBin = isWin ? 'C:\\Windows\\System32\\tar.exe' : 'tar';
    return execFileSync(tarBin, ['-tf', zipPath], { encoding: 'utf8' }).split(/\r?\n/).filter(Boolean);
  } catch (tarErr) {
    try {
      return execFileSync('unzip', ['-Z1', zipPath], { encoding: 'utf8' }).split(/\r?\n/).filter(Boolean);
    } catch {
      throw new Error(`无法列出 zip 条目（需要 bsdtar 或 unzip）：${tarErr.message}`);
    }
  }
}

function extractZip(zipPath, destDir) {
  const isWin = process.platform === 'win32';
  try {
    const tarBin = isWin ? 'C:\\Windows\\System32\\tar.exe' : 'tar';
    execFileSync(tarBin, ['-xf', zipPath, '-C', destDir], { stdio: 'ignore' });
    return;
  } catch (tarErr) {
    try {
      execFileSync('unzip', ['-o', '-q', zipPath, '-d', destDir], { stdio: 'ignore' });
    } catch {
      throw new Error(`无法解压 zip（需要 bsdtar 或 unzip）：${tarErr.message}`);
    }
  }
}

/** zip 模式主流程。返回 {ok, problems, checked}。 */
function verifyZip(zipPath, manifestPath) {
  const problems = [];
  if (!fs.existsSync(zipPath)) throw new Error(`zip 不存在：${zipPath}`);
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`manifest 不存在：${manifestPath}（make-release 构建产物 manifest.json 与 zip 同目录生成）`);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (!manifest.zip || !Array.isArray(manifest.files)) throw new Error(`manifest 结构无效：${manifestPath}`);

  const zipSha = sha256File(zipPath);
  if (zipSha !== manifest.zip.sha256) {
    problems.push(`zip sha256 不符：实际 ${zipSha}，manifest 声明 ${manifest.zip.sha256}——绝不要安装这个包，重新下载。`);
  }

  const entries = listZipEntries(zipPath);
  problems.push(...checkZipEntryNames(entries));
  const entryFiles = entries
    .map((n) => String(n).replace(/^\.\//, ''))
    .filter((n) => n && !n.endsWith('/'));

  problems.push(...compareFileSets(manifest.files.map((f) => f.path), entryFiles));

  // 解压逐文件校验（zip 已损坏无法解压时，作为校验失败报告而非崩溃）
  const tmp = fs.mkdtempSync(path.join(path.dirname(path.resolve(zipPath)), 'verify-tmp-'));
  let extractOk = false;
  try {
    try {
      extractZip(zipPath, tmp);
      extractOk = true;
    } catch (e) {
      problems.push(`zip 无法解压（文件损坏或被篡改）：${e.message.split('\n')[0]}`);
    }
    if (extractOk) {
      for (const f of manifest.files) {
        const abs = path.join(tmp, ...f.path.split('/'));
        if (!fs.existsSync(abs)) {
          problems.push(`解压后缺失：${f.path}`);
          continue;
        }
        const buf = fs.readFileSync(abs);
        if (buf.length !== f.bytes) problems.push(`字节数不符：${f.path}（实际 ${buf.length}，声明 ${f.bytes}）`);
        const got = crypto.createHash('sha256').update(buf).digest('hex');
        if (got !== f.sha256) problems.push(`sha256 不符：${f.path}（实际 ${got}，声明 ${f.sha256}）`);
      }
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  return { ok: problems.length === 0, problems, checked: manifest.files.length, version: manifest.version };
}

/** 安装模式：按 <dir>/RELEASE-MANIFEST.json 校验发行文件。用户数据（config.json/data/ 等）不比对。 */
function verifyInstalled(dir) {
  const manifestPath = path.join(dir, 'RELEASE-MANIFEST.json');
  if (!fs.existsSync(manifestPath)) {
    return { ok: false, problems: [`未找到 ${manifestPath}（源码树安装无此文件，跳过校验即可；发行包安装应包含它）`], checked: 0 };
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (!Array.isArray(manifest.files)) return { ok: false, problems: ['RELEASE-MANIFEST.json 结构无效（缺 files）'], checked: 0 };
  const problems = [];
  for (const f of manifest.files) {
    const abs = path.join(dir, ...f.path.split('/'));
    if (!fs.existsSync(abs)) {
      problems.push(`发行文件缺失：${f.path}`);
      continue;
    }
    const buf = fs.readFileSync(abs);
    if (buf.length !== f.bytes) problems.push(`字节数不符：${f.path}（实际 ${buf.length}，声明 ${f.bytes}）`);
    const got = crypto.createHash('sha256').update(buf).digest('hex');
    if (got !== f.sha256) problems.push(`sha256 不符：${f.path}（实际 ${got}，声明 ${f.sha256}）`);
  }
  return { ok: problems.length === 0, problems, checked: manifest.files.length, version: manifest.version };
}

function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === '--installed') {
    if (!argv[1]) {
      console.error('用法：node tools/verify-release.cjs --installed <安装目录>');
      process.exit(1);
    }
    const r = verifyInstalled(argv[1]);
    if (r.ok) {
      console.log(`[verify-release] 安装完整性：通过（${r.checked} 个发行文件 sha256 全部一致${r.version ? `，版本 ${r.version}` : ''}）`);
    } else {
      console.error('[verify-release] 安装完整性：失败——绝不使用不完整的安装。请重新下载 zip 并重试。');
      for (const p of r.problems) console.error(`  - ${p}`);
      process.exit(1);
    }
    return;
  }
  if (!argv[0] || argv[0].startsWith('--')) {
    console.error('用法：node bridge/tools/verify-release.cjs <zip> [--manifest <manifest.json>]');
    console.error('      node tools/verify-release.cjs --installed <安装目录>');
    process.exit(1);
  }
  const zipPath = argv[0];
  const manifestIdx = argv.indexOf('--manifest');
  const manifestPath = manifestIdx >= 0 ? argv[manifestIdx + 1] : path.join(path.dirname(path.resolve(zipPath)), 'manifest.json');
  try {
    const r = verifyZip(zipPath, manifestPath);
    console.log(`[verify-release] 目标：${zipPath}${r.version ? `（版本 ${r.version}）` : ''}`);
    if (r.ok) {
      console.log(`[verify-release] 通过：zip sha256 一致；${r.checked} 个文件逐一匹配 manifest；无禁止物（config.json/device.json/.env/data//asr//node_modules/点文件）。`);
    } else {
      console.error('[verify-release] 失败：');
      for (const p of r.problems) console.error(`  - ${p}`);
      process.exit(1);
    }
  } catch (e) {
    console.error(`[verify-release] 失败：${e.message}`);
    process.exit(1);
  }
}

if (require.main === module) main();

module.exports = { checkZipEntryNames, compareFileSets, verifyZip, verifyInstalled, FORBIDDEN_BASENAMES, FORBIDDEN_SEGMENTS };
