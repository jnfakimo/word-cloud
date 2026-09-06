param(
    [string]$Distribution = '',
    [string]$ReportPath = (Join-Path $env:USERPROFILE 'Inspection-maintenance\local-runtime-latest.txt')
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# Read-only deployment diagnostics. No environment values, credentials, business
# records, container restarts, or filesystem mutations are requested from WSL.
$wslCommand = Get-Command wsl.exe -ErrorAction Stop
$distributions = @(& $wslCommand.Source --list --quiet | ForEach-Object {
    ($_ -replace "`0", '').Trim()
} | Where-Object { $_ })
if ($LASTEXITCODE -ne 0) { throw 'Cannot list WSL distributions.' }
if ($distributions.Count -eq 0) { throw 'No WSL distribution is registered for this Windows user.' }
Write-Output ('Registered WSL distributions: ' + ($distributions -join ', '))
if (-not $Distribution) {
    $candidates = @($distributions | Where-Object { $_ -notmatch '^docker-desktop(?:-data)?$' })
    if ($candidates.Count -ne 1) {
        throw 'Multiple or no application distributions found. Run again with -Distribution using a listed name.'
    }
    $Distribution = $candidates[0]
}
if ($Distribution -notin $distributions) { throw 'The requested distribution is not registered.' }
Write-Output ('Inspecting distribution: ' + $Distribution)

$diagnostic = @'
set -eu
printf 'Docker runtime containers (names and images only):\n'
docker ps --format '{{.Names}} {{.Image}}'
containers=$(docker ps --format '{{.Names}} {{.Image}}' | awk '$2 ~ /^supabase\/edge-runtime:/ { print $1 }')
if [ -z "$containers" ]; then
  printf 'No running supabase/edge-runtime container found. No changes made.\n' >&2
  exit 2
fi
for container in $containers; do
  printf '\nEdge container: %s\n' "$container"
  docker inspect --format 'State={{.State.Status}} Image={{.Config.Image}}' "$container"
  printf 'Mount source -> destination:\n'
  docker inspect --format '{{range .Mounts}}{{println .Source "->" .Destination}}{{end}}' "$container"
  printf 'Migration configuration presence (values never printed):\n'
  docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$container" |
    awk -F= 'BEGIN { count=split("CWA_API_KEY CRON_SECRET LINE_CHANNEL_SECRET LINE_NOTIFY_WEBHOOK_SECRET GOOGLE_CALENDAR_CLIENT_ID GOOGLE_CALENDAR_CLIENT_SECRET GOOGLE_CALENDAR_REDIRECT_URI GOOGLE_TOKEN_ENCRYPTION_KEY FIREBASE_SERVICE_ACCOUNT_B64 FIREBASE_PROJECT_ID", names, " "); for(i=1;i<=count;i++) wanted[names[i]]=1 } wanted[$1] { state[$1]=(length($0)>length($1)+1 ? "set" : "empty") } END { for(i=1;i<=count;i++) print names[i] "=" (names[i] in state ? state[names[i]] : "missing") }'
  docker exec "$container" sh -c '
    set -eu
    root=/home/deno/functions
    if [ ! -d "$root" ]; then
      printf "Standard functions path is absent; inspect the mounts above.\n"
      exit 0
    fi
    printf "Deployed function entry hashes:\n"
    find "$root" -mindepth 2 -maxdepth 2 -type f -name index.ts -exec sha256sum {} \;
    for file in admin-api/index.ts admin-api/board-notices.ts app-api/index.ts app-api/market-board-notices.ts official-document-timeout-check/index.ts; do
      if [ -f "$root/$file" ]; then
        sha256sum "$root/$file"
      else
        printf "Not present: %s\n" "$file"
      fi
    done
  '
done
if docker ps --format '{{.Names}}' | grep -qx 'supabase-db'; then
  printf '\nLocal PostgreSQL read-only aggregate inventory (row estimates are not exact counts):\n'
  docker exec -i supabase-db psql -X -v ON_ERROR_STOP=1 -U postgres -d postgres -At <<'SQL'
BEGIN READ ONLY;
SET LOCAL statement_timeout = '30s';
SELECT 'PUBLIC_TABLE|' || c.relname || '|rls=' || c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' ORDER BY c.relname;
SELECT 'ROW_ESTIMATE|' || relname || '|' || n_live_tup FROM pg_stat_user_tables WHERE schemaname='public' ORDER BY relname;
SELECT 'AUTH_USERS|' || count(*) FROM auth.users;
SELECT 'STORAGE_OBJECTS|' || count(*) FROM storage.objects;
SELECT 'STORAGE_BUCKET|' || id || '|public=' || public FROM storage.buckets ORDER BY id;
SELECT 'PG_CRON_INSTALLED|' || count(*) FROM pg_extension WHERE extname='pg_cron';
COMMIT;
SQL
fi
printf '\nRead-only inspection complete. No deployment performed.\n'
'@

# Explicit root is needed to inspect Docker; the fixed shell program above only
# reads container metadata, application file hashes and database aggregate counts.
# Pass the program on stdin so Windows PowerShell 5.1 cannot strip its embedded
# quotes while serializing native command arguments. Normalize pipe CRLF in WSL.
$report = [IO.Path]::GetFullPath($ReportPath)
[IO.Directory]::CreateDirectory((Split-Path $report -Parent)) | Out-Null
$diagnostic | & $wslCommand.Source --distribution $Distribution --user root --exec sh -c "tr -d '\r' | sh" 2>&1 |
    Tee-Object -FilePath $report
$inspectionExit = $LASTEXITCODE
Write-Output ('Report saved: ' + $report)
if ($inspectionExit -ne 0) { throw "WSL runtime inspection failed (exit $inspectionExit). No deployment was requested." }
