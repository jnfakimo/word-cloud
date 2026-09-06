#!/usr/bin/env node

/**
 * 從 database-backup.mjs 產生的備份還原資料到 Supabase。
 *
 * 這支腳本會寫正式資料庫，所以預設什麼都不做：不加 --execute 就只是演練，
 * 印出打算送出的批次與筆數。--execute 還要同時給對得上的 --confirm=<project_ref>，
 * 避免把備份倒進錯的專案。
 *
 * 還原一律是 upsert 或 insert-missing，永遠不 DELETE：正式資料依規範只能追加、
 * 更新或停用，41 張表上的 trg_prevent_removal 也會直接擋下實體刪除。所以還原
 * 「不會」把備份之後新增的資料清掉——它補回缺的、蓋回被改壞的，僅此而已。
 *
 * 型別交給 PostgreSQL：NDJSON 每行是 row_to_json 的輸出，用 jsonb_populate_recordset
 * 轉回原本的欄位型別，不必自己猜 timestamptz 或 numeric 該怎麼寫。
 *
 * 這支刻意不接任何 workflow，只能由人手動執行。
 */

import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { verifyBackup } from './database-backup.mjs';

const MANAGEMENT_TOKEN = process.env.SUPABASE_ACCESS_TOKEN || '';
const PROJECT_REF = process.env.SUPABASE_PROJECT_REF || '';
const QUERY_URL = `https://api.supabase.com/v1/projects/${encodeURIComponent(PROJECT_REF)}/database/query`;
const BATCH = 200;

export function parseArgs(argv) {
  const args = { tables: [], mode: 'upsert', execute: false, confirm: '', dir: '', skipVerify: false };
  for (const item of argv) {
    if (item === '--execute') args.execute = true;
    else if (item === '--skip-verify') args.skipVerify = true;
    else if (item.startsWith('--dir=')) args.dir = item.slice(6);
    else if (item.startsWith('--confirm=')) args.confirm = item.slice(10);
    else if (item.startsWith('--mode=')) args.mode = item.slice(7);
    else if (item.startsWith('--tables=')) args.tables = item.slice(9).split(',').map(s => s.trim()).filter(Boolean);
    else if (item === '--all') args.tables = ['*'];
    else throw new Error(`未知參數：${item}`);
  }
  return args;
}

function quoteIdent(name) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`表名不符合預期：${name}`);
  return `"${name}"`;
}

