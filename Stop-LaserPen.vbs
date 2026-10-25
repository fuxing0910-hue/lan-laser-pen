Option Explicit
Dim files, shell, scriptPath, command
Set files = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
scriptPath = files.BuildPath(files.GetParentFolderName(WScript.ScriptFullName), "scripts\launch.ps1")
command = "powershell.exe -NoProfile -STA -ExecutionPolicy Bypass -File """ & scriptPath & """ -Action Stop"
shell.Run command, 0, False
