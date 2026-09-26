#!/usr/bin/env bash
# miniproctor bridge 安装/升级脚本（macOS / Linux / Git Bash）
#
# 用法：sh setup.sh [源目录] [目标目录]
#   源目录 缺省 = 自动定位（本脚本所在的发行包或源码树；兼容"扁平结构"与"bridge/ 子目录"两种布局）
#   目标目录 缺省 = ~/miniproctor-bridge（用户主目录；也可传第二个参数指定）
#
# 升级保护（TASK-021/E20/E23；V12-24 原子升级）：
#   - 目标已存在的 config.json / device.json / data/（含 outbox/inbox）一律保留不覆盖；
#   - config.json 仅补齐缺失字段（调用 node tools/setup-wizard.cjs --fill-missing，在暂存目录内进行）；
#   - 先构建暂存目录并做完整性校验（RELEASE-MANIFEST.json 逐文件 sha256），校验通过才切换；
#   - 原子切换 = 旧目录整体改名（<Target>.old-<时间戳>，即 config/设备身份/队列数据的完整备份），
#     暂存目录顶上成为新活动目录；切换失败自动改名还原，旧版照常可运行；
#   - 运行任务提示：bridge 运行时持有 data/bridge.lock（单实例锁），升级前检测到运行中的
#     bridge 会提示"等待或明确结束任务"（§16：不能偷偷中断），交互确认后才继续，非交互直接中止。
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

# 升级保护快照（切换前记录）
HAD_CFG=0
if [ -f "$TARGET/config.json" ]; then HAD_CFG=1; fi
HAD_DATA=0
if [ -d "$TARGET/data" ]; then HAD_DATA=1; fi
HAD_DEVICE=0
if [ -f "$TARGET/data/device.json" ] || [ -f "$TARGET/device.json" ]; then HAD_DEVICE=1; fi

IN_PLACE=0
if [ "$SOURCE" = "$TARGET" ]; then IN_PLACE=1; fi

# ---- 运行任务检查（V12-24 / §16：升级前对运行任务选择等待或明确结束，不能偷偷中断）----
# bridge 运行时持有 data/bridge.lock（单实例锁，CLOSE-010）；锁持有者进程存活 = 可能有任务在跑。
if [ "$HAD_DATA" -eq 1 ] && [ -f "$TARGET/data/bridge.lock" ]; then
  LOCK="$TARGET/data/bridge.lock"
  LOCK_PID="$(node -e 'try{const i=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(String(Number.isInteger(i.pid)?i.pid:""))}catch{}' "$LOCK" 2>/dev/null || true)"
  # 探活用 node process.kill：Git Bash 的 kill -0 看不到原生 Windows pid（2026-09-26 实测），
  # node 的 process.kill(pid,0) 在 Windows/macOS/Linux 三平台语义一致（与 bridge instance-lock 同实现）
  HOLDER_ALIVE=0
  if [ -n "$LOCK_PID" ] && node -e "try{process.kill($LOCK_PID,0);process.exit(0)}catch{process.exit(1)}" 2>/dev/null; then HOLDER_ALIVE=1; fi
  if [ "$HOLDER_ALIVE" -eq 1 ]; then
    echo "[!] 检测到 bridge 正在运行（PID $LOCK_PID，锁 $LOCK）。" >&2
    echo "[!] 升级会中断正在执行的任务。建议先等待任务结束、或到小程序上明确停止任务，并关闭 bridge（node src/main.js run 的窗口 Ctrl+C），再运行本脚本。" >&2
    ANS=""
    if [ -t 0 ]; then
      printf "仍要继续升级吗？（继续将中断运行任务）[y/N] "
      read -r ANS || ANS=""
    fi
    case "$ANS" in
      y|Y) echo "[!] 已确认继续：正在运行的任务可能被中断，请知悉。" >&2 ;;
      *) echo "已取消升级：bridge 正在运行。等待/结束后重试（本脚本未改动任何文件）。" >&2; exit 1 ;;
    esac
  else
    echo "[i] 发现陈旧实例锁（无存活持有者）：升级后由新版本接管清理"
  fi
fi

