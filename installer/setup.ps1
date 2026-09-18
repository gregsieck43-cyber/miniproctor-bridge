# miniproctor bridge 安装/升级脚本（Windows PowerShell 5.1+）
#
# 用法：powershell -NoProfile -ExecutionPolicy Bypass -File setup.ps1 [-Source <解压目录>] [-Target <安装目录>]
#   Source 缺省 = 自动定位（本脚本所在的发行包或源码树；兼容"扁平结构"与"bridge/ 子目录"两种布局）
#   Target  缺省 = $HOME\miniproctor-bridge（用户主目录；也可用 -Target 指定任意目录）
#
# 升级保护（TASK-021/E20/E23）：
#   - 目标已存在的 config.json / device.json / data/（含 outbox/inbox）一律保留不覆盖；
#   - config.json 仅补齐缺失字段（调用 node tools\setup-wizard.cjs --fill-missing）；
#   - 程序目录（src/tools/installer 等）按发行包内容替换。
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

# ---- 复制程序文件（保护清单永不覆盖）----
$protectedNames = @("config.json", "device.json", "data", "node_modules")
if (-not $inPlace) {
  New-Item -ItemType Directory -Force -Path $Target | Out-Null
  foreach ($item in (Get-ChildItem -LiteralPath $Source)) {
    $name = $item.Name
    if ($protectedNames -contains $name -or $name -like "*.log") { continue }
    $dest = Join-Path $Target $name
    if ($item.PSIsContainer) {
      if (Test-Path -LiteralPath $dest) { Remove-Item -LiteralPath $dest -Recurse -Force }
      Copy-Item -LiteralPath $item.FullName -Destination $dest -Recurse -Force
    } else {
      Copy-Item -LiteralPath $item.FullName -Destination $dest -Force
    }
  }
  Write-Host "[ok] 程序文件已复制到 $Target（config.json / device.json / data/ / *.log 不参与覆盖）"
} else {
  Write-Host "[i] 源与目标相同，原地升级模式：只做配置补齐与自检，不复制文件"
}

# ---- config.json：缺失则建模板；已有则只补缺失字段 ----
$cfg = Join-Path $Target "config.json"
$example = Join-Path $Target "config.example.json"
if ((-not (Test-Path -LiteralPath $cfg)) -and (Test-Path -LiteralPath $example)) {
  Copy-Item -LiteralPath $example -Destination $cfg
  Write-Host "[ok] 已创建 config.json（默认模板；运行 node tools\setup-wizard.cjs 切到 endpoint 模式，无需任何密钥）"
} elseif (Test-Path -LiteralPath $cfg) {
  Push-Location $Target
  try { & node tools\setup-wizard.cjs --fill-missing } finally { Pop-Location }
}

# ---- 发行完整性校验（RELEASE-MANIFEST.json 逐文件 sha256；失败绝不继续）----
$manifest = Join-Path $Target "RELEASE-MANIFEST.json"
if (Test-Path -LiteralPath $manifest) {
  Write-Host "[i] 校验发行文件完整性（RELEASE-MANIFEST.json）..."
  Push-Location $Target
  try { & node tools\verify-release.cjs --installed $Target | Write-Host } finally { Pop-Location }
  if ($LASTEXITCODE -ne 0) {
    throw "发行文件完整性校验失败（sha256 不符或文件缺失）。已中止：绝不使用不完整的安装。请重新下载 zip 并重试。"
  }
}

# ---- 安装后自检 ----
Write-Host ""
Write-Host "== 安装后自检 =="
$entryOk = (Test-Path -LiteralPath (Join-Path $Target "src\main.js")) -and (Test-Path -LiteralPath (Join-Path $Target "package.json")) -and (Test-Path -LiteralPath (Join-Path $Target "tools\setup-wizard.cjs"))
if (-not $entryOk) { throw "入口文件缺失（src\main.js / package.json / tools\setup-wizard.cjs）：$Target" }
Write-Host "[ok] 入口文件齐全：src\main.js + package.json + tools\setup-wizard.cjs"

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
if ($hadData) { Write-Host "[ok] 升级保护：已有 data/（outbox/inbox 队列）原样保留" }
if ($hadDevice) { Write-Host "[ok] 升级保护：已有设备身份 device.json 原样保留（无需重新配对）" } else { Write-Host "[i] 未配对状态：安装后运行 node src\main.js pair 开始配对" }
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
