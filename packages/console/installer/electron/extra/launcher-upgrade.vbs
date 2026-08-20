Rem Pi Console launcher (upgrade-aware): prefer Electron build, fallback to legacy node+Edge app
Dim fso, sh, electron, electronDir, base, listening, line, exec, i, ready, http, edge
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
base = fso.GetParentFolderName(WScript.ScriptFullName)

Rem Read the actual Electron install directory written by the NSIS installer.
electronDir = ""
On Error Resume Next
electronDir = sh.RegRead("HKCU\Software\pi-console\ElectronInstallDir")
On Error Goto 0
If electronDir <> "" Then
  electron = electronDir & "\PiConsole.exe"
Else
  electron = sh.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\Programs\PiConsole\PiConsole.exe"
  If Not fso.FileExists(electron) Then
    electron = sh.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\Programs\pi-console\PiConsole.exe"
  End If
End If

Rem If Electron build is installed, launch it (upgrade path)
If fso.FileExists(electron) Then
  sh.Run """" & electron & """", 1, False
  WScript.Quit
End If

Rem Legacy mode: node server + Edge app window
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
