import { needsWechatCredentials } from '../cloud/wechat-auth.js';

/**
 * doctor 健康判定的纯函数核心：输入环境事实，输出 { ok, checks }。
 * ok = 不存在任何 status === 'fail' 的检查项。
 * - node 版本 >= 22
 * - 配对状态：informational/warn，不算 fail
 * - 微信凭据完整性：缺失时 http-poll/wss 下 warn「仅 mock 可用」；kind='cloud' 下 fail
 * - agent CLI 可达性：probe 返回完整路径即 pass，null 即 fail（可用 checkAgent=false 跳过）
 */
export function buildDoctorReport({
  nodeVersion = process.version,
  platform = process.platform,
  arch = process.arch,
  cwd = process.cwd(),
  config,
  paired = false,
  deviceId = null,
  agentConfig = { source: null, miniproctor: null, ui: false },
  checkAgent = true,
  probe = () => null,
} = {}) {
  const checks = [];

  const major = parseNodeMajor(nodeVersion);
  checks.push(
    major != null && major >= 22
      ? pass('node-version', 'Node.js >= 22', nodeVersion)
      : fail('node-version', 'Node.js >= 22', `${nodeVersion}：bridge 需要 Node.js v22 或更高版本`),
  );

  if (paired) {
    checks.push(info('pairing', '设备配对', `已配对 device_id=${deviceId || 'unknown'}`));
  } else {
    checks.push(warn('pairing', '设备配对', '尚未与手机端配对，仅可连接 mock 中继'));
  }

  const credentialsMissing = Boolean(needsWechatCredentials(config));
  const relayKind = config?.relay?.kind ?? 'http-poll';
  if (!credentialsMissing) {
    checks.push(pass('wechat-credentials', '微信云调用凭据', `appid/envId 已配置（relay=${relayKind}）`));
  } else if (relayKind === 'cloud') {
    checks.push(fail('wechat-credentials', '微信云调用凭据', `relay kind=${relayKind} 但 appid/secret/envId 缺失或为测试占位值`));
  } else {
    checks.push(warn('wechat-credentials', '微信云调用凭据', 'appid/secret/envId 缺失或为 TEST_APPID，仅 mock 可用'));
  }

  if (checkAgent) {
    const command = config?.agent?.command;
    const resolved = command ? probe(command) : null;
    if (command && resolved) {
      checks.push(pass('agent-command', `Agent CLI 可达（${command}）`, resolved));
    } else {
      checks.push(fail('agent-command', `Agent CLI 可达（${command || '未配置'}）`, 'where/which 未找到可执行文件；请安装 Agent CLI 或使用 --no-check-agent 跳过该项'));
    }
  }

  return {
    ok: !checks.some((check) => check.status === 'fail'),
    node: nodeVersion,
    platform,
    arch,
    cwd,
    relay: config?.relay ?? null,
    bridge: config?.bridge ?? null,
    agent: config?.agent ?? null,
    wechatAppid: config?.wechat?.appid ?? null,
    wechatConfigured: !credentialsMissing,
    paired,
    deviceId,
    agentConfig: {
      source: agentConfig.source ?? null,
      miniproctor: agentConfig.miniproctor ?? null,
      ui_block_present: Boolean(agentConfig.ui),
    },
    checks,
  };
}

export function parseNodeMajor(version) {
  const match = /^v(\d+)/.exec(String(version || ''));
  return match ? Number(match[1]) : null;
}

function check(id, title, detail, status) {
  return { id, status, title, detail };
}
function pass(id, title, detail) { return check(id, title, detail, 'pass'); }
function warn(id, title, detail) { return check(id, title, detail, 'warn'); }
function fail(id, title, detail) { return check(id, title, detail, 'fail'); }
function info(id, title, detail) { return check(id, title, detail, 'info'); }
