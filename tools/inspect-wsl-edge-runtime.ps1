param(
    [string]$Distribution = ''
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
  docker exec "$container" sh -c '
    set -eu
    root=/home/deno/functions
    if [ ! -d "$root" ]; then
      printf "Standard functions path is absent; inspect the mounts above.\n"
      exit 0
    fi
    for file in admin-api/index.ts admin-api/board-notices.ts app-api/index.ts app-api/market-board-notices.ts official-document-timeout-check/index.ts; do
      if [ -f "$root/$file" ]; then
        sha256sum "$root/$file"
      else
        printf "Not present: %s\n" "$file"
      fi
    done
  '
done
printf '\nRead-only inspection complete. No deployment performed.\n'
'@

# Explicit root is needed to inspect Docker; the fixed shell program above only
# reads container metadata and hashes five known application source files.
# Pass the program on stdin so Windows PowerShell 5.1 cannot strip its embedded
# quotes while serializing native command arguments. Normalize pipe CRLF in WSL.
$diagnostic | & $wslCommand.Source --distribution $Distribution --user root --exec sh -c "tr -d '\r' | sh"
if ($LASTEXITCODE -ne 0) { throw "WSL runtime inspection failed (exit $LASTEXITCODE). No deployment was requested." }
