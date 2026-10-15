import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { QODER_PROFILE_VERSION, verifyQoderEntry, verifyQoderPhysicalPath } from './qoder-sdk-worker.js';
export { QODER_PROFILE_VERSION };
const failure = code => Object.assign(new Error(code), { code });
const inside = (a, b) => { const r = path.relative(a, b); return r === '' || r !== '..' && !r.startsWith('..' + path.sep) && !path.isAbsolute(r); };

export function qoderProfileEntry(command) {
  if (typeof command !== 'string' || !path.isAbsolute(command) || /[\u0000-\u001f\u007f"]/u.test(command)) throw failure('qoder-profile-entry-invalid');
  const entry = path.resolve(command), suffix = path.join('node_modules', '@qoder-ai', 'qodercli', 'bundle', 'qodercli.js');
  if (!entry.toLowerCase().endsWith((path.sep + suffix).toLowerCase())) throw failure('qoder-profile-entry-invalid');
  return entry;
}

/** Trusted local reference only; neither credentials nor paths are sent to cloud. */
export function qoderAuthConfigDir(ambientEnv = process.env) {
  const value = ambientEnv.MINIPROCTOR_QODER_AUTH_DIR || ambientEnv.QODER_CONFIG_DIR || path.join(os.homedir(), '.qoder');
  if (typeof value !== 'string' || !path.isAbsolute(value) || /[\u0000-\u001f\u007f"]/u.test(value)) throw failure('qoder-auth-path-invalid');
  return path.resolve(value);
}

/** Version-only discovery never reads the Agent's authentication store. */
export function probeQoderRuntime({ command, dataDir } = {}) {
  const out = { ok: false, exit_code: null, output: '', stderr: '', truncated: false, timed_out: false, error: null, version_line: null, reason: null };
  let scope = null, exited = false;
  try {
    const entry = qoderProfileEntry(command); verifyQoderEntry(entry);
    if (process.platform !== 'win32' || process.versions.node !== '24.16.0') throw failure('qoder-node-version-unverified');
    if (typeof dataDir !== 'string' || !path.isAbsolute(dataDir)) throw failure('qoder-probe-state-required');
    dataDir = path.resolve(dataDir); verifyQoderPhysicalPath(dataDir);
    const vendor = path.dirname(path.dirname(entry));
    if (inside(vendor, dataDir) || inside(dataDir, vendor)) throw failure('qoder-probe-state-invalid');
    scope = path.join(dataDir, 'qoder-version-probes', crypto.randomUUID()); fs.mkdirSync(scope, { recursive: true });
    const env = {};
    for (const n of ['SystemRoot', 'WINDIR', 'ComSpec', 'SystemDrive']) if (process.env[n]) env[n] = process.env[n];
    for (const n of ['HOME', 'USERPROFILE', 'QODER_CONFIG_DIR', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'TMPDIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME', 'npm_config_cache']) env[n] = scope;
    Object.assign(env, { NODE_DISABLE_COMPILE_CACHE: '1', NODE_COMPILE_CACHE: '', NODE_OPTIONS: '', NODE_PATH: '' });
    const probe = spawnSync(process.execPath, [entry, '--version'], { cwd: scope, env, windowsHide: true, timeout: 10000, encoding: 'utf8', maxBuffer: 8192 });
    exited = probe.status !== null; out.exit_code = probe.status; out.timed_out = probe.error?.code === 'ETIMEDOUT'; out.truncated = probe.error?.code === 'ENOBUFS';
    if (probe.status !== 0 || probe.stdout.trim() !== '1.1.64') throw failure('qoder-cli-unverified');
    verifyQoderEntry(entry); out.ok = true; out.output = QODER_PROFILE_VERSION; out.version_line = QODER_PROFILE_VERSION;
  } catch (e) { out.reason = /^qoder-[a-z-]+$/u.test(e.code || '') ? e.code : 'qoder-runtime-unverified'; }
  finally {
    if (scope && exited) { try {
      verifyQoderPhysicalPath(scope);
      if (!inside(path.resolve(dataDir), scope)) throw failure('qoder-probe-state-invalid');
      fs.rmSync(scope, { recursive: true }); const parent = path.dirname(scope); if (!fs.readdirSync(parent).length) fs.rmdirSync(parent);
    } catch { out.ok = false; out.version_line = null; out.reason = 'qoder-probe-cleanup-failed'; } }
  }
  return out;
}
