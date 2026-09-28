#!/usr/bin/env node
// Optional OpenHands SDK runtime. Keep all packages/cache/temp inside the
// explicit Agent workspace, separate from bridge upgrades and global Python.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const LOCK = path.join(__dirname, 'openhands-requirements-win-py314.lock');

function fail(message) {
  console.error(`[setup-openhands] ${message}`);
  process.exit(1);
}

function readArgs(argv) {
  const options = { workspace: null, python: null, uv: null, cacheDir: null, verifyOnly: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--workspace' && argv[i + 1]) options.workspace = argv[++i];
    else if (arg === '--python' && argv[i + 1]) options.python = argv[++i];
    else if (arg === '--uv' && argv[i + 1]) options.uv = argv[++i];
    else if (arg === '--cache-dir' && argv[i + 1]) options.cacheDir = argv[++i];
    else if (arg === '--verify-only') options.verifyOnly = true;
    else fail(`未知参数：${arg}；用法：node tools/setup-openhands.cjs --workspace <项目目录> [--python <Python 3.14 路径>] [--uv <uv 路径>] [--cache-dir <项目缓存>] [--verify-only]`);
  }
  if (!options.workspace) fail('必须明确指定 --workspace <项目目录>，依赖会安装到其 .deps/ 内');
  return options;
}

function run(command, args, env, cwd) {
  const result = spawnSync(command, args, {
    env, cwd, stdio: 'inherit', windowsHide: true,
    timeout: 20 * 60 * 1000,
  });
  if (result.error) fail(`${command} 执行失败：${result.error.message}`);
  if (result.status !== 0) fail(`${command} 退出码 ${result.status}；已保留工作区内依赖与缓存，可修复后重跑`);
}

const options = readArgs(process.argv.slice(2));
if (process.platform !== 'win32') fail('当前锁定清单仅通过 Windows/Python 3.14 实测；其他系统待单独取证后提供对应清单');
if (!fs.existsSync(LOCK)) fail(`发行包缺少依赖锁定清单：${LOCK}`);
const workspace = path.resolve(options.workspace);
if (!fs.existsSync(workspace) || !fs.statSync(workspace).isDirectory()) {
  fail(`工作区目录不存在：${workspace}`);
}
const venv = path.join(workspace, '.deps', 'openhands-v12');
const python = path.join(venv, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const venvUv = path.join(venv, process.platform === 'win32' ? 'Scripts/uv.exe' : 'bin/uv');
const temp = path.join(workspace, '.tmp', 'openhands-install');
const cache = path.join(workspace, '.cache', 'pip-openhands-v12');
const env = {
  ...process.env,
  TEMP: temp, TMP: temp, TMPDIR: temp,
  HOME: path.join(temp, 'home'),
  USERPROFILE: path.join(temp, 'home'),
  APPDATA: path.join(temp, 'appdata'),
  LOCALAPPDATA: path.join(temp, 'localappdata'),
  PIP_CACHE_DIR: cache,
  UV_CACHE_DIR: options.cacheDir ? path.resolve(options.cacheDir) : path.join(workspace, '.cache', 'uv-openhands-v12'),
  PYTHONPYCACHEPREFIX: path.join(temp, 'pycache'),
  PIP_DISABLE_PIP_VERSION_CHECK: '1',
  PIP_NO_INPUT: '1',
  OPENHANDS_SUPPRESS_BANNER: '1',
};
for (const dir of [path.dirname(venv), temp, cache, env.UV_CACHE_DIR, env.HOME, env.APPDATA, env.LOCALAPPDATA, env.PYTHONPYCACHEPREFIX]) {
  fs.mkdirSync(dir, { recursive: true });
}

if (!options.verifyOnly) {
  if (!fs.existsSync(python)) {
    const basePython = options.python || (process.platform === 'win32' ? 'py' : 'python3');
    const baseArgs = options.python ? [] : (process.platform === 'win32' ? ['-3.14'] : []);
    console.log(`[setup-openhands] 创建隔离环境：${venv}`);
    run(basePython, [...baseArgs, '-m', 'venv', venv], env, workspace);
  }
  if (!fs.existsSync(python)) fail(`虚拟环境 Python 不存在：${python}`);
  run(python, ['-c', 'import sys; assert sys.version_info[:2] == (3, 14), "OpenHands Windows lock requires Python 3.14"'], env, workspace);
  let uv = options.uv ? path.resolve(options.uv) : venvUv;
  if (options.uv && !fs.existsSync(uv)) fail(`指定的 uv 不存在：${uv}`);
  if (!fs.existsSync(uv)) {
    console.log('[setup-openhands] 安装固定 uv 0.11.21 到隔离 Python 环境');
    run(python, ['-m', 'pip', 'install', '--only-binary=:all:', 'uv==0.11.21'], env, workspace);
    uv = venvUv;
  }
  if (!fs.existsSync(uv)) fail(`uv 安装后入口不存在：${uv}`);
  console.log(`[setup-openhands] 使用 uv 安装 Windows/Python 3.14 锁定依赖：${LOCK}`);
  run(uv, ['pip', 'install', '--python', python, '--only-binary', 'litellm', '-r', LOCK], env, workspace);
}
if (!fs.existsSync(python)) fail(`尚未安装 OpenHands 隔离环境：${python}`);
const verify = [
  'from importlib.metadata import version',
  'from openhands.sdk import LLM, Conversation',
  'from openhands.tools import get_default_agent',
  'expected = {"openhands-sdk":"1.49.6", "openhands-tools":"1.49.6", "litellm":"1.93.1"}',
  'actual = {name:version(name) for name in expected}',
  'assert actual == expected, f"version mismatch: {actual}"',
  'print("OpenHands SDK dependency versions:", actual)',
].join('\n');
run(python, ['-c', verify], env, workspace);
console.log(`[setup-openhands] 就绪：${python}`);
console.log('[setup-openhands] 登记 profile 时将 --command 指向上面的 Python；bridge 进程需设置 OPENHANDS_LLM_MODEL、OPENHANDS_LLM_API_KEY，以及可选的 OPENHANDS_LLM_BASE_URL。');
