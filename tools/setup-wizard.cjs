#!/usr/bin/env node
/**
 * miniproctor 一键配置向导（交互式）：node tools/setup-wizard.cjs
 *
 * 两种模式：
 *   1) endpoint（推荐，公开运营默认）：填云函数 HTTP 访问服务基础 URL（形如
 *      https://<envId>-<suffix>.<region>.app.tcloudbase.com），无需 AppSecret——bridge 用
 *      设备私钥对每个请求做 ed25519 签名，云端按绑定公钥验签。
 *   2) cloud（开发者自用调试）：填 AppID/AppSecret/envId，经微信 API 网关调云函数。
 * 生成 bridge/config.json（.gitignore 保护，永不入库）。
 *
 * 升级保护（TASK-021/E23）：
 *   - 已存在 config.json 时默认只补齐缺失字段，不覆盖任何已有值；完全重写需显式选择 O。
 *   - 任何模式下都不触碰 data/（outbox/inbox/device.json）。
 * 非交互补齐模式：node tools/setup-wizard.cjs --fill-missing（安装脚本调用，无提问）。
 */
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

const root = path.resolve(__dirname, '..');
const target = path.join(root, 'config.json');
const examplePath = path.join(root, 'config.example.json');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q, def = '') => new Promise((res) => rl.question(`${q}${def ? `（回车=默认 ${def}）` : ''}: `, (a) => res(a.trim() || def)));

/** 深度补齐：只把 donor 中 existing 缺失的键加进去，绝不改写已有值。返回新增键路径列表。 */
function fillMissingKeys(existing, donor, prefix = '', added = []) {
  for (const key of Object.keys(donor)) {
    const p = prefix ? `${prefix}.${key}` : key;
    if (!(key in existing)) {
      existing[key] = donor[key];
      added.push(p);
    } else if (
      existing[key] && donor[key]
      && typeof existing[key] === 'object' && typeof donor[key] === 'object'
      && !Array.isArray(existing[key]) && !Array.isArray(donor[key])
    ) {
      fillMissingKeys(existing[key], donor[key], p, added);
    }
  }
  return added;
}

/** 非交互补齐：config.json 已有→只补缺失字段；没有→写默认模板。 */
function fillMissingMode() {
  const example = fs.existsSync(examplePath) ? JSON.parse(fs.readFileSync(examplePath, 'utf8')) : {};
  if (!fs.existsSync(target)) {
    fs.writeFileSync(target, `${JSON.stringify(example, null, 2)}\n`, 'utf8');
    console.log(`已写入 ${target}（默认模板）`);
    return;
  }
  const cur = JSON.parse(fs.readFileSync(target, 'utf8'));
  const added = fillMissingKeys(cur, structuredClone(example));
  if (added.length > 0) {
    fs.writeFileSync(target, `${JSON.stringify(cur, null, 2)}\n`, 'utf8');
    console.log(`已写入 ${target}（升级保护：保留原有值，仅补齐缺失字段 ${added.length} 个：${added.join(', ')}）`);
  } else {
    console.log(`已确认 ${target}（升级保护：配置完整，未做任何修改）`);
  }
}

(async () => {
  // 安装脚本的静默补齐通道
  if (process.argv.slice(2).includes('--fill-missing')) {
    fillMissingMode();
    rl.close();
    return;
  }

  console.log('== miniproctor bridge 配置向导 ==\n');

  // 升级保护：绝不静默覆盖已有 config.json / device.json / data/
  let preserve = false;
  if (fs.existsSync(target)) {
    console.log('检测到已有 config.json —— 升级保护：默认只补齐缺失字段，不会覆盖你已有的任何设置，也不会触碰 data/（outbox/inbox/device.json）。');
    const choice = (await ask('选择 U=仅补齐缺失字段（默认）/ O=完全重写（会丢弃旧值，请谨慎）/ Q=退出', 'U')).toUpperCase();
    if (choice === 'Q') { console.log('已退出，未做任何修改。'); rl.close(); return; }
    if (choice !== 'O') { fillMissingMode(); rl.close(); return; }
    preserve = false; // 显式选择完全重写
  }

  console.log('模式说明：');
  console.log('  endpoint = 推荐。只需小程序里展示的接入地址，无需任何密钥；请求以设备私钥签名，云端验签。');
  console.log('  cloud    = 开发者自用。需要 AppID/AppSecret（mp.weixin.qq.com → 开发管理 → 开发设置 生成）。\n');
  const mode = (await ask('连接模式 endpoint/cloud', 'endpoint')).toLowerCase();
  const example = fs.existsSync(examplePath) ? JSON.parse(fs.readFileSync(examplePath, 'utf8')) : {};
  const cfg = preserve ? JSON.parse(fs.readFileSync(target, 'utf8')) : structuredClone(example);

  if (mode === 'endpoint') {
    const baseUrl = await ask('云函数接入地址', 'https://cloud1-d9gmxxh3t0958f4a4-1478470112.ap-shanghai.app.tcloudbase.com');
    if (!/^https:\/\/.+/.test(baseUrl)) { console.error('接入地址必须是 https:// 开头'); process.exit(1); }
    const endpointRelay = { kind: 'endpoint', baseUrl: '', timeoutMs: 10000, endpoints: { baseUrl } };
    if (preserve) {
      fillMissingKeys(cfg, { relay: endpointRelay });
    } else {
      cfg.wechat = { appid: example.wechat ? example.wechat.appid : '', secret: '', envId: '' };
      cfg.relay = endpointRelay;
    }
  } else if (mode === 'cloud') {
    console.log('AppSecret 获取：mp.weixin.qq.com 登录 → 开发 → 开发管理 → 开发设置 → AppSecret「生成/重置」（管理员扫码）。');
    console.log('注意：重置会使旧 secret 失效；此文件不会提交 git。');
    const appid = await ask('AppID', example.wechat ? example.wechat.appid : '');
    const secret = await ask('AppSecret');
    const envId = await ask('云环境 envId', 'cloud1-d9gmxxh3t0958f4a4');
    if (!secret) { console.error('AppSecret 不能为空'); process.exit(1); }
    const cloudRelay = { kind: 'cloud', baseUrl: '', timeoutMs: 5000 };
    if (preserve) {
      fillMissingKeys(cfg, { relay: cloudRelay, wechat: { appid, secret, envId } });
    } else {
      cfg.wechat = { appid, secret, envId };
      cfg.relay = cloudRelay;
    }
  } else {
    console.error(`未知模式：${mode}`);
    process.exit(1);
  }

  fs.writeFileSync(target, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');
  console.log(`\n已写入 ${target}`);
  console.log('下一步：node src/main.js doctor   （自检）');
  console.log('      node src/main.js pair      （开始配对，终端显示 6 位码）');
  rl.close();
})().catch((e) => { console.error(e); process.exit(1); });
