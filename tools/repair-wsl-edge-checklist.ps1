param([string]$Distribution = '', [switch]$Apply)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$wsl = Get-Command wsl.exe -ErrorAction Stop
$names = @(& $wsl.Source --list --quiet | ForEach-Object { ($_ -replace "`0", '').Trim() } | Where-Object { $_ })
if ($LASTEXITCODE -ne 0) { throw 'Cannot list WSL distributions.' }
if (-not $Distribution) {
    $candidates = @($names | Where-Object { $_ -notmatch '^docker-desktop(?:-data)?$' })
    if ($candidates.Count -ne 1) { throw 'Specify -Distribution with the application WSL name.' }
    $Distribution = $candidates[0]
}
if ($Distribution -notin $names) { throw 'Unknown WSL distribution.' }
$scriptFile = Join-Path $PSScriptRoot 'repair-wsl-edge-checklist.sh'
$script = [IO.File]::ReadAllText($scriptFile)
$mode = if ($Apply) { '1' } else { '0' }
$report = Join-Path $env:USERPROFILE 'Inspection-maintenance\edge-repair-latest.txt'
[IO.Directory]::CreateDirectory((Split-Path $report -Parent)) | Out-Null
# Fixed script on stdin preserves its quotes under Windows PowerShell 5.1.
$script | & $wsl.Source --distribution $Distribution --user root --exec sh -c "tr -d '\r' | sh -s -- $mode 2>&1" 2>&1 | Tee-Object -FilePath $report
$result = $LASTEXITCODE
Write-Output ('Report saved: ' + $report)
if ($result -ne 0) { throw ('WSL repair failed (exit ' + $result + '). Review the saved report before proceeding.') }

# Refresh the read-only inventory after a successful apply.
if ($Apply) { & (Join-Path $PSScriptRoot 'inspect-wsl-edge-runtime.ps1') -Distribution $Distribution }
