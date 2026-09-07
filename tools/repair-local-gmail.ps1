param([string]$Distribution = '')
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
# ASCII preserves Windows PowerShell 5.1 compatibility.
if ('192.168.50.192' -notin @(Get-NetIPAddress -AddressFamily IPv4 | Select-Object -ExpandProperty IPAddress)) {
    throw 'Run this repair on the formal server 192.168.50.192.'
}
$names = @(& wsl.exe --list --quiet | ForEach-Object { ($_ -replace "`0", '').Trim() } |
    Where-Object { $_ -and $_ -notmatch '^docker-desktop' })
if ($LASTEXITCODE -ne 0) { throw 'Cannot list WSL distributions.' }
if (-not $Distribution) {
    if ($names.Count -ne 1) { throw 'Select the application WSL distribution explicitly.' }
    $Distribution = $names[0]
}
if ($Distribution -notin $names) { throw 'Unknown application WSL distribution.' }
$program = Join-Path $PSScriptRoot 'repair-local-gmail.py'
$linuxProgram = (& wsl.exe --distribution $Distribution --exec wslpath -a $program) -join ''
if ($LASTEXITCODE -ne 0 -or -not $linuxProgram.StartsWith('/mnt/')) { throw 'Cannot resolve the repair program.' }
Write-Output 'Gmail SMTP repair: smtp.gmail.com:587 with verified STARTTLS.'
Write-Output 'Enter the sender Gmail address and a Google 16-letter APP PASSWORD.'
Write-Output 'Do not enter your normal Google account password. No email will be sent by this tool.'
$email = Read-Host 'Sender Gmail address'
$securePassword = Read-Host 'Google app password (hidden)' -AsSecureString
$pointer = [IntPtr]::Zero
try {
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
    $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
    $payload = @{email=$email;password=$plain} | ConvertTo-Json -Compress
    # Credentials travel only over stdin, never command arguments or disk files.
    $raw = @($payload | & wsl.exe --distribution $Distribution --user root --exec python3 $linuxProgram 2>$null)
    $repairExit = $LASTEXITCODE
} finally {
    if ($pointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
    $plain = $null; $payload = $null
    $securePassword.Dispose()
}
$root = Join-Path $env:USERPROFILE 'Inspection-maintenance'
[IO.Directory]::CreateDirectory($root) | Out-Null
$reportFile = Join-Path $root 'gmail-repair-latest.json'
try { $report = ($raw -join "`n") | ConvertFrom-Json }
catch { $report = @{status='failed';errorCode='repair-report-unavailable';deliveryTestPerformed=$false}; $repairExit=1 }
[IO.File]::WriteAllText($reportFile, ($report | ConvertTo-Json -Depth 8), (New-Object System.Text.UTF8Encoding($false)))
Write-Output ('Gmail repair status: ' + $report.status)
Write-Output ('Private report saved: ' + $reportFile)
Write-Output 'Refreshing the migration inventory in the same run.'
& (Join-Path $PSScriptRoot 'inspect-local-cutover.ps1') -Distribution $Distribution
$inventoryExit = $LASTEXITCODE
Write-Output ('Gmail repair exit=' + $repairExit + '; inventory exit=' + $inventoryExit)
if ($repairExit -ne 0 -or $inventoryExit -ne 0) { exit 1 }
Write-Output 'Gmail configuration and inventory finished. Recovery email receipt remains to be verified in the website.'
exit 0
