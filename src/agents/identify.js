/**
 * V12-08：受控身份识别（identify）。
 *
 * 契约来源：主方案 §7.1（五种身份与识别优先级）、§9（自报 JSON 属不可信输入）。
 *
 * 硬边界（每一条都可追溯到主方案原文）：
 *   1. 受控发现——只探测「用户指定路径 / PATH 命中」的命令；绝不扫全盘、不上传环境变量、
 *      不读取任何 Agent 认证文件（§7.1）。
 *   2. 防同名恶意 wrapper——识别阶段【绝不】采用 cwd 优先解析（runner 的 cwd 优先语义只属于
 *      已授权会话；识别阶段若把 cwd 内同名程序当目标 = 优先执行攻击者放置的 wrapper）；
 *      解析出的二进制若位于 cwd 或系统临时目录，标记 suspicious 并拒绝升级身份（§7.1）。
 *   3. 探测带资源上限——--version 探测参数来自目录声明（probe.version_args 只允许旗标），
 *      超时即杀、输出超限即弃（ok=false），无 shell、无提权、args 数组直传 spawn（§7.1/契约§4）。
 *   4. 自报 JSON 只填白名单字段——schema_version / installer_identity{product,host,version} /
 *      runtime_candidate{agent_key,display_name,region}；其余一切键（permission/shell/command/
 *      env/path/...）一律丢弃；畸形/超限/未知 schema → 拒绝（§9）。
 *   5. installer_identity 与 runtime 严格区分（§7.1 第 1/2 种身份）；自报身份永远不产生
 *      「已验证」结论——识别结果最低为 unknown，绝不回退/伪装 claude-code（T12）。
 *
 * 诚实边界：verdict='probe-ok' 只表示「二进制在合理位置解析成功且 --version 正常应答」，
 * 不等于安装包/协议握手级验证（后者挂 V03 真实 CLI 往返与 V12-14 注册闭环）。位于普通
 * PATH 目录、仅输出伪造版本号的 wrapper 无法在本层识别，只能由协议级验证兜底——不宣称已覆盖。
 */
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { isCmdShimPath, resolveCommandPath } from '../lib/command-resolve.js';
import { isPathInside } from '../adapters/capabilities.js';
import { resolveAgentKey, getCatalogEntry } from './catalog.js';

/** 自报 JSON 输入字节上限（§9：不可信输入，先限大小再解析）。 */
export const SELF_REPORT_MAX_BYTES = 16 * 1024;
export const SELF_REPORT_SCHEMA_VERSION = 1;
/** §9 installer_identity.host 枚举。 */
export const INSTALLER_HOSTS = Object.freeze(['cli', 'ide', 'desktop', 'unknown']);
/** §9 runtime_candidate.region 枚举（与 profile-store PROFILE_REGIONS 同口径）。 */
export const IDENTIFY_REGIONS = Object.freeze(['cn', 'global', 'unknown']);

/* ------------------------------------------------------------------ *
 * 受控命令解析
 * ------------------------------------------------------------------ */

/**
 * 把用户指定的命令解析为可执行文件路径。
 * 规则：裸命令名只走 PATH（显式不传 cwd，规避 command-resolve 的 win32 cwd 优先语义）；
 * 绝对路径原样接受（用户显式指定位置，§7.1「用户指定」）；含分隔符的相对路径拒绝——
 * 相对路径会隐式落到 cwd，正是 wrapper 攻击面。
 *
 * @returns {{ ok: true, resolved_path: string } | { ok: false, reason: string }}
 */
export function resolveRuntimeCommand(command, { platform = process.platform } = {}) {
  const raw = String(command ?? '').trim();
  if (!raw) return { ok: false, reason: 'missing-command' };
  if (raw.length > 1024) return { ok: false, reason: 'command-too-long' };
  if (/[\u0000-\u001F]/.test(raw)) return { ok: false, reason: 'command-has-control-chars' };
  if (/[/\\]/.test(raw)) {
    if (!path.isAbsolute(raw)) return { ok: false, reason: 'relative-path-not-allowed' };
    return { ok: true, resolved_path: raw };
  }
  const resolved = resolveCommandPath(raw, { platform }); // 刻意不传 cwd：PATH-only
  if (!resolved) return { ok: false, reason: 'command-not-on-path' };
  return { ok: true, resolved_path: resolved };
}