if [ "$IN_PLACE" -eq 0 ]; then
  # ---- 1) 暂存：程序文件 + 用户数据（config.json/device.json/data 原样带入暂存目录）----
  STAGING="$TARGET.staging"
  if [ -e "$STAGING" ]; then rm -rf "$STAGING"; fi
  mkdir -p "$STAGING"
  for entry in "$SOURCE"/*; do
    [ -e "$entry" ] || continue
    name="$(basename "$entry")"
    case "$name" in
      config.json|device.json|data|node_modules|*.log) continue ;;
    esac
    if [ -d "$entry" ]; then
      cp -R "$entry" "$STAGING/$name"
    else
      cp -f "$entry" "$STAGING/$name"
    fi
  done
  for user_item in config.json device.json data; do
    if [ -e "$TARGET/$user_item" ]; then cp -R "$TARGET/$user_item" "$STAGING/$user_item"; fi
  done
  echo "[ok] 暂存目录就绪：$STAGING（程序文件 + 用户 config.json/device.json/data/ 已带入，未触碰现有安装）"

  # ---- 2) config.json：暂存内缺失则建模板；已有则只补缺失字段（在暂存内做，不触碰现有安装）----
  CFG_STAGE="$STAGING/config.json"
  EXAMPLE_STAGE="$STAGING/config.example.json"
  if [ ! -f "$CFG_STAGE" ] && [ -f "$EXAMPLE_STAGE" ]; then
    cp "$EXAMPLE_STAGE" "$CFG_STAGE"
    echo "[ok] 已创建 config.json（默认模板；运行 node tools/setup-wizard.cjs 切到 endpoint 模式，无需任何密钥）"
  elif [ -f "$CFG_STAGE" ]; then
    (cd "$STAGING" && node tools/setup-wizard.cjs --fill-missing)
  fi

  # ---- 3) 先校验暂存包（RELEASE-MANIFEST.json 逐文件 sha256）；失败绝不切换，现有安装原样 ----
  if [ -f "$STAGING/RELEASE-MANIFEST.json" ]; then
    echo "[i] 校验暂存安装完整性（先于切换；失败即中止，现有安装不受影响）..."
    if ! (cd "$STAGING" && node tools/verify-release.cjs --installed "$STAGING"); then
      rm -rf "$STAGING"
      echo "暂存包完整性校验失败（sha256 不符或文件缺失）。已中止，现有安装未被改动。请重新下载 zip 并重试。" >&2
      exit 1
    fi
  fi

  # ---- 4) 原子切换：旧目录整体改名 = 配置/数据完整备份；暂存顶上成为新活动目录 ----
  if [ -d "$TARGET" ]; then
    STAMP="$(date +%Y%m%d-%H%M%S)"
    BACKUP="$TARGET.old-$STAMP"
    mv "$TARGET" "$BACKUP"
    if ! mv "$STAGING" "$TARGET"; then
      # 切换失败：立即改名还原，保证旧版照常可运行（T17：升级失败旧版可运行）
      mv "$BACKUP" "$TARGET"
      echo "切换到新版本失败。已回滚为原版本，$TARGET 可继续使用。" >&2
      # 暂存目录尽力清理（V12-24 演练 G 发现：若失败原因正是暂存内文件被占用，
      # 此处必然删不掉——绝不因此中断，否则用户看不到上面的可操作回滚提示）
      if rm -rf "$STAGING" 2>/dev/null; then
        echo "[i] 暂存目录已清理。" >&2
      else
        echo "[warn] 暂存目录残留（内有文件被占用）：$STAGING —— 关闭占用该目录的程序后可手动删除，不影响已回滚的旧版本。" >&2
      fi
      exit 1
    fi
    echo "[ok] 已原子切换：新版本 $TARGET"
    echo "[ok] 配置与数据备份：旧版本连同 config.json/device.json/data/ 完整保留于 $BACKUP"
    echo "[i] 回滚方法：关闭 bridge 后，把 $TARGET 改名挪走，再把 $BACKUP 改名回 $TARGET，即可恢复旧版本"
    # 清理更早的历史备份（只保留本次；确认新版运行正常后也可手动删除本备份）
    for old in "$TARGET".old-*; do
      [ -d "$old" ] || continue
      [ "$old" = "$BACKUP" ] && continue
      rm -rf "$old"
    done
  else
    mv "$STAGING" "$TARGET"
    echo "[ok] 全新安装完成：$TARGET"
  fi
else
  echo "[i] 源与目标相同，原地模式：只做配置补齐与自检，不重建目录"
  CFG="$TARGET/config.json"
  EXAMPLE="$TARGET/config.example.json"
  if [ ! -f "$CFG" ] && [ -f "$EXAMPLE" ]; then
    cp "$EXAMPLE" "$CFG"
    echo "[ok] 已创建 config.json（默认模板）"
  elif [ -f "$CFG" ]; then
    (cd "$TARGET" && node tools/setup-wizard.cjs --fill-missing)
  fi
  if [ -f "$TARGET/RELEASE-MANIFEST.json" ]; then
    echo "[i] 校验安装完整性（RELEASE-MANIFEST.json）..."
    if ! (cd "$TARGET" && node tools/verify-release.cjs --installed "$TARGET"); then
      echo "发行文件完整性校验失败（sha256 不符或文件缺失）。已中止：绝不使用不完整的安装。请重新下载 zip 并重试。" >&2
      exit 1
    fi
  fi
fi

CFG="$TARGET/config.json"

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
if [ "$HAD_DATA" -eq 1 ]; then echo "[ok] 升级保护：已有 data/（outbox/inbox 队列）原样带入新目录"; fi
if [ "$HAD_DEVICE" -eq 1 ]; then
  echo "[ok] 升级保护：已有设备身份 device.json 原样带入（无需重新配对）"
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
