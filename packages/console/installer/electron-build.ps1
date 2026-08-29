# Pi 控制台 Electron 版构建脚本
#
# 流程：版本同步（读 console package.json）→ 拷贝 src/web/packs/skills → 编译并安装本地 agent
#       → 校验本地 agent → electron-builder 打 NSIS 安装包 → 校验 app.asar
# 产物：中文安装包及供客户端更新使用的 PiConsole-Setup-<version>.exe
#
# 用法：powershell -ExecutionPolicy Bypass -File electron-build.ps1 [-OutputDir dist]
# OutputDir 用于产物目录被占用（如杀软/残留句柄锁定旧 dist）时换目录重构建。

param([string]$OutputDir = "dist")

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

# Electron's installer download runs in a child Node process. Node fetch only
# honors HTTP(S)_PROXY when this switch is present at process startup.
if (-not $env:NODE_USE_ENV_PROXY) { $env:NODE_USE_ENV_PROXY = "1" }

$ElectronDir = Join-Path $PSScriptRoot "electron"
$ConsoleDir = Split-Path $PSScriptRoot -Parent
$RepositoryRoot = (Resolve-Path (Join-Path $ConsoleDir "..\..")).Path
$CodingAgentDir = Join-Path $RepositoryRoot "packages\coding-agent"
$AiDir = Join-Path $RepositoryRoot "packages\ai"

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

function Assert-PathWithin([string]$Parent, [string]$Candidate, [string]$Label) {
	$ParentFull = [IO.Path]::GetFullPath($Parent).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
	$CandidateFull = [IO.Path]::GetFullPath($Candidate)
	$Prefix = $ParentFull + [IO.Path]::DirectorySeparatorChar
	if (-not $CandidateFull.StartsWith($Prefix, [StringComparison]::OrdinalIgnoreCase)) {
		throw "$Label 不在允许目录内：$CandidateFull"
	}
	return $CandidateFull
}

