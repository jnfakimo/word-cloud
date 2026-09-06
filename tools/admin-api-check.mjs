import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

function checkRoutes(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (['.next', 'out', 'node_modules'].includes(entry.name)) continue;
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) checkRoutes(file);
    else if (/\.(tsx?|jsx?)$/.test(entry.name)) assert.doesNotMatch(readFileSync(file, 'utf8'), /["'`]\/api\/local\//, `不可再呼叫已移除的 cookie API：${file}`);
  }
}
checkRoutes('web');

// Bundle the actual adapter, substituting only its session client and audit sink.
const output = await build({
  entryPoints: ['web/lib/admin-api.ts'], bundle: true, write: false, platform: 'node', format: 'esm',
  plugins: [{ name: 'admin-test-dependencies', setup(builder) {
    builder.onResolve({ filter: /^\.\/(supabase|security-audit-sink)$/ }, args => ({ path: args.path, namespace: 'test' }));
    builder.onLoad({ filter: /.*/, namespace: 'test' }, args => ({ contents: args.path.endsWith('/supabase')
      ? 'export const getSupabase = () => globalThis.adminTestClient;'
      : 'export const emitSecurityDataRead = label => globalThis.adminTestReads.push(label);' }));
  } }],
});
const { invokeAdminApi } = await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`);
let calls = [];
let result;
globalThis.adminTestReads = [];
globalThis.adminTestClient = { functions: { invoke: async (...args) => { calls.push(args); return result; } } };
result = { data: { ok: true, data: [{ application_id: 'test' }] }, error: null };
assert.deepEqual(await invokeAdminApi('admin_list_account_applications', { action: 'must-not-override' }), result.data);
assert.deepEqual(calls[0], ['admin-api', { body: { action: 'admin_list_account_applications' }, timeout: 15000 }]);
assert.deepEqual(globalThis.adminTestReads, ['讀取帳號申請清單']);

for (const [status, body, expected] of [
  [401, '', /登入已逾時/], [403, '', /沒有執行/], [404, '<html>Not found</html>', /404/],
  [400, JSON.stringify({ message: '直屬主管必須是啟用中的帳號' }), /直屬主管必須是啟用中的帳號/],
  [503, '', /503/],
]) {
  calls = [];
  result = { data: null, error: { context: new Response(body, { status }) } };
  await assert.rejects(invokeAdminApi('admin_save_user'), expected);
  assert.equal(calls.length, 1, '管理寫入失敗不可重送');
}
calls = [];
result = { data: null, error: new Error('network timeout') };
await assert.rejects(invokeAdminApi('admin_save_user'), /連線失敗或逾時/);
assert.equal(calls.length, 1);
result = { data: { ok: false, message: '資料不符合系統規則' }, error: null };
await assert.rejects(invokeAdminApi('admin_save_user'), /資料不符合系統規則/);
assert.equal(globalThis.adminTestReads.length, 1, '失敗操作不可紀錄成成功讀取');
console.log('管理 API 回歸檢查通過：session client 路由、回應契約、權限／逾時／非 JSON 錯誤與不重送管理寫入。');
