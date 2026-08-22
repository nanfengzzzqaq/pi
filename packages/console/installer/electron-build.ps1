# Pi 控制台 Electron 版构建脚本
#
# 流程：版本同步（读 console package.json）→ 拷贝 src/web/packs/skills → 编译并安装本地 agent
#       → 校验本地 agent → electron-builder 打 NSIS 安装包 → 校验 app.asar
# 产物：中文安装包及供客户端更新使用的 PiConsole-Setup-<version>.exe
#
# 用法：powershell -ExecutionPolicy Bypass -File electron-build.ps1

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

# Electron's installer download runs in a child Node process. Node fetch only
# honors HTTP(S)_PROXY when this switch is present at process startup.
if (-not $env:NODE_USE_ENV_PROXY) { $env:NODE_USE_ENV_PROXY = "1" }

$ElectronDir = Join-Path $PSScriptRoot "electron"
$ConsoleDir = Split-Path $PSScriptRoot -Parent
$RepositoryRoot = (Resolve-Path (Join-Path $ConsoleDir "..\..")).Path
$CodingAgentDir = Join-Path $RepositoryRoot "packages\coding-agent"

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
$Verifier = Join-Path $ElectronDir "scripts\verify-local-agent.js"

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

# 3. 先编译当前仓库，再将本地 coding-agent 压包安装进 Electron 暂存目录。
# package.json 仍保留 registry 版本用于依赖解析；最终实际装入安装包的 agent 必须来自本仓库。
$LocalAgentPackageDir = Join-Path ([System.IO.Path]::GetTempPath()) ("pi-console-local-agent-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $LocalAgentPackageDir -Force | Out-Null
try {
    Push-Location $RepositoryRoot
    try {
        & npm.cmd run build:offline
        if ($LASTEXITCODE -ne 0) { throw "本地仓库编译失败" }

        & npm.cmd pack --workspace=@earendil-works/pi-coding-agent --pack-destination $LocalAgentPackageDir
        if ($LASTEXITCODE -ne 0) { throw "本地 coding-agent 打包失败" }
    } finally {
        Pop-Location
    }

    $LocalAgentPackages = @(Get-ChildItem -LiteralPath $LocalAgentPackageDir -Filter "*.tgz" -File)
    if ($LocalAgentPackages.Count -ne 1) {
        throw "本地 coding-agent 压包数量异常：$($LocalAgentPackages.Count)"
    }
    $LocalAgentPackage = $LocalAgentPackages[0].FullName

    Push-Location $ElectronDir
    try {
        & npm.cmd install --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) { throw "npm install 失败" }

		& node --test (Join-Path $ElectronDir "scripts\verify-local-agent.node-test.js")
		if ($LASTEXITCODE -ne 0) { throw "安装包关键资源校验器自测失败" }

        # 校验脚本依赖 Electron 暂存目录安装的 @electron/asar；必须在 npm install 后运行，
        # 否则干净 CI 会在真正开始校验前因模块缺失退出。
        node $Verifier --source-console $ConsoleDir --staged-electron $ElectronDir
        if ($LASTEXITCODE -ne 0) { throw "Electron 暂存目录中的控制台关键资源与源码不一致" }
        Write-Host "已校验 Electron 暂存目录中的控制台关键资源"

        & npm.cmd install --no-audit --no-fund --no-save --package-lock=false --force $LocalAgentPackage
        if ($LASTEXITCODE -ne 0) { throw "安装本地 coding-agent 失败" }
    } finally {
        Pop-Location
    }

    $LocalAgentDist = Join-Path $CodingAgentDir "dist"
    $InstalledAgentDist = Join-Path $ElectronDir "node_modules\@earendil-works\pi-coding-agent\dist"
    node $Verifier --source-dist $LocalAgentDist --installed-dist $InstalledAgentDist
    if ($LASTEXITCODE -ne 0) { throw "Electron 暂存目录中的 coding-agent 与本地构建不一致" }
    Write-Host "已校验 Electron 暂存目录中的本地 coding-agent"

    # 4. 生成图标并打包，再从 app.asar 读取关键文件做第二次哈希校验。
    Push-Location $ElectronDir
    try {
        node scripts/generate-icon.js
        & npx.cmd electron-builder --win nsis
        if ($LASTEXITCODE -ne 0) { throw "electron-builder 失败" }
    } finally {
        Pop-Location
    }

    $PackagedAsar = Join-Path $ElectronDir "dist\win-unpacked\resources\app.asar"
    if (-not (Test-Path -LiteralPath $PackagedAsar)) { throw "未找到打包结果 $PackagedAsar" }
    node $Verifier --source-dist $LocalAgentDist --asar $PackagedAsar
    if ($LASTEXITCODE -ne 0) { throw "app.asar 中的 coding-agent 与本地构建不一致" }
    Write-Host "已校验 app.asar 中的本地 coding-agent"

	node $Verifier --source-electron $ElectronDir --asar $PackagedAsar
	if ($LASTEXITCODE -ne 0) { throw "app.asar 中的可信浏览器控制器与暂存源码不一致" }
	Write-Host "已校验 app.asar 中的可信浏览器控制器"

    $PackagedUnpackedApp = Join-Path $ElectronDir "dist\win-unpacked\resources\app.asar.unpacked"
    if (-not (Test-Path -LiteralPath $PackagedUnpackedApp)) { throw "未找到解包资源 $PackagedUnpackedApp" }
    node $Verifier --source-console $ConsoleDir --unpacked-app $PackagedUnpackedApp
    if ($LASTEXITCODE -ne 0) { throw "安装包中的控制台关键资源与源码不一致" }
    Write-Host "已校验安装包中的控制台关键资源"
} finally {
	if (Test-Path -LiteralPath $LocalAgentPackageDir) {
		Remove-Item -LiteralPath $LocalAgentPackageDir -Recurse -Force
	}
}

$SetupExe = Join-Path $ElectronDir "dist\Pi控制台-Setup-$Version.exe"
if (-not (Test-Path $SetupExe)) { throw "未找到产物 $SetupExe" }
$UpdateAsset = Join-Path $ElectronDir "dist\PiConsole-Setup-$Version.exe"
Copy-Item -LiteralPath $SetupExe -Destination $UpdateAsset -Force
$SizeMb = [math]::Round((Get-Item $SetupExe).Length / 1MB, 1)
Write-Host ""
Write-Host "== 构建完成 =="
Write-Host "产物：$SetupExe（$SizeMb MB）"
Write-Host "更新发布文件：$UpdateAsset"
