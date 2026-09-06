#!/bin/sh
# Scoped repair for the WSL mount verified on 2026-09-06. No DB or secret changes.
set -eu
apply=${1:-0}
case "$apply" in 0|1) ;; *) echo 'Expected dry-run (0) or apply (1).' >&2; exit 2;; esac
root=/opt/inspection/supabase/volumes/functions
source=/mnt/c/Users/jnfa/Inspection-checklist-release-43136ca/supabase/functions
backup_root=/opt/inspection/maintenance/edge-repair
diagnostics=/mnt/c/Users/jnfa/Inspection-maintenance/edge-dependency-snapshots
container=supabase-edge-functions
for command in docker sha256sum curl python3 flock realpath; do command -v "$command" >/dev/null; done
[ "$(realpath "$root")" = "$root" ] || { echo 'Unexpected target path.' >&2; exit 2; }
[ -d "$source" ] || { echo 'Staged release is absent.' >&2; exit 2; }
[ "$(docker inspect --format '{{.State.Status}}' "$container")" = running ]
mount=$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/home/deno/functions"}}{{.Source}}{{end}}{{end}}' "$container")
[ "$mount" = "$root" ] || { echo 'Unexpected container mount.' >&2; exit 2; }
# Serialize deployment without restarting or changing a container in dry-run.
mkdir -p "$backup_root"
[ "$(realpath "$backup_root")" = "$backup_root" ] || { echo 'Unexpected backup path.' >&2; exit 2; }
[ ! -L "$backup_root/deploy.lock" ] || { echo 'Unexpected lock symlink.' >&2; exit 2; }
exec 9>>"$backup_root/deploy.lock"
flock -n 9 || { echo 'Another repair is running.' >&2; exit 2; }
entries='admin-api/index.ts ba2d916eb2c26974e71368c4f6f4f183e255212280330563c93b67fad25303be ea85d2bb66f479013feb6ffed365639a099b51fb1b703a5b5b7a272c614494f2
admin-api/board-notices.ts 04b13f40673a15eadbb3508fdd00ce5537b61e6cab2bb3d9616a8c042663e66d missing
app-api/index.ts 033f1028ad620439ac25fefe9ec9606f0baf54ebebe32737a4a6d59905dd6504 7be26ab6756b768f1ba505f3b9ba30b675c516f3f3bd462fe490a7cb25895087
app-api/market-board-notices.ts 3ae28544a8244c59d99bb7d0c74aef529b6ed326fcf30c1601e6bf786356e254 missing
official-document-timeout-check/index.ts 1c3da8c4f05ea2f405b1932bea3075b14caf3fdb1eaf2f7650111ec91445ab6a aa4f2b8cd02ad86449a998434c1f6dea630be61a9dc9f5c4c7720cfbfa59fa22'
dependencies='f035df33960c8fd81738e6a914ac56e09f59b1989bf96d7f03b15eb7c87b1a05 6f4269ac7ad3651c874a3e2ccfd3a8f89fa0cd860448bac80f3a424f925f7b93 _shared/security-monitor.ts
cd1ee3ef56eeca26a84a031169c3c27eef972523fd000df97f298b49f6a22c34 b3376c8dbf10ad4a48275fa7cd593ad93c023d702e4684b4568d0e336d97744c _shared/password-policy.ts
28ef31c1c7f15b85ab68a8d92bd183b46670725e82980391f5e0e26b0fabd78b e601122583be5163f964e5be8d9ea2b5718332f2e341d397b7b76d5532a3a716 _shared/floor.ts
b65338899d81cbde2caccd36fe9142b25ded5d9aa12543344dbfb0c3bcb5071a e43e9c04c5ba5aafe36f3a1bd84480262ecbae56a04fac58d79053724c7c8e74 _shared/client-ip.ts'
# Accept only reviewed content; CRLF-to-LF normalization never changes a file.
# A real content difference stops before HTTP checks, copies or restarts and
# saves bounded source snapshots in the private Windows maintenance directory.
python3 - "$root" "$diagnostics" "$dependencies" <<'PY'
from pathlib import Path
import hashlib,json,sys,tempfile
root=Path(sys.argv[1])
destination=Path(sys.argv[2])
expected=[line.split() for line in sys.argv[3].splitlines()]
records=[]
failed=False
for raw_expected,lf_expected,relative in expected:
    file=root/relative
    if file.resolve()!=file.absolute() or not file.is_file():
        print('DEPENDENCY_UNSAFE_OR_MISSING|'+relative)
        failed=True
        continue
    data=file.read_bytes()
    raw=hashlib.sha256(data).hexdigest()
    canonical=hashlib.sha256(data.replace(b'\r\n',b'\n')).hexdigest()
    state='exact' if raw==raw_expected else 'line-endings-only' if canonical==lf_expected else 'content-mismatch'
    print('DEPENDENCY|'+relative+'|'+state+'|raw='+raw+'|lf='+canonical)
    records.append({'path':relative,'state':state,'sha256':raw,'lf_sha256':canonical})
    failed=failed or state=='content-mismatch'
