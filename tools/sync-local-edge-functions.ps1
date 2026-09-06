param(
    [string]$SourceRoot = (Split-Path $PSScriptRoot -Parent),
    [string]$FunctionsRoot = 'C:\supabase-0705\functions',
    [string]$Container = 'supabase_edge_runtime_0705',
    [string]$GatewayUrl = 'http://127.0.0.1:54321',
    [switch]$SkipPull,
    [switch]$Apply
)

# 內網自架 Supabase 的 edge function 更新。
#
# GitHub 的 deploy-edge-functions workflow 只會部署到雲端專案；內網站台
# （1.34.250.22:5057）自 3d36c23d0 起改走本機 Docker Supabase，edge_runtime 容器
# 以唯讀 bind mount 讀 $FunctionsRoot（見 fix-selfhosted-login 的作法），因此
# 每次 supabase/functions/ 有更動，都要在 Docker 主機上跑這支腳本把新版複製過去。
# 預設只試跑（顯示會被更新的檔案），加 -Apply 才真的複製並重啟容器。

$ErrorActionPreference = 'Stop'
$source = [IO.Path]::GetFullPath($SourceRoot).TrimEnd('\')
$functionsSource = Join-Path $source 'supabase\functions'
$target = [IO.Path]::GetFullPath($FunctionsRoot).TrimEnd('\')
if (-not (Test-Path -LiteralPath (Join-Path $functionsSource 'app-api\index.ts'))) {
    throw "找不到來源 $functionsSource\app-api\index.ts；請以 repo 檢出目錄執行。"
}
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    throw '找不到 docker；請在 Docker 主機上執行。'
}
$running = docker ps --format '{{.Names}}' | Where-Object { $_ -eq $Container }
if (-not $running) { throw "容器 $Container 沒有在執行。" }
$mount = (docker inspect $Container | ConvertFrom-Json)[0].Mounts | Where-Object { $_.Destination -match 'functions' } | Select-Object -First 1
if (-not $mount) { throw "容器 $Container 沒有 functions 掛載。" }
Write-Output "容器 functions 掛載：$($mount.Source) -> $($mount.Destination)"

if (-not $SkipPull) {
    & git -C $source fetch --quiet origin main
    if ($LASTEXITCODE -ne 0) { throw '無法取得遠端 main。' }
    $behind = & git -C $source rev-list --count HEAD..origin/main
    if ($LASTEXITCODE -eq 0 -and [int]$behind -gt 0) {
        if ($Apply) {
            & git -C $source pull --ff-only --quiet origin main
            if ($LASTEXITCODE -ne 0) { throw '來源檢出無法快轉到 origin/main，請先處理本機變更。' }
        } else {
            Write-Output "來源檢出落後 origin/main $behind 筆；-Apply 會先快轉更新。"
        }
    }
}
$commit = & git -C $source rev-parse --short HEAD
Write-Output "來源版本：$commit"

# deno check 在主機上不一定有；至少確認 app-api 與 _shared 都在。
foreach ($required in @('app-api\index.ts', '_shared\security-monitor.ts', '_shared\password-policy.ts', '_shared\floor.ts', '_shared\client-ip.ts')) {
    if (-not (Test-Path -LiteralPath (Join-Path $functionsSource $required))) { throw "來源缺少 $required。" }
}

$robocopyArgs = @($functionsSource, $target, '/E', '/XD', 'node_modules', '.branches', '.temp', '/XF', '*.lock', '/NJH', '/NJS', '/NDL', '/NP', '/R:2', '/W:2')
if (-not $Apply) {
    Write-Output '--- 試跑：以下檔案會被更新（加 -Apply 才會寫入並重啟容器） ---'
    & robocopy @robocopyArgs /L
    if ($LASTEXITCODE -ge 8) { throw "robocopy 試跑失敗（$LASTEXITCODE）。" }
    exit 0
}

if (Test-Path -LiteralPath $target) {
    $backup = "$target-backup-" + (Get-Date -Format 'yyyyMMdd-HHmmss')
    & robocopy $target $backup /E /NJH /NJS /NDL /NP /R:1 /W:1 | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "備份現行 functions 失敗（$LASTEXITCODE）。" }
    Write-Output "已備份現行 functions 至 $backup"
}
& robocopy @robocopyArgs | Out-Null
if ($LASTEXITCODE -ge 8) { throw "複製 functions 失敗（$LASTEXITCODE）。" }
$copied = Get-Item -LiteralPath (Join-Path $target 'app-api\index.ts')
$sourceFile = Get-Item -LiteralPath (Join-Path $functionsSource 'app-api\index.ts')
if ($copied.Length -ne $sourceFile.Length) { throw 'app-api/index.ts 複製後大小不符。' }
Write-Output "app-api/index.ts 已更新（$($copied.Length) bytes）"

docker restart $Container | Out-Null
Start-Sleep -Seconds 8

# 驗證：本機 app-api 的市場看板回應要帶品名代碼（495546f 之後的版本才有）。
$anon = $env:SUPABASE_LOCAL_ANON_KEY
if (-not $anon) {
    $envFile = Join-Path (Split-Path $target -Parent) '.env'
    if (Test-Path -LiteralPath $envFile) {
        $line = Get-Content -LiteralPath $envFile | Where-Object { $_ -match '^\s*ANON_KEY\s*=' } | Select-Object -First 1
        if ($line) { $anon = ($line -split '=', 2)[1].Trim().Trim('"').Trim("'") }
    }
}
if (-not $anon) {
    $config = Get-Content -LiteralPath (Join-Path $source 'web\lib\config.ts') -Raw
    if ($config -match "LOCAL_SUPABASE_ANON_KEY = '([^']+)'") { $anon = $matches[1] }
}
if (-not $anon) { Write-Warning '找不到本機 anon key，略過 API 驗證。'; exit 0 }
try {
    $headers = @{ apikey = $anon; Authorization = "Bearer $anon"; 'Content-Type' = 'application/json' }
    $response = Invoke-RestMethod -Method Post -Uri "$GatewayUrl/functions/v1/app-api" -Headers $headers -Body '{"action":"market_board_public"}' -TimeoutSec 90
    $payload = if ($response.PSObject.Properties['data']) { $response.data } else { $response }
    $rows = @($payload.table.rows)
    $withCode = @($rows | Where-Object { $_.code }).Count
    Write-Output "本機 app-api 回應：資料日 $($payload.latest_date)，$($rows.Count) 個品項，$withCode 個有品名代碼。"
    if ($rows.Count -gt 0 -and $withCode -eq 0) { Write-Warning '回應沒有品名代碼，容器可能仍在載入舊版；請查 docker logs。' }
} catch {
    Write-Warning "API 驗證失敗：$($_.Exception.Message)"
    docker logs $Container --tail 25
}
