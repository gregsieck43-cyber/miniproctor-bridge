#!/usr/bin/env bash
# miniproctor bridge 安装/升级脚本（macOS / Linux / Git Bash）
#
# 用法：sh setup.sh [源目录] [目标目录]
#   源目录 缺省 = 自动定位（本脚本所在的发行包或源码树；兼容"扁平结构"与"bridge/ 子目录"两种布局）
#   目标目录 缺省 = ~/miniproctor-bridge（用户主目录；也可传第二个参数指定）
#
# 升级保护（TASK-021/E20/E23）：
#   - 目标已存在的 config.json / device.json / data/（含 outbox/inbox）一律保留不覆盖；
#   - config.json 仅补齐缺失字段（调用 node tools/setup-wizard.cjs --fill-missing）；
#   - 程序目录（src/tools/installer 等）按发行包内容替换。
# 安全声明：本脚本不安装、不升级任何全局组件；不请求 sudo。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"

find_bridge_root() {
  # 从脚本目录向上最多两级：本级/上级/上上级，每级先查"扁平"（package.json+src/main.js 就在目录里），
  # 再查"bridge/ 子目录"（源码树布局）。
  local dir="$1" i parent
  for i in 1 2 3; do
    if [ -f "$dir/package.json" ] && [ -f "$dir/src/main.js" ]; then
      printf '%s\n' "$dir"; return 0
    fi
    if [ -f "$dir/bridge/package.json" ] && [ -f "$dir/bridge/src/main.js" ]; then
      printf '%s\n' "$dir/bridge"; return 0
    fi
    parent="$(dirname "$dir")"
    if [ "$parent" = "$dir" ]; then return 1; fi
    dir="$parent"
  done
  return 1
}

# ---- 定位发行源 ----
SOURCE="${1:-}"
if [ -z "$SOURCE" ]; then
  SOURCE="$(find_bridge_root "$SCRIPT_DIR")" || {
    echo "未定位到 bridge 包（需要 package.json + src/main.js）。请把本脚本放在发行包内运行，或传第一个参数指定解压目录。" >&2
    exit 1
  }
fi
if [ ! -f "$SOURCE/src/main.js" ]; then
  echo "源目录无效：$SOURCE（缺少 src/main.js）" >&2
  exit 1
fi
SOURCE="$(cd "$SOURCE" && pwd)"

# ---- Node 版本检查（要求 >=22，建议 v24；不满足明确报错，不自动安装）----
if ! command -v node >/dev/null 2>&1; then
  echo "缺少 Node.js（要求 >=22，建议 v24）。请先安装：https://nodejs.org 。本脚本不会自动安装任何组件。" >&2
  exit 1
fi
NODE_VERSION="$(node --version)"
NODE_MAJOR="$(node -e "process.stdout.write(process.versions.node.split('.')[0])")"
if [ "$NODE_MAJOR" -lt 22 ] 2>/dev/null; then
  echo "Node.js 版本过低：$NODE_VERSION（要求 >=22，建议 v24）。请手动升级后重试；本脚本不会自动安装任何组件。" >&2
  exit 1
fi
echo "[ok] Node.js $NODE_VERSION（要求 >=22；建议 v24 及以上）"

# ---- 安装目标 ----
TARGET="${2:-$HOME/miniproctor-bridge}"
TARGET="$(mkdir -p "$(dirname "$TARGET")" && cd "$(dirname "$TARGET")" && pwd)/$(basename "$TARGET")"
echo "[i] 发行源：$SOURCE"
echo "[i] 安装目标：$TARGET"

# 升级保护快照（复制前记录）
HAD_CFG=0
if [ -f "$TARGET/config.json" ]; then HAD_CFG=1; fi
HAD_DATA=0
if [ -d "$TARGET/data" ]; then HAD_DATA=1; fi
HAD_DEVICE=0
if [ -f "$TARGET/data/device.json" ] || [ -f "$TARGET/device.json" ]; then HAD_DEVICE=1; fi

# ---- 复制程序文件（保护清单永不覆盖）----
IN_PLACE=0
if [ "$SOURCE" = "$TARGET" ]; then IN_PLACE=1; fi

