@echo off
setlocal

set "SCRIPT_DIR=%~dp0"
set "PWSH=%SystemRoot%\System32\WindowsPowerShell\v1.0\pwsh.exe"

if exist "%ProgramFiles%\PowerShell\7\pwsh.exe" (
    set "PWSH=%ProgramFiles%\PowerShell\7\pwsh.exe"
) else if exist "%ProgramFiles(x86)%\PowerShell\7\pwsh.exe" (
    set "PWSH=%ProgramFiles(x86)%\PowerShell\7\pwsh.exe"
) else if exist "%LocalAppData%\Microsoft\WindowsApps\pwsh.exe" (
    set "PWSH=%LocalAppData%\Microsoft\WindowsApps\pwsh.exe"
) else if exist "%SystemRoot%\System32\pwsh.exe" (
    set "PWSH=%SystemRoot%\System32\pwsh.exe"
)

if not exist "%PWSH%" (
    echo [error] PowerShell 7 (pwsh.exe) が見つかりませんでした。
    echo         https://learn.microsoft.com/powershell/scripting/install/installing-powershell を参照して PowerShell 7 を導入してください。
    exit /b 1
)

"%PWSH%" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%install-windows-native-host.ps1" %*
exit /b %ERRORLEVEL%
