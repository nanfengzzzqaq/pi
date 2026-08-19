Rem Pi Console launcher (upgrade-aware): prefer Electron build, fallback to legacy node+Edge app
Dim fso, sh, electron, base, listening, line, exec, i, ready, http, edge
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
base = fso.GetParentFolderName(WScript.ScriptFullName)

Rem Electron 版已安装则直接启动（升级衔接）
electron = sh.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\Programs\PiConsole\PiConsole.exe"
If fso.FileExists(electron) Then
  sh.Run """" & electron & """", 1, False
  WScript.Quit
End If

Rem 以下为旧版（node 服务 + Edge 独立窗口）逻辑
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
