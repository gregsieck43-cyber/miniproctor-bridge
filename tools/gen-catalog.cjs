#!/usr/bin/env node
/**
 * V12-08：catalog 同源生成脚本。
 *
 * 数据源：src/agents/catalog-entries/<agent_key>.json（契约唯一事实源）。
 * 产物：src/agents/catalog.js（版本化目录 + 别名映射 + 查询函数，随发行只读）。
 *
 * 校验依据：src/agents/adapter-contract.md §1（catalog-entry JSON schema，V12-09 冻结）：
 *   - agent_key/aliases 命名约束；别名不得与任何 agent_key 冲突、不得跨条目重复；
 *   - adapter_id ∈ 现有 AGENT_TYPES（不逐产品新建分发分支）；
 *   - lifecycle / integration_mode / capabilities / initial_prompt_channel / probe 枚举与上限；
 *   - logo_asset 禁止网络 URL（§7.1：LOGO/别名映射到目录，不由任意网络 URL 提供）；
 *   - docs_ref 必须指向仓内真实存在的本地快照（防止编造接口/资料）。
 * 运行：cd xcx/bridge && node tools/gen-catalog.cjs（校验失败退出码 1，不产出半成品）。
 * 注意：logo_asset 只校验格式不校验文件存在——Logo 资产由 V12-17 统一落地。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const BRIDGE_ROOT = path.resolve(__dirname, '..');
const ENTRIES_DIR = path.join(BRIDGE_ROOT, 'src', 'agents', 'catalog-entries');
const OUT_FILE = path.join(BRIDGE_ROOT, 'src', 'agents', 'catalog.js');
// 仓根 = bridge(1) ← xcx(2) ← 仓库根(3)；docs_ref 以仓根为基准（与主方案口径一致）
const REPO_ROOT = path.resolve(BRIDGE_ROOT, '..', '..');

// 与 xcx/protocol/schema.cjs AGENT_TYPES 同步（bridge 发行包自包含字面镜像，漂移由 tests 对拍强制）
const AGENT_TYPES = ['claude-code', 'codex', 'generic'];
// 与 src/adapters/capabilities.js CAPABILITY_KEYS / INTEGRATION_MODES / INITIAL_PROMPT_CHANNELS 同步
const CAPABILITY_KEYS = ['create', 'read', 'stop', 'append', 'resume', 'approve', 'fileChanges', 'usage'];
const INTEGRATION_MODES = ['stdio', 'acp', 'local-api', 'hook', 'manual-report'];
const INITIAL_PROMPT_CHANNELS = ['stdin', 'launch-args', null];
const LIFECYCLES = ['active', 'deprecated', 'unmaintained', 'unknown'];
const KEY_RE = /^[a-z0-9][a-z0-9_-]*$/;
const FLAG_RE = /^-{1,2}[a-z0-9][a-z0-9-]*$/i;

const errors = [];
function fail(msg) {
  errors.push(msg);
}

/** 逐条目按契约 §1 校验；返回规范化条目（去除多余键，保持已知字段）。 */
function validateEntry(raw, fileName) {
  const where = `catalog-entries/${fileName}`;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    fail(`${where}: 必须是 JSON 对象`);
    return null;
  }
  for (const key of ['schema_version', 'agent_key', 'display_name', 'aliases', 'logo_asset', 'lifecycle', 'adapter_id', 'integration_mode', 'capabilities', 'initial_prompt_channel', 'verification', 'probe', 'docs_ref']) {
    if (!(key in raw)) fail(`${where}: 缺少必填字段 ${key}`);
  }
  if (errors.length) return null;

  const key = raw.agent_key;
  if (typeof key !== 'string' || !KEY_RE.test(key) || key.length > 64) {
    fail(`${where}: agent_key 非法（需 ^[a-z0-9][a-z0-9_-]*$ 且 ≤64 字符）：${JSON.stringify(key)}`);
  }
  if (path.basename(fileName) !== `${key}.json`) {
    fail(`${where}: 文件名必须等于 agent_key.json`);
  }
  if (raw.schema_version !== 1 || !Number.isInteger(raw.schema_version) || raw.schema_version < 1) {
    fail(`${where}: schema_version 必须是整数 ≥1，当前 ${JSON.stringify(raw.schema_version)}`);
  }
  if (typeof raw.display_name !== 'string' || !raw.display_name.trim() || raw.display_name.length > 100) {
    fail(`${where}: display_name 必须是非空字符串 ≤100 字符`);
  }
  if (!Array.isArray(raw.aliases)) {
    fail(`${where}: aliases 必须是字符串数组`);
  } else {
    for (const alias of raw.aliases) {
      if (typeof alias !== 'string' || !KEY_RE.test(alias) || alias.length > 64) {
        fail(`${where}: 别名非法：${JSON.stringify(alias)}`);
      }
      if (alias === key) fail(`${where}: 别名 ${alias} 与自身 agent_key 重复（无意义）`);
    }
  }
  if (typeof raw.logo_asset !== 'string' || !raw.logo_asset.trim()
    || /^(https?:)?\/\//i.test(raw.logo_asset) || path.isAbsolute(raw.logo_asset)) {
    fail(`${where}: logo_asset 必须是仓内相对路径（禁止网络 URL / 绝对路径）：${JSON.stringify(raw.logo_asset)}`);
  }
  if (!LIFECYCLES.includes(raw.lifecycle)) {
    fail(`${where}: lifecycle 非法（${LIFECYCLES.join('|')}）：${JSON.stringify(raw.lifecycle)}`);
  }
  if (!AGENT_TYPES.includes(raw.adapter_id)) {
    fail(`${where}: adapter_id 必须是 AGENT_TYPES 之一（${AGENT_TYPES.join('|')}）：${JSON.stringify(raw.adapter_id)}`);
  }
  if (!INTEGRATION_MODES.includes(raw.integration_mode)) {
    fail(`${where}: integration_mode 非法（${INTEGRATION_MODES.join('|')}）：${JSON.stringify(raw.integration_mode)}`);
  }
  const caps = raw.capabilities;
  if (!caps || typeof caps !== 'object' || Array.isArray(caps)) {
    fail(`${where}: capabilities 必须是对象`);
  } else {
    for (const capKey of CAPABILITY_KEYS) {
      if (typeof caps[capKey] !== 'boolean') fail(`${where}: capabilities.${capKey} 必须是布尔值`);
    }
    for (const extra of Object.keys(caps)) {
      if (!CAPABILITY_KEYS.includes(extra)) fail(`${where}: capabilities 含未知键 ${extra}`);
    }
  }
  if (!INITIAL_PROMPT_CHANNELS.includes(raw.initial_prompt_channel)) {
    fail(`${where}: initial_prompt_channel 非法（stdin|launch-args|null）：${JSON.stringify(raw.initial_prompt_channel)}`);
  }
  const ver = raw.verification;
  if (!ver || typeof ver !== 'object' || Array.isArray(ver)) {
    fail(`${where}: verification 必须是对象`);
  } else {
    for (const [capKey, item] of Object.entries(ver)) {
      if (!CAPABILITY_KEYS.includes(capKey)) fail(`${where}: verification 含未知键 ${capKey}`);
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        fail(`${where}: verification.${capKey} 必须是 {status, evidence}`);
        continue;
      }
      if (!['verified', 'pending', 'unavailable'].includes(item.status)) {
        fail(`${where}: verification.${capKey}.status 非法（verified|pending|unavailable）：${JSON.stringify(item.status)}`);
      }
      if (typeof item.evidence !== 'string' || !item.evidence.trim()) {
        fail(`${where}: verification.${capKey}.evidence 必须是非空字符串`);
      }
    }
  }
  const probe = raw.probe;
  if (!probe || typeof probe !== 'object' || Array.isArray(probe)) {
    fail(`${where}: probe 必须是对象`);
  } else {
    if (!Array.isArray(probe.version_args) || probe.version_args.length === 0
      || !probe.version_args.every((a) => typeof a === 'string' && FLAG_RE.test(a))) {
      fail(`${where}: probe.version_args 必须是非空旗标数组（只允许 --flag 形态，不允许任意命令）`);
    }
    if (!Number.isInteger(probe.timeout_ms) || probe.timeout_ms <= 0 || probe.timeout_ms > 10000) {
      fail(`${where}: probe.timeout_ms 必须是整数 (0,10000]`);
    }
    if (!Number.isInteger(probe.output_max_bytes) || probe.output_max_bytes <= 0 || probe.output_max_bytes > 8192) {
      fail(`${where}: probe.output_max_bytes 必须是整数 (0,8192]`);
    }
  }
  if (typeof raw.docs_ref !== 'string' || !raw.docs_ref.trim()) {
    fail(`${where}: docs_ref 必须是非空字符串`);
  } else if (/^(https?:)?\/\//i.test(raw.docs_ref)) {
    fail(`${where}: docs_ref 必须指向仓内本地快照（禁止网络 URL）`);
  } else {
    const abs = path.join(REPO_ROOT, raw.docs_ref);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      fail(`${where}: docs_ref 指向的本地快照不存在：${raw.docs_ref}`);
    }
  }
  if (errors.length) return null;

  // 规范化输出：只保留契约字段，字段序与契约 §1 表一致
  return {
    schema_version: raw.schema_version,
    agent_key: key,
    display_name: raw.display_name,
    aliases: [...raw.aliases],
    logo_asset: raw.logo_asset,
    lifecycle: raw.lifecycle,
    adapter_id: raw.adapter_id,
    integration_mode: raw.integration_mode,
    capabilities: Object.fromEntries(CAPABILITY_KEYS.map((k) => [k, Boolean(raw.capabilities[k])])),
    initial_prompt_channel: raw.initial_prompt_channel,
    verification: Object.fromEntries(Object.keys(raw.verification).map((k) => [k, { status: raw.verification[k].status, evidence: raw.verification[k].evidence }])),
    probe: { version_args: [...raw.probe.version_args], timeout_ms: raw.probe.timeout_ms, output_max_bytes: raw.probe.output_max_bytes },
    docs_ref: raw.docs_ref,
  };
}

