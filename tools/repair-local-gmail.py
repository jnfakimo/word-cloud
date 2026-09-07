"""Scoped Gmail SMTP repair. Credentials arrive on stdin and never enter reports."""
import copy
import datetime
import json
import os
from pathlib import Path
import re
import smtplib
import ssl
import subprocess
import sys
import tempfile
import time

ROOT = Path('/opt/inspection/supabase')
KEYS = ('HOST', 'PORT', 'USER', 'PASS', 'ADMIN_EMAIL', 'SENDER_NAME')


class RepairError(Exception):
    pass


def command(args, timeout=45):
    result = subprocess.run(args, capture_output=True, text=True, timeout=timeout)
    if result.returncode:
        raise RepairError('command-failed')
    return result.stdout


def credentials(payload):
    email = payload.get('email', '').strip()
    password = payload.get('password', '').replace(' ', '')
    if not re.fullmatch(r'[A-Za-z0-9._%+-]+@gmail\.com', email, re.I):
        raise RepairError('gmail-address-required')
    if not re.fullmatch(r'[a-zA-Z]{16}', password):
        raise RepairError('google-16-letter-app-password-required')
    return email, password


def settings(email, password):
    return dict(zip(KEYS, ('smtp.gmail.com', '587', email, password, email, 'Inspection')))


def updated_env(original, values):
    lines = original.decode('utf-8').splitlines(keepends=True)
    seen = set()
    for index, line in enumerate(lines):
        match = re.match(r'^\s*(?:export\s+)?SMTP_(' + '|'.join(KEYS) + r')\s*=', line)
        if match:
            key = match[1]
            if key in seen:
                raise RepairError('duplicate-smtp-env-key')
            seen.add(key)
            lines[index] = 'SMTP_' + key + '=' + values[key] + '\n'
    text = ''.join(lines)
    if text and not text.endswith('\n'):
        text += '\n'
    text += ''.join('SMTP_' + key + '=' + values[key] + '\n' for key in KEYS if key not in seen)
    return text.encode('utf-8')


def confined(path, root):
    path = Path(path)
    if not path.is_absolute() or path.is_symlink() or not path.resolve().is_relative_to(root.resolve()):
        raise RepairError('compose-path-outside-formal-root')
    return path


def compose_command(info, root):
    labels = info['Config'].get('Labels') or {}
    if labels.get('com.docker.compose.service') != 'auth':
        raise RepairError('auth-compose-service-mismatch')
    if Path(labels.get('com.docker.compose.project.working_dir', '')) != root:
        raise RepairError('compose-working-directory-mismatch')
    project = labels.get('com.docker.compose.project', '')
    if not re.fullmatch(r'[a-z0-9][a-z0-9_-]*', project):
        raise RepairError('compose-project-invalid')
    env_label = labels.get('com.docker.compose.project.environment_file')
    if env_label and Path(env_label) != root / '.env':
        raise RepairError('nonstandard-compose-env-file')
    paths = labels.get('com.docker.compose.project.config_files', '').split(',')
    args = ['docker', 'compose', '--project-directory', str(root), '--project-name', project,
            '--env-file', str(root / '.env')]
    for raw in paths:
        path = confined(raw, root)
        if not path.is_file() or path.suffix not in ('.yml', '.yaml'):
            raise RepairError('compose-file-missing')
        args += ['-f', str(path)]
    return args


def check_delta(before, after, values):
    normalized = copy.deepcopy(after)
    actual = normalized['services']['auth']['environment']
    old = before['services']['auth']['environment']
    for key, value in values.items():
        name = 'GOTRUE_SMTP_' + key
        if str(actual.get(name, '')) != value:
            raise RepairError('smtp-env-not-wired-through-compose')
        if name in old:
            actual[name] = old[name]
        else:
            actual.pop(name, None)
    if normalized != before:
        raise RepairError('unexpected-non-smtp-compose-change')


def atomic_write(path, content, mode, uid, gid):
    descriptor, name = tempfile.mkstemp(prefix='.gmail-repair-', dir=path.parent)
    try:
        os.fchmod(descriptor, mode)
        os.fchown(descriptor, uid, gid)
        with os.fdopen(descriptor, 'wb') as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)  # Only the exact temporary file this function created.


def authenticate(email, password):
    # Mandatory verified STARTTLS; no fallback to plaintext and no email delivery.
    with smtplib.SMTP('smtp.gmail.com', 587, timeout=20) as smtp:
        smtp.ehlo()
        smtp.starttls(context=ssl.create_default_context())
        smtp.ehlo()
        smtp.login(email, password)