if failed:
    if destination.resolve()!=destination.absolute() or root==destination or root in destination.parents:
        raise SystemExit('Unsafe diagnostic destination; no deployment.')
    destination.mkdir(parents=True,exist_ok=True)
    snapshot=Path(tempfile.mkdtemp(prefix='snapshot-',dir=destination))
    # Only named application sources; never read .env, container env or DB data.
    for relative in [row[2] for row in expected]+['main/index.ts']:
        file=root/relative
        if file.resolve()!=file.absolute() or not file.is_file():
            continue
        if file.stat().st_size>2*1024*1024:
            raise SystemExit('Unexpected source size; no deployment.')
        data=file.read_bytes()
        copy=snapshot/relative
        copy.parent.mkdir(parents=True,exist_ok=True)
        copy.write_bytes(data)
        if copy.read_bytes()!=data:
            raise SystemExit('Diagnostic copy verification failed; no deployment.')
    (snapshot/'manifest.json').write_text(json.dumps({'state':'dependency-mismatch-no-deployment','files':records},indent=2),encoding='utf-8')
    print('Dependency snapshot saved: '+str(snapshot))
    raise SystemExit('Unreviewed dependency content: no application files changed and no container restarted.')
PY
# Refuse unknown local edits, symlink targets, or altered staged files before writing.
printf '%s\n' "$entries" | while read -r file expected previous; do
  [ "$(realpath "$(dirname "$root/$file")")" = "$(dirname "$root/$file")" ]
  [ ! -L "$root/$file" ]
  actual=$(sha256sum "$source/$file" | cut -d ' ' -f 1)
  [ "$actual" = "$expected" ] || { echo "Staged hash mismatch: $file" >&2; exit 2; }
  if [ -e "$root/$file" ]; then
    current=$(sha256sum "$root/$file" | cut -d ' ' -f 1)
    [ "$current" = "$previous" ] || [ "$current" = "$expected" ] || { echo "Unreviewed target change: $file" >&2; exit 2; }
  else
    [ "$previous" = missing ] || { echo "Required target absent: $file" >&2; exit 2; }
  fi
done
health() {
  # Container-local HTTP is the existing Edge listener; external TLS is untouched.
  ip=$(docker inspect --format '{{range .NetworkSettings.Networks}}{{println .IPAddress}}{{end}}' "$container" | sed '/^$/d')
  printf '%s\n' "$ip" | python3 -c 'import ipaddress,sys; a=ipaddress.ip_address(sys.stdin.read().strip()); assert a.version==4 and a.is_private' || return 1
  curl --silent --show-error --fail --max-time 30 -H 'Content-Type: application/json' -d '{"action":"market_board_public"}' "http://$ip:9000/app-api" |
    python3 -c 'import json,sys; p=json.load(sys.stdin); assert p.get("ok") is True; assert isinstance(p["data"]["table"]["rows"],list)' || return 1
  code=$(curl --silent --show-error --max-time 15 -o /dev/null -w '%{http_code}' -H 'Content-Type: application/json' -d '{"action":"users"}' "http://$ip:9000/admin-api") || return 1
  [ "$code" = 401 ] || return 1
}
health || { echo 'Pre-deployment API check failed; no application files changed.' >&2; exit 2; }
if [ "$apply" = 0 ]; then echo 'Dry-run passed: five source files, dependencies and existing APIs verified. No deployment.'; exit 0; fi
mkdir -p "$backup_root"
backup=$(mktemp -d "$backup_root/repair-20260906-XXXXXXXX")
# Back up every existing affected file before any replacement.
printf '%s\n' "$entries" | while read -r file expected previous; do
  mkdir -p "$backup/$(dirname "$file")"
  if [ -f "$root/$file" ]; then cp -p "$root/$file" "$backup/$file"; cmp -s "$root/$file" "$backup/$file"; fi
done
rollback() {
  trap - EXIT HUP INT TERM
  echo "Repair failed; restoring existing entry files from $backup" >&2
  printf '%s\n' "$entries" | while read -r file expected previous; do
    if [ -f "$backup/$file" ]; then
      cp -p "$backup/$file" "$root/$file.rollback-tmp" && mv -f "$root/$file.rollback-tmp" "$root/$file" || exit 1
    fi
  done
  docker restart "$container" >/dev/null || true
  echo 'Rollback attempted. Added helper modules are retained but unused by the old entry files; verify APIs before retrying.' >&2
  exit 1
}
trap rollback EXIT
trap 'exit 1' HUP INT TERM
printf '%s\n' "$entries" | while read -r file expected previous; do
  cp "$source/$file" "$root/$file.repair-tmp"
  chmod 644 "$root/$file.repair-tmp"
  mv -f "$root/$file.repair-tmp" "$root/$file"
  [ "$(sha256sum "$root/$file" | cut -d ' ' -f 1)" = "$expected" ]
done
docker restart "$container" >/dev/null
healthy=0
for attempt in 1 2 3 4 5; do
  sleep 2
  if health; then healthy=1; break; fi
done
[ "$healthy" = 1 ] || { echo 'Post-deployment API check failed.' >&2; exit 1; }
trap - EXIT HUP INT TERM
printf 'WSL repair completed: five files verified; public API and anonymous-admin denial passed.\nBackup: %s\n' "$backup"
echo 'IIS, authenticated workflows, credentials and data migration still require separate verification.'
