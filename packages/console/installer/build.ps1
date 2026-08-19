# Pi 控制台 Windows 安装包构建脚本
#
# 产物：out/Pi控制台-Setup-<version>.exe
# 运行时组成：官方 Node 绿色版 node.exe + 独立 app 目录（npm 生产依赖）+ OfficeCLI 预置 + 启动器
# 打包机要求：Windows x64 + Node/npm（构建用）；NSIS 与运行时 Node 均由本脚本自动下载
#
# 用法：pwsh -File build.ps1   （或 powershell -ExecutionPolicy Bypass -File build.ps1）

$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$ProgressPreference = "SilentlyContinue"

# ---------------------------------------------------------------------------
# 配置（版本写死，保证可复现）
# ---------------------------------------------------------------------------

$NodeVersion = "v24.19.0"                                                    # Node 24 LTS (Krypton)
$NodeZipUrl = "https://nodejs.org/dist/$NodeVersion/node-$NodeVersion-win-x64.zip"
$NodeShasumsUrl = "https://nodejs.org/dist/$NodeVersion/SHASUMS256.txt"
$NsisVersion = "3.11"
$NsisZipUrl = "https://sourceforge.net/projects/nsis/files/NSIS%203/$NsisVersion/nsis-$NsisVersion.zip/download"

# ---------------------------------------------------------------------------
# 路径
# ---------------------------------------------------------------------------

$InstallerDir = $PSScriptRoot
$ConsoleDir = Split-Path $InstallerDir -Parent
$Staging = Join-Path $InstallerDir "staging"
$OutDir = Join-Path $InstallerDir "out"
$ToolsDir = Join-Path $InstallerDir ".tools"

$Version = (Get-Content (Join-Path $ConsoleDir "package.json") | ConvertFrom-Json).version
Write-Host "== Pi 控制台安装包构建 v$Version =="

# ---------------------------------------------------------------------------
# 工具函数
# ---------------------------------------------------------------------------

function Get-FileChecked([string]$Url, [string]$Dest) {
    Write-Host "下载 $Url"
    # 优先用系统自带 curl.exe：对 SourceForge 这类多级 302/JS 中转更可靠
    $curl = Get-Command curl.exe -ErrorAction SilentlyContinue
    if ($curl) {
        & $curl.Source -L --fail --retry 3 -S -o $Dest $Url
        if ($LASTEXITCODE -eq 0 -and (Test-Path $Dest) -and (Get-Item $Dest).Length -gt 0) { return }
        Write-Host "curl 下载未成功（exit=$LASTEXITCODE），改用 Invoke-WebRequest 重试"
    }
    Invoke-WebRequest -Uri $Url -OutFile $Dest -UseBasicParsing -UserAgent "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"
    if (-not (Test-Path $Dest) -or (Get-Item $Dest).Length -eq 0) {
        throw "下载失败：$Url"
    }
}

# ---------------------------------------------------------------------------
# 1. 清理
# ---------------------------------------------------------------------------

# 目录被其他进程占用（如资源管理器/终端停在里面）时只清内容，不让构建硬失败
foreach ($dir in @($Staging, $OutDir)) {
    if (Test-Path $dir) {
        try {
            Remove-Item $dir -Recurse -Force -ErrorAction Stop
        } catch {
            Get-ChildItem $dir -Force -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
            Write-Host "目录被占用，已尽量清空内容：$dir"
        }
    }
}
New-Item -ItemType Directory -Path $Staging, $OutDir, (Join-Path $Staging "node") -Force | Out-Null

# ---------------------------------------------------------------------------
# 2. 运行时 Node（官方绿色版，只取 node.exe，SHA256 校验）
# ---------------------------------------------------------------------------

