"""Collector boundary and redaction tests; no production Docker/WSL calls."""
import contextlib
import importlib.util
import io
import json
from pathlib import Path
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
             contextlib.redirect_stdout(output)):
            exit_code = cutover.main()
        self.assertEqual(exit_code, 2)
        self.assertNotIn('PRIVATE', output.getvalue())
        self.assertFalse(json.loads(output.getvalue())['cutoverComplete'])


if __name__ == '__main__':
    unittest.main()
