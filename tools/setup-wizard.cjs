#!/usr/bin/env node
/**
 * miniproctor 一键配置向导（交互式）：node tools/setup-wizard.cjs
 *
 * 两种模式：
 *   1) endpoint（推荐，公开运营默认）：填云函数 HTTP 访问服务基础 URL（形如
 *      https://<envId>.service.tcloudbase.com），无需 AppSecret——bridge 用
 *      设备私钥对每个请求做 ed25519 签名，云端按绑定公钥验签。
 *   2) cloud（开发者自用调试）：填 AppID/AppSecret/envId，经微信 API 网关调云函数。
 * 生成 bridge/config.json（.gitignore 保护，永不入库）。
 */
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

const root = path.resolve(__dirname, '..');
const target = path.join(root, 'config.json');
const example = JSON.parse(fs.readFileSync(path.join(root, 'config.example.json'), 'utf8'));

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q, def = '') => new Promise((res) => rl.question(`${q}${def ? `（回车=默认 ${def}）` : ''}: `, (a) => res(a.trim() || def)));

(async () => {
  console.log('== miniproctor bridge 配置向导 ==\n');
  console.log('模式说明：');
  console.log('  endpoint = 推荐。只需小程序里展示的接入地址，无需任何密钥；请求以设备私钥签名，云端验签。');
  console.log('  cloud    = 开发者自用。需要 AppID/AppSecret（mp.weixin.qq.com → 开发管理 → 开发设置 生成）。\n');
  const mode = (await ask('连接模式 endpoint/cloud', 'endpoint')).toLowerCase();
  const cfg = structuredClone(example);

  if (mode === 'endpoint') {
    const baseUrl = await ask('云函数接入地址（小程序设置页可复制）', 'https://cloud1-d9gmxxh3t0958f4a4.service.tcloudbase.com');
    if (!/^https:\/\/.+/.test(baseUrl)) { console.error('接入地址必须是 https:// 开头'); process.exit(1); }
    cfg.wechat = { appid: example.wechat.appid, secret: '', envId: '' };
    cfg.relay = { kind: 'endpoint', baseUrl: '', timeoutMs: 10000, endpoints: { baseUrl } };
  } else if (mode === 'cloud') {
    console.log('AppSecret 获取：mp.weixin.qq.com 登录 → 开发 → 开发管理 → 开发设置 → AppSecret「生成/重置」（管理员扫码）。');
    console.log('注意：重置会使旧 secret 失效；此文件不会提交 git。');
    const appid = await ask('AppID', 'wxf2236b260c3bff8a');
    const secret = await ask('AppSecret');
    const envId = await ask('云环境 envId', 'cloud1-d9gmxxh3t0958f4a4');
    if (!secret) { console.error('AppSecret 不能为空'); process.exit(1); }
    cfg.wechat = { appid, secret, envId };
    cfg.relay = { kind: 'cloud', baseUrl: '', timeoutMs: 5000 };
  } else {
    console.error(`未知模式：${mode}`);
    process.exit(1);
  }

  fs.writeFileSync(target, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
  console.log(`\n已写入 ${target}`);
  console.log('下一步：node src/main.js doctor   （自检）');
  console.log('      node src/main.js pair      （开始配对，终端显示 6 位码）');
  rl.close();
})().catch((e) => { console.error(e); process.exit(1); });
