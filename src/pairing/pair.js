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

/**
 * checkPairing 状态 → 轮询动作映射（纯函数，便于单测；TASK-004 ⑦）。
 * 云端状态枚举扩展（如 claiming）与未知新状态一律返回 wait，保持旧轮询语义
 * （向后兼容：已部署 bridge 对非 bound 状态持续轮询直至超时）。
 */
export function evaluatePairingStatus(status) {
  if (status === 'bound') return { action: 'bound' };
  if (status === 'expired') return { action: 'abort', reason: 'pairing-expired' };
  if (status === 'failed') return { action: 'abort', reason: 'pairing-locked' };
  return { action: 'wait' };
}