/**
 * 二进制位置疑点分析（纯路径判断，无 IO）：
 *   - binary-in-cwd：目标位于当前工作目录（同名 wrapper 最廉价的落点）；
 *   - binary-in-temp：目标位于系统临时目录（攻击者常用落点）。
 * 命中任一疑点即 suspicious——拒绝升级为已识别身份。
 */
export function analyzeBinaryLocation(resolvedPath, { cwd = process.cwd(), tmpDir = os.tmpdir() } = {}) {
  const suspicious = [];
  if (!resolvedPath) return suspicious;
  if (isPathInside(resolvedPath, cwd)) suspicious.push('binary-in-cwd');
  if (tmpDir && isPathInside(resolvedPath, tmpDir)) suspicious.push('binary-in-temp');
  return suspicious;
}

/* ------------------------------------------------------------------ *
 * --version 探测（超时 + 输出上限 + 无 shell 无提权）
 * ------------------------------------------------------------------ */

const FLAG_RE = /^-{1,2}[a-z0-9][a-z0-9-]*$/i;

/**
 * 运行 `command <version_args>` 采集版本输出。
 * @param {object} opts command 必须是可执行路径/裸名；args 必须是旗标数组（拒绝任意命令）；
 *   timeoutMs 到期杀进程；outputMaxBytes 输出截断上限（超限 → ok=false）。
 * 无 shell（spawn 数组直传）、无提权、不上传任何环境变量——只在本机采集。
 * @returns {Promise<{ok:boolean, exit_code:number|null, output:string, stderr:string,
 *   truncated:boolean, timed_out:boolean, error:string|null, version_line:string|null, reason:string|null}>}
 */
export function probeRuntime({ command, args = ['--version'], timeoutMs = 10000, outputMaxBytes = 8192 } = {}) {
  return new Promise((resolve) => {
    const cmdPath = String(command ?? '').trim();
    const maxBytes = Number.isInteger(outputMaxBytes) && outputMaxBytes > 0 ? outputMaxBytes : 8192;
    const timeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.min(timeoutMs, 60_000) : 10_000;
    const flagArgs = Array.isArray(args) ? args.map(String) : [];
    const denied = (reason) => resolve({ ok: false, exit_code: null, output: '', stderr: '', truncated: false, timed_out: false, error: null, version_line: null, reason });
    if (!cmdPath) return denied('missing-command');
    // 旗标白名单：版本探测参数只能是 --flag 形态（契约 §1 probe 约束；防御把探测通道变成任意命令通道）
    if (flagArgs.length === 0 || !flagArgs.every((a) => FLAG_RE.test(a))) return denied('invalid-probe-args');
    if (cmdPath.includes('"')) return denied('invalid-command');

    // .cmd/.bat shim 无法被 spawn 直接执行：经 cmd.exe /d /s /c 显式传参（路径加引号；
    // args 已是旗标白名单，无元字符——不引入 shell 注入面）。
    const isShim = process.platform === 'win32' && isCmdShimPath(cmdPath);
    const bin = isShim ? (process.env.ComSpec || 'cmd.exe') : cmdPath;
    const spawnArgs = isShim ? ['/d', '/s', '/c', `"${cmdPath}"`, ...flagArgs] : flagArgs;

    let child;
    try {
      child = spawn(bin, spawnArgs, { shell: false, windowsHide: true, windowsVerbatimArguments: isShim });
    } catch (err) {
      return denied('spawn-failed');
    }

    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let truncated = false;
    let timedOut = false;
    let overLimit = false;
    let settled = false;

    const finish = (exitCode, err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const output = stdout.toString('utf8');
      const errText = stderr.toString('utf8');
      const firstLine = [output, errText]
        .flatMap((text) => text.split(/\r?\n/))
        .map((line) => line.trim())
        .find((line) => line !== '') ?? null;
      const reason = overLimit ? 'output-too-large'
        : timedOut ? 'timeout'
          : err ? 'spawn-failed'
            : exitCode !== 0 ? `exit-${exitCode}`
              : firstLine ? null : 'empty-output';
      resolve({
        ok: reason === null,
        exit_code: exitCode,
        output,
        stderr: errText,
        truncated,
        timed_out: timedOut,
        error: err ?? null,
        version_line: firstLine ? firstLine.slice(0, 64) : null,
        reason,
      });
    };

    const collect = (chunk, sink) => {
      if (overLimit) return sink;
      if (sink.length + chunk.length > maxBytes) {
        overLimit = true; // 超限即弃：版本探测输出不应超过目录声明的上限
        truncated = true;
        try { child.kill('SIGKILL'); } catch { /* ignore */ }
        return sink;
      }
      return Buffer.concat([sink, chunk]);
    };
    child.stdout.on('data', (chunk) => { stdout = collect(chunk, stdout); });
    child.stderr.on('data', (chunk) => { stderr = collect(chunk, stderr); });

    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      // 立即结算：cmd shim 树被杀后 stdout/stderr 管道可能仍被孙进程握住，
      // 等 'close' 会把超时响应拖到孙进程退出——探测结果此刻已定（超时即未知）。
      finish(null, null);
    }, timeout);
    timer.unref?.();

    child.on('error', (err) => finish(null, err?.code ? `${err.code}: ${err.message}` : String(err)));
    child.on('close', (code) => finish(code, null));
  });
}

