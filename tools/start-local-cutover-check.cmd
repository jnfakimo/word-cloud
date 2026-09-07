@echo off
setlocal
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -File "%~dp0inspect-local-cutover.ps1"
set "inspection_result=%ERRORLEVEL%"
echo.
echo Read-only check finished with exit code %inspection_result%.
echo Report: %USERPROFILE%\Inspection-maintenance\local-cutover-latest.json
pause
exit /b %inspection_result%
