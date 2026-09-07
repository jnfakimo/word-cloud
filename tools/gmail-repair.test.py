"""Isolated SMTP repair transactions. Never connects to Gmail or production."""
import copy
import importlib.util
import json
import os
from pathlib import Path
import smtplib
import subprocess
import tempfile
import unittest
from unittest.mock import patch, MagicMock

spec = importlib.util.spec_from_file_location('gmail', Path(__file__).with_name('repair-local-gmail.py'))
gmail = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gmail)
PAYLOAD = {'email': 'test.sender@gmail.com', 'password': 'abcd efgh ijkl mnop'}


class RepairTests(unittest.TestCase):
    def test_input_and_env_preservation(self):
        email, password = gmail.credentials(PAYLOAD)
        values = gmail.settings(email, password)
        original = b'# retain\nOTHER_SECRET=PRIVATE\nSMTP_HOST=old\n'
        result = gmail.updated_env(original, values)
        self.assertIn(b'OTHER_SECRET=PRIVATE\n', result)
        self.assertIn(b'SMTP_HOST=smtp.gmail.com\n', result)
        self.assertEqual(result.count(b'SMTP_HOST='), 1)
        with self.assertRaises(gmail.RepairError):
            gmail.updated_env(b'SMTP_HOST=a\nSMTP_HOST=b', values)
        for bad in ({'email':'gmail.com','password':'abcdefghijklmnop'},
                    {'email':'test@gmail.com','password':'ordinary-password'},
                    {'email':'x@gmail.com\nINJECT=1','password':'abcdefghijklmnop'}):
            with self.assertRaises(gmail.RepairError): gmail.credentials(bad)

    def test_verified_tls_precedes_auth_no_send(self):
        smtp = MagicMock()
        with patch.object(gmail.smtplib, 'SMTP') as factory:
            factory.return_value.__enter__.return_value = smtp
            gmail.authenticate('test@gmail.com', 'abcdefghijklmnop')
        methods = [call[0] for call in smtp.method_calls]
        self.assertEqual(methods, ['ehlo', 'starttls', 'ehlo', 'login'])
        context = smtp.starttls.call_args.kwargs['context']
        self.assertTrue(context.check_hostname)
        self.assertEqual(context.verify_mode, gmail.ssl.CERT_REQUIRED)

    def run_fixture(self, failure=None):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder).resolve()
            env = root / '.env'
            original = b'OTHER_SECRET=PRIVATE\nSMTP_HOST=old.invalid\n'
            env.write_bytes(original)
            compose_file = root / 'docker-compose.yml'
            compose_file.write_text('fixture', encoding='ascii')
            baseline = {'services':{'auth':{'image':'supabase/gotrue:test',
                        'container_name':'supabase-auth','environment':{'GOTRUE_SMTP_HOST':'old.invalid',
                        'DATABASE_URL':'PRIVATE'}}, 'db':{'image':'postgres:unchanged'}}}
            info = {'Config':{'Image':'supabase/gotrue:test',
                    'Env':['GOTRUE_SMTP_HOST=old.invalid','DATABASE_URL=PRIVATE'],
                    'Labels':{'com.docker.compose.service':'auth',
                              'com.docker.compose.project':'supabase',
                              'com.docker.compose.project.working_dir':str(root),
                              'com.docker.compose.project.config_files':str(compose_file)}},
                    'State':{'Status':'running','Health':{'Status':'healthy'}}}
            if failure == 'path':
                info['Config']['Labels']['com.docker.compose.project.config_files'] = str(root.parent/'other.yml')
            calls = []
            values = gmail.settings(*gmail.credentials(PAYLOAD))
            def execute(args, **kwargs):
                calls.append(args)
                self.assertNotIn('abcdefghijklmnop', ' '.join(args))
                if args[1] == 'inspect': return json.dumps([info])
                if 'config' in args:
                    config = copy.deepcopy(baseline)
                    if env.read_bytes() != original:
                        config['services']['auth']['environment'].update({'GOTRUE_SMTP_'+k:v for k,v in values.items()})
                        if failure == 'delta': config['services']['db']['image'] = 'unexpected'
                    return json.dumps(config)
                if args[1] == 'exec' and failure == 'dns':
                    raise gmail.RepairError('dns-test-failure')
                if 'up' in args:
                    self.assertEqual(args[-1], 'auth')
                    self.assertIn('--no-deps', args)
                    self.assertIn('never', args)
                return ''
            def authenticate(email, password):
                self.assertEqual(env.read_bytes(), original)
                if failure == 'auth': raise smtplib.SMTPAuthenticationError(535, b'PRIVATE')
            def write(path, data, *args): path.write_bytes(data)
            def health(execute):
                result = copy.deepcopy(info)
                if env.read_bytes() != original:
                    if failure == 'health': raise gmail.RepairError('health-test-failure')
                    result['Config']['Env'] = ['GOTRUE_SMTP_'+k+'='+v for k,v in values.items()]
                return result
            report = {'status':'failed','deliveryTestPerformed':False}
            if failure:
                expected = smtplib.SMTPAuthenticationError if failure == 'auth' else gmail.RepairError
                with self.assertRaises(expected):
                    gmail.repair(PAYLOAD, report, root, execute, authenticate, write, health)
                self.assertEqual(env.read_bytes(), original)
                if failure in ('delta','dns','health'):
                    self.assertEqual(report['rollback'], 'completed')
                if failure in ('auth','path','delta'):
                    self.assertFalse(any('up' in args for args in calls))
            else:
                gmail.repair(PAYLOAD, report, root, execute, authenticate, write, health)
                self.assertEqual(report['status'], 'configured')
                self.assertIn(b'OTHER_SECRET=PRIVATE', env.read_bytes())
                self.assertEqual((Path(report['backupDirectory'])/'original.env').read_bytes(), original)
            serialized = json.dumps(report)
            self.assertNotIn('PRIVATE', serialized)
            self.assertNotIn(PAYLOAD['email'], serialized)
            self.assertNotIn('abcdefghijklmnop', serialized)

    def test_success_and_private_backup(self): self.run_fixture()
    def test_auth_failure_never_changes_env(self): self.run_fixture('auth')
    def test_outside_compose_path_refused(self): self.run_fixture('path')
    def test_unrelated_delta_restores_without_restart(self): self.run_fixture('delta')
    def test_health_failure_rolls_back(self): self.run_fixture('health')
    def test_container_dns_failure_rolls_back(self): self.run_fixture('dns')

    @unittest.skipUnless(os.name == 'posix', 'Linux file ownership')
    def test_atomic_private_file(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / '.env'
            gmail.atomic_write(path, b'PRIVATE', 0o600, os.getuid(), os.getgid())
            self.assertEqual(path.read_bytes(), b'PRIVATE')
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            gmail.atomic_write(path, b'RESTORED', 0o600, os.getuid(), os.getgid())
            self.assertEqual(path.read_bytes(), b'RESTORED')
            self.assertEqual(list(Path(folder).iterdir()), [path])

    @unittest.skipUnless(os.name == 'nt', 'Windows PowerShell')
    def test_windows_secure_prompt_stdin_and_report(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            launcher = root / 'repair-local-gmail.ps1'
            launcher.write_bytes(Path(__file__).with_name(launcher.name).read_bytes())
            (root / 'inspect-local-cutover.ps1').write_text('param($Distribution)\nexit 0', encoding='ascii')
            script = r'''
function Get-NetIPAddress { [pscustomobject]@{IPAddress='192.168.50.192'} }
function Read-Host {
  param($Prompt, [switch]$AsSecureString)
  if ($AsSecureString) {
    $value=New-Object Security.SecureString
    foreach($character in 'abcdefghijklmnop'.ToCharArray()) { $value.AppendChar($character) }
    $value
  }
  else { 'test.sender@gmail.com' }
}
function wsl.exe {
  $global:LASTEXITCODE=0
  if ($args -contains '--list') { 'Ubuntu' }
  elseif ($args -contains 'wslpath') { '/mnt/c/repair-local-gmail.py' }
  else {
    if (($args -join ' ') -match 'abcdefghijklmnop') { throw 'secret in command arguments' }
    $data=(@($input) -join "`n") | ConvertFrom-Json
    if ($data.password -ne 'abcdefghijklmnop') { throw 'stdin did not receive the secret' }
    '{"status":"configured","deliveryTestPerformed":false}'
  }
}
& '__LAUNCHER__'
exit $LASTEXITCODE
'''.replace('__LAUNCHER__', str(launcher).replace("'", "''"))
            wrapper = root / 'fixture.ps1'
            wrapper.write_text(script, encoding='ascii')
            result = subprocess.run(['powershell.exe','-NoProfile','-File',str(wrapper)],
                                    env={**os.environ,'USERPROFILE':str(root)},
                                    capture_output=True,text=True,timeout=20)
            self.assertEqual(result.returncode, 0, result.stderr)
            report_text = (root/'Inspection-maintenance/gmail-repair-latest.json').read_text(encoding='utf-8')
            self.assertEqual(json.loads(report_text)['status'], 'configured')
            for private in ('abcdefghijklmnop','test.sender@gmail.com'):
                self.assertNotIn(private, report_text + result.stdout + result.stderr)

    @unittest.skipUnless(os.name == 'nt', 'Windows PowerShell')
    def test_powershell_parser(self):
        path = str(Path(__file__).with_name('repair-local-gmail.ps1').resolve()).replace("'", "''")
        script = "$e=$null;$t=$null;[System.Management.Automation.Language.Parser]::ParseFile('"+path+"',[ref]$t,[ref]$e)|Out-Null;if($e.Count){exit 1}"
        result = subprocess.run(['powershell.exe','-NoProfile','-Command',script],capture_output=True)
        self.assertEqual(result.returncode, 0)


if __name__ == '__main__': unittest.main()