/* ------------------------------------------------------------------ *
 * 自报 JSON 白名单化（§9：不可信输入，只填白名单字段）
 * ------------------------------------------------------------------ */

function cleanClaimText(value, maxChars) {
  if (value === null || value === undefined) return null;
  const out = String(value).replace(/[\u0000-\u001F\u007F]/g, '').trim();
  return out ? out.slice(0, maxChars) : null;
}

/** 枚举字段归一：非字符串/未知值一律落 'unknown'（不编造，§9「不知道的字段写 unknown」）。 */
function enumOrUnknown(value, allowed) {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return allowed.includes(normalized) ? normalized : 'unknown';
}

/**
 * 自报 JSON 白名单化。@returns {{ok:true, self_report:object}|{ok:false, reason:string}}
 * 输出只含：schema_version / installer_identity{product,host,version} /
 * runtime_candidate{agent_key,display_name,region}。其余一切键一律丢弃。
 */
export function sanitizeSelfReport(raw) {
  let input = raw;
  if (typeof input === 'string') {
    if (Buffer.byteLength(input, 'utf8') > SELF_REPORT_MAX_BYTES) return { ok: false, reason: 'self-report-too-large' };
    try {
      input = JSON.parse(input);
    } catch {
      return { ok: false, reason: 'invalid-json' };
    }
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, reason: 'invalid-json' };
  if (input.schema_version !== SELF_REPORT_SCHEMA_VERSION) return { ok: false, reason: 'unsupported-schema-version' };

  const installerRaw = input.installer_identity && typeof input.installer_identity === 'object' && !Array.isArray(input.installer_identity) ? input.installer_identity : {};
  const runtimeRaw = input.runtime_candidate && typeof input.runtime_candidate === 'object' && !Array.isArray(input.runtime_candidate) ? input.runtime_candidate : {};

  // agent_key 只接受能映射到目录的值（别名可）；编造的 key 归 unknown——不编造目录外身份
  const claimedKey = resolveAgentKey(cleanClaimText(runtimeRaw.agent_key, 64) ?? '');
  const selfReport = {
    schema_version: SELF_REPORT_SCHEMA_VERSION,
    installer_identity: {
      product: cleanClaimText(installerRaw.product, 100) ?? 'unknown',
      host: enumOrUnknown(installerRaw.host, INSTALLER_HOSTS),
      version: cleanClaimText(installerRaw.version, 64) ?? 'unknown',
    },
    runtime_candidate: {
      agent_key: claimedKey ?? 'unknown',
      display_name: cleanClaimText(runtimeRaw.display_name, 100) ?? 'unknown',
      region: enumOrUnknown(runtimeRaw.region, IDENTIFY_REGIONS),
    },
  };
  return { ok: true, self_report: selfReport };
}

