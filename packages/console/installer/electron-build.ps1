# Pi 控制台 Electron 版构建脚本
#
# 流程：版本同步（读 console package.json）→ 拷贝 src/web/packs/skills → 安装生产依赖
#       → electron-builder 打 NSIS 安装包
# 产物：installer/electron/dist/Pi控制台-Setup-<version>.exe
#
# 用法：powershell -ExecutionPolicy Bypass -File electron-build.ps1

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

# Electron's installer download runs in a child Node process. Node fetch only
# honors HTTP(S)_PROXY when this switch is present at process startup.
if (-not $env:NODE_USE_ENV_PROXY) { $env:NODE_USE_ENV_PROXY = "1" }

$ElectronDir = Join-Path $PSScriptRoot "electron"
$ConsoleDir = Split-Path $PSScriptRoot -Parent

Write-Host "== Pi 控制台 Electron 版构建 =="

# 1. 版本同步（与 packages/console/package.json 一致）
node (Join-Path $PSScriptRoot "sync-version.cjs") (Join-Path $ConsoleDir "package.json") (Join-Path $ElectronDir "package.json")
$Version = (node (Join-Path $PSScriptRoot "get-version.cjs") (Join-Path $ElectronDir "package.json")).Trim()

# 2. 拷贝最新源码
foreach ($Dir in @("src", "web", "packs", "skills")) {
    $Target = Join-Path $ElectronDir $Dir
    if (Test-Path $Target) { Remove-Item $Target -Recurse -Force }
    Copy-Item (Join-Path $ConsoleDir $Dir) $Target -Recurse
    Write-Host "已拷贝 $Dir/"
}

# 2.5 预置 OfficeCLI（必要工具）：优先开发数据目录，其次当前用户已安装副本。
# 只复制到安装包自身，不修改系统 PATH；客户端首启再复制到 %APPDATA% 的外置数据目录。
$BundledBinDir = Join-Path $ElectronDir "data\bin"
if (Test-Path $BundledBinDir) { Remove-Item $BundledBinDir -Recurse -Force }
New-Item -ItemType Directory -Force $BundledBinDir | Out-Null
$OfficeCliCandidates = @(
    (Join-Path $ConsoleDir "data\bin\officecli.exe"),
    (Join-Path $env:APPDATA "pi-console\data\bin\officecli.exe")
)
$OfficeCliSource = $OfficeCliCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $OfficeCliSource) {
    throw "未找到 OfficeCLI。请先在开发客户端的工具页安装，再构建 Windows 安装包。"
}
Copy-Item -LiteralPath $OfficeCliSource (Join-Path $BundledBinDir "officecli.exe")
$OfficeCliRecord = Join-Path (Split-Path $OfficeCliSource -Parent) "officecli.json"
if (Test-Path -LiteralPath $OfficeCliRecord) {
    Copy-Item -LiteralPath $OfficeCliRecord (Join-Path $BundledBinDir "officecli.json")
}
Write-Host "已预置 OfficeCLI：$OfficeCliSource"