function sqlLiteral(text) {
  return `E'${String(text).replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;
}

async function query(sql, readOnly) {
  const response = await fetch(QUERY_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${MANAGEMENT_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql, read_only: readOnly }),
    signal: AbortSignal.timeout(60000),
  });
  if (!response.ok) throw new Error(`Management API 回應 HTTP ${response.status}`);
  return response.json();
}

/** A primary key is required: ON CONFLICT does not deduplicate a table without constraints. */
async function primaryKey(table) {
  const rows = await query(
    'select a.attname as col from pg_index i ' +
    'join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey) ' +
    `where i.indrelid = ${sqlLiteral(`public.${table}`)}::regclass and i.indisprimary ` +
    'order by array_position(i.indkey, a.attnum)',
    true,
  );
  return rows.map(r => r.col);
}

async function columns(table) {
  const rows = await query(
    'select column_name from information_schema.columns ' +
    `where table_schema = 'public' and table_name = ${sqlLiteral(table)} order by ordinal_position`,
    true,
  );
  return rows.map(r => r.column_name);
}

export function buildStatement(table, rows, pk, cols, mode) {
  return buildStatementFromLines(table, rows.map(row => JSON.stringify(row)), pk, cols, mode);
}

/** Keep PostgreSQL's original JSON numbers: parsing and serializing loses bigint/numeric precision. */
export function buildStatementFromLines(table, lines, pk, cols, mode) {
  const ident = `public.${quoteIdent(table)}`;
  if (!pk.length) throw new Error(`資料表 ${table} 沒有主鍵，無法保證重複還原安全，請另訂隔離還原程序。`);
  if (!['upsert', 'insert-missing'].includes(mode)) throw new Error('未知還原模式。');
  for (const line of lines) {
    let row;
    try { row = JSON.parse(line); } catch { throw new Error('備份列不是有效 JSON。'); }
    if (!row || Array.isArray(row) || typeof row !== 'object') throw new Error('備份列必須是 JSON 物件。');
  }
  const payload = sqlLiteral(`[${lines.join(',')}]`);
  const base = `insert into ${ident} select * from jsonb_populate_recordset(null::${ident}, ${payload}::jsonb)`;
  if (mode === 'insert-missing') return `${base} on conflict do nothing`;
  const updatable = cols.filter(c => !pk.includes(c));
  if (!updatable.length) return `${base} on conflict do nothing`;
  const setClause = updatable.map(c => `${quoteIdent(c)} = excluded.${quoteIdent(c)}`).join(', ');
  return `${base} on conflict (${pk.map(quoteIdent).join(', ')}) do update set ${setClause}`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!PROJECT_REF) throw new Error('請明確設定 SUPABASE_PROJECT_REF；還原不預設指向正式專案。');
  if (!MANAGEMENT_TOKEN) throw new Error('缺少 SUPABASE_ACCESS_TOKEN。');
  if (!args.dir) throw new Error('請以 --dir=<解開後的備份目錄> 指定來源。');
  if (!['upsert', 'insert-missing'].includes(args.mode)) throw new Error(`--mode 只能是 upsert 或 insert-missing。`);
  if (!args.tables.length) throw new Error('請以 --tables=a,b 指定要還原的表，或用 --all 還原全部。');
  if (args.execute && args.confirm !== PROJECT_REF) {
    throw new Error(`--execute 必須同時指定 --confirm=${PROJECT_REF}，確認目標專案無誤。`);
  }

  if (!args.skipVerify) {
    const { problems, warnings } = await verifyBackup(args.dir);
    for (const warning of warnings) console.warn(warning);
    if (problems.length) {
      throw new Error(`備份完整性檢查未通過，拒絕還原：\n  ${problems.join('\n  ')}`);
    }
    console.log('備份完整性檢查通過。');
  }

  const manifest = JSON.parse(await readFile(path.join(args.dir, 'manifest.json'), 'utf8'));
  if (manifest.project_ref !== PROJECT_REF) {
    console.log(`注意：備份來自專案 ${manifest.project_ref}，目前目標是 ${PROJECT_REF}。`);
  }
  const available = (await readdir(path.join(args.dir, 'tables')))
    .filter(f => f.endsWith('.ndjson')).map(f => f.slice(0, -7));
  const targets = args.tables[0] === '*' ? available : args.tables;
  const missing = targets.filter(t => !available.includes(t));
  if (missing.length) throw new Error(`備份裡沒有這些表：${missing.join(', ')}`);

  console.log(`模式：${args.mode}｜${args.execute ? '**實際寫入**' : '演練（未加 --execute，不會寫入）'}`);
  console.log(`備份時間：${manifest.created_at}｜目標專案：${PROJECT_REF}\n`);

  let totalRows = 0;
  let totalBatches = 0;
  // Preflight every selected table before the first write, so an unsupported
  // no-primary-key table cannot leave an otherwise avoidable partial restore.
  const plans = [];
  for (const table of targets) {
    quoteIdent(table);
    const content = await readFile(path.join(args.dir, 'tables', `${table}.ndjson`), 'utf8');
    const rows = content ? content.trimEnd().split('\n') : [];
    if (!rows.length) { console.log(`  ${table.padEnd(32)} 備份中為空，略過`); continue; }
    const pk = await primaryKey(table);
    const cols = await columns(table);
    if (!pk.length) throw new Error(`資料表 ${table} 沒有主鍵，已在寫入前中止。`);
    for (let i = 0; i < rows.length; i += BATCH) buildStatementFromLines(table, rows.slice(i, i + BATCH), pk, cols, args.mode);
    plans.push({ table, rows, pk, cols });
  }
  for (const { table, rows, pk, cols } of plans) {
    let batches = 0;
    for (let i = 0; i < rows.length; i += BATCH) {
      const statement = buildStatementFromLines(table, rows.slice(i, i + BATCH), pk, cols, args.mode);
      if (args.execute) await query(statement, false);
      batches += 1;
    }
    const note = `主鍵 ${pk.join('+')}`;
    console.log(`  ${table.padEnd(32)} ${String(rows.length).padStart(6)} 筆／${batches} 批（${note}）`);
    totalRows += rows.length;
    totalBatches += batches;
  }

  console.log(`\n合計 ${targets.length} 張表、${totalRows} 筆、${totalBatches} 批。`);
  if (!args.execute) {
    console.log(`確認無誤後加上 --execute --confirm=${PROJECT_REF} 才會真的寫入。`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch(error => {
    console.error(`還原失敗：${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
