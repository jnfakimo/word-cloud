import assert from 'node:assert/strict';
import { build } from 'esbuild';

// Exercise the actual API adapter with a configured legacy remote Node endpoint.
// Only transport/session/audit dependencies are replaced; no account is changed.
let edgeCalls = [];
let remoteCalls = [];
let edgeError = null;
const savedFetch = globalThis.fetch;
const savedWindow = globalThis.window;
globalThis.window = { sessionStorage: {}, setTimeout, clearTimeout };
globalThis.routingClient = {
  auth: { getSession: async () => ({ data: { session: { access_token: 'synthetic-session' } } }) },
  functions: { invoke: async (...args) => {
    edgeCalls.push(args);
    return { data: { ok: true, data: 'local-result' }, error: edgeError };
  } },
};
globalThis.fetch = async (...args) => { remoteCalls.push(args); return Response.json({ ok: true, data: 'remote-result' }); };
try {
  for (const endpoint of ['https://192.168.50.192', 'https://192.168.50.192:5057', 'https://203.0.113.10:5443', 'http://localhost:3000', 'https://example.supabase.co']) {
    const output = await build({
      entryPoints: ['web/lib/supabase.ts'], bundle: true, write: false, platform: 'node', format: 'esm',
      define: { 'process.env.NEXT_PUBLIC_APP_API_URL': JSON.stringify('https://legacy.example.com') },
      plugins: [{ name: 'routing-dependencies', setup(builder) {
        builder.onResolve({ filter: /^(@supabase\/supabase-js|\.\/(config|error-tracker|security-audit-sink))$/ }, args => ({ path: args.path, namespace: 'test' }));
        builder.onLoad({ filter: /.*/, namespace: 'test' }, args => ({ contents:
          args.path === '@supabase/supabase-js' ? 'export const createClient = () => globalThis.routingClient;'
          : args.path === './config' ? `export const SUPABASE_URL = ${JSON.stringify(endpoint)}; export const SUPABASE_ANON_KEY = 'synthetic-public-key';`
          : args.path === './error-tracker' ? 'export const reportIfInfrastructureError = () => {};'
          : 'export const emitSecurityDataRead = () => {};'
        }));
      } }],
    });
    const { invokeAppApi } = await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`);
    const local = !endpoint.includes('supabase.co');
    for (const action of ['change_password', 'workorder_update']) {
      edgeCalls = []; remoteCalls = [];
      assert.equal(await invokeAppApi(action, { example: 'synthetic' }), local ? 'local-result' : 'remote-result');
      assert.equal(edgeCalls.length, local ? 1 : 0);
      assert.equal(remoteCalls.length, local ? 0 : 1);
      if (local) assert.deepEqual(edgeCalls[0], ['app-api', { body: { action, example: 'synthetic' } }]);
    }
    if (local) {
      edgeCalls = []; remoteCalls = []; edgeError = new Error('synthetic rejection');
      const previousError = console.error;
      try {
        console.error = () => {};
        await assert.rejects(invokeAppApi('change_password'), /synthetic rejection/);
      } finally { console.error = previousError; edgeError = null; }
      assert.equal(edgeCalls.length, 1);
      assert.equal(remoteCalls.length, 0, 'local write failure must not fall back to the remote backend');
    }
  }
  console.log('Local API routing passed: password/business writes stay local, forwarded ports, no remote fallback, cloud compatibility retained.');
} finally {
  globalThis.fetch = savedFetch;
  if (savedWindow === undefined) delete globalThis.window; else globalThis.window = savedWindow;
  delete globalThis.routingClient;
}
