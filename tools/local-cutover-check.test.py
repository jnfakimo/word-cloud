"""Collector boundary and redaction tests; no production Docker/WSL calls."""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('cutover', Path(__file__).with_name('inspect-local-cutover.py'))
cutover = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cutover)


class CollectorTests(unittest.TestCase):
    def test_setting_values_never_leave_collector(self):
        result = cutover.presence(['CWA_API_KEY=private-value=with-equals',
                                   'CRON_SECRET=', 'UNRELATED_SECRET=private-value'])
        self.assertEqual(result['CWA_API_KEY'], 'set')
        self.assertEqual(result['CRON_SECRET'], 'empty')
        self.assertEqual(result['LINE_CHANNEL_SECRET'], 'missing')
        self.assertNotIn('private-value', json.dumps(result))
        self.assertNotIn('UNRELATED_SECRET', result)

    def test_scheduler_tokens_and_commands_redacted(self):
        command = "curl -H 'x-cron-secret: PRIVATE' https://example.supabase.co/functions/v1/patrol-timeout-check"
        def execute(args, data, timeout):
            self.assertIn('READ ONLY', data)
            self.assertIn('REPEATABLE READ', data)
            self.assertIn('-X', args)
            return json.dumps({'section':'cron', 'id':1, 'schedule':'*/5 * * * *',
                               'active':True, 'command':command})
        result = cutover.database_report(execute)
        self.assertTrue(result[0]['referencesCloud'])
        self.assertIn('patrol-timeout-check', result[0]['jobClasses'])
        self.assertNotIn('PRIVATE', json.dumps(result))
        self.assertNotIn('command', result[0])

    def test_ambiguous_container_layout_refused(self):
        def execute(args):
            if args[1] == 'ps':
                return 'supabase-db\nsupabase-edge-functions\n'
            return json.dumps([{'Config':{'Image':'supabase/edge-runtime:test','Env':[]},
                                'State':{'Status':'running'},
                                'HostConfig':{'RestartPolicy':{'Name':'always'}},
                                'Mounts':[]}])
        with self.assertRaisesRegex(RuntimeError, 'mount-mismatch'):
            cutover.container_report(execute)

    def test_container_secrets_and_errors_omitted(self):
        def execute(args):
            if args[1] == 'ps':
                return 'supabase-db\nsupabase-edge-functions\nother-app\n'
            return json.dumps([{'Config':{'Image':'test','Env':['CRON_SECRET=PRIVATE']},
                                'State':{'Status':'running','Error':'PRIVATE'},
                                'HostConfig':{'RestartPolicy':{'Name':'unless-stopped'}},
                                'Mounts':[{'Source':'/opt/inspection/supabase/volumes/functions',
                                           'Destination':'/home/deno/functions','Type':'bind'}]}])
        result = cutover.container_report(execute)
        self.assertEqual(len(result), 2)
        self.assertNotIn('PRIVATE', json.dumps(result))
        self.assertEqual(result[1]['settings']['CRON_SECRET'], 'set')

    def test_failure_not_reported_as_success_or_secret(self):
        output = io.StringIO()
        with (patch.object(cutover, 'container_report', side_effect=RuntimeError('PRIVATE')),
             patch.object(cutover, 'database_report', return_value=[]),
             patch.object(cutover, 'scheduler_report', return_value={}),
             patch.object(cutover, 'mail_report', return_value={}),
             contextlib.redirect_stdout(output)):
            exit_code = cutover.main()
        self.assertEqual(exit_code, 2)
        self.assertNotIn('PRIVATE', output.getvalue())
        self.assertFalse(json.loads(output.getvalue())['cutoverComplete'])

    def test_auth_mail_diagnostics_never_return_addresses_or_credentials(self):
        def execute(args, **kwargs):
            if args[0] == cutover.sys.executable or args[1] == 'exec':
                return 'resolved'
            if args[1] == 'inspect':
                return json.dumps([{'Config':{'Image':'supabase/gotrue:test', 'Env':[
                    'GOTRUE_SMTP_HOST=smtp.private.example', 'GOTRUE_SMTP_PASS=PRIVATE',
                    'GOTRUE_SMTP_USER=PRIVATE@example.com', 'GOTRUE_SMTP_PORT=587']}}])
            self.assertEqual(args, ['docker','logs','--since','2h','--tail','300','supabase-auth'])
            self.assertTrue(kwargs['include_stderr'])
            return 'Error sending recovery email: SMTP 535 authentication failed PRIVATE@example.com PRIVATE\n'
        result = cutover.mail_report(execute)
        self.assertEqual(result['settings']['GOTRUE_SMTP_PASS'], 'set')
        self.assertEqual(result['settings']['GOTRUE_SMTP_ADMIN_EMAIL'], 'missing')
        self.assertEqual(result['recentLogSignals']['authenticationRejected'], 1)
        self.assertNotIn('PRIVATE', json.dumps(result))
        self.assertNotIn('smtp.private.example', json.dumps(result))
        self.assertFalse(result['deliveryTestPerformed'])

    def test_dns_checks_are_bounded_and_redacted(self):
        def execute(args, **kwargs):
            self.assertEqual(kwargs['timeout'], 15)
            if args[0] == cutover.sys.executable:
                raise RuntimeError('PRIVATE host detail')
            self.assertNotIn('PRIVATE.example.com', args)
            return 'lookup-failed'
        result = cutover.mail_dns_report(['GOTRUE_SMTP_HOST=PRIVATE.example.com'], execute)
        self.assertTrue(result['hostIsPlaceholder'])
        self.assertEqual(result['wslLookup'], 'lookup-command-failed')
        self.assertEqual(result['authContainerLookup'], 'lookup-failed')
        self.assertNotIn('PRIVATE', json.dumps(result))
        self.assertFalse(cutover.mail_dns_report(['GOTRUE_SMTP_HOST=smtp.example.com.real.tld'],
                         lambda *args, **kwargs: 'resolved')['hostIsPlaceholder'])
        self.assertTrue(cutover.mail_dns_report(['GOTRUE_SMTP_HOST=https://private.tld'],
                        lambda *args, **kwargs: 'resolved')['hostHasWhitespaceOrScheme'])

    def test_mail_signal_categories_and_empty_logs(self):
        cases = {'connectionRefused':'smtp dial tcp: connection refused',
                 'tlsFailure':'/recover x509 unknown authority',
                 'dnsFailure':'smtp lookup: no such host',
                 'connectionTimeout':'smtp: i/o timeout',
                 'templateFailure':'email template parse error',
                 'senderOrRecipientRejected':'smtp 550 recipient rejected',
                 'rateLimited':'/recover email rate limit exceeded'}
        for key, line in cases.items():
            self.assertEqual(cutover.mail_log_summary(line)[key], 1)
        self.assertFalse(any(cutover.mail_log_summary('').values()))

    @unittest.skipUnless(os.name == 'nt', 'Windows PowerShell integration')
    def test_windows_task_actions_and_private_report(self):
        with tempfile.TemporaryDirectory(prefix='cutover-ps-test-') as temp:
            fixture = Path(temp).resolve()
            collector = Path(__file__).with_name('inspect-local-cutover.ps1').resolve()
            script = r'''
function Get-NetIPAddress { [pscustomobject]@{IPAddress='192.168.50.192'} }
function Get-ScheduledTask {
  [pscustomobject]@{TaskName='Windows COM task';Actions=@([pscustomobject]@{ClassId='PRIVATE'})}
  [pscustomobject]@{TaskName='Windows empty action';Actions=$null}
  [pscustomobject]@{
    TaskName='Inspection backup';TaskPath='\';State='Ready'
    Actions=@([pscustomobject]@{Execute='powershell.exe';Arguments='-File backup.ps1 -Secret PRIVATE'})
    Triggers=@([pscustomobject]@{CimClass=[pscustomobject]@{CimClassName='MSFT_TaskBootTrigger'}})
    Settings=[pscustomobject]@{Enabled=$true}
    Principal=[pscustomobject]@{LogonType='Password'}
  }
  [pscustomobject]@{
    TaskName='Inspection on-demand';TaskPath='\';State='Ready'
    Actions=@([pscustomobject]@{Execute='check.exe';Arguments=''})
    Triggers=$null;Settings=[pscustomobject]@{Enabled=$true}
    Principal=[pscustomobject]@{LogonType='Interactive'}
  }
  if ($env:INSPECTION_TEST_PARTIAL -eq '1') {
    [pscustomobject]@{TaskName='Inspection denied';TaskPath='\';Actions=@([pscustomobject]@{Execute='check.exe'})}
  }
}
function Get-ScheduledTaskInfo {
  param($TaskName, $TaskPath)
  if ($TaskName -eq 'Inspection denied') { throw 'PRIVATE denied task details' }
  if ($TaskName -eq 'Inspection on-demand') {
    [pscustomobject]@{LastRunTime=$null;NextRunTime=$null;LastTaskResult=267011}
    return
  }
  [pscustomobject]@{LastRunTime=[datetime]'2026-09-07';NextRunTime=[datetime]'2026-09-08';LastTaskResult=0}
}
function wsl.exe {
  $global:LASTEXITCODE=0
  if ($args -contains '--list') { 'Ubuntu' }
  else { '{"mode":"read-only","cutoverComplete":false,"sections":{}}' }
}
& '__COLLECTOR__'
exit $LASTEXITCODE
'''.replace('__COLLECTOR__', str(collector).replace("'", "''"))
            wrapper = fixture / 'run.ps1'
            wrapper.write_text(script, encoding='ascii')
            env = {**os.environ, 'USERPROFILE':str(fixture)}
            result = subprocess.run(['powershell.exe','-NoProfile','-File',str(wrapper)],
                                    capture_output=True, text=True, env=env, timeout=30)
            self.assertEqual(result.returncode, 0, result.stderr)
            report = json.loads((fixture/'Inspection-maintenance/local-cutover-latest.json').read_text(encoding='utf-8'))
            self.assertEqual(report['windowsTasks']['status'], 'collected')
            self.assertEqual(len(report['windowsTasks']['evidence']), 2)
            self.assertIn('MSFT_TaskBootTrigger', report['windowsTasks']['evidence'][0]['triggerTypes'])
            self.assertEqual(report['windowsTasks']['evidence'][1]['triggerTypes'], [])
            self.assertIsNone(report['windowsTasks']['evidence'][1]['lastRun'])
            self.assertIsNone(report['windowsTasks']['evidence'][1]['nextRun'])
            self.assertNotIn('PRIVATE', json.dumps(report))
            self.assertFalse(report['cutoverComplete'])
            result = subprocess.run(['powershell.exe','-NoProfile','-File',str(wrapper)],
                                    capture_output=True, text=True,
                                    env={**env, 'INSPECTION_TEST_PARTIAL':'1'}, timeout=30)
            self.assertNotEqual(result.returncode, 0)
            report = json.loads((fixture/'Inspection-maintenance/local-cutover-latest.json').read_text(encoding='utf-8'))
            self.assertEqual(report['windowsTasks']['status'], 'partial')
            self.assertEqual(len(report['windowsTasks']['evidence']), 2)
            self.assertEqual(report['windowsTasks']['errors'][0]['stage'], 'runtime-info')
            self.assertNotIn('PRIVATE', json.dumps(report))


if __name__ == '__main__':
    unittest.main()
