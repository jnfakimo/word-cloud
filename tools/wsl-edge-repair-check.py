"""Exercise actual repair file operations with synthetic files and mocked Docker/HTTP."""
import hashlib
import os
from pathlib import Path
import re
import shlex
import shutil
import subprocess
import sys
import tempfile

SCRIPT = Path(__file__).with_name('repair-wsl-edge-checklist.sh').read_text(encoding='utf-8')
SHELL = r'C:\Program Files\Git\bin\bash.exe' if os.name == 'nt' else shutil.which('sh')
assert SHELL
entries = [line.split() for line in re.search(r"entries='(.*?)'", SCRIPT, re.S).group(1).splitlines()]
deps = [line.split() for line in re.search(r"dependencies='(.*?)'", SCRIPT, re.S).group(1).splitlines()]

def digest(value):
    return hashlib.sha256(value).hexdigest()

def run_case(name, apply, mode='', corrupt=False, drift=False, dependency_lf=False, dependency_drift=False):
    with tempfile.TemporaryDirectory(prefix='inspection-repair-test-') as temp:
        # Windows hosted runners may provide RUNNER~1 in TEMP; resolve the fixture
        # before crossing into Git Bash so realpath checks see the same path.
        fixture = Path(temp).resolve()
        root, source, backup, diagnostics = [fixture/p for p in ('target', 'source', 'backup', 'diagnostics')]
        root.mkdir(); source.mkdir(); backup.mkdir(); diagnostics.mkdir()
        script = SCRIPT
        before = {}
        for relative, new_hash, old_hash in entries:
            content = ('after:' + relative).encode()
            target = source/relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(content)
            script = script.replace(new_hash, digest(content))
            target = root/relative
            target.parent.mkdir(parents=True, exist_ok=True)
            if old_hash != 'missing':
                old = ('before:' + relative).encode()
                target.write_bytes(old)
                before[relative] = old
                script = script.replace(old_hash, digest(old))
        for old_hash, lf_hash, relative in deps:
            target = root/relative
            target.parent.mkdir(parents=True, exist_ok=True)
            content = ('shared:' + relative + '\r\n').encode()
            canonical = content.replace(b'\r\n', b'\n')
            target.write_bytes(canonical if dependency_lf else content)
            script = script.replace(old_hash, digest(content)).replace(lf_hash, digest(canonical))
        if dependency_drift:
            (root/deps[0][2]).write_bytes(b'unreviewed shared function')
        dependency_before = {relative: (root/relative).read_bytes() for _, _, relative in deps}
        if corrupt:
            (source/entries[0][0]).write_bytes(b'corrupt source')
        if drift:
            (root/entries[0][0]).write_bytes(b'new local edit')
            before[entries[0][0]] = b'new local edit'
        for literal, value in (
            ('root=/opt/inspection/supabase/volumes/functions', root),
            ('source=/mnt/c/Users/jnfa/Inspection-checklist-release-43136ca/supabase/functions', source),
            ('backup_root=/opt/inspection/maintenance/edge-repair', backup),
            ('diagnostics=/mnt/c/Users/jnfa/Inspection-maintenance/edge-dependency-snapshots', diagnostics),
        ):
            script = script.replace(literal, literal.split('=')[0] + '=$(realpath ' + shlex.quote(value.as_posix()) + ')')
        script = script.replace('sleep 2', 'sleep 0')
        header = 'fixture=$(realpath ' + shlex.quote(fixture.as_posix()) + ')\nmode=' + shlex.quote(mode) + '\n'
        header += 'python3() { ' + shlex.quote(Path(sys.executable).as_posix()) + ' "$@"; }\n'
        header += r'''
flock() { return 0; }
docker() {
  if [ "$1" = restart ]; then echo restarted >> "$fixture/restarts"; return 0; fi
  case "$3" in
    *State.Status*) echo running;;
    *Mounts*) echo "$root";;
    *NetworkSettings*) echo 10.0.0.2;;
    *) return 2;;
  esac
}
curl() {
  if [ "$mode" = fail-after-restart ] && [ -f "$fixture/restarts" ]; then return 22; fi
  for value in "$@"; do
    case "$value" in
      */admin-api) printf 401; return 0;;
    esac
  done
  printf '{"ok":true,"data":{"table":{"rows":[]}}}'
}
'''
        result = subprocess.run([SHELL, '-s', '--', str(int(apply))], input=header+script, text=True, capture_output=True, timeout=40)
        expected_success = not (corrupt or drift or mode or dependency_drift)
        assert (result.returncode == 0) == expected_success, (name, result.stdout, result.stderr)
        for relative, *_ in entries:
            target = root/relative
            if expected_success and apply:
                assert target.read_bytes() == (source/relative).read_bytes(), name
            elif relative in before:
                assert target.read_bytes() == before[relative], name
            elif not apply or corrupt or drift or dependency_drift:
                assert not target.exists(), name
        restarts = (fixture/'restarts').read_text().splitlines() if (fixture/'restarts').exists() else []
        assert len(restarts) == (2 if mode else 1 if apply and expected_success else 0), (name, restarts)
        if apply and expected_success:
            folders = list(backup.glob('repair-*'))
            assert len(folders) == 1
            for relative, content in before.items():
                assert (folders[0]/relative).read_bytes() == content
        for relative, original in dependency_before.items():
            assert (root/relative).read_bytes() == original, name
        if dependency_drift:
            snapshots=list(diagnostics.glob('snapshot-*'))
            assert len(snapshots)==1
            assert (snapshots[0]/deps[0][2]).read_bytes()==b'unreviewed shared function'
            assert (root/deps[0][2]).read_bytes()==b'unreviewed shared function'
            assert (snapshots[0]/'manifest.json').is_file()
        print(name + ': passed')

run_case('dry-run preserves files and does not restart', False)
run_case('apply verifies and backs up all existing files', True)
run_case('corrupt source stops before writes', True, corrupt=True)
run_case('unreviewed local change stops before writes', True, drift=True)
run_case('post-deploy failure restores previous entry files', True, mode='fail-after-restart')
run_case('reviewed dependency LF line endings are accepted without rewriting', True, dependency_lf=True)
run_case('unknown dependency stops and saves source for review', True, dependency_drift=True)
print('Synthetic filesystem checks passed; Docker, HTTP and flock are mocked. Live host validation remains required.')
