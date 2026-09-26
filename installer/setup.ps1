# miniproctor bridge 安装/升级脚本（Windows PowerShell 5.1+）
#
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File setup.ps1 [-Source <解压目录>] [-Target <安装目录>]
#   Source 缺省 = 自动定位（本脚本所在的发行包或源码树；兼容"扁平结构"与"bridge/ 子目录"两种布局）
#   Target  缺省 = $HOME\miniproctor-bridge（用户主目录；也可用 -Target 指定任意目录）
#
# 升级保护（TASK-021/E20/E23；V12-24 原子升级）：
#   - 目标已存在的 config.json / device.json / data/（含 outbox/inbox）一律保留不覆盖；
#   - config.json 仅补齐缺失字段（调用 node tools\setup-wizard.cjs --fill-missing，在暂存目录内进行）；
#   - 先构建暂存目录并做完整性校验（RELEASE-MANIFEST.json 逐文件 sha256），校验通过才切换；
#   - 原子切换 = 旧目录整体改名（<Target>.old-<时间戳>，即 config/设备身份/队列数据的完整备份），
#     暂存目录顶上成为新活动目录；切换失败自动改名还原，旧版照常可运行；
#   - 运行任务提示：bridge 运行时持有 data\bridge.lock（单实例锁），升级前检测到运行中的
#     bridge 会提示"等待或明确结束任务"（§16：不能偷偷中断），交互确认后才继续，非交互直接中止。
# 安全声明：本脚本不安装、不升级任何全局组件；不请求管理员权限。
param(
  [string]$Source = "",
  [string]$Target = ""
)
$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

function Find-BridgeRoot([string]$startDir) {
  # 从脚本目录向上最多两级：本级/上级/上上级，每级先查"扁平"（package.json+src/main.js 就在目录里），
  # 再查"bridge/ 子目录"（源码树布局）。
  $dir = $startDir
  for ($i = 0; $i -lt 3; $i++) {
    if ((Test-Path -LiteralPath (Join-Path $dir "package.json")) -and (Test-Path -LiteralPath (Join-Path $dir "src\main.js"))) { return $dir }
    $nested = Join-Path $dir "bridge"
    if ((Test-Path -LiteralPath (Join-Path $nested "package.json")) -and (Test-Path -LiteralPath (Join-Path $nested "src\main.js"))) { return $nested }
    $parent = Split-Path -Parent $dir
    if (-not $parent -or $parent -eq $dir) { break }
    $dir = $parent
  }
  return $null
}

# ---- 定位发行源 ----
if (-not $Source) {
  $Source = Find-BridgeRoot $ScriptDir
  if (-not $Source) {
    throw "未定位到 bridge 包（需要 package.json + src\main.js）。请把本脚本放在发行包内运行，或用 -Source 指定解压目录。"
  }
}
if (-not (Test-Path -LiteralPath (Join-Path $Source "src\main.js"))) {
  throw "Source 无效：$Source（缺少 src\main.js）"
}

# ---- Node 版本检查（要求 >=22，建议 v24；不满足明确报错，不自动安装）----
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw "缺少 Node.js（要求 >=22，建议 v24）。请先安装：https://nodejs.org 。本脚本不会自动安装任何组件。"
}
$nodeVer = (& node --version)
$major = [int](($nodeVer -replace '^v', '').Split('.')[0])
if ($major -lt 22) {
  throw "Node.js 版本过低：$nodeVer（要求 >=22，建议 v24）。请手动升级后重试；本脚本不会自动安装任何组件。"
}
Write-Host "[ok] Node.js $nodeVer（要求 >=22；建议 v24 及以上）"

# ---- 安装目标 ----
if (-not $Target) { $Target = Join-Path $HOME "miniproctor-bridge" }
$Source = [System.IO.Path]::GetFullPath($Source)
$Target = [System.IO.Path]::GetFullPath($Target)
Write-Host "[i] 发行源：$Source"
Write-Host "[i] 安装目标：$Target"

