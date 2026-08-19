# Pi 控制台 Electron 版构建脚本
#
# 流程：版本同步（读 console package.json）→ 拷贝 src/web/packs → 安装生产依赖
#       → electron-builder 打 NSIS 安装包
# 产物：installer/electron/dist/Pi控制台-Setup-<version>.exe
#
# 用法：powershell -ExecutionPolicy Bypass -File electron-build.ps1

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$ElectronDir = Join-Path $PSScriptRoot "electron"
$ConsoleDir = Split-Path $PSScriptRoot -Parent

Write-Host "== Pi 控制台 Electron 版构建 =="

# 1. 版本同步（与 packages/console/package.json 一致）
node (Join-Path $PSScriptRoot "sync-version.cjs") (Join-Path $ConsoleDir "package.json") (Join-Path $ElectronDir "package.json")
$Version = (node (Join-Path $PSScriptRoot "get-version.cjs") (Join-Path $ElectronDir "package.json")).Trim()

# 2. 拷贝最新源码
foreach ($Dir in @("src", "web", "packs")) {
    $Target = Join-Path $ElectronDir $Dir
    if (Test-Path $Target) { Remove-Item $Target -Recurse -Force }
    Copy-Item (Join-Path $ConsoleDir $Dir) $Target -Recurse
    Write-Host "已拷贝 $Dir/"
}

# 3. 生产依赖（registry 发布版 SDK；发布版自带 bundle 依赖，但显式声明 typebox 供 packs 引用）
Push-Location $ElectronDir
try {
    cmd /c "npm install --no-audit --no-fund"
    if ($LASTEXITCODE -ne 0) { throw "npm install 失败" }
} finally {
    Pop-Location
}

# 4. 生成图标并打包
Push-Location $ElectronDir
try {
    node scripts/generate-icon.js
    cmd /c "npx electron-builder --win nsis"
    if ($LASTEXITCODE -ne 0) { throw "electron-builder 失败" }
} finally {
    Pop-Location
}

$SetupExe = Join-Path $ElectronDir "dist\Pi控制台-Setup-$Version.exe"
if (-not (Test-Path $SetupExe)) { throw "未找到产物 $SetupExe" }
$SizeMb = [math]::Round((Get-Item $SetupExe).Length / 1MB, 1)
Write-Host ""
Write-Host "== 构建完成 =="
Write-Host "产物：$SetupExe（$SizeMb MB）"