$ToolsNodeDir = Join-Path $ToolsDir "node-$NodeVersion"
$NodeExe = Join-Path $ToolsNodeDir "node.exe"
if (-not (Test-Path $NodeExe)) {
    New-Item -ItemType Directory -Path $ToolsNodeDir -Force | Out-Null
    $ZipPath = Join-Path $ToolsNodeDir "node.zip"
    Get-FileChecked $NodeZipUrl $ZipPath

    # 校验：node-vX-win-x64.zip 在 SHASUMS256.txt 里有一行
    $SumsPath = Join-Path $ToolsNodeDir "SHASUMS256.txt"
    Get-FileChecked $NodeShasumsUrl $SumsPath
    $ZipName = "node-$NodeVersion-win-x64.zip"
    $sumLine = Select-String -Path $SumsPath -SimpleMatch $ZipName | Select-Object -First 1
    if (-not $sumLine) { throw "SHASUMS256.txt 里找不到 $ZipName" }
    $expected = $sumLine.Line.Trim().Split(" ")[0]
    $actual = (Get-FileHash $ZipPath -Algorithm SHA256).Hash.ToLower()
    if ($actual -ne $expected.ToLower()) { throw "Node zip SHA256 校验失败：expected=$expected actual=$actual" }
    Write-Host "Node $NodeVersion SHA256 校验通过"

    Expand-Archive -Path $ZipPath -DestinationPath $ToolsNodeDir -Force
    Copy-Item (Join-Path $ToolsNodeDir "node-$NodeVersion-win-x64\node.exe") $NodeExe -Force
    Remove-Item $ZipPath -Force
}
Copy-Item $NodeExe (Join-Path $Staging "node\node.exe")
Write-Host "已放置运行时 Node $NodeVersion"

# ---------------------------------------------------------------------------
# 3. app 目录（源码 + registry 生产依赖）
# ---------------------------------------------------------------------------

$AppDir = Join-Path $Staging "app"
New-Item -ItemType Directory -Path $AppDir | Out-Null
Copy-Item (Join-Path $ConsoleDir "src") (Join-Path $AppDir "src") -Recurse
Copy-Item (Join-Path $ConsoleDir "web") (Join-Path $AppDir "web") -Recurse
Copy-Item (Join-Path $ConsoleDir "packs") (Join-Path $AppDir "packs") -Recurse

# 从 npm registry 拉发布版 SDK（版本与 monorepo 开发时一致或更新，这里锁定 registry 最新）
# 注意：npm 在 monorepo 里会往输出里混 workspace 警告，只取形如 x.y.z 的版本行
function Get-NpmVersionLine([string[]]$Lines) {
    foreach ($l in $Lines) {
        if ("$l" -match '^\s*(\d+(\.\d+)+\S*)\s*$') { return $Matches[1] }
    }
    return $null
}
$SdkVersion = Get-NpmVersionLine (npm view "@earendil-works/pi-coding-agent" version)
if (-not $SdkVersion) { throw "无法查询 @earendil-works/pi-coding-agent 的 registry 版本" }
Write-Host "SDK（npm registry）：@earendil-works/pi-coding-agent@$SdkVersion"

# 发布版 SDK 把依赖打包在自身 node_modules 里；packs/ 里的代码 import "typebox"
# 需要它在 app/node_modules 根上可解析，因此显式声明为直接依赖（版本对齐 SDK 所用）
$TypeboxVersion = Get-NpmVersionLine (npm view "@earendil-works/pi-coding-agent@$SdkVersion" dependencies.typebox)
if (-not $TypeboxVersion) { $TypeboxVersion = "1.3.7" }

$appPackageJson = @{
    name     = "pi-console-app"
    version  = $Version
    private  = $true
    type     = "module"
    dependencies = @{
        "@earendil-works/pi-coding-agent" = $SdkVersion
        "typebox"                         = $TypeboxVersion
        "undici"                          = "8.9.0"
    }
} | ConvertTo-Json
# 无 BOM 写入（仓库的 check:pinned-deps 会全树扫描 package.json，BOM 会导致 JSON.parse 失败）
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[IO.File]::WriteAllText((Join-Path $AppDir "package.json"), $appPackageJson, $Utf8NoBom)