/* ------------------------------------------------------------------ *
 * 综合识别（resolver + probe + 自报；installer 与 runtime 分离）
 * ------------------------------------------------------------------ */

/**
 * 识别一次 runtime 候选。
 * @param {object} opts command 用户指定命令；agentKey 用户明确选择的 agent_key（可空）；
 *   selfReport 自报 JSON（字符串或对象，不可信，先白名单化）；cwd 位置疑点判定基准。
 * @returns {Promise<{verdict:'unknown'|'suspicious'|'probe-ok', agent_key:string,
 *   agent_key_source:'user'|'none', installer_identity:object|null,
 *   runtime:{command,resolved_path:string|null,suspicious:string[],probe:object|null,version_line:string|null},
 *   reasons:string[]}>}
 */
export async function identifyRuntime({ command, agentKey = null, selfReport = null, cwd = process.cwd() } = {}) {
  const reasons = [];
  let sanitized = null;
  if (selfReport !== null && selfReport !== undefined) {
    sanitized = sanitizeSelfReport(selfReport);
    if (!sanitized.ok) reasons.push(`self-report-rejected:${sanitized.reason}`);
  }
  const installer = sanitized?.ok ? sanitized.self_report.installer_identity : null; // 仅记录来源提示（§7.1 第 1 种身份）

  const resolved = resolveRuntimeCommand(command);
  if (!resolved.ok) {
    return {
      verdict: 'unknown',
      agent_key: 'unknown',
      agent_key_source: 'none',
      installer_identity: installer,
      runtime: { command: String(command ?? ''), resolved_path: null, suspicious: [], probe: null, version_line: null },
      reasons: [...reasons, resolved.reason],
    };
  }

  const suspicious = analyzeBinaryLocation(resolved.resolved_path, { cwd });
  const userKey = agentKey ? resolveAgentKey(agentKey) : null;
  if (agentKey && !userKey) reasons.push('user-agent-key-unknown');
  // 自报 runtime_candidate 只用于选择探测参数，绝不升级身份（verdict 保持 unknown，T12）
  const claimedKey = sanitized?.ok && sanitized.self_report.runtime_candidate.agent_key !== 'unknown'
    ? sanitized.self_report.runtime_candidate.agent_key
    : null;
  if (claimedKey && !userKey) reasons.push('self-report-not-locally-verified');

  const entry = (userKey ?? claimedKey) ? getCatalogEntry(userKey ?? claimedKey) : null;
  const probe = await probeRuntime({
    command: resolved.resolved_path,
    args: entry?.probe?.version_args ?? ['--version'],
    timeoutMs: entry?.probe?.timeout_ms ?? 10000,
    outputMaxBytes: entry?.probe?.output_max_bytes ?? 8192,
  });
  if (!probe.ok) reasons.push(`probe-failed:${probe.reason}`);

  let verdict;
  let agentKeyOut = 'unknown';
  let keySource = 'none';
  if (suspicious.length > 0) {
    verdict = 'suspicious';
    reasons.push(`suspicious:${suspicious.join('+')}`);
  } else if (!probe.ok) {
    verdict = 'unknown';
  } else if (userKey) {
    // 识别优先级第 1-2 级：本地解析成功 + 用户明确选择 → probe-ok（协议级验证挂 V03/V12-14）
    verdict = 'probe-ok';
    agentKeyOut = userKey;
    keySource = 'user';
  } else {
    // 只有自报/文件名启发：维持 unknown（§7.1 优先级第 3 级以下不产生已验证身份）
    verdict = 'unknown';
  }

  return {
    verdict,
    agent_key: agentKeyOut,
    agent_key_source: keySource,
    installer_identity: installer,
    runtime: {
      command: String(command ?? ''),
      resolved_path: resolved.resolved_path,
      suspicious,
      probe,
      version_line: probe.ok ? probe.version_line : null,
    },
    reasons,
  };
}
