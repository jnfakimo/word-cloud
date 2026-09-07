param([string]$Distribution = '')
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# ASCII for Windows PowerShell 5.1. This collector never installs/starts jobs.
$localAddresses = @(Get-NetIPAddress -AddressFamily IPv4 | Select-Object -ExpandProperty IPAddress)
if ('192.168.50.192' -notin $localAddresses) {
    throw 'Run this collector on the formal host 192.168.50.192.'
}
$reportRoot = Join-Path $env:USERPROFILE 'Inspection-maintenance'
[IO.Directory]::CreateDirectory($reportRoot) | Out-Null
$report = [ordered]@{ collectedAt=(Get-Date).ToString('o'); mode='read-only'; cutoverComplete=$false }
$tasks = @()
try {
    foreach ($task in @(Get-ScheduledTask)) {
        $actionText = ($task.Actions | ForEach-Object {
            # Windows also has COM-handler tasks; their action has no Execute.
            if ($_.PSObject.Properties['Execute']) {
                $arguments = if ($_.PSObject.Properties['Arguments']) { [string]$_.Arguments } else { '' }
                [string]$_.Execute + ' ' + $arguments
            }
        }) -join ' '
        if (($task.TaskName + ' ' + $actionText) -notmatch '(?i)inspection|supabase|/opt/inspection|run-local-market') { continue }
        $info = Get-ScheduledTaskInfo -TaskName $task.TaskName -TaskPath $task.TaskPath
        $triggerTypes = @($task.Triggers | ForEach-Object { $_.CimClass.CimClassName })
        $sha = [Security.Cryptography.SHA256]::Create()
        try { $actionHash = ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($actionText)))).Replace('-','').ToLowerInvariant() }
        finally { $sha.Dispose() }
        $tasks += [ordered]@{ name=$task.TaskName; state=[string]$task.State; enabled=$task.Settings.Enabled;
            triggerTypes=$triggerTypes; logonType=[string]$task.Principal.LogonType;
            lastRun=$info.LastRunTime.ToString('o'); nextRun=$info.NextRunTime.ToString('o');
            lastResult=$info.LastTaskResult; actionSha256=$actionHash;
            referencesCloud=($actionText -match '\.supabase\.co');
            rebootExecutionVerified=$false }
    }
    $report.windowsTasks = @{status='collected';evidence=$tasks}
} catch { $report.windowsTasks = @{status='unavailable';errorType=$_.Exception.GetType().Name} }

try {
    $distributions = @(& wsl.exe --list --quiet | ForEach-Object { ($_ -replace "`0", '').Trim() } | Where-Object { $_ -and $_ -notmatch '^docker-desktop' })
    if ($LASTEXITCODE -ne 0) { throw 'WSL distribution listing failed.' }
    if (-not $Distribution) {
        if ($distributions.Count -ne 1) { throw 'Select a registered application distribution explicitly.' }
        $Distribution = $distributions[0]
    }
    if ($Distribution -notin $distributions) { throw 'Distribution is not registered.' }
    $program = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'inspect-local-cutover.py'))
    # Script stdin avoids PowerShell 5.1 native-argument quote corruption.
    # Suppress raw WSL stderr: it can contain host details; JSON records safe errors.
    $raw = @($program | & wsl.exe --distribution $Distribution --user root --exec sh -c "tr -d '\r' | python3 - 2>/dev/null")
    $wslExit = $LASTEXITCODE
    $report.wsl = ($raw -join "`n") | ConvertFrom-Json
    $report.wslExit = $wslExit
} catch { $report.wsl = @{status='unavailable';errorType=$_.Exception.GetType().Name}; $report.wslExit=2 }

$report.pending = @('Cloud/local keyed data comparison','Auth migration and login verification',
    'Storage byte hashes and readback','Isolated full restore','Single scheduler cutover',
    'Reboot execution evidence','Weather and notification functional checks')
$reportFile = Join-Path $reportRoot 'local-cutover-latest.json'
$encoding = New-Object System.Text.UTF8Encoding($false)
[IO.File]::WriteAllText($reportFile, ($report | ConvertTo-Json -Depth 12), $encoding)
Write-Output ('Read-only report saved: ' + $reportFile)
Write-Output 'This report does not perform deployment, migration, restore or notification delivery.'
if ($report.wslExit -ne 0 -or $report.windowsTasks.status -ne 'collected') {
    throw 'One or more evidence sections are unavailable. Review the saved report.'
}