function main() {
  let fileNames;
  try {
    fileNames = fs.readdirSync(ENTRIES_DIR).filter((f) => f.endsWith('.json')).sort();
  } catch (err) {
    console.error(`[gen-catalog] 读取 catalog-entries 失败：${err?.message || err}`);
    process.exitCode = 1;
    return;
  }
  if (fileNames.length === 0) {
    console.error('[gen-catalog] catalog-entries 目录为空——至少需要 A01/A02 两个已冻结条目');
    process.exitCode = 1;
    return;
  }

  const entries = [];
  const seenKeys = new Map(); // agent_key -> 文件名
  const aliasOwner = new Map(); // alias -> agent_key
  for (const fileName of fileNames) {
    let raw = null;
    try {
      raw = JSON.parse(fs.readFileSync(path.join(ENTRIES_DIR, fileName), 'utf8'));
    } catch (err) {
      fail(`catalog-entries/${fileName}: JSON 解析失败：${err?.message || err}`);
      continue;
    }
    const entry = validateEntry(raw, fileName);
    if (!entry) continue;
    if (seenKeys.has(entry.agent_key)) {
      fail(`catalog-entries/${fileName}: agent_key ${entry.agent_key} 与 ${seenKeys.get(entry.agent_key)} 重复`);
      continue;
    }
    seenKeys.set(entry.agent_key, fileName);
    for (const alias of entry.aliases) {
      const owner = aliasOwner.get(alias);
      if (owner) fail(`catalog-entries/${fileName}: 别名 ${alias} 已被 ${owner} 占用（跨条目别名冲突）`);
      else aliasOwner.set(alias, entry.agent_key);
    }
    entries.push(entry);
  }
  // 别名不得与任何 agent_key 冲突（否则映射二义）
  for (const alias of aliasOwner.keys()) {
    if (seenKeys.has(alias)) fail(`别名 ${alias} 与条目 agent_key 冲突（${seenKeys.get(alias)}）`);
  }
  if (errors.length) {
    console.error(`[gen-catalog] 校验失败，共 ${errors.length} 处：`);
    for (const e of errors) console.error(`  - ${e}`);
    process.exitCode = 1;
    return;
  }

  const schemaVersion = Math.max(...entries.map((e) => e.schema_version));
  const body = JSON.stringify(entries, null, 2)
    .split('\n')
    .map((line) => (line ? `  ${line}` : line))
    .join('\n');
  const out = `// 本文件由 bridge/tools/gen-catalog.cjs 从 src/agents/catalog-entries/*.json 同源生成——勿手改。
// 重新生成：cd xcx/bridge && node tools/gen-catalog.cjs
// 契约：src/agents/adapter-contract.md §1（V12-09 冻结）。目录只随发行更新、运行时只读、
// 不接受远端下发可执行代码（主方案 §7.2）；unknown 一律 fail-closed，绝不回退 claude-code（T12）。

export const CATALOG_SCHEMA_VERSION = ${schemaVersion};

/** 全量目录条目（${entries.length} 个：A01–A27 首发 key + roo-code 停服历史条目）。 */
export const CATALOG_ENTRIES = Object.freeze(${body}.map((entry) => Object.freeze({
  ...entry,
  aliases: Object.freeze([...entry.aliases]),
  capabilities: Object.freeze({ ...entry.capabilities }),
  verification: Object.freeze(Object.fromEntries(Object.entries(entry.verification).map(([k, v]) => [k, Object.freeze({ ...v })]))),
  probe: Object.freeze({ ...entry.probe }),
})));

const KEY_INDEX = new Map(CATALOG_ENTRIES.map((entry) => [entry.agent_key, entry]));
const ALIAS_INDEX = new Map(CATALOG_ENTRIES.flatMap((entry) => entry.aliases.map((alias) => [alias, entry.agent_key])));

/**
 * 名称 → 规范化 agent_key：先精确 key，再别名表；未知返回 null。
 * 识别优先级最低为 unknown（§7.1）——绝不猜 Claude、绝不回退 'claude-code'（T12）。
 */
export function resolveAgentKey(name) {
  const normalized = String(name ?? '').trim().toLowerCase();
  if (!normalized) return null;
  if (KEY_INDEX.has(normalized)) return normalized;
  return ALIAS_INDEX.get(normalized) ?? null;
}

/** 按 agent_key 取目录条目；未知返回 null（调用方按 unknown fail-closed 处理）。 */
export function getCatalogEntry(agentKey) {
  return KEY_INDEX.get(String(agentKey ?? '').trim().toLowerCase()) ?? null;
}

/** 全量条目（只读视图；数组与条目均已冻结）。 */
export function listCatalogEntries() {
  return CATALOG_ENTRIES;
}
`;

  // 临时文件 → 校验 → 原子替换（与 profile/协议写入同纪律；§9 注册语义）
  const tmp = `${OUT_FILE}.tmp`;
  fs.writeFileSync(tmp, out, 'utf8');
  fs.renameSync(tmp, OUT_FILE);

  const activeCount = entries.filter((e) => e.lifecycle === 'active').length;
  console.log(`[gen-catalog] 生成 ${path.relative(REPO_ROOT, OUT_FILE)}：条目 ${entries.length}（active ${activeCount}，deprecated ${entries.length - activeCount}），别名 ${aliasOwner.size} 个`);
}

main();