$inPlace = [string]::Equals(
  $Source.TrimEnd('\') + '\',
  $Target.TrimEnd('\') + '\',
  [System.StringComparison]::OrdinalIgnoreCase)

# 升级保护快照（复制前记录）
$hadCfg = Test-Path -LiteralPath (Join-Path $Target "config.json")
$hadData = Test-Path -LiteralPath (Join-Path $Target "data")
$hadDevice = (Test-Path -LiteralPath (Join-Path $Target "data\device.json")) -or (Test-Path -LiteralPath (Join-Path $Target "device.json"))

# ---- 运行任务检查（V12-24 / §16：升级前对运行任务选择等待或明确结束，不能偷偷中断）----
# bridge 运行时持有 data\bridge.lock（单实例锁，CLOSE-010）；锁持有者进程存活 = 可能有任务在跑。
$lockPath = Join-Path $Target "data\bridge.lock"
if (Test-Path -LiteralPath $lockPath) {
  $holderPid = 0
  try {
    $lockInfo = Get-Content -LiteralPath $lockPath -Raw | ConvertFrom-Json
    if ($lockInfo -and $lockInfo.pid) { $holderPid = [int]$lockInfo.pid }
  } catch { $holderPid = 0 }
  $holderAlive = $false
  if ($holderPid -gt 0) {
    try { $null = Get-Process -Id $holderPid -ErrorAction Stop; $holderAlive = $true } catch { $holderAlive = $false }
  }
  if ($holderAlive) {
    Write-Warning "检测到 bridge 正在运行（PID $holderPid，锁 $lockPath）。"
    Write-Warning "升级会中断正在执行的任务。建议先等待任务结束、或到小程序上明确停止任务，并关闭 bridge（运行 node src\main.js run 的窗口按 Ctrl+C），再运行本脚本。"
    $ans = ""
    try { $ans = (Read-Host "仍要继续升级吗？（继续将中断运行任务）[y/N]").Trim().ToLower() } catch { $ans = "" }
    if ($ans -ne "y") { throw "已取消升级：bridge 正在运行。等待/结束后重试（本脚本未改动任何文件）。" }
    Write-Warning "已确认继续：正在运行的任务可能被中断，请知悉。"
  } else {
    Write-Host "[i] 发现陈旧实例锁（无存活持有者）：升级后由新版本接管清理"
  }
}

# 程序文件复制规则：保护清单（用户数据）永不来自发行包
$protectedNames = @("config.json", "device.json", "data", "node_modules")

if (-not $inPlace) {
  # ---- 1) 暂存：程序文件 + 用户数据（config.json/device.json/data 原样带入暂存目录）----
  $staging = "$Target.staging"
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Target) | Out-Null
  if (Test-Path -LiteralPath $staging) { Remove-Item -LiteralPath $staging -Recurse -Force }
  New-Item -ItemType Directory -Force -Path $staging | Out-Null
  foreach ($item in (Get-ChildItem -LiteralPath $Source)) {
    $name = $item.Name
    if ($protectedNames -contains $name -or $name -like "*.log") { continue }
    Copy-Item -LiteralPath $item.FullName -Destination (Join-Path $staging $name) -Recurse -Force
  }
  foreach ($userItem in @("config.json", "device.json", "data")) {
    $src = Join-Path $Target $userItem
    if (Test-Path -LiteralPath $src) { Copy-Item -LiteralPath $src -Destination (Join-Path $staging $userItem) -Recurse -Force }
  }
  Write-Host "[ok] 暂存目录就绪：$staging（程序文件 + 用户 config.json/device.json/data/ 已带入，未触碰现有安装）"

  # ---- 2) config.json：暂存内缺失则建模板；已有则只补缺失字段（在暂存内做，不触碰现有安装）----
  $cfgStage = Join-Path $staging "config.json"
  $exampleStage = Join-Path $staging "config.example.json"
  if ((-not (Test-Path -LiteralPath $cfgStage)) -and (Test-Path -LiteralPath $exampleStage)) {
    Copy-Item -LiteralPath $exampleStage -Destination $cfgStage
    Write-Host "[ok] 已创建 config.json（默认模板；运行 node tools\setup-wizard.cjs 切到 endpoint 模式，无需任何密钥）"
  } elseif (Test-Path -LiteralPath $cfgStage) {
    Push-Location $staging
    try { & node tools\setup-wizard.cjs --fill-missing } finally { Pop-Location }
  }

  # ---- 3) 先校验暂存包（RELEASE-MANIFEST.json 逐文件 sha256）；失败绝不切换，现有安装原样 ----
  $manifestStage = Join-Path $staging "RELEASE-MANIFEST.json"
  if (Test-Path -LiteralPath $manifestStage) {
    Write-Host "[i] 校验暂存安装完整性（先于切换；失败即中止，现有安装不受影响）..."
    Push-Location $staging
    try { & node tools\verify-release.cjs --installed $staging | Write-Host } finally { Pop-Location }
    if ($LASTEXITCODE -ne 0) {
      Remove-Item -LiteralPath $staging -Recurse -Force
      throw "暂存包完整性校验失败（sha256 不符或文件缺失）。已中止，现有安装未被改动。请重新下载 zip 并重试。"
    }
  }

  # ---- 4) 原子切换：旧目录整体改名 = 配置/数据完整备份；暂存顶上成为新活动目录 ----
  # 改名必须用 [System.IO.Directory]::Move（同卷真改名、失败不建目标）；PowerShell 的
  # Move-Item 在目标不存在时会退化成「建目录 + 逐文件复制」，撞上被占用文件即留下半套
  # 新版本、并让随后的还原把备份嵌套进半成品目录（V12-24 演练 G7 实测复现）。
  if (Test-Path -LiteralPath $Target) {
    $stamp = (Get-Date).ToString("yyyyMMdd-HHmmss")
    $backupDir = "$Target.old-$stamp"
    [System.IO.Directory]::Move($Target, $backupDir)
    try {
      [System.IO.Directory]::Move($staging, $Target)
    } catch {
      # 切换失败：立即改名还原，保证旧版照常可运行（T17：升级失败旧版可运行）。
      # 还原前清掉任何半成品目标（防御式：真改名不应产生，若产生则归档会嵌套错位）。
      if (Test-Path -LiteralPath $Target) { Remove-Item -LiteralPath $Target -Recurse -Force -ErrorAction SilentlyContinue }
      [System.IO.Directory]::Move($backupDir, $Target)
      Write-Warning "切换到新版本失败（$($_.Exception.Message)）。已回滚为原版本，$Target 可继续使用。"
      # 暂存目录尽力清理（V12-24 演练 G 发现：失败原因若正是暂存内文件被占用，
      # 此处必然删不掉——绝不因此中断，否则用户看不到上面的可操作回滚提示）
      try {
        if (Test-Path -LiteralPath $staging) { Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction Stop }
        Write-Host "[i] 暂存目录已清理。"
      } catch {
        Write-Warning "暂存目录残留（内有文件被占用）：$staging —— 关闭占用该目录的程序后可手动删除，不影响已回滚的旧版本。"
      }
      exit 1
    }
    Write-Host "[ok] 已原子切换：新版本 $Target"
    Write-Host "[ok] 配置与数据备份：旧版本连同 config.json/device.json/data/ 完整保留于 $backupDir"
    Write-Host "[i] 回滚方法：关闭 bridge 后，把 $Target 改名挪走，再把 $backupDir 改名回 $Target，即可恢复旧版本"
    # 清理更早的历史备份（只保留本次；确认新版运行正常后也可手动删除本备份）
    Get-ChildItem -LiteralPath (Split-Path -Parent $Target) -Directory -Filter ((Split-Path -Leaf $Target) + ".old-*") |
      Where-Object { $_.FullName -ne $backupDir } |
      Remove-Item -Recurse -Force
  } else {
    [System.IO.Directory]::Move($staging, $Target)
    Write-Host "[ok] 全新安装完成：$Target"
  }
} else {
  Write-Host "[i] 源与目标相同，原地模式：只做配置补齐与自检，不重建目录"
  $cfg = Join-Path $Target "config.json"
  $example = Join-Path $Target "config.example.json"
  if ((-not (Test-Path -LiteralPath $cfg)) -and (Test-Path -LiteralPath $example)) {
    Copy-Item -LiteralPath $example -Destination $cfg
    Write-Host "[ok] 已创建 config.json（默认模板）"
  } elseif (Test-Path -LiteralPath $cfg) {
    Push-Location $Target
    try { & node tools\setup-wizard.cjs --fill-missing } finally { Pop-Location }
  }
  $manifest = Join-Path $Target "RELEASE-MANIFEST.json"
  if (Test-Path -LiteralPath $manifest) {
    Write-Host "[i] 校验安装完整性（RELEASE-MANIFEST.json）..."
    Push-Location $Target
    try { & node tools\verify-release.cjs --installed $Target | Write-Host } finally { Pop-Location }
    if ($LASTEXITCODE -ne 0) {
      throw "发行文件完整性校验失败（sha256 不符或文件缺失）。已中止：绝不使用不完整的安装。请重新下载 zip 并重试。"
    }
  }
}

# ---- 安装后自检 ----
Write-Host ""
Write-Host "== 安装后自检 =="
$entryOk = (Test-Path -LiteralPath (Join-Path $Target "src\main.js")) -and (Test-Path -LiteralPath (Join-Path $Target "package.json")) -and (Test-Path -LiteralPath (Join-Path $Target "tools\setup-wizard.cjs"))
if (-not $entryOk) { throw "入口文件缺失（src\main.js / package.json / tools\setup-wizard.cjs）：$Target" }
Write-Host "[ok] 入口文件齐全：src\main.js + package.json + tools\setup-wizard.cjs"

$cfg = Join-Path $Target "config.json"
if (Test-Path -LiteralPath $cfg) { Write-Host "[ok] config.json 存在" } else { Write-Host "[warn] config.json 不存在（运行 node tools\setup-wizard.cjs 生成）" }

try {
  $dataDir = Join-Path $Target "data"
  New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
  $probe = Join-Path $dataDir ".write-test"
  Set-Content -LiteralPath $probe -Value "ok"
  Remove-Item -LiteralPath $probe -Force
  Write-Host "[ok] 数据目录可写：$dataDir（device.json / outbox / inbox 保存在此）"
} catch {
  throw "数据目录不可写：$($_.Exception.Message)"
}
if ($hadData) { Write-Host "[ok] 升级保护：已有 data/（outbox/inbox 队列）原样带入新目录" }
if ($hadDevice) { Write-Host "[ok] 升级保护：已有设备身份 device.json 原样带入（无需重新配对）" } else { Write-Host "[i] 未配对状态：安装后运行 node src\main.js pair 开始配对" }
if ($hadCfg -and -not $inPlace) { Write-Host "[ok] 升级保护：已有 config.json 仅补齐缺失字段，未覆盖" }

# Agent CLI 探测（仅提示，不算失败；真实探测也可运行 node src\main.js doctor 不带参数）
foreach ($cli in @("claude", "codex")) {
  if (Get-Command $cli -ErrorAction SilentlyContinue) { Write-Host "[i] 检测到 Agent CLI：$cli" }
}

Push-Location $Target
try { & node src\main.js doctor --no-check-agent } finally { Pop-Location }

Write-Host ""
Write-Host "miniproctor bridge 安装完成：$Target"
Write-Host "下一步："
Write-Host "  cd '$Target'"
Write-Host "  node tools\setup-wizard.cjs   # 交互式配置（endpoint 模式无需任何密钥）"
Write-Host "  node src\main.js doctor       # 自检（含 Agent CLI 探测）"
Write-Host "  node src\main.js pair         # 生成 6 位配对码，到小程序输入完成绑定"
Write-Host "  node src\main.js run          # 启动常驻服务"
