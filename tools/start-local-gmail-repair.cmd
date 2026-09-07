@echo off
setlocal
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -File "%~dp0repair-local-gmail.ps1"
set "inspection_result=%ERRORLEVEL%"
echo.
echo Gmail repair finished with exit code %inspection_result%.
echo Report: %USERPROFILE%\Inspection-maintenance\gmail-repair-latest.json
pause
exit /b %inspection_result%
