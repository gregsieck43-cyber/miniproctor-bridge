import fs from 'node:fs';
import { EndpointTransport } from '../src/transport/endpoint.js';
import { invokeCloudFunction } from '../src/cloud/wechat-auth.js';
import { appendAuthFields } from '../src/cloud/device-keys.js';
import { canonical } from '../src/lib/canonical.js';

const state = JSON.parse(fs.readFileSync('./data/device.json', 'utf8'));
const config = JSON.parse(fs.readFileSync('./config.json', 'utf8'));
const BASE = 'https://cloud1-d9gmxxh3t0958f4a4-1478470112.ap-shanghai.app.tcloudbase.com';
const epConfig = { relay: { kind: 'endpoint', timeoutMs: 15000, endpoints: { baseUrl: BASE } }, bridge: {}, wechat: {}, agent: {} };

console.log('=== 态1b(修正): 合法签名 → syncReport 推 custom 事件（应 accepted:1） ===');
const t = new EndpointTransport({ config: epConfig, deviceId: state.device_id, tokenHash: state.token_hash, privateKey: state.private_key });
const ev = [{ event_id: `e2e_tri_${Date.now()}`, session_id: 's_tri_state_verify', seq: 0, agent_type: 'generic', event_type: 'custom', payload: { custom_type: 'tri_verify', text: 'endpoint 三态验证' } }];
const r2 = await t.pushEvents(ev);
console.log(JSON.stringify(r2));

console.log('=== 态3(修正): 旧 AppSecret 通道 + 签名（bridge cloud 模式真实形态，应 ok:true） ===');
const payload = appendAuthFields(
  { token_hash: state.token_hash, device_id: state.device_id },
  { deviceId: state.device_id, privateKey: state.private_key, canonical }
);
const r3 = await invokeCloudFunction(config, 'pullCommands', payload);
console.log(JSON.stringify({ ok: r3.ok, errcode: r3.errcode, dataOk: r3.data?.ok, cmds: r3.data?.commands?.length }));