if [ "$IN_PLACE" -eq 0 ]; then
  mkdir -p "$TARGET"
  for entry in "$SOURCE"/*; do
    [ -e "$entry" ] || continue
    name="$(basename "$entry")"
    case "$name" in
      config.json|device.json|data|node_modules|*.log) continue ;;
    esac
    if [ -d "$entry" ]; then
      rm -rf "$TARGET/$name"
      cp -R "$entry" "$TARGET/$name"
    else
      cp -f "$entry" "$TARGET/$name"
    fi
  done
  echo "[ok] 程序文件已复制到 $TARGET（config.json / device.json / data/ / *.log 不参与覆盖）"
else
  echo "[i] 源与目标相同，原地升级模式：只做配置补齐与自检，不复制文件"
fi

# ---- config.json：缺失则建模板；已有则只补缺失字段 ----
CFG="$TARGET/config.json"
EXAMPLE="$TARGET/config.example.json"
if [ ! -f "$CFG" ] && [ -f "$EXAMPLE" ]; then
  cp "$EXAMPLE" "$CFG"
  echo "[ok] 已创建 config.json（默认模板；运行 node tools/setup-wizard.cjs 切到 endpoint 模式，无需任何密钥）"
elif [ -f "$CFG" ]; then
  (cd "$TARGET" && node tools/setup-wizard.cjs --fill-missing)
fi

# ---- 发行完整性校验（RELEASE-MANIFEST.json 逐文件 sha256；失败绝不继续）----
if [ -f "$TARGET/RELEASE-MANIFEST.json" ]; then
  echo "[i] 校验发行文件完整性（RELEASE-MANIFEST.json）..."
  if ! (cd "$TARGET" && node tools/verify-release.cjs --installed "$TARGET"); then
    echo "发行文件完整性校验失败（sha256 不符或文件缺失）。已中止：绝不使用不完整的安装。请重新下载 zip 并重试。" >&2
    exit 1
  fi
fi

# ---- 安装后自检 ----
echo ""
echo "== 安装后自检 =="
if [ -f "$TARGET/src/main.js" ] && [ -f "$TARGET/package.json" ] && [ -f "$TARGET/tools/setup-wizard.cjs" ]; then
  echo "[ok] 入口文件齐全：src/main.js + package.json + tools/setup-wizard.cjs"
else
  echo "入口文件缺失（src/main.js / package.json / tools/setup-wizard.cjs）：$TARGET" >&2
  exit 1
fi

if [ -f "$CFG" ]; then echo "[ok] config.json 存在"; else echo "[warn] config.json 不存在（运行 node tools/setup-wizard.cjs 生成）"; fi

DATA_DIR="$TARGET/data"
mkdir -p "$DATA_DIR"
if touch "$DATA_DIR/.write-test" 2>/dev/null; then
  rm -f "$DATA_DIR/.write-test"
  echo "[ok] 数据目录可写：$DATA_DIR（device.json / outbox / inbox 保存在此）"
else
  echo "数据目录不可写：$DATA_DIR" >&2
  exit 1
fi
if [ "$HAD_DATA" -eq 1 ]; then echo "[ok] 升级保护：已有 data/（outbox/inbox 队列）原样保留"; fi
if [ "$HAD_DEVICE" -eq 1 ]; then
  echo "[ok] 升级保护：已有设备身份 device.json 原样保留（无需重新配对）"
else
  echo "[i] 未配对状态：安装后运行 node src/main.js pair 开始配对"
fi
if [ "$HAD_CFG" -eq 1 ] && [ "$IN_PLACE" -eq 0 ]; then echo "[ok] 升级保护：已有 config.json 仅补齐缺失字段，未覆盖"; fi

# Agent CLI 探测（仅提示，不算失败；真实探测也可运行 node src/main.js doctor 不带参数）
for cli in claude codex; do
  if command -v "$cli" >/dev/null 2>&1; then echo "[i] 检测到 Agent CLI：$cli"; fi
done

(cd "$TARGET" && node src/main.js doctor --no-check-agent)

echo ""
echo "miniproctor bridge 安装完成：$TARGET"
echo "下一步："
echo "  cd \"$TARGET\""
echo "  node tools/setup-wizard.cjs   # 交互式配置（endpoint 模式无需任何密钥）"
echo "  node src/main.js doctor       # 自检（含 Agent CLI 探测）"
echo "  node src/main.js pair         # 生成 6 位配对码，到小程序输入完成绑定"
echo "  node src/main.js run          # 启动常驻服务"
