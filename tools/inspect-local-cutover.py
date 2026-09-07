"""Read-only WSL cutover evidence. stdout contains aggregates, never secrets."""
import datetime
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys

SETTINGS = ('CWA_API_KEY', 'CRON_SECRET', 'LINE_CHANNEL_SECRET',
            'LINE_NOTIFY_WEBHOOK_SECRET', 'GOOGLE_CALENDAR_CLIENT_ID',
            'GOOGLE_CALENDAR_CLIENT_SECRET', 'GOOGLE_CALENDAR_REDIRECT_URI',
            'GOOGLE_TOKEN_ENCRYPTION_KEY', 'FIREBASE_SERVICE_ACCOUNT_B64',
            'FIREBASE_PROJECT_ID')
MAIL_SETTINGS = ('GOTRUE_SMTP_HOST', 'GOTRUE_SMTP_PORT', 'GOTRUE_SMTP_USER',
                 'GOTRUE_SMTP_PASS', 'GOTRUE_SMTP_ADMIN_EMAIL',
                 'GOTRUE_SMTP_SENDER_NAME', 'GOTRUE_SITE_URL',
                 'GOTRUE_URI_ALLOW_LIST', 'GOTRUE_MAILER_TEMPLATES_RECOVERY')
JOBS = ('patrol-timeout-check', 'meeting-booking-check',
        'official-document-timeout-check', 'google-calendar',
        'market', 'backup', 'monitor', 'synthetic')


def run(args, data=None, timeout=45, include_stderr=False):
    result = subprocess.run(args, input=data, capture_output=True,
                            text=True, timeout=timeout, check=False)
    if result.returncode:
        # stderr may contain connection credentials or SQL data: never relay it.
        raise RuntimeError('command-exit-' + str(result.returncode))
    return result.stdout + (result.stderr if include_stderr else '')


def presence(entries, names=SETTINGS):
    values = dict(item.split('=', 1) for item in entries if '=' in item)
    return {key: ('set' if values[key] else 'empty') if key in values
            else 'missing' for key in names}


def mail_log_summary(logs):
    # Only fixed counters leave memory: auth logs can include addresses/tokens.
    candidates = [line for line in logs.splitlines()
                  if re.search(r'smtp|mail|/recover|recovery', line, re.I)]
    patterns = {
        'recoveryMailFailure': r'error sending recovery email|error sending.*email',
        'authenticationRejected': r'\b535\b|\b534\b|authentication failed|invalid.*credentials',
        'connectionRefused': r'connection refused',
        'dnsFailure': r'no such host|name resolution|server misbehaving',
        'connectionTimeout': r'i/o timeout|connection timed out|deadline exceeded',
        'tlsFailure': r'x509|certificate|tls handshake|starttls.*(fail|required)',
        'senderOrRecipientRejected': r'\b550\b|\b553\b|sender.*rejected|recipient.*rejected',
        'templateFailure': r'template.*(error|fail)|failed.*template',
        'rateLimited': r'rate limit|too many requests',
    }
    return {name: sum(bool(re.search(pattern, line, re.I)) for line in candidates)
            for name, pattern in patterns.items()}


def mail_dns_report(entries, execute=run):
    values = dict(item.split('=', 1) for item in entries if '=' in item)
    host = values.get('GOTRUE_SMTP_HOST', '')
    normalized = host.lower().rstrip('.')
    result = {'hostIsPlaceholder': any(normalized == domain or normalized.endswith('.' + domain)
              for domain in ('example.com', 'example.net', 'example.org', 'invalid', 'test')),
              'hostHasWhitespaceOrScheme': bool(re.search(r'\s|://', host)),
              'wslLookup': 'not-attempted', 'authContainerLookup': 'not-attempted'}
    if not host:
        return result
    # Resolve only the configured mail host. No SMTP login or delivery is attempted.
    probes = {
        'wslLookup': [sys.executable, '-c',
                      'import socket,sys; socket.getaddrinfo(sys.argv[1], None); print("resolved")', host],
        'authContainerLookup': ['docker', 'exec', 'supabase-auth', 'sh', '-c',
            'if command -v getent >/dev/null 2>&1; then '
            'getent hosts "$GOTRUE_SMTP_HOST" >/dev/null 2>&1; r=$?; '
            'elif command -v nslookup >/dev/null 2>&1; then '
            'nslookup "$GOTRUE_SMTP_HOST" >/dev/null 2>&1; r=$?; '
            'else printf "tool-unavailable"; exit 0; fi; '
            'if [ "$r" -eq 0 ]; then printf "resolved"; else printf "lookup-failed"; fi']}
    for name, args in probes.items():
        try:
            output = execute(args, timeout=15).strip()
            result[name] = output if output in ('resolved', 'lookup-failed', 'tool-unavailable') else 'unavailable'
        except subprocess.TimeoutExpired:
            result[name] = 'timeout'
        except RuntimeError:
            result[name] = 'lookup-command-failed'
    return result


