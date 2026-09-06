#!/usr/bin/env node

/**
 * 備份與還原邏輯的離線檢查，不連任何網路。
 *
 * 備份最危險的失效方式是安靜的：分頁邊界差一筆、某張表寫到一半、還原時多送了一句
 * 刪除。這些都不會當場報錯，要等到真的需要還原那天才發現，而那天沒有第二次機會。
 * 這支就是把那些邊界釘死。
 */

import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import path from 'node:path';

const failures = [];
const check = (label, ok, detail = '') => {
  if (!ok) failures.push(`${label}${detail ? `：${detail}` : ''}`);
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail && !ok ? `　${detail}` : ''}`);
};

const backupModule = new URL('./database-backup.mjs', import.meta.url).href;
const restoreModule = new URL('./database-restore.mjs', import.meta.url).href;

// ---- 備份：分頁邊界與完整性 ----
// 三張表刻意選在邊界上：正好整除一頁、比一頁多一筆、以及完全空的表。
const TABLES = { exact_200: 200, over_page: 201, empty_table: 0 };
const OUT = await mkdtemp(path.join(tmpdir(), 'backup-check-'));
let readOnlyViolations = 0;
const seenOrders = new Map();

const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const body = JSON.parse(init.body);
  if (body.read_only !== true) readOnlyViolations += 1;
  const reply = data => ({ ok: true, status: 200, json: async () => data });
  if (body.query.includes('information_schema.tables')) {
    return reply(Object.keys(TABLES).map(table_name => ({ table_name })));
  }
  if (body.query.includes('pg_catalog.pg_index')) {
    return reply([
      { table_name: 'exact_200', column_name: 'id' },
      { table_name: 'over_page', column_name: 'id' },
      { table_name: 'over_page', column_name: 'ts' },
    ]);
  }
  const match = body.query.match(/from \(select \* from public\."([a-z0-9_]+)" (?:where (.+) )?order by (.+) limit (\d+)(?: offset (\d+))?\) t$/);
  if (!match) throw new Error(`未預期的查詢：${body.query.slice(0, 60)}`);
  const [, table, where, order, limit, offset] = match;
  seenOrders.set(table, order);
  const start = where ? Number(where.match(/> \(E'(\d+)'/)[1]) + 1 : Number(offset || 0);
  const rows = [];
  for (let i = start; i < Math.min(TABLES[table], start + Number(limit)); i++) {
    rows.push({ r: JSON.stringify({ id: i, name: `第 ${i} 筆`, ts: '2026-08-25T12:00:00+08:00' }),
      backup_cursor: JSON.stringify(table === 'over_page' ? [String(i), '2026-08-25T12:00:00+08:00'] : [String(i)]) });
  }
  return reply(rows);
};

process.env.SUPABASE_ACCESS_TOKEN = 'offline-check';
process.env.BACKUP_OUT_DIR = OUT;
process.env.BACKUP_PAGE_SIZE = '100';
process.env.BACKUP_INCLUDE_STORAGE = 'false';

console.log('備份：分頁與完整性');
const { main, verifyBackup, buildTablePageQuery } = await import(backupModule);
await main();
globalThis.fetch = originalFetch;

const manifest = JSON.parse(await readFile(path.join(OUT, 'manifest.json'), 'utf8'));
check('備份查詢全部是唯讀', readOnlyViolations === 0, `${readOnlyViolations} 次非唯讀`);
check('單欄主鍵使用索引排序', seenOrders.get('exact_200') === '"id"');
check('複合主鍵保留欄位順序', seenOrders.get('over_page') === '"id", "ts"');
check('無主鍵保留 ctid 分頁', seenOrders.get('empty_table') === 'ctid');
const cursorQuery = buildTablePageQuery('test', ['id', 'name'], 100, 2000, ['9007199254740993', "O'Brien\\x"]);
check('主鍵以游標接續、不使用 OFFSET', !/\boffset\b/i.test(cursorQuery) && cursorQuery.includes('where ("id", "name") >'));
check('游標保留大整數與正確跳脫字元', cursorQuery.includes("E'9007199254740993'") && cursorQuery.includes("E'O''Brien\\\\x'"));
let invalidCursorRejected = false;
try { buildTablePageQuery('test', ['id'], 100, 0, [null]); } catch { invalidCursorRejected = true; }
check('無效游標會中止', invalidCursorRejected);
for (const [name, expected] of Object.entries(TABLES)) {
  const entry = manifest.tables.find(t => t.name === name);
  check(`${name} 筆數 ${expected}`, entry?.rows === expected, `實際 ${entry?.rows}`);
  const content = await readFile(path.join(OUT, 'tables', `${name}.ndjson`), 'utf8');
  const lines = content ? content.trimEnd().split('\n').length : 0;
  check(`${name} 實際行數 ${expected}`, lines === expected, `實際 ${lines}`);
  const ids = content.trim() ? content.trimEnd().split('\n').map(line => JSON.parse(line).id) : [];
  check(`${name} 分頁無遺漏或重複`, ids.length === expected && ids.every((id, index) => id === index));
}
check('manifest 總筆數正確', manifest.totals.rows === 401, `實際 ${manifest.totals.rows}`);
check('manifest 標明未含 auth 帳號', manifest.scope.auth_users === false);

const clean = await verifyBackup(OUT);
check('未竄改時完整性檢查通過', clean.problems.length === 0, clean.problems.join('；'));

const target = path.join(OUT, 'tables', 'over_page.ndjson');
const original = await readFile(target, 'utf8');
await writeFile(target, original.replace('第 5 筆', '第 X 筆'));
check('抓得到內容被竄改', (await verifyBackup(OUT)).problems.length > 0);
await writeFile(target, original.split('\n').slice(1).join('\n'));
const truncated = await verifyBackup(OUT);
check('抓得到少了一行', truncated.problems.some(p => p.includes('行數')));
await rm(OUT, { recursive: true, force: true });

// ---- 還原：產生的 SQL 不得含刪除語意 ----
console.log('還原：語句與參數');
const { buildStatement, parseArgs } = await import(restoreModule);
const rows = [{ id: 1, name: 'a' }, { id: 2, name: 'b' }];
const upsert = buildStatement('locations', rows, ['id'], ['id', 'name'], 'upsert');
const missing = buildStatement('locations', rows, ['id'], ['id', 'name'], 'insert-missing');
const noPk = buildStatement('locations', rows, [], ['id', 'name'], 'upsert');

for (const [label, sql] of [['upsert', upsert], ['insert-missing', missing], ['無主鍵', noPk]]) {
  check(`${label} 不含 delete/truncate/drop`, !/\b(delete|truncate|drop)\b/i.test(sql));
  check(`${label} 使用 jsonb_populate_recordset`, sql.includes('jsonb_populate_recordset'));
}
check('upsert 會更新非主鍵欄位', upsert.includes('do update set "name" = excluded."name"'));
check('upsert 不更新主鍵本身', !upsert.includes('do update set "id"'));
check('insert-missing 不覆蓋既有資料', missing.includes('on conflict do nothing'));
check('無主鍵時退回 insert-missing', noPk.includes('on conflict do nothing'));

let rejected = false;
try { buildStatement('locations; drop table users', rows, ['id'], ['id'], 'upsert'); } catch { rejected = true; }
check('表名含 SQL 片段時拒絕', rejected);

const args = parseArgs(['--dir=/tmp/b', '--tables=a,b']);
check('未指定 --execute 時預設為演練', args.execute === false);

console.log('');
if (failures.length) {
  console.error(`::error::備份／還原邏輯檢查未通過（${failures.length} 項）：`);
  for (const item of failures) console.error(`  - ${item}`);
  process.exit(1);
}
console.log('備份與還原邏輯檢查通過。');
