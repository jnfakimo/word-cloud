import { test } from 'node:test';
import assert from 'node:assert/strict';
import { backupRequest } from './backup-request.mjs';
const url = 'https://fixture.invalid/private';
const read = response => response.json();
test('暫時 HTTP 失敗有限重試，成功只回傳資料', async () => {
  let calls = 0;
  const result = await backupRequest(url, {}, read, '備份', { delay: async () => {}, fetcher: async () => ++calls < 3 ? new Response('', { status: 503 }) : Response.json({ ok: true }) });
  assert.deepEqual(result, { ok: true }); assert.equal(calls, 3);
});
test('權限失敗不重試、不洩露錯誤本文', async () => {
  let calls = 0;
  await assert.rejects(backupRequest(url, {}, read, '備份', { fetcher: async () => { calls++; return new Response('secret response', { status: 403 }); } }), { message: '備份回應 HTTP 403' });
  assert.equal(calls, 1);
});
test('逾時涵蓋回應本文，不只涵蓋 headers', async () => {
  let calls = 0;
  await assert.rejects(backupRequest(url, {}, read, '備份', { timeoutMs: 10, attempts: 2, delay: async () => {}, fetcher: async (_url, { signal }) => {
    calls++;
    return { ok: true, json: () => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('secret transport details')), { once: true })) };
  } }), { message: '備份逾時' });
  assert.equal(calls, 2);
});
test('未成功請求不會被當成備份成功', async () => {
  let calls = 0;
  await assert.rejects(backupRequest(url, {}, read, '備份', { delay: async () => {}, fetcher: async () => { calls++; throw new Error('private URL'); } }), { message: '備份連線或回應讀取失敗' });
  assert.equal(calls, 3);
});
