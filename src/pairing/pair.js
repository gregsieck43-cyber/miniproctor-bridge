import crypto from 'node:crypto';
import { generateDeviceKeyPair } from '../cloud/device-keys.js';

export function createPairingOffer({ deviceId, ttlMs = 10 * 60 * 1000, generateKeys = true } = {}) {
  const nonce = crypto.randomBytes(16).toString('base64url');
  const token = crypto.randomBytes(32).toString('base64url');
  const pairingCode = crypto.randomInt(0, 1000000).toString().padStart(6, '0');
  // v0.3：配对即生成设备身份密钥对；公钥随 registerPairing 上云，私钥落 device.json
  const keys = generateKeys ? generateDeviceKeyPair() : null;
  return {
    pairing_id: `p_${crypto.randomUUID()}`,
    nonce,
    nonce_hash: sha256(nonce),
    token,
    token_hash: sha256(token),
    device_id: deviceId || `d_${crypto.randomUUID()}`,
    expires_at: Date.now() + ttlMs,
    pairing_code: pairingCode,
    pairing_code_hash: sha256(pairingCode),
    public_key: keys?.public_key || null,
    private_key: keys?.private_key || null,
  };
}

export function sha256(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}
