#!/usr/bin/env node

/**
 * Supabase 正式資料庫與 Storage 備份。
 *
 * Free 方案沒有自動備份，也沒有 PITR：資料一旦被 UPDATE 寫壞就沒有任何時間點
 * 可以回溯（41 張表的 trg_prevent_removal 只擋得住 DELETE/TRUNCATE）。這支腳本
 * 補的就是這個缺口。
 *
 * 認證只用 Management API token，由 GitHub Actions 提供。token 與 service_role
 * key 都不會寫進 stdout、備份檔或 manifest。
 *
 * 資料以 row_to_json 匯出成 NDJSON：型別轉換交給 PostgreSQL，還原時用
 * jsonb_populate_record 轉回來，不必自己猜 timestamp 或 numeric 的格式。
 */

import { createHash } from 'node:crypto';
import { mkdir, writeFile, appendFile, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { backupRequest } from './backup-request.mjs';

const PROJECT_REF = process.env.SUPABASE_PROJECT_REF || 'qztffronusdhgxhjjubt';
const MANAGEMENT_TOKEN = process.env.SUPABASE_ACCESS_TOKEN || '';
const OUT_DIR = process.env.BACKUP_OUT_DIR || '';
const PAGE_SIZE = integerEnv('BACKUP_PAGE_SIZE', 2000, 100, 10000);
const INCLUDE_STORAGE = process.env.BACKUP_INCLUDE_STORAGE !== 'false';

const QUERY_URL = `https://api.supabase.com/v1/projects/${encodeURIComponent(PROJECT_REF)}/database/query`;
const KEYS_URL = `https://api.supabase.com/v1/projects/${encodeURIComponent(PROJECT_REF)}/api-keys?reveal=true`;

function integerEnv(name, fallback, min, max) {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}

function fail(message) {
  console.error(`::error::${message}`);
  process.exit(1);
}

/** 對 Management API 送唯讀查詢。備份流程絕不寫入正式庫。 */
async function query(sql) {
  return backupRequest(QUERY_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${MANAGEMENT_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query: sql, read_only: true }),
  }, response => response.json(), 'Management API');
}

/** 識別碼一律走這裡，避免表名被當成 SQL 片段拼進查詢。 */
function quoteIdent(name) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`表名不符合預期：${name}`);
  return `"${name}"`;
}

async function listTables() {
  const rows = await query(
    "select table_name from information_schema.tables " +
    "where table_schema = 'public' and table_type = 'BASE TABLE' order by table_name",
  );
  const keys = await query(
    // information_schema.table_constraints hides PKs from the Management API's
    // read-only role. Catalog metadata remains readable without write privileges.
    'select c.relname as table_name, a.attname as column_name from pg_catalog.pg_index i ' +
    'join pg_catalog.pg_class c on c.oid = i.indrelid ' +
    'join pg_catalog.pg_namespace n on n.oid = c.relnamespace ' +
    'join lateral unnest(i.indkey::smallint[]) with ordinality k(attnum, position) on true ' +
    'join pg_catalog.pg_attribute a on a.attrelid = c.oid and a.attnum = k.attnum ' +
    "where n.nspname = 'public' and i.indisprimary and k.position <= i.indnkeyatts " +
    'order by c.relname, k.position',
  );
  return rows.map(r => ({
    name: r.table_name,
    primaryColumns: keys.filter(k => k.table_name === r.table_name).map(k => k.column_name),
  }));
}

/**
 * Prefer the primary-key index instead of sorting every table by physical ctid.
 * Bound the source rows before JSON conversion; otherwise wide JSON columns can
 * make sorting needlessly expensive. Tables without a PK retain the ctid fallback.
 * Requests use separate read snapshots: this is still an off-peak logical export,
 * not a transaction-consistent PostgreSQL snapshot under concurrent updates.
 */
async function dumpTable(table, primaryColumns, tablesDir) {
  const ident = quoteIdent(table);
  const order = primaryColumns.length ? primaryColumns.map(quoteIdent).join(', ') : 'ctid';
  const file = path.join(tablesDir, `${table}.ndjson`);
  const hash = createHash('sha256');
  let offset = 0;
  let rows = 0;
  await writeFile(file, '');
  for (;;) {
    const batch = await query(
      `select row_to_json(t)::text as r from (select * from public.${ident} ` +
      `order by ${order} limit ${PAGE_SIZE} offset ${offset}) t`,
    );
    if (!batch.length) break;
    const chunk = batch.map(row => row.r).join('\n') + '\n';
    hash.update(chunk);
    await appendFile(file, chunk);
    rows += batch.length;
    console.log(`資料表 ${table}：已匯出 ${rows} 列`);
    offset += batch.length;
    if (batch.length < PAGE_SIZE) break;
  }
  return { name: table, rows, sha256: hash.digest('hex') };
}

