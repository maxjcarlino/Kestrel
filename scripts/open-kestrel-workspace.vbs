' Opens a Kestrel workspace file with no console window at all: runs the Node
' launcher (open-workspace.mjs) hidden, and reports a problem in a message box.
' install-windows.ps1 registers this as the program for .kestrel files, so a
' double-click runs:  wscript.exe "...\open-kestrel-workspace.vbs" "<file>"
' (open-kestrel-workspace.bat does the same job for "Open with", minimized.)
Option Explicit
Dim sh, fso, here, target, code
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)
If WScript.Arguments.Count = 0 Then
  MsgBox "Double-click a Kestrel workspace (.kestrel) file to open it.", vbInformation, "Kestrel"
  WScript.Quit 1
End If
target = WScript.Arguments(0)
code = 0
On Error Resume Next
code = sh.Run("node """ & here & "\open-workspace.mjs"" """ & target & """", 0, True)
If Err.Number <> 0 Then code = 9009
On Error GoTo 0
If code <> 0 Then
  MsgBox "Kestrel could not open:" & vbCrLf & vbCrLf & target & vbCrLf & vbCrLf & _
    "Check that Node.js is installed (nodejs.org) and that the file still exists.", vbExclamation, "Kestrel"
End If
WScript.Quit code