Write-Host "npm install --omit=dev（staging/app）"
Push-Location $AppDir
try {
    # 用 cmd /c 包裹：npm 的 stderr 警告不进入 PS 管道（$ErrorActionPreference=Stop 会误判为异常）
    cmd /c "npm install --omit=dev --no-audit --no-fund"
    if ($LASTEXITCODE -ne 0) { throw "npm install 失败" }
} finally {
    Pop-Location
}

# TS 源码直接以 Node 原生 type-stripping 运行（Node >= 22.18 默认启用），无需 tsx

# ---------------------------------------------------------------------------
# 4. 预置 OfficeCLI（装完即用）
# ---------------------------------------------------------------------------

$BinDir = Join-Path $ConsoleDir "data\bin"
$OfficeCliExe = Join-Path $BinDir "officecli.exe"
$OfficeCliJson = Join-Path $BinDir "officecli.json"
if (-not (Test-Path $OfficeCliExe)) {
    throw "缺少 $OfficeCliExe —— 先在开发环境运行服务并点击页面上的下载按钮，或手动放置后再打包"
}
New-Item -ItemType Directory -Path (Join-Path $AppDir "data\bin") -Force | Out-Null
Copy-Item $OfficeCliExe (Join-Path $AppDir "data\bin\officecli.exe")
if (Test-Path $OfficeCliJson) { Copy-Item $OfficeCliJson (Join-Path $AppDir "data\bin\officecli.json") }
Write-Host "已预置 OfficeCLI"

# ---------------------------------------------------------------------------
# 5. 启动器
# ---------------------------------------------------------------------------

# 调试启动器：可见控制台窗口（看日志用）。内容保持 ASCII，避免代码页问题。
$Bat = @'
@echo off
setlocal
rem Pi Console debug launcher (visible window)
set "PI_CONSOLE_DATA=%APPDATA%\pi-console\data"
set "PORT=3200"

rem If port 3200 is already listening, just open the browser (prevents double instances)
netstat -ano | findstr /C:":3200" | findstr /C:"LISTENING" >nul 2>&1
if %errorlevel%==0 (
  start "" http://127.0.0.1:3200
  exit /b 0
)

echo Starting Pi Console...
echo Data dir: %PI_CONSOLE_DATA%
echo Press Ctrl+C to stop.
"%~dp0node\node.exe" "%~dp0app\src\server.ts"
pause
'@
Set-Content -Path (Join-Path $Staging "Pi控制台.bat") -Value $Bat -Encoding ASCII

# 日常启动器：隐藏窗口运行 + 轮询就绪后以 Edge App 模式打开独立客户端窗口
# （无地址栏/标签页的独立窗口；找不到 Edge 时回退默认浏览器）。内容保持 ASCII。
$Vbs = @'
Rem Pi Console launcher: hidden server + standalone app window (Edge --app mode)
Dim base, sh, exec, line, listening, i, ready, http, edge
Set sh = CreateObject("WScript.Shell")
Dim fso
Set fso = CreateObject("Scripting.FileSystemObject")
base = fso.GetParentFolderName(WScript.ScriptFullName)

Rem Locate Edge (typical install paths)
edge = ""
If fso.FileExists(sh.ExpandEnvironmentStrings("%ProgramFiles(x86)%") & "\Microsoft\Edge\Application\msedge.exe") Then
  edge = sh.ExpandEnvironmentStrings("%ProgramFiles(x86)%") & "\Microsoft\Edge\Application\msedge.exe"
ElseIf fso.FileExists(sh.ExpandEnvironmentStrings("%ProgramFiles%") & "\Microsoft\Edge\Application\msedge.exe") Then
  edge = sh.ExpandEnvironmentStrings("%ProgramFiles%") & "\Microsoft\Edge\Application\msedge.exe"
End If

Sub OpenAppWindow()
  If edge <> "" Then
    sh.Run """" & edge & """ --app=http://127.0.0.1:3200/ --window-size=1280,860", 1, False
  Else
    sh.Run "http://127.0.0.1:3200", 1, False
  End If
