#!/usr/bin/env bash
# miniproctor doctor：一键只读体检（不修改任何配置）。
# 检查项（TASK-021 ⑥）：Node 版本 / 入口可执行 / config.json / 数据目录可写 /
# outbox·inbox 队列与配对状态 / Agent CLI 真实探测 / bridge 自身 doctor / 发行完整性。
#
# 用法：sh miniproctor-doctor.sh [bridge目录]
#   缺省自动定位（兼容"扁平结构"发行包与"bridge/ 子目录"源码树）。
# 退出码：0 = 无 fail 项；1 = 有 fail 项。
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
FAILS=0

find_bridge_root() {
  local dir="$1" i parent
  for i in 1 2 3; do
    if [ -f "$dir/package.json" ] && [ -f "$dir/src/main.js" ]; then printf '%s\n' "$dir"; return 0; fi
    if [ -f "$dir/bridge/package.json" ] && [ -f "$dir/bridge/src/main.js" ]; then printf '%s\n' "$dir/bridge"; return 0; fi
    parent="$(dirname "$dir")"
    if [ "$parent" = "$dir" ]; then return 1; fi
    dir="$parent"
  done
  return 1
}

pass() { echo "[ok]   $*"; }
warn() { echo "[warn] $*"; }
fail() { echo "[FAIL] $*"; FAILS=$((FAILS + 1)); }

echo "== miniproctor doctor =="

BRIDGE="${1:-}"
if [ -z "$BRIDGE" ]; then
  BRIDGE="$(find_bridge_root "$SCRIPT_DIR")" || BRIDGE=""
fi
if [ -z "$BRIDGE" ] || [ ! -f "$BRIDGE/src/main.js" ]; then
  fail "未定位到 bridge 目录（需要 package.json + src/main.js）；可传参数指定"
  BRIDGE=""
fi

# 1. Node 版本
if command -v node >/dev/null 2>&1; then
  NODE_VERSION="$(node --version 2>/dev/null || echo N/A)"
  NODE_MAJOR="$(node -e "process.stdout.write(process.versions.node.split('.')[0])" 2>/dev/null || echo 0)"
  if [ "$NODE_MAJOR" -ge 22 ] 2>/dev/null; then
    pass "Node.js $NODE_VERSION（要求 >=22；建议 v24）"
  else
    fail "Node.js $NODE_VERSION 低于 22（建议 v24）：bridge 无法运行"
  fi
else
  fail "未找到 node 命令（要求 >=22，建议 v24）"
  NODE_VERSION="N/A"
fi

if [ -n "$BRIDGE" ]; then
  echo "[i]   bridge: $BRIDGE"

  # 2. 入口可执行
  if [ -f "$BRIDGE/package.json" ] && [ -f "$BRIDGE/src/main.js" ] && [ -f "$BRIDGE/tools/setup-wizard.cjs" ]; then
    pass "入口文件齐全：package.json + src/main.js + tools/setup-wizard.cjs"
  else
    fail "入口文件缺失（package.json / src/main.js / tools/setup-wizard.cjs）"
  fi

  # 3. config 完整性
  if [ -f "$BRIDGE/config.json" ]; then
    if node -e "JSON.parse(require('node:fs').readFileSync(process.argv[1],'utf8'))" "$BRIDGE/config.json" 2>/dev/null; then
      pass "config.json 存在且为合法 JSON"
    else
      fail "config.json 不是合法 JSON"
    fi
  else
    warn "config.json 不存在：运行 node tools/setup-wizard.cjs 生成（endpoint 模式无需任何密钥）"
  fi

  # 4. 数据目录可写 + outbox/inbox/配对状态
  DATA_DIR="$BRIDGE/data"
  if [ -d "$DATA_DIR" ]; then
    if touch "$DATA_DIR/.doctor-write-test" 2>/dev/null; then
      rm -f "$DATA_DIR/.doctor-write-test"
      pass "数据目录可写：$DATA_DIR"
    else
      fail "数据目录不可写：$DATA_DIR"
    fi
  else
    warn "数据目录不存在（首次 pair/run 时创建）：$DATA_DIR"
  fi
  if [ -f "$DATA_DIR/device.json" ]; then
    pass "配对状态：已配对（data/device.json 存在）"
  else
    warn "配对状态：未配对（运行 node src/main.js pair 开始配对）"
  fi
  for q in outbox inbox; do
    if [ -d "$DATA_DIR/$q" ]; then
      CNT="$(ls -1 "$DATA_DIR/$q" 2>/dev/null | wc -l | tr -d ' ')"
      echo "[i]   持久队列 $q：$CNT 个条目"
    fi
  done

  # 5. 发行完整性（仅发行包安装含 RELEASE-MANIFEST.json；源码树自动跳过）
  if [ -f "$BRIDGE/RELEASE-MANIFEST.json" ]; then
    if (cd "$BRIDGE" && node tools/verify-release.cjs --installed "$BRIDGE" >/dev/null 2>&1); then
      pass "发行完整性：RELEASE-MANIFEST.json 逐文件 sha256 全部一致"
    else
      fail "发行完整性：发行文件被改动或缺失（详见 node tools/verify-release.cjs --installed $BRIDGE）"
    fi
  else
    echo "[i]   RELEASE-MANIFEST.json 不存在（源码树运行，跳过发行完整性校验）"
  fi

  # 6. Agent CLI 真实探测（仅提示；完整探测见下方 bridge doctor 不带 --no-check-agent）
  for cli in claude codex; do
    if command -v "$cli" >/dev/null 2>&1; then
      pass "Agent CLI 可达：$cli ($(command -v "$cli"))"
    else
      echo "[i]   Agent CLI 未安装：$cli（可选；未配对与 CLI 缺失不影响 doctor ok）"
    fi
  done

  # 7. bridge 自身 doctor（含 node 版本/凭据/配对判定；CLI 探测失败不算 fail，故用 --no-check-agent）
  if command -v node >/dev/null 2>&1; then
    echo "[i]   bridge doctor："
    if (cd "$BRIDGE" && node src/main.js doctor --no-check-agent); then
      :
    else
      fail "bridge doctor 执行失败（上方 JSON 中 ok:false 的项需处理）"
    fi
  fi
fi

echo "== 结论 =="
if [ "$FAILS" -eq 0 ]; then
  echo "[ok] 无 fail 项。"
  exit 0
else
  echo "[FAIL] $FAILS 项 fail，请按上方输出处理。"
  exit 1
fi
