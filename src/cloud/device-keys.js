/**
 * 设备身份密钥（ed25519）：私钥永留电脑 device.json；
 * 公钥随配对上云存入 bindings。此后每个桥接请求都对业务负载签名，
 * 云端只持公钥即可验签——被截获 token_hash 也无法伪造请求。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

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
  if (payload && (payload.auth_ts !== undefined || payload.auth_sig !== undefined)) {
    // 业务负载不允许自带鉴权字段：同名键会破坏"签名对象=剥离后对象"的不变式（fail-closed）
    throw new TypeError('payload must not contain auth_ts/auth_sig');
  }
  const ts = Date.now();
  const body = canon(payload);
  return { ...payload, auth_ts: ts, auth_sig: signPayload(privateKey, deviceId, ts, body) };
}

/* ------------------------------------------------------------------ *
 * TASK-019 ④：device.json（含 ed25519 私钥）落盘保护
 *  - 原子写：临时文件 + 同目录 rename 替换，断电/崩溃不留半写文件；
 *  - 权限：临时文件先收紧再替换，POSIX chmod 600；Windows 尽力而为
 *    （attrib +h 隐藏 + icacls 去继承仅授权当前用户）——ACL 语义随文件系统/环境
 *    差异较大，失败只警告不阻塞（写入本身已成功，权限缺口在 doctor 可见）。
 *  - 诊断/日志永不包含 device.json 内容；doctor 检查项只输出权限结论。
 * ------------------------------------------------------------------ */

/** 对单个已存在的文件施加最小权限；返回警告列表（空 = 全部成功）。 */
function applyMinimalPermissions(filePath) {
  const warnings = [];
  if (process.platform === 'win32') {
    // Windows：隐藏属性 + ACL 收紧均为尽力而为（见文件头注释）
    try {
      execFileSync('attrib', ['+h', filePath], { stdio: 'ignore' });
    } catch (err) {
      warnings.push(`attrib +h failed: ${err?.message || err}`);
    }
    const user = process.env.USERNAME || '';
    if (user) {
      try {
        // /inheritance:r 去掉继承的宽 ACL；/grant:r 仅保留当前用户完全控制
        execFileSync('icacls', [filePath, '/inheritance:r', '/grant:r', `${user}:F`], { stdio: 'ignore' });
      } catch (err) {
        warnings.push(`icacls failed: ${err?.message || err}`);
      }
    }
  } else {
    try {
      fs.chmodSync(filePath, 0o600); // POSIX：仅属主读写
    } catch (err) {
      warnings.push(`chmod 600 failed: ${err?.message || err}`);
    }
  }
  return warnings;
}

/**
 * 原子写 device.json（临时文件 + rename）并收紧权限。
 * @param {string} filePath device.json 绝对路径
 * @param {object|string} state 设备状态对象（或已序列化 JSON 文本）
 * @returns {{ ok: boolean, warnings: string[] }}
 */
export function writeDeviceStateFile(filePath, state) {
  const data = typeof state === 'string' ? state : JSON.stringify(state, null, 2);
  const tmp = `${filePath}.tmp-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
  fs.writeFileSync(tmp, data, 'utf8');
  let warnings = [];
  try {
    warnings = applyMinimalPermissions(tmp); // 先收紧临时文件，再原子替换
    fs.renameSync(tmp, filePath);
    warnings = warnings.concat(applyMinimalPermissions(filePath));
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* 清理失败忽略 */ }
    throw err;
  }
  return { ok: true, warnings };
}

/**
 * doctor 权限检查项（不读取/不输出文件内容，结论不含绝对路径）：
 *   absent（未配对）/ pass / warn（过宽或 Windows 未能确认隐藏属性）。
 * Windows 的 ACL 详细审计依赖 icacls 输出解析（各语言环境输出不稳定），此处只核验
 * 隐藏属性是否在位作为"已保护"信号，其余情况给出可执行的加固建议。
 */
export function inspectDeviceKeyPermissions(filePath, { platform = process.platform } = {}) {
  let stat = null;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return { status: 'absent', detail: 'device.json 不存在（尚未配对或已归档）' };
  }
  if (!stat.isFile()) return { status: 'absent', detail: 'device.json 不存在（尚未配对或已归档）' };
  if (platform === 'win32') {
    try {
      // attrib 输出形如 "  A  SH  C:\path"——隐藏标志位在路径之前的标志区
      const out = execFileSync('attrib', [filePath], { encoding: 'utf8' });
      const flags = out.slice(0, Math.max(0, out.indexOf(':') - 2) || 16);
      if (flags.includes('H')) {
        return { status: 'pass', detail: 'device.json 已隐藏（attrib +h）；ACL 已尽力收紧（icacls），详情见部署文档' };
      }
      return { status: 'warn', detail: 'device.json 未设隐藏属性；建议重新配对（自动收紧）或手工执行 attrib +h 与 icacls <file> /inheritance:r /grant:r "%USERNAME%":F' };
    } catch {
      return { status: 'warn', detail: '无法确认 device.json 权限（attrib 检查失败）；建议手工核验隐藏属性与 ACL' };
    }
  }
  const mode = stat.mode & 0o777;
  if (mode & 0o077) {
    return { status: 'warn', detail: `device.json 权限过宽（${mode.toString(8).padStart(3, '0')}，组/其他可访问）；建议 chmod 600` };
  }
  return { status: 'pass', detail: `device.json 权限 ${mode.toString(8).padStart(3, '0')}（仅属主可读写）` };
}