def auth_info(execute):
    info = json.loads(execute(['docker', 'inspect', 'supabase-auth']))[0]
    if not info['Config']['Image'].startswith('supabase/gotrue:'):
        raise RepairError('auth-image-mismatch')
    return info


def wait_healthy(execute):
    for _ in range(20):
        info = auth_info(execute)
        if info['State']['Status'] == 'running' and info['State'].get('Health', {}).get('Status') == 'healthy':
            return info
        time.sleep(3)
    raise RepairError('auth-health-timeout')


def repair(payload, report, root=ROOT, execute=command, authenticate_fn=authenticate,
           write=atomic_write, health=wait_healthy):
    report['stage'] = 'validate-input'
    email, password = credentials(payload)
    values = settings(email, password)
    env = confined(root / '.env', root)
    info = auth_info(execute)
    if info['State']['Status'] != 'running' or info['State'].get('Health', {}).get('Status') != 'healthy':
        raise RepairError('auth-not-healthy-before-repair')
    compose = compose_command(info, root)
    original = env.read_bytes()
    stat = env.stat()
    replacement = updated_env(original, values)
    report['stage'] = 'verify-current-compose'
    before = json.loads(execute(compose + ['config', '--format', 'json']))
    service = before['services']['auth']
    current = dict(item.split('=', 1) for item in info['Config']['Env'] if '=' in item)
    if service.get('image') != info['Config']['Image'] or service.get('container_name') != 'supabase-auth':
        raise RepairError('auth-compose-image-or-container-drift')
    if any(current.get(key) != str(value) for key, value in service['environment'].items()):
        raise RepairError('auth-compose-environment-drift')
    report['stage'] = 'gmail-tls-authentication'
    authenticate_fn(email, password)
    report['gmailTlsAuthentication'] = 'passed'
    report['stage'] = 'backup'
    backup_dir = Path(tempfile.mkdtemp(prefix='gmail-repair-', dir=root))
    os.chmod(backup_dir, 0o700)
    backup = backup_dir / 'original.env'
    write(backup, original, 0o600, stat.st_uid, stat.st_gid)
    report['backupDirectory'] = str(backup_dir)
    restart_attempted = False
    if env.read_bytes() != original:
        raise RepairError('env-changed-during-preflight')
    report['stage'] = 'apply-smtp-config'
    write(env, replacement, 0o600, stat.st_uid, stat.st_gid)
    try:
        after = json.loads(execute(compose + ['config', '--format', 'json']))
        check_delta(before, after, values)
        report['stage'] = 'restart-auth-only'
        restart_attempted = True
        execute(compose + ['up', '-d', '--no-deps', '--no-build', '--pull', 'never', 'auth'], timeout=120)
        result = health(execute)
        actual = dict(item.split('=', 1) for item in result['Config']['Env'] if '=' in item)
        if any(actual.get('GOTRUE_SMTP_' + key) != value for key, value in values.items()):
            raise RepairError('auth-smtp-readback-mismatch')
        report['stage'] = 'auth-container-dns'
        execute(['docker', 'exec', 'supabase-auth', 'sh', '-c',
                 'getent hosts smtp.gmail.com >/dev/null 2>&1 || nslookup smtp.gmail.com >/dev/null 2>&1'], timeout=20)
    except Exception:
        report['rollback'] = 'started'
        if env.read_bytes() != replacement:
            report['rollback'] = 'blocked-by-concurrent-env-change'
            raise RepairError('concurrent-env-change-review-private-backup')
        write(env, original, stat.st_mode & 0o777, stat.st_uid, stat.st_gid)
        if restart_attempted:
            try:
                execute(compose + ['up', '-d', '--no-deps', '--no-build', '--pull', 'never', 'auth'], timeout=120)
                health(execute)
            except Exception:
                report['rollback'] = 'env-restored-auth-health-unverified'
                raise RepairError('rollback-auth-health-unverified')
        report['rollback'] = 'completed'
        raise
    report.update(status='configured', stage='complete', authHealth='healthy',
                  authSmtpReadback='passed', authContainerDns='passed')


def main():
    report = {'mode': 'gmail-smtp-repair', 'status': 'failed', 'deliveryTestPerformed': False,
              'collectedAt': datetime.datetime.now(datetime.timezone.utc).isoformat()}
    try:
        if os.name != 'posix' or os.geteuid() != 0:
            raise RepairError('run-through-formal-windows-launcher')
        import fcntl
        with open(ROOT / '.gmail-repair.lock', 'a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            repair(json.load(sys.stdin), report)
    except Exception as error:
        report['errorCode'] = str(error) if isinstance(error, RepairError) else type(error).__name__
    print(json.dumps(report))
    return 0 if report['status'] == 'configured' else 1


if __name__ == '__main__':
    sys.exit(main())
