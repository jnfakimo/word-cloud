@echo off
setlocal
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -File "%~dp0start-iis-site-sync.ps1"
set "inspectionSyncExit=%errorlevel%"
echo.
if not "%inspectionSyncExit%"=="0" echo Update stopped. Review Inspection-maintenance\iis-sync-latest.txt.
if "%inspectionSyncExit%"=="0" echo IIS update completed. Authenticated browser checks are still required.
pause
exit /b %inspectionSyncExit%