def mail_report(execute=run):
    info = json.loads(execute(['docker', 'inspect', 'supabase-auth']))[0]
    if not info['Config']['Image'].startswith('supabase/gotrue:'):
        raise RuntimeError('formal-auth-image-mismatch')
    logs = execute(['docker', 'logs', '--since', '2h', '--tail', '300', 'supabase-auth'],
                   include_stderr=True)
    return {'settings': presence(info['Config'].get('Env', []), MAIL_SETTINGS),
            'dnsDiagnostics': mail_dns_report(info['Config'].get('Env', []), execute),
            'recentLogSignals': mail_log_summary(logs),
            'logWindow': 'last-2-hours-max-300-lines',
            'deliveryTestPerformed': False}


def command_summary(command):
    return {'sha256': hashlib.sha256(command.encode()).hexdigest(),
            'jobClasses': [name for name in JOBS if name in command.lower()],
            'referencesCloud': '.supabase.co' in command.lower(),
            'referencesLocal': any(value in command.lower() for value in
                                   ('192.168.50.192', '127.0.0.1', 'localhost',
                                    '/opt/inspection'))}


SQL = r"""
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout='30s';
SELECT json_build_object('section','notification-settings','key',k.key,
  'state',CASE WHEN s.key IS NULL THEN 'missing' WHEN coalesce(s.value,'')='' THEN 'empty' ELSE 'set' END)
  FROM (VALUES('line_channel_token'),('line_group_id')) AS k(key)
  LEFT JOIN public.system_settings s ON s.key=k.key ORDER BY k.key;
SELECT json_build_object('section','auth','authCount',(SELECT count(*) FROM auth.users),
  'publicCount',(SELECT count(*) FROM public.users),
  'activeWithoutAuth',(SELECT count(*) FROM public.users WHERE status='active' AND auth_id IS NULL),
  'danglingAuthLinks',(SELECT count(*) FROM public.users u LEFT JOIN auth.users a ON a.id=u.auth_id WHERE u.auth_id IS NOT NULL AND a.id IS NULL),
  'authWithoutPublic',(SELECT count(*) FROM auth.users a WHERE NOT EXISTS(SELECT 1 FROM public.users u WHERE u.auth_id=a.id)),
  'duplicateAuthLinks',(SELECT count(*) FROM (SELECT auth_id FROM public.users WHERE auth_id IS NOT NULL GROUP BY auth_id HAVING count(*)>1) d));
SELECT json_build_object('section','storage','bucket',b.id,'public',b.public,
  'objects',count(o.id),'metadataBytes',coalesce(sum(CASE WHEN o.metadata->>'size' ~ '^[0-9]+$' THEN (o.metadata->>'size')::numeric ELSE 0 END),0))
  FROM storage.buckets b LEFT JOIN storage.objects o ON o.bucket_id=b.id GROUP BY b.id,b.public ORDER BY b.id;
SELECT json_build_object('section','table','name',c.relname,'rls',c.relrowsecurity,
  'primaryKey',EXISTS(SELECT 1 FROM pg_constraint p WHERE p.conrelid=c.oid AND p.contype='p'))
  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' ORDER BY c.relname;
SELECT format('SELECT json_build_object(''section'',''rows'',''table'',%L,''count'',count(*)) FROM %I.%I;',tablename,schemaname,tablename)
  FROM pg_tables WHERE schemaname='public' ORDER BY tablename
\gexec
SELECT CASE WHEN to_regclass('cron.job') IS NOT NULL THEN
  'SELECT json_build_object(''section'',''cron'',''id'',jobid,''schedule'',schedule,''active'',active,''command'',command) FROM cron.job ORDER BY jobid'
  ELSE 'SELECT json_build_object(''section'',''cron-status'',''available'',false)' END
\gexec
COMMIT;
"""