# 3. 先编译当前仓库，再将本地 pi-ai 与 coding-agent 压包安装进 Electron 暂存目录。
# package.json 仍保留 registry 版本用于基础依赖解析；最终实际装入安装包的 AI 与 agent 都必须来自本仓库。
$LocalPackageDir = Join-Path ([System.IO.Path]::GetTempPath()) ("pi-console-local-packages-" + [guid]::NewGuid().ToString("N"))
$LocalAiPackageDir = Join-Path $LocalPackageDir "pi-ai"
$LocalAgentPackageDir = Join-Path $LocalPackageDir "coding-agent"
$LocalAgentCorePackageDir = Join-Path $LocalPackageDir "agent-core"
New-Item -ItemType Directory -Path $LocalAiPackageDir, $LocalAgentPackageDir, $LocalAgentCorePackageDir -Force | Out-Null
try {
    Push-Location $RepositoryRoot
    try {
        & npm.cmd run build:offline
        if ($LASTEXITCODE -ne 0) { throw "本地仓库编译失败" }

		& npm.cmd pack --workspace=@earendil-works/pi-ai --pack-destination $LocalAiPackageDir
		if ($LASTEXITCODE -ne 0) { throw "本地 pi-ai 打包失败" }

		& npm.cmd pack --workspace=@earendil-works/pi-agent-core --pack-destination $LocalAgentCorePackageDir
		if ($LASTEXITCODE -ne 0) { throw "本地 pi-agent-core 打包失败" }

		& npm.cmd pack --workspace=@earendil-works/pi-coding-agent --pack-destination $LocalAgentPackageDir
		if ($LASTEXITCODE -ne 0) { throw "本地 coding-agent 打包失败" }
    } finally {
        Pop-Location
    }

	$LocalAiPackages = @(Get-ChildItem -LiteralPath $LocalAiPackageDir -Filter "*.tgz" -File)
	if ($LocalAiPackages.Count -ne 1) {
		throw "本地 pi-ai 压包数量异常：$($LocalAiPackages.Count)"
	}
	$LocalAiPackage = $LocalAiPackages[0].FullName

	$LocalAgentCorePackages = @(Get-ChildItem -LiteralPath $LocalAgentCorePackageDir -Filter "*.tgz" -File)
	if ($LocalAgentCorePackages.Count -ne 1) {
		throw "本地 pi-agent-core 压包数量异常：$($LocalAgentCorePackages.Count)"
	}
	$LocalAgentCorePackage = $LocalAgentCorePackages[0].FullName

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

		# 一次性安装本地 agent / agent-core / pi-ai 三个压包：
		# 单独安装 agent 会让 agent-core 的 pi-ai 依赖重新解析到 registry 最新版
		# （如 0.84.3），把第二份 pi-ai 提升到根级，破坏打包校验的唯一性约束。
		& npm.cmd install --no-audit --no-fund --no-save --package-lock=false --force $LocalAgentPackage $LocalAgentCorePackage $LocalAiPackage
		if ($LASTEXITCODE -ne 0) { throw "安装本地 coding-agent/pi-agent-core/pi-ai 失败" }

		$InstalledAgentRoot = Join-Path $ElectronDir "node_modules\@earendil-works\pi-coding-agent"
	} finally {
		Pop-Location
	}

	$LocalAgentDist = Join-Path $CodingAgentDir "dist"
	$LocalAiDist = Join-Path $AiDir "dist"
	$InstalledAgentDist = Join-Path $InstalledAgentRoot "dist"
	$InstalledAiParent = Join-Path $InstalledAgentRoot "node_modules\@earendil-works"
	$ResolvedInstalledAgentRoot = (Resolve-Path -LiteralPath $InstalledAgentRoot).Path
	$InstalledAiParent = Assert-PathWithin $ResolvedInstalledAgentRoot ([IO.Path]::GetFullPath($InstalledAiParent)) "pi-ai 依赖父目录创建目标"
	if (-not (Test-Path -LiteralPath $InstalledAiParent -PathType Container)) {
		New-Item -ItemType Directory -Path $InstalledAiParent -Force | Out-Null
	}
	$ResolvedInstalledAiParent = (Resolve-Path -LiteralPath $InstalledAiParent).Path
	Assert-PathWithin $ResolvedInstalledAgentRoot $ResolvedInstalledAiParent "pi-ai 依赖父目录" | Out-Null
	$InstalledAiParent = $ResolvedInstalledAiParent
	$InstalledAiRoot = Join-Path $InstalledAiParent "pi-ai"
	$InstalledAiDist = Join-Path $InstalledAiRoot "dist"
	$InstalledAiRoot = Assert-PathWithin $ResolvedInstalledAgentRoot $InstalledAiRoot "pi-ai 替换目标"
	# npm 可能把 registry pi-ai 去重到 Electron 根 node_modules。此时 nested 目标原本不存在，
	# 无需备份；验证失败只删除新激活的 nested 副本，即恢复到原先由根副本解析的布局。
	$OriginalNestedAiExists = Test-Path -LiteralPath $InstalledAiRoot -PathType Container
	$ResolvedRegistryAiRoot = $null
	if ($OriginalNestedAiExists) {
		$ResolvedRegistryAiRoot = (Resolve-Path -LiteralPath $InstalledAiRoot).Path
		Assert-PathWithin $ResolvedInstalledAgentRoot $ResolvedRegistryAiRoot "registry pi-ai" | Out-Null
	}

	# npm pack 产物只能包含 package/ 下的普通文件或目录。先完成条目与类型预检，
	# 再直接解包到同盘的极短唯一暂存目录，避免 PowerShell Copy-Item 触发 Windows 长路径限制。
	# 必须用 System32 的 bsdtar：PATH 里若有 Git Bash 的 GNU tar，会把 C:\ 路径当成远程主机。
	$TarSource = Join-Path $env:SystemRoot "System32\tar.exe"
	if (-not (Test-Path -LiteralPath $TarSource)) {
		$TarSource = (Get-Command tar.exe -ErrorAction Stop).Source
	}
	$ArchiveEntries = @(& $TarSource -tzf $LocalAiPackage)
	if ($LASTEXITCODE -ne 0 -or $ArchiveEntries.Count -eq 0) { throw "无法读取本地 pi-ai 压包目录" }
	foreach ($Entry in $ArchiveEntries) {
		$NormalizedEntry = "$Entry".Replace('\', '/').Trim()
		$Segments = @($NormalizedEntry.Split('/', [StringSplitOptions]::RemoveEmptyEntries))
		if (
			($NormalizedEntry -ne "package" -and -not $NormalizedEntry.StartsWith("package/", [StringComparison]::Ordinal)) -or
			[IO.Path]::IsPathRooted($NormalizedEntry) -or
			$Segments -contains ".."
		) {
			throw "本地 pi-ai 压包包含越界路径，已拒绝解包"
		}
	}
	$VerboseArchiveEntries = @(& $TarSource -tvzf $LocalAiPackage)
	if ($LASTEXITCODE -ne 0 -or $VerboseArchiveEntries.Count -eq 0) { throw "无法校验本地 pi-ai 压包条目类型" }
	foreach ($Entry in $VerboseArchiveEntries) {
		$Type = "$Entry".TrimStart()[0]
		if ($Type -ne '-' -and $Type -ne 'd') { throw "本地 pi-ai 压包包含链接或特殊条目，已拒绝解包" }
	}

	$InstalledVolumeRoot = [IO.Path]::GetPathRoot($ResolvedInstalledAgentRoot)
	$ShortTempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
	if ($env:RUNNER_TEMP) {
		$RunnerTempRoot = [IO.Path]::GetFullPath($env:RUNNER_TEMP)
		if (
			(Test-Path -LiteralPath $RunnerTempRoot -PathType Container) -and
			[String]::Equals([IO.Path]::GetPathRoot($RunnerTempRoot), $InstalledVolumeRoot, [StringComparison]::OrdinalIgnoreCase)
		) {
			$ShortTempRoot = $RunnerTempRoot
		}
	}
	if (-not [String]::Equals([IO.Path]::GetPathRoot($ShortTempRoot), $InstalledVolumeRoot, [StringComparison]::OrdinalIgnoreCase)) {
		throw "系统与 Runner 临时目录均不在 Electron 暂存卷，无法安全原子替换本地 pi-ai"
	}
	$ResolvedShortTempRoot = (Resolve-Path -LiteralPath $ShortTempRoot).Path
	Assert-PathWithin $InstalledVolumeRoot $ResolvedShortTempRoot "pi-ai 同盘短暂存根目录" | Out-Null
	$ReplacementAiRoot = $null
	try {
		for ($Attempt = 0; $Attempt -lt 16 -and -not $ReplacementAiRoot; $Attempt++) {
			$CandidateAiRoot = Assert-PathWithin $ResolvedShortTempRoot (Join-Path $ResolvedShortTempRoot ("p" + [guid]::NewGuid().ToString("N").Substring(0, 16))) "pi-ai 同盘短暂存目录"
			if (Test-Path -LiteralPath $CandidateAiRoot) { continue }
			$CandidateCreated = $false
			try {
				New-Item -ItemType Directory -Path $CandidateAiRoot -ErrorAction Stop | Out-Null
				$CandidateCreated = $true
				$ReplacementAiRoot = $CandidateAiRoot
				$ReplacementAiRoot = (Resolve-Path -LiteralPath $CandidateAiRoot).Path
				Assert-PathWithin $ResolvedShortTempRoot $ReplacementAiRoot "pi-ai 已创建的同盘短暂存目录" | Out-Null
			} catch {
				if (-not $CandidateCreated -and (Test-Path -LiteralPath $CandidateAiRoot)) { continue }
				throw
			}
		}
		if (-not $ReplacementAiRoot) { throw "无法创建唯一的 pi-ai 同盘短暂存目录" }

		& $TarSource -xzf $LocalAiPackage -C $ReplacementAiRoot --strip-components=1
		if ($LASTEXITCODE -ne 0) { throw "tar.exe 不支持安全去除 package 根目录或解包本地 pi-ai 失败" }
		$SourceAiManifest = Get-Content -Raw -LiteralPath (Join-Path $AiDir "package.json") | ConvertFrom-Json
		$ExtractedAiManifestPath = Join-Path $ReplacementAiRoot "package.json"
		if (-not (Test-Path -LiteralPath $ExtractedAiManifestPath -PathType Leaf)) { throw "本地 pi-ai 压包缺少 package.json" }
		$ExtractedAiManifest = Get-Content -Raw -LiteralPath $ExtractedAiManifestPath | ConvertFrom-Json
		if (
			$ExtractedAiManifest.name -ne "@earendil-works/pi-ai" -or
			$ExtractedAiManifest.version -ne $SourceAiManifest.version
		) {
			throw "本地 pi-ai 压包名称或版本与当前源码不一致"
		}

		$RegistryAiBackupRoot = $null
		for ($Attempt = 0; $Attempt -lt 16 -and -not $RegistryAiBackupRoot; $Attempt++) {
			$CandidateBackupRoot = Assert-PathWithin $ResolvedInstalledAgentRoot (Join-Path $InstalledAiParent (".b" + [guid]::NewGuid().ToString("N").Substring(0, 16))) "pi-ai 回滚目录"
			if (-not (Test-Path -LiteralPath $CandidateBackupRoot)) { $RegistryAiBackupRoot = $CandidateBackupRoot }
		}
		if (-not $RegistryAiBackupRoot) { throw "无法分配唯一的 pi-ai 回滚目录" }
		$ExistingAiDependencies = if ($ResolvedRegistryAiRoot) { Join-Path $ResolvedRegistryAiRoot "node_modules" } else { $null }
		if ($ExistingAiDependencies -and (Test-Path -LiteralPath $ExistingAiDependencies -PathType Container)) {
			$ReplacementAiDependencies = Join-Path $ReplacementAiRoot "node_modules"
			if (Test-Path -LiteralPath $ReplacementAiDependencies) { throw "本地 pi-ai 压包不应携带 node_modules" }
			Copy-Item -LiteralPath $ExistingAiDependencies -Destination $ReplacementAiDependencies -Recurse
		}

		$BackupCreated = $false
		$ReplacementActivated = $false
		try {
			if ($OriginalNestedAiExists) {
				Move-Item -LiteralPath $ResolvedRegistryAiRoot -Destination $RegistryAiBackupRoot
				$BackupCreated = $true
			}
			Move-Item -LiteralPath $ReplacementAiRoot -Destination $InstalledAiRoot
			$ReplacementActivated = $true
			node $Verifier --source-ai-dist $LocalAiDist --installed-ai-dist $InstalledAiDist --installed-agent-root $InstalledAgentRoot
			if ($LASTEXITCODE -ne 0) { throw "Electron 暂存目录中的 pi-ai 不是本地构建或 coding-agent 仍解析到 registry 副本" }
		} catch {
			$ReplacementFailure = $_
			try {
				if ($ReplacementActivated -and (Test-Path -LiteralPath $InstalledAiRoot)) {
					Assert-PathWithin $ResolvedInstalledAgentRoot $InstalledAiRoot "失败的本地 pi-ai" | Out-Null
					Remove-Item -LiteralPath $InstalledAiRoot -Recurse -Force
					$ReplacementActivated = $false
				}
				if ($BackupCreated -and (Test-Path -LiteralPath $RegistryAiBackupRoot)) {
					Move-Item -LiteralPath $RegistryAiBackupRoot -Destination $InstalledAiRoot
					$BackupCreated = $false
				}
			} catch {
				throw "本地 pi-ai 替换失败且 registry 副本自动恢复失败；回滚目录已保留：$RegistryAiBackupRoot"
			}
			throw $ReplacementFailure
		}
		if ($BackupCreated) {
			try {
				Remove-Item -LiteralPath $RegistryAiBackupRoot -Recurse -Force -ErrorAction Stop
				$BackupCreated = $false
			} catch {
				throw "本地 pi-ai 已替换并验证成功，但旧 registry 备份清理失败；已保留可用的本地 pi-ai 与残留备份：$RegistryAiBackupRoot"
			}
		}
		Write-Host "已原子替换并校验 Electron 暂存目录中的本地 pi-ai 与实际解析路径"
	} finally {
		if ($ReplacementAiRoot -and (Test-Path -LiteralPath $ReplacementAiRoot)) {
			Assert-PathWithin $ResolvedShortTempRoot $ReplacementAiRoot "残留 pi-ai 短暂存目录" | Out-Null
			Remove-Item -LiteralPath $ReplacementAiRoot -Recurse -Force
		}
	}

	node $Verifier --source-dist $LocalAgentDist --installed-dist $InstalledAgentDist
    if ($LASTEXITCODE -ne 0) { throw "Electron 暂存目录中的 coding-agent 与本地构建不一致" }
    Write-Host "已校验 Electron 暂存目录中的本地 coding-agent"

    # 4. 生成图标并打包，再从 app.asar 读取关键文件做第二次哈希校验。
    Push-Location $ElectronDir
    try {
        node scripts/generate-icon.js
        & npx.cmd electron-builder --win nsis "--config.directories.output=$OutputDir"
        if ($LASTEXITCODE -ne 0) { throw "electron-builder 失败" }
    } finally {
        Pop-Location
    }

    $PackagedAsar = Join-Path $ElectronDir "$OutputDir\win-unpacked\resources\app.asar"
    if (-not (Test-Path -LiteralPath $PackagedAsar)) { throw "未找到打包结果 $PackagedAsar" }
	node $Verifier --source-dist $LocalAgentDist --asar $PackagedAsar
	if ($LASTEXITCODE -ne 0) { throw "app.asar 中的 coding-agent 与本地构建不一致" }
	Write-Host "已校验 app.asar 中的本地 coding-agent"

	node $Verifier --source-ai-dist $LocalAiDist --asar $PackagedAsar
	if ($LASTEXITCODE -ne 0) { throw "app.asar 中的 pi-ai 与本地构建不一致或仍包含嵌套 registry 副本" }
	Write-Host "已校验 app.asar 中的本地 pi-ai 与 DeepSeek 模型数据"

	node $Verifier --source-electron $ElectronDir --asar $PackagedAsar
	if ($LASTEXITCODE -ne 0) { throw "app.asar 中的可信浏览器控制器与暂存源码不一致" }
	Write-Host "已校验 app.asar 中的可信浏览器控制器"

    $PackagedUnpackedApp = Join-Path $ElectronDir "$OutputDir\win-unpacked\resources\app.asar.unpacked"
    if (-not (Test-Path -LiteralPath $PackagedUnpackedApp)) { throw "未找到解包资源 $PackagedUnpackedApp" }
    node $Verifier --source-console $ConsoleDir --unpacked-app $PackagedUnpackedApp
    if ($LASTEXITCODE -ne 0) { throw "安装包中的控制台关键资源与源码不一致" }
    Write-Host "已校验安装包中的控制台关键资源"
} finally {
	if (Test-Path -LiteralPath $LocalPackageDir) {
		Remove-Item -LiteralPath $LocalPackageDir -Recurse -Force
	}
}

$SetupExe = Join-Path $ElectronDir "$OutputDir\Pi控制台-Setup-$Version.exe"
if (-not (Test-Path $SetupExe)) { throw "未找到产物 $SetupExe" }
$UpdateAsset = Join-Path $ElectronDir "$OutputDir\PiConsole-Setup-$Version.exe"
Copy-Item -LiteralPath $SetupExe -Destination $UpdateAsset -Force
$SizeMb = [math]::Round((Get-Item $SetupExe).Length / 1MB, 1)
Write-Host ""
Write-Host "== 构建完成 =="
Write-Host "产物：$SetupExe（$SizeMb MB）"
Write-Host "更新发布文件：$UpdateAsset"
