import assert from 'node:assert/strict';
import { build } from 'esbuild';

const bundle = await build({
  entryPoints: ['supabase/functions/official-document-timeout-check/index.ts'],
  bundle: true, write: false, platform: 'node', format: 'esm',
  plugins: [{ name: 'offline-db', setup(builder) {
    builder.onResolve({ filter: /^https:\/\/esm\.sh\// }, args => ({ path: args.path, namespace: 'offline' }));
    builder.onLoad({ filter: /.*/, namespace: 'offline' }, () => ({
      contents: 'export const createClient = () => globalThis.__timeoutCheckDb;', loader: 'js',
    }));
  } }],
});
let handler;
globalThis.Deno = { serve: fn => { handler = fn; }, env: { get: name => name === 'CRON_SECRET' ? 'offline-cron' : 'offline' } };
await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const captured = [];
const originalError = console.error;
console.error = (...args) => captured.push(JSON.stringify(args));
try {
  for (const failure of [new Error('PRIVATE_SQL_AND_TOKEN'), { message: 'PRIVATE_SQL_AND_TOKEN', details: 'private schema' }]) {
    globalThis.__timeoutCheckDb = { from() { throw failure; } };
    const response = await handler(new Request('https://example.test', { method: 'POST', headers: { 'x-cron-secret': 'offline-cron' }, body: '{}' }));
    assert.equal(response.status, 500);
    const body = await response.json();
    assert.equal(body.ok, false);
    assert.equal(body.message, '公文逾時檢查暫時無法完成，請稍後再試。');
    assert.match(body.request_id, /^[0-9a-f-]{36}$/);
    assert.doesNotMatch(JSON.stringify(body), /PRIVATE|schema|stack/);
    assert.ok(captured.at(-1).includes(body.request_id));
  }
  assert.doesNotMatch(captured.join('\n'), /PRIVATE|schema|stack/);
  const rejected = await handler(new Request('https://example.test', { method: 'POST', body: '{}' }));
  assert.equal(rejected.status, 401);
} finally {
  console.error = originalError;
  delete globalThis.Deno;
  delete globalThis.__timeoutCheckDb;
}
console.log('公文逾時實際 handler：Error／資料庫錯誤不外洩、request ID 可追蹤、未授權 401 通過。');
