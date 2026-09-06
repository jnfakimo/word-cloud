@echo off
setlocal
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -File "%~dp0repair-wsl-edge-checklist.ps1" -Apply
set "inspectionRepairExit=%errorlevel%"
echo.
if not "%inspectionRepairExit%"=="0" echo Repair stopped. The report is saved in Inspection-maintenance.
if "%inspectionRepairExit%"=="0" echo Repair command completed. Review the saved report for verification.
pause
exit /b %inspectionRepairExit%
