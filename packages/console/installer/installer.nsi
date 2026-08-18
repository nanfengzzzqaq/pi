; Pi 控制台 Windows 安装脚本（NSIS 3.x）
; 安装到 $LOCALAPPDATA\Programs\pi-console（无需管理员权限）
; 数据目录 %APPDATA%\pi-console\data 由启动器使用，卸载时保留
;
; 编译：makensis /DVERSION=<x.y.z> /DSTAGING=<staging 绝对路径> installer.nsi

!define APPNAME "Pi 控制台"
!define APPID "pi-console"
!define HOMEPAGE "https://github.com/nanfengzzzqaq/pi"

Unicode true
ManifestDPIAware true

Name "${APPNAME}"
OutFile "out\Pi控制台-Setup-${VERSION}.exe"
InstallDir "$LOCALAPPDATA\Programs\${APPID}"
InstallDirRegKey HKCU "Software\${APPID}" "InstallDir"
RequestExecutionLevel user

;--------------------------------
; 版本信息

VIProductVersion "${VERSION}.0"
VIAddVersionKey /LANG=2052 "ProductName" "${APPNAME}"
VIAddVersionKey /LANG=2052 "FileDescription" "${APPNAME} 安装程序"
VIAddVersionKey /LANG=2052 "FileVersion" "${VERSION}"
VIAddVersionKey /LANG=2052 "LegalCopyright" ""

;--------------------------------
; 界面

!include "MUI2.nsh"

!define MUI_ABORTWARNING
!define MUI_ICON "${NSISDIR}\Contrib\Graphics\Icons\modern-install.ico"
!define MUI_UNICON "${NSISDIR}\Contrib\Graphics\Icons\modern-uninstall.ico"

!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "SimpChinese"

;--------------------------------
; 安装

Section "Install"
  SetOutPath "$INSTDIR"

  ; staging 内容：node\、app\、两个启动器（vbs 用 ASCII 文件名，更新链 cmd 调用时不受代码页影响）
  File /r "${STAGING}\node"
  File /r "${STAGING}\app"
  File "${STAGING}\Pi控制台.bat"
  File "${STAGING}\launcher.vbs"

  ; 开始菜单 + 桌面快捷方式（指向 launcher.vbs：隐藏窗口并自动开客户端窗口）
  CreateDirectory "$SMPROGRAMS\${APPNAME}"
  CreateShortcut "$SMPROGRAMS\${APPNAME}\${APPNAME}.lnk" "$INSTDIR\launcher.vbs" "" "$INSTDIR\launcher.vbs"
  CreateShortcut "$SMPROGRAMS\${APPNAME}\卸载 ${APPNAME}.lnk" "$INSTDIR\Uninstall.exe"
  CreateShortcut "$DESKTOP\${APPNAME}.lnk" "$INSTDIR\launcher.vbs" "" "$INSTDIR\launcher.vbs"

  ; 注册卸载信息（当前用户）
  WriteRegStr HKCU "Software\${APPID}" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APPID}" "DisplayName" "${APPNAME}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APPID}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APPID}" "DisplayIcon" "$INSTDIR\Uninstall.exe"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APPID}" "UninstallString" "$INSTDIR\Uninstall.exe"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APPID}" "URLInfoAbout" "${HOMEPAGE}"
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APPID}" "NoModify" 1
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APPID}" "NoRepair" 1

  WriteUninstaller "$INSTDIR\Uninstall.exe"
SectionEnd

;--------------------------------
; 卸载

Section "Uninstall"
  ; 卸载向导提示数据位置（数据保留，不删 %APPDATA%\pi-console）
  MessageBox MB_OK|MB_ICONINFORMATION "将删除程序文件。$\r$\n$\r$\n你的数据（会话、设置、OfficeCLI）保存在：$APPDATA\pi-console\data$\r$\n如需彻底清理，请手动删除该目录。"

  Delete "$DESKTOP\${APPNAME}.lnk"
  RMDir /r "$SMPROGRAMS\${APPNAME}"
  RMDir /r "$INSTDIR"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APPID}"
  DeleteRegKey HKCU "Software\${APPID}"
SectionEnd
