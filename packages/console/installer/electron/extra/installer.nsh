; 升级衔接：安装完成后，把旧版（vbs 模式）安装目录的 launcher.vbs 改写为
; "Electron 优先" 版本，旧版点击更新后重启时自动进入 Electron。
!macro customInstall
  ; 记录 Electron 的真实安装位置，供旧版 VBS 迁移桥接和故障诊断使用。
  WriteRegStr HKCU "Software\pi-console" "ElectronInstallDir" "$INSTDIR"
  ReadRegStr $0 HKCU "Software\pi-console" "InstallDir"
  StrCmp $0 "" skipUpgrade
  IfFileExists "$0\launcher.vbs" 0 skipUpgrade
  CopyFiles "$INSTDIR\extra\launcher-upgrade.vbs" "$0\launcher.vbs"
skipUpgrade:
!macroend
