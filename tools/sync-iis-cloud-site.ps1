# UTF-8 BOM is required: this script is also run by Windows PowerShell 5.1.
param(
    [string]$SiteRoot = 'C:\InspectionRuntime\site\Inspection',
    [string]$StateRoot = 'C:\InspectionRuntime\site-sync',
    [switch]$Apply
)

$ErrorActionPreference = 'Stop'
$repo = 'jnfakimo/Inspection'
$projectRoot = Split-Path $PSScriptRoot -Parent
$sitePath = [IO.Path]::GetFullPath($SiteRoot).TrimEnd('\')
$statePath = [IO.Path]::GetFullPath($StateRoot).TrimEnd('\')
if (-not (Test-Path -LiteralPath (Join-Path $sitePath 'v2\login\index.html'))) {
    throw '找不到既有內網站台，停止同步。'
}
if ($statePath.StartsWith($sitePath + '\', [StringComparison]::OrdinalIgnoreCase)) {
    throw '下載與備份目錄不得位於公開網站內。'
}
[IO.Directory]::CreateDirectory($statePath) | Out-Null
$lock = $null
try {
    $lock = [IO.File]::Open((Join-Path $statePath 'sync.lock'), 'OpenOrCreate', 'ReadWrite', 'None')
    $runsText = & gh run list --repo $repo --workflow hardened-pages.yml --branch main --status success --limit 1 --json databaseId,headSha
    if ($LASTEXITCODE -ne 0) { throw '無法取得雲端部署紀錄。' }
    $runs = @($runsText | ConvertFrom-Json)
    if ($runs.Count -ne 1) { throw '找不到成功的正式部署。' }
    $run = $runs[0]
    $stateFile = Join-Path $statePath 'last-success.json'
    if (Test-Path -LiteralPath $stateFile) {
        $previous = Get-Content -LiteralPath $stateFile -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($previous.commit -eq $run.headSha) { Write-Output '內網已是最新成功部署版本。'; exit 0 }
    }
    # A fresh directory keeps an interrupted prior download from being reused.
    $jobPath = Join-Path $statePath ((Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N'))
    $download = Join-Path $jobPath 'download'
    $release = Join-Path $jobPath 'release'
    [IO.Directory]::CreateDirectory($release) | Out-Null
    & gh run download $run.databaseId --repo $repo -n github-pages -D $download
    if ($LASTEXITCODE -ne 0) { throw '下載正式網站產物失敗。' }
    $archive = Join-Path $download 'artifact.tar'
    $entries = & tar -tf $archive
    if ($LASTEXITCODE -ne 0) { throw '網站封裝無法讀取。' }
    foreach ($entry in $entries) {
        if ($entry -match '(^[/\\]|(^|[/\\])\.\.([/\\]|$)|:)') { throw '網站封裝包含不安全路徑。' }
    }
    & tar -xf $archive -C $release
    if ($LASTEXITCODE -ne 0) { throw '網站封裝解壓失敗。' }
    & node (Join-Path $projectRoot 'tools\verify-provenance.mjs') (Join-Path $release 'provenance.json') (Join-Path $release 'provenance.sig') (Join-Path $projectRoot 'security\provenance-public-key.pem')
    if ($LASTEXITCODE -ne 0) { throw '正式網站來源簽章驗證失敗。' }
    $manifest = Get-Content -LiteralPath (Join-Path $release 'provenance.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($manifest.commit -ne $run.headSha -or $manifest.repository -ne $repo) { throw '網站產物與成功部署版本不符。' }
    $paths = @()
    foreach ($file in $manifest.files) {
        $relative = $file.path.Replace('/', '\')
        $source = [IO.Path]::GetFullPath((Join-Path $release $relative))
        $target = [IO.Path]::GetFullPath((Join-Path $sitePath $relative))
        if (-not $source.StartsWith($release + '\', [StringComparison]::OrdinalIgnoreCase) -or
            -not $target.StartsWith($sitePath + '\', [StringComparison]::OrdinalIgnoreCase) -or
            $relative -match '(^|\\)web\.config$') { throw '產物路徑超出同步範圍。' }
        if ((Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash.ToLowerInvariant() -ne $file.sha256) {
            throw "網站檔案雜湊不符：$relative"
        }
        $paths += $relative
    }
    $paths += @('provenance.json', 'provenance.sig')
    Write-Output "已驗證正式版本 $($run.headSha)，共 $($manifest.files.Count) 個檔案。"
    if (-not $Apply) { Write-Output '試跑完成，尚未寫入內網。'; exit 0 }
    $backup = Join-Path $jobPath 'before'
    # Keep all old bundles: a browser holding an old HTML page can still finish loading.
    # Copy assets first, HTML last. Never mirror/delete directories or touch IIS configuration.
    $ordered = @($paths | Sort-Object -Unique | Sort-Object @{Expression={if ($_ -match '\.html$') { 1 } else { 0 }}})
    foreach ($relative in $ordered) {
        $target = Join-Path $sitePath $relative
        if (Test-Path -LiteralPath $target) {
            $backupFile = Join-Path $backup $relative
            [IO.Directory]::CreateDirectory((Split-Path $backupFile -Parent)) | Out-Null
            Copy-Item -LiteralPath $target -Destination $backupFile
        }
    }
    foreach ($relative in $ordered) {
        $target = Join-Path $sitePath $relative
        [IO.Directory]::CreateDirectory((Split-Path $target -Parent)) | Out-Null
        Copy-Item -LiteralPath (Join-Path $release $relative) -Destination $target -Force
    }
    foreach ($file in $manifest.files) {
        if ((Get-FileHash -LiteralPath (Join-Path $sitePath $file.path) -Algorithm SHA256).Hash.ToLowerInvariant() -ne $file.sha256) {
            throw '內網寫入後雜湊驗證失敗；下次將重新同步，備份已保留。'
        }
    }
    @{commit=$run.headSha;run=$run.databaseId;completed_at=(Get-Date).ToString('o');backup=$backup;files=$manifest.files.Count} |
        ConvertTo-Json | Set-Content -LiteralPath $stateFile -Encoding UTF8
    Write-Output "內網同步完成：$($run.headSha)。"
} catch {
    $_.Exception.Message | Set-Content -LiteralPath (Join-Path $statePath 'last-error.txt') -Encoding UTF8
    throw
} finally {
    if ($lock) { $lock.Dispose() }
}
