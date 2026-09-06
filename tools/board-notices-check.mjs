import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { readMarketBoardNotices } from '../supabase/functions/app-api/market-board-notices.ts';

// Exercise the real authenticated HTTP handler; only the database, auth service and limiter are replaced.
const output = await build({ entryPoints: ['supabase/functions/admin-api/index.ts'], bundle: true, write: false, platform: 'node', format: 'esm', plugins: [{ name: 'services', setup(b) {
  b.onResolve({ filter: /^https:|security-monitor\.ts$/ }, a => ({ path: a.path, namespace: 'fixture' }));
  b.onLoad({ filter: /.*/, namespace: 'fixture' }, a => ({ contents: a.path.startsWith('https:')
    ? 'export const createClient=()=>globalThis.boardDb;'
    : 'export const enforceDurableRateLimit=async()=>({allowed:true});export const recordRateLimitDenial=async()=>{};export const securityRequestId=()=>"test";' }));
} }] });
process.env.SUPABASE_URL = 'https://fixture.invalid'; process.env.SUPABASE_ANON_KEY = 'fixture'; process.env.SUPABASE_SERVICE_ROLE_KEY = 'fixture';
const { handleAdminApiRequest } = await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`);
const personalId = '10000000-0000-0000-0000-000000000001';
let rows = [{ notif_id: personalId, recipient_id: 'person', event: 'new_repair', title: '個人通知', body: '私人內容' }];
let profile = { user_id: 'admin', auth_id: 'auth', rbac_role: 'sysadmin', role: 'admin', status: 'active' };
let queries = [], audits = [], dbError = false;
globalThis.boardDb = {
  auth: { getUser: async () => ({ data: { user: { id: 'auth' } }, error: null }) },
  from(table) {
    let filters = [], update, insert, single = false;
    const q = { table, operation: 'select' }; queries.push(q);
    const api = {
      select() { return api; }, order() { return api; }, limit() { return api; },
      eq(k, v) { filters.push(row => row[k] === v); return api; },
      is(k, v) { filters.push(row => (row[k] ?? null) === v); return api; },
      in(k, values) { filters.push(row => values.includes(row[k])); return api; },
      or(expression) { assert.equal(expression, 'event.is.null,event.neq.board_notice_inactive'); filters.push(row => row.event !== 'board_notice_inactive'); return api; },
      update(value) { update = value; q.operation = 'update'; return api; },
      insert(value) { insert = value; q.operation = 'insert'; return api; },
      maybeSingle() { single = true; return api; },
      then(resolve, reject) {
        if (dbError && table === 'notifications') return Promise.resolve({ data: null, error: { message: 'fixture' } }).then(resolve, reject);
        let found = (table === 'users' ? [profile] : table === 'notifications' ? rows : []).filter(row => filters.every(filter => filter(row)));
        if (update) found.forEach(row => Object.assign(row, update));
        if (insert) {
          if (table === 'audit_logs') audits.push(insert);
          else { const row = { notif_id: '20000000-0000-0000-0000-000000000002', created_at: '2026-09-06T00:00:00Z', ...insert }; rows.push(row); found = [row]; }
        }
        return Promise.resolve({ data: structuredClone(single ? found[0] || null : found), error: null }).then(resolve, reject);
      },
    }; return api;
  },
};
async function call(action, payload = {}, token = true) {
  const response = await handleAdminApiRequest(new Request('https://fixture.invalid/admin-api', { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer fixture' } : {}) }, body: JSON.stringify({ action, ...payload }) }));
  return { status: response.status, body: await response.json() };
}
const action = 'admin_save_board_notice';
const values = { title: ' 公告 ', body: ' 測試內容 ', publish_confirmed: true };
assert.equal((await call(action, values, false)).status, 401);
profile = { ...profile, role: 'reporter', rbac_role: 'reporter' }; queries = [];
for (const name of [action, 'admin_list_board_notices', 'admin_toggle_board_notice']) assert.equal((await call(name, values)).status, 403);
assert.ok(!queries.some(q => q.table === 'notifications'));
profile = { ...profile, role: 'admin', rbac_role: 'sysadmin' };
assert.equal((await call(action, { ...values, publish_confirmed: false })).status, 400);
assert.equal((await call(action, { ...values, body: 'a'.repeat(201) })).status, 400);
assert.equal((await call(action, { ...values, title: ' ' })).status, 400);
assert.equal((await call(action, { ...values, notif_id: personalId })).status, 404);
assert.equal((await call('admin_toggle_board_notice', { notif_id: personalId, status: 'inactive' })).status, 404);
assert.equal(rows[0].body, '私人內容');
const created = await call(action, values); assert.equal(created.status, 200);
const noticeId = created.body.data.notif_id;
assert.equal(created.body.data.title, '公告'); assert.equal(created.body.data.recipient_id, null);
assert.equal(audits.length, 1);
assert.equal((await call('admin_list_board_notices')).body.data.length, 1);
assert.equal((await readMarketBoardNotices(globalThis.boardDb, true)).data.length, 1);
assert.equal((await call('admin_toggle_board_notice', { notif_id: noticeId, status: 'invalid' })).status, 400);
assert.equal((await call('admin_toggle_board_notice', { notif_id: noticeId, status: 'inactive' })).status, 200);
assert.equal(rows.length, 2, '停用不可刪除歷史');
assert.equal((await readMarketBoardNotices(globalThis.boardDb, true)).data.length, 0);
assert.equal((await readMarketBoardNotices(globalThis.boardDb, false)).data.length, 1);
assert.equal((await call(action, { ...values, notif_id: noticeId, body: '已修訂', publish_confirmed: false })).status, 200);
assert.equal(rows[1].event, 'board_notice_inactive', '編輯停用公告不可自動重新公開');
assert.equal((await call('admin_toggle_board_notice', { notif_id: noticeId, status: 'active' })).status, 400);
assert.equal((await call('admin_toggle_board_notice', { notif_id: noticeId, status: 'active', publish_confirmed: true })).status, 200);
assert.equal((await readMarketBoardNotices(globalThis.boardDb, true)).data[0].body, '已修訂');
dbError = true;
assert.equal((await call('admin_list_board_notices')).status, 503);
assert.equal((await call(action, values)).status, 503);
console.log('看板公告檢查通過：登入／管理員防護、輸入與公開確認、個人通知隔離、建立／編輯／停用／啟用、公開及登入版篩選、稽核與資料庫失敗。');
