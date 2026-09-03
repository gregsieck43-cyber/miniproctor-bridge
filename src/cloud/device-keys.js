/**
 * 设备身份密钥（ed25519）：私钥永留电脑 device.json；
 * 公钥随配对上云存入 bindings。此后每个桥接请求都对业务负载签名，
 * 云端只持公钥即可验签——被截获 token_hash 也无法伪造请求。
 */
import crypto from 'node:crypto';

/** 生成设备密钥对：public_key 为 SPKI DER 的 base64，私钥为 PEM 文本。 */
export function generateDeviceKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return {
    public_key: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString('utf8'),
  };
}

/**
 * 签名一条已含 auth.ts 的负载：
 * 消息 = `${device_id}.${ts}.${sha256hex(canonical(payload))}`
 */
export function signPayload(privateKeyPem, deviceId, ts, canonicalPayload) {
  const digest = crypto.createHash('sha256').update(canonicalPayload).digest('hex');
  const message = Buffer.from(`${deviceId}.${ts}.${digest}`, 'utf8');
  const key = crypto.createPrivateKey(privateKeyPem);
  return crypto.sign(null, message, key).toString('base64');
}

/** 验签（测试与云端同构参考实现）。载荷 ts 时钟窗由调用方校验。 */
export function verifyPayload(publicKeyBase64, deviceId, ts, canonicalPayload, signatureBase64) {
  try {
    const digest = crypto.createHash('sha256').update(canonicalPayload).digest('hex');
    const message = Buffer.from(`${deviceId}.${ts}.${digest}`, 'utf8');
    const key = crypto.createPublicKey({
      key: Buffer.from(publicKeyBase64, 'base64'),
      type: 'spki',
      format: 'der',
    });
    return crypto.verify(null, message, key, Buffer.from(signatureBase64, 'base64'));
  } catch {
    return false;
  }
}

/** 组装带签名鉴权字段的事件外层：{ ...payload, auth_ts, auth_sig } */
export function appendAuthFields(payload, { deviceId, privateKey, canonical: canon }) {
  if (!privateKey) return payload;
  const ts = Date.now();
  const body = canon(payload);
  return { ...payload, auth_ts: ts, auth_sig: signPayload(privateKey, deviceId, ts, body) };
}
