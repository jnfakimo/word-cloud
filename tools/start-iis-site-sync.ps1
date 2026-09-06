$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$report = Join-Path $env:USERPROFILE 'Inspection-maintenance\iis-sync-latest.txt'
[IO.Directory]::CreateDirectory((Split-Path $report -Parent)) | Out-Null
try {
    $isTargetHost = @([Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces() |
        ForEach-Object { $_.GetIPProperties().UnicastAddresses } |
        Where-Object { $_.Address.ToString() -eq '192.168.50.192' }).Count -gt 0
    if (-not $isTargetHost) { throw 'Run this update on the server with local IP 192.168.50.192. No site files changed.' }
    $request = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'iis-release-request.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    if ([string]$request.commit -notmatch '^[a-f0-9]{40}$') { throw 'A reviewed release commit is required.' }
    $powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    # Child process keeps the sync script's exit statements from bypassing report handling.
    & $powershell -NoLogo -NoProfile -NonInteractive -File (Join-Path $PSScriptRoot 'sync-iis-cloud-site.ps1') -ExpectedCommit $request.commit -Apply 2>&1 |
        Tee-Object -FilePath $report
    if ($LASTEXITCODE -ne 0) { throw ('IIS sync failed with exit ' + $LASTEXITCODE) }
    $state = Get-Content -LiteralPath 'C:\InspectionRuntime\site-sync\last-success.json' -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($state.commit -ne $request.commit) { throw 'The completion record does not match the reviewed release.' }
    $state | ConvertTo-Json | Add-Content -LiteralPath $report -Encoding UTF8
    Write-Output ('IIS files verified. Report saved: ' + $report)
    Write-Output 'Authenticated browser workflows still require verification.'
} catch {
    $_.Exception.Message | Add-Content -LiteralPath $report -Encoding UTF8
    Write-Error $_
    exit 1
}
