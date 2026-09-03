#!/usr/bin/env node
/**
 * setup-asr：为 bridge 下载本地语音识别（ASR）离线模型资产。
 *
 * 架构：bridge 通过 npm 包 sherpa-onnx（+ 平台二进制 sherpa-onnx-win-x64 等）
 * 进程内跑 SenseVoice-Small int8 推理，识别在用户电脑本机完成——
 * 运行期零联网、零 API 费用、无密钥。npm 依赖装法见 docs/免费语音识别方案.md。
 *
 * 本脚本只负责下载 npm 注册表拿不到的两件大资产到 bridge/asr/：
 *   - model.int8.onnx   SenseVoice-Small int8 模型（中英日韩粤，239MB）
 *   - tokens.txt        模型词表
 *
 * 下载源：hf-mirror.com（HuggingFace 国内镜像，实测可跑满带宽；
 * GitHub 直连本机实测仅 ~5KB/s 不可用）。8MB 分块 Range 请求断点续传，
 * 单块重试 5 次。完成后整体校验 sha256（HF 仓库 LFS oid）。
 * 零外部依赖：Node 18+（全局 fetch）。
 *
 * 用法：node tools/setup-asr.cjs [--dest ./asr]
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const HF_REPO = 'csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17';

const ASSETS = [
  {
    name: 'model.int8.onnx',
    size: 239233841,
    sha256: 'c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51',
    url: `https://hf-mirror.com/${HF_REPO}/resolve/main/model.int8.onnx`,
  },
  {
    name: 'tokens.txt',
    size: 315894,
    url: `https://hf-mirror.com/${HF_REPO}/resolve/main/tokens.txt`,
  },
];

const CHUNK = 8 * 1024 * 1024;
const MAX_RETRY = 5;

function fileSize(p) {
  try { return fs.statSync(p).size; } catch { return 0; }
}

function sha256File(p) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const s = fs.createReadStream(p);
    s.on('data', (d) => h.update(d));
    s.on('end', () => resolve(h.digest('hex')));
    s.on('error', reject);
  });
}

function mb(n) { return (n / 1024 / 1024).toFixed(1); }

async function fetchRange(url, start, end) {
  const res = await fetch(url, { headers: { Range: `bytes=${start}-${end}` }, signal: AbortSignal.timeout(120000) });
  if (!res.ok) throw new Error(`http ${res.status}`);
  if (start > 0 && res.status !== 206) throw new Error('range-unsupported');
  return Buffer.from(await res.arrayBuffer());
}

async function downloadAsset(destDir, asset) {
  const dest = path.join(destDir, asset.name);
  let done = fileSize(dest);
  if (done > asset.size) { fs.rmSync(dest); done = 0; } // 大小超限视为损坏，重下
  if (done === asset.size) {
    if (asset.sha256) {
      const got = await sha256File(dest);
      if (got === asset.sha256) { console.log(`[ok] ${asset.name} 已存在且校验通过，跳过`); return; }
      console.log(`[!] ${asset.name} sha256 不符，重新下载`);
      fs.rmSync(dest); done = 0;
    } else {
      console.log(`[ok] ${asset.name} 已存在，跳过`);
      return;
    }
  }

  while (done < asset.size) {
    const end = Math.min(done + CHUNK, asset.size) - 1;
    let buf = null;
    let lastErr = null;
    for (let retry = 0; retry < MAX_RETRY && !buf; retry += 1) {
      try {
        buf = await fetchRange(asset.url, done, end);
      } catch (err) {
        lastErr = err;
        console.log(`[retry ${retry + 1}] ${asset.name} @${mb(done)}MB: ${err.message}`);
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
    if (!buf) throw new Error(`${asset.name} 下载失败（${lastErr && lastErr.message}），请稍后重跑本脚本续传`);
    fs.appendFileSync(dest, buf);
    done += buf.length;
    console.log(`[..] ${asset.name} ${mb(done)}/${mb(asset.size)} MB`);
  }

  if (done !== asset.size) throw new Error(`${asset.name} 大小异常：${done} != ${asset.size}`);
  if (asset.sha256) {
    const got = await sha256File(dest);
    if (got !== asset.sha256) throw new Error(`${asset.name} sha256 校验失败（got ${got}），请删除后重跑`);
    console.log(`[ok] ${asset.name} 下载完成，sha256 校验通过`);
  } else {
    console.log(`[ok] ${asset.name} 下载完成`);
  }
}

async function main(argv) {
  const destIdx = argv.indexOf('--dest');
  const destDir = path.resolve(__dirname, '..', destIdx >= 0 ? argv[destIdx + 1] : 'asr');
  fs.mkdirSync(destDir, { recursive: true });
  console.log(`[setup-asr] 目标目录：${destDir}`);
  for (const asset of ASSETS) await downloadAsset(destDir, asset);
  console.log('[setup-asr] 模型资产就绪。语音识别将在本机离线完成，不产生任何 API 费用。');
}

main(process.argv.slice(2)).catch((err) => {
  console.error('[setup-asr] 失败：', err.message);
  process.exitCode = 1;
});