/** service_role key 只在記憶體中停留，不寫檔也不列印。 */
async function serviceRoleKey() {
  const keys = await backupRequest(KEYS_URL, {
    headers: { Authorization: `Bearer ${MANAGEMENT_TOKEN}` },
  }, response => response.json(), '取得 Storage 備份權限');
  const found = (Array.isArray(keys) ? keys : []).find(k => k.name === 'service_role');
  if (!found?.api_key) throw new Error('回應中找不到 service_role 金鑰');
  return found.api_key;
}

async function dumpStorage(storageDir) {
  const buckets = await query('select id, name, public from storage.buckets order by name');
  if (!buckets.length) return [];
  const key = await serviceRoleKey();
  const summary = [];
  for (const bucket of buckets) {
    const objects = await query(
      `select name, coalesce((metadata->>'size')::bigint, 0) as size from storage.objects ` +
      `where bucket_id = '${bucket.id.replace(/'/g, "''")}' order by name`,
    );
    let bytes = 0;
    let saved = 0;
    for (const object of objects) {
      const url = `https://${PROJECT_REF}.supabase.co/storage/v1/object/` +
        `${encodeURIComponent(bucket.name)}/${object.name.split('/').map(encodeURIComponent).join('/')}`;
      const body = await backupRequest(url, {
        headers: { Authorization: `Bearer ${key}`, apikey: key },
      }, async response => Buffer.from(await response.arrayBuffer()), 'Storage 物件下載');
      const target = path.join(storageDir, bucket.name, object.name);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, body);
      bytes += body.byteLength;
      saved += 1;
    }
    summary.push({ bucket: bucket.name, public: bucket.public === true, objects: saved, bytes });
  }
  return summary;
}

export async function main() {
  if (!MANAGEMENT_TOKEN) fail('缺少 SUPABASE_ACCESS_TOKEN。');
  if (!OUT_DIR) fail('缺少 BACKUP_OUT_DIR。');

  const startedAt = new Date();
  const tablesDir = path.join(OUT_DIR, 'tables');
  const storageDir = path.join(OUT_DIR, 'storage');
  await mkdir(tablesDir, { recursive: true });
  if (INCLUDE_STORAGE) await mkdir(storageDir, { recursive: true });

  const tables = await listTables();
  if (!tables.length) fail('public schema 查不到任何資料表，備份中止。');

  const dumped = [];
  for (const table of tables) {
    console.log(`開始匯出資料表 ${table.name}（${table.primaryColumns.length ? '主鍵排序' : '無主鍵，實體位置排序'}）`);
    dumped.push(await dumpTable(table.name, table.primaryColumns, tablesDir));
    console.log(`完成資料表 ${table.name}：${dumped.at(-1).rows} 列`);
  }

  const storage = INCLUDE_STORAGE ? await dumpStorage(storageDir) : [];

  const manifest = {
    version: 1,
    created_at: startedAt.toISOString(),
    finished_at: new Date().toISOString(),
    project_ref: PROJECT_REF,
    page_size: PAGE_SIZE,
    scope: {
      public_tables: true,
      storage_objects: INCLUDE_STORAGE,
      // 這兩項刻意不納入：auth.users 與 cluster 角色需要另一組權限，且還原時
      // 牽涉帳號身分，不適合和資料備份混在同一份檔案裡。復原後帳號要重建，
      // 詳見 docs/DATABASE_BACKUP_RECOVERY.md。
      auth_users: false,
      database_roles: false,
    },
    totals: {
      tables: dumped.length,
      rows: dumped.reduce((sum, t) => sum + t.rows, 0),
      storage_objects: storage.reduce((sum, b) => sum + b.objects, 0),
      storage_bytes: storage.reduce((sum, b) => sum + b.bytes, 0),
    },
    tables: dumped,
    storage,
  };
  await writeFile(path.join(OUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

  console.log(
    `備份完成：${manifest.totals.tables} 張表、${manifest.totals.rows} 筆資料、` +
    `${manifest.totals.storage_objects} 個 Storage 物件（${manifest.totals.storage_bytes} bytes）。`,
  );
}

/** 供還原腳本與驗證流程重用，確認 NDJSON 與 manifest 記載的一致。 */
export async function verifyBackup(dir) {
  const manifest = JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8'));
  const problems = [];
  for (const table of manifest.tables) {
    const file = path.join(dir, 'tables', `${table.name}.ndjson`);
    let content = '';
    try {
      content = await readFile(file, 'utf8');
    } catch {
      problems.push(`${table.name}：找不到 ${table.name}.ndjson`);
      continue;
    }
    const digest = createHash('sha256').update(content).digest('hex');
    if (digest !== table.sha256) problems.push(`${table.name}：sha256 不符`);
    const lines = content ? content.trimEnd().split('\n').length : 0;
    if (content === '' ? table.rows !== 0 : lines !== table.rows) {
      problems.push(`${table.name}：行數 ${content === '' ? 0 : lines} 與 manifest 的 ${table.rows} 不符`);
    }
  }
  return { manifest, problems };
}

// 只有直接執行才跑；被 import 時（還原腳本、測試）不動作。
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch(error => fail(error instanceof Error ? error.message : String(error)));
}