End Sub

listening = False
Set exec = sh.Exec("cmd /c netstat -ano | findstr " & Chr(34) & ":3200" & Chr(34))
Do While Not exec.StdOut.AtEndOfStream
  line = exec.StdOut.ReadLine()
  If InStr(line, "LISTENING") > 0 Then listening = True
Loop

If listening Then
  OpenAppWindow
Else
  sh.Environment("PROCESS")("PI_CONSOLE_DATA") = sh.ExpandEnvironmentStrings("%APPDATA%") & "\pi-console\data"
  sh.Environment("PROCESS")("PORT") = "3200"
  sh.Run """" & base & "\node\node.exe"" """ & base & "\app\src\server.ts""", 0, False
  ready = False
  For i = 1 To 60
    WScript.Sleep 1000
    On Error Resume Next
    Set http = CreateObject("MSXML2.ServerXMLHTTP")
    http.Open "GET", "http://127.0.0.1:3200/", False
    http.Send ""
    If Err.Number = 0 Then
      If http.Status = 200 Then ready = True
    End If
    On Error Goto 0
    If ready Then Exit For
  Next
  OpenAppWindow
End If
'@
# 两个 vbs 内容一致（均为 Edge App 独立窗口模式）：
# launcher.vbs 供新快捷方式使用；Pi控制台.vbs 兼容旧版本安装留下的快捷方式
Set-Content -Path (Join-Path $Staging "launcher.vbs") -Value $Vbs -Encoding ASCII
Set-Content -Path (Join-Path $Staging "Pi控制台.vbs") -Value $Vbs -Encoding ASCII
Write-Host "已生成启动器（Pi控制台.bat / launcher.vbs / Pi控制台.vbs 兼容旧版）"

# ---------------------------------------------------------------------------
# 6. NSIS 便携版
# ---------------------------------------------------------------------------

$Makensis = Join-Path $ToolsDir "nsis-$NsisVersion\Bin\makensis.exe"
if (-not (Test-Path $Makensis)) {
    Write-Host "下载 NSIS $NsisVersion 便携版"
    New-Item -ItemType Directory -Path $ToolsDir -Force | Out-Null
    $NsisZip = Join-Path $ToolsDir "nsis-$NsisVersion.zip"
    Get-FileChecked $NsisZipUrl $NsisZip
    # SourceForge 直链是 302 跳转，Invoke-WebRequest 默认跟随；若拿到 HTML 而非 zip 则提示手动放置
    $bytes = [IO.File]::ReadAllBytes($NsisZip)
    $isZip = ($bytes.Length -gt 100000 -and $bytes[0] -eq 0x50 -and $bytes[1] -eq 0x4B)
    if (-not $isZip) {
        throw "NSIS 下载失败（拿到的不是 zip）。请手动下载 nsis-$NsisVersion.zip 解压到 $ToolsDir 后重试"
    }
    Expand-Archive -Path $NsisZip -DestinationPath $ToolsDir -Force
    Remove-Item $NsisZip -Force
}
if (-not (Test-Path $Makensis)) {
    throw "找不到 makensis（$Makensis）。请手动放置 NSIS 便携版后重试"
}

# ---------------------------------------------------------------------------
# 7. 编译安装包
# ---------------------------------------------------------------------------

Write-Host "makensis 编译中…"
& $Makensis "/DVERSION=$Version" "/DSTAGING=$Staging" (Join-Path $InstallerDir "installer.nsi")
if ($LASTEXITCODE -ne 0) { throw "makensis 编译失败" }

$SetupExe = Join-Path $OutDir "Pi控制台-Setup-$Version.exe"
if (-not (Test-Path $SetupExe)) { throw "未找到产物 $SetupExe" }
$SizeMb = [math]::Round((Get-Item $SetupExe).Length / 1MB, 1)
Write-Host ""
Write-Host "== 构建完成 =="
Write-Host "产物：$SetupExe（$SizeMb MB）"