def database_report(execute=run):
    output = execute(['docker', 'exec', '-i', 'supabase-db', 'psql', '-X', '-q',
                      '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'postgres', '-At'],
                     data=SQL, timeout=180)
    rows = [json.loads(line) for line in output.splitlines() if line.startswith('{')]
    for row in rows:
        if row.get('section') == 'cron':
            row.update(command_summary(row.pop('command', '')))
    return rows


def container_report(execute=run):
    names = execute(['docker', 'ps', '-a', '--format', '{{.Names}}']).splitlines()
    names = [name for name in names if name.startswith('supabase-') and re.fullmatch(r'[\w.-]+', name)]
    if not names:
        raise RuntimeError('formal-containers-not-found')
    result = []
    for name in names:
        info = json.loads(execute(['docker', 'inspect', name]))[0]
        entry = {'name': name, 'image': info['Config']['Image'],
                 'state': info['State']['Status'],
                 'health': info['State'].get('Health', {}).get('Status', 'not-configured'),
                 'startedAt': info['State'].get('StartedAt'),
                 'restartPolicy': info['HostConfig']['RestartPolicy']['Name'],
                 'mounts': [{'source': m['Source'], 'destination': m['Destination'],
                             'type': m['Type']} for m in info.get('Mounts', [])]}
        if name == 'supabase-edge-functions':
            entry['settings'] = presence(info['Config'].get('Env', []))
            if not any(m['source'] == '/opt/inspection/supabase/volumes/functions'
                       and m['destination'] == '/home/deno/functions' for m in entry['mounts']):
                raise RuntimeError('formal-edge-mount-mismatch')
        result.append(entry)
    if not {'supabase-db', 'supabase-edge-functions'}.issubset(names):
        raise RuntimeError('formal-containers-incomplete')
    return result


def scheduler_report(execute=run):
    entries = []
    # Read only known system cron locations, never print environment assignments.
    paths = [Path('/etc/crontab'), Path('/var/spool/cron/crontabs/root')]
    cron_dir = Path('/etc/cron.d')
    if cron_dir.is_dir():
        paths.extend(sorted(cron_dir.iterdir()))
    for path in paths:
        if not path.is_file() or path.is_symlink():
            continue
        for number, line in enumerate(path.read_text().splitlines(), 1):
            stripped = line.strip()
            if (not stripped or stripped.startswith('#') or
                    re.match(r'^[A-Za-z_][A-Za-z0-9_]*\s*=', stripped)):
                continue
            entries.append({'file': str(path), 'line': number, **command_summary(stripped)})
    units = execute(['systemctl', 'list-unit-files', '--type=service', '--type=timer',
                     '--no-pager', '--no-legend'])
    relevant = [line.split()[:2] for line in units.splitlines()
                if re.search(r'(docker|inspection|supabase|cron|market)', line, re.I)]
    return {'cronEntries': entries, 'unitEnablement': relevant,
            'rebootExecutionVerified': False}


def main():
    report = {'collectedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
              'mode': 'read-only', 'cutoverComplete': False, 'sections': {}}
    for name, collect in [('containers', container_report), ('database', database_report),
                          ('schedulers', scheduler_report), ('authMail', mail_report)]:
        try:
            report['sections'][name] = {'status': 'collected', 'evidence': collect()}
        except Exception as error:
            # Exception types are safe; arbitrary messages may contain secrets.
            report['sections'][name] = {'status': 'unavailable', 'errorType': type(error).__name__}
    print(json.dumps(report, ensure_ascii=True))
    return 0 if all(s['status'] == 'collected' for s in report['sections'].values()) else 2


if __name__ == '__main__':
    raise SystemExit(main())