# 2.6 预置 Pi 私有 Bash/Git 运行时。
# 使用 Git for Windows 官方 MinGit BusyBox 发行包：它专为第三方应用内嵌，
# 提供 Git、sh 和常用 Unix 命令。只解压进安装包，绝不运行安装器或修改系统 PATH。
$MinGitVersion = "2.55.0.4"
$MinGitSha256 = "255a8d6f43e330817ae1eb2599e153835383cdfb17759c5251318242b03ad3db"
$MinGitUrl = "https://github.com/git-for-windows/git/releases/download/v2.55.0.windows.4/MinGit-2.55.0.4-busybox-64-bit.zip"
$MinGitArchive = Join-Path $env:TEMP "pi-console-MinGit-$MinGitVersion-busybox-64-bit.zip"
$BundledMinGitDir = Join-Path $ElectronDir "data\runtime\mingit"
$ArchiveReady = Test-Path -LiteralPath $MinGitArchive
if ($ArchiveReady) {
    $ArchiveReady = (Get-FileHash -LiteralPath $MinGitArchive -Algorithm SHA256).Hash.ToLowerInvariant() -eq $MinGitSha256
}
if (-not $ArchiveReady) {
    Invoke-WebRequest -UseBasicParsing -Uri $MinGitUrl -OutFile $MinGitArchive
}
$ActualMinGitHash = (Get-FileHash -LiteralPath $MinGitArchive -Algorithm SHA256).Hash.ToLowerInvariant()
if ($ActualMinGitHash -ne $MinGitSha256) {
    throw "MinGit 校验失败：期望 $MinGitSha256，实际 $ActualMinGitHash"
}
if (Test-Path -LiteralPath $BundledMinGitDir) { Remove-Item -LiteralPath $BundledMinGitDir -Recurse -Force }
New-Item -ItemType Directory -Path $BundledMinGitDir -Force | Out-Null
Expand-Archive -LiteralPath $MinGitArchive -DestinationPath $BundledMinGitDir -Force
$BusyBoxPath = Join-Path $BundledMinGitDir "mingw64\bin\busybox.exe"
$PrivateGitPath = Join-Path $BundledMinGitDir "cmd\git.exe"
if (-not (Test-Path -LiteralPath $BusyBoxPath) -or -not (Test-Path -LiteralPath $PrivateGitPath)) {
    throw "MinGit 解压结果不完整：缺少 busybox.exe 或 git.exe"
}
@{
    version = $MinGitVersion
    source = $MinGitUrl
    sha256 = $MinGitSha256
    distribution = "Git for Windows MinGit BusyBox"
} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $BundledMinGitDir "pi-runtime.json") -Encoding utf8
Write-Host "已预置 Pi 私有 Bash/Git：Git for Windows MinGit $MinGitVersion"

# 2.7 预置 Pi 官方 grep/find 所需的 rg/fd。只复制到私有 agent/bin，
# 不修改系统 PATH，也不覆盖电脑已有的同名命令。
$BundledAgentBin = Join-Path $ElectronDir "data\agent\bin"
if (Test-Path -LiteralPath $BundledAgentBin) { Remove-Item -LiteralPath $BundledAgentBin -Recurse -Force }
New-Item -ItemType Directory -Path $BundledAgentBin -Force | Out-Null
$SearchTools = @(
    @{
        Name = "rg.exe"
        Version = "15.2.0"
        Url = "https://github.com/BurntSushi/ripgrep/releases/download/15.2.0/ripgrep-15.2.0-x86_64-pc-windows-msvc.zip"
        Sha256 = "71b2fef860abe467217a538ff31de02f5258807c0129f771846f87bd029aafc5"
        Inner = "ripgrep-15.2.0-x86_64-pc-windows-msvc\rg.exe"
    },
    @{
        Name = "fd.exe"
        Version = "10.4.2"
        Url = "https://github.com/sharkdp/fd/releases/download/v10.4.2/fd-v10.4.2-x86_64-pc-windows-msvc.zip"
        Sha256 = "b2816e506390a89941c63c9187d58a3cc10e9a55f2ef0685f9ea0eccaf7c98c8"
        Inner = "fd-v10.4.2-x86_64-pc-windows-msvc\fd.exe"
    }
)
foreach ($Tool in $SearchTools) {
    $Archive = Join-Path $env:TEMP "pi-console-$($Tool.Name)-$($Tool.Version).zip"
    $Ready = Test-Path -LiteralPath $Archive
    if ($Ready) { $Ready = (Get-FileHash -LiteralPath $Archive -Algorithm SHA256).Hash.ToLowerInvariant() -eq $Tool.Sha256 }
    if (-not $Ready) { Invoke-WebRequest -UseBasicParsing -Uri $Tool.Url -OutFile $Archive }
    $Actual = (Get-FileHash -LiteralPath $Archive -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($Actual -ne $Tool.Sha256) { throw "$($Tool.Name) 校验失败：期望 $($Tool.Sha256)，实际 $Actual" }
    $Extracted = Join-Path $env:TEMP "pi-console-$($Tool.Name)-$($Tool.Version)"
    if (Test-Path -LiteralPath $Extracted) { Remove-Item -LiteralPath $Extracted -Recurse -Force }
    Expand-Archive -LiteralPath $Archive -DestinationPath $Extracted -Force
    Copy-Item -LiteralPath (Join-Path $Extracted $Tool.Inner) (Join-Path $BundledAgentBin $Tool.Name)
    Write-Host "已预置文件搜索工具：$($Tool.Name) $($Tool.Version)"
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
