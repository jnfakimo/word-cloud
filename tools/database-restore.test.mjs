import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { buildStatementFromLines, buildStatement } from './database-restore.mjs';

test('PostgreSQL 還原保留 bigint、numeric、特殊字元與冪等行為', async () => {
  const db = new PGlite();
  try {
    await db.exec('create table public.restore_check (id bigint primary key, amount numeric, label text, details jsonb)');
    const raw = '{"id":9007199254740993,"amount":12345678901234567890.123456789,"label":"O\'Brien\\\\path","details":{"value":9007199254740995}}';
    const cols = ['id', 'amount', 'label', 'details'];
    const statement = buildStatementFromLines('restore_check', [raw], ['id'], cols, 'upsert');
    // The explicit E literal remains correct for both PostgreSQL string modes.
    for (const setting of ['on', 'off']) {
      await db.exec(`set standard_conforming_strings = ${setting}`);
      await db.exec(statement);
      await db.exec(statement);
      const { rows } = await db.query('select id::text, amount::text, label, details->>\'value\' as nested from restore_check');
      assert.deepEqual(rows, [{ id: '9007199254740993', amount: '12345678901234567890.123456789', label: "O'Brien\\path", nested: '9007199254740995' }]);
    }
    const changed = raw.replace("O'Brien", 'changed');
    await db.exec(buildStatementFromLines('restore_check', [changed], ['id'], cols, 'insert-missing'));
    assert.equal((await db.query('select label from restore_check')).rows[0].label, "O'Brien\\path");
    await db.exec(buildStatementFromLines('restore_check', [changed], ['id'], cols, 'upsert'));
    assert.equal((await db.query('select label from restore_check')).rows[0].label, 'changed\\path');
  } finally { await db.close(); }
});

test('PostgreSQL 複合主鍵更新，無主鍵與無效 JSON 在 SQL 執行前拒絕', async () => {
  const db = new PGlite();
  try {
    await db.exec('create table public.compound_restore (day date, code text, note text, primary key(day, code))');
    const cols = ['day', 'code', 'note'];
    await db.exec(buildStatement('compound_restore', [{ day: '2026-09-06', code: 'a', note: 'first' }], ['day','code'], cols, 'upsert'));
    await db.exec(buildStatement('compound_restore', [{ day: '2026-09-06', code: 'a', note: 'second' }], ['day','code'], cols, 'upsert'));
    assert.deepEqual((await db.query('select note from compound_restore')).rows, [{ note: 'second' }]);
    assert.throws(() => buildStatement('compound_restore', [], [], cols, 'upsert'), /沒有主鍵/);
    for (const bad of ['[]', 'null', '42', '"secret"', '{bad']) {
      assert.throws(() => buildStatementFromLines('compound_restore', [bad], ['day','code'], cols, 'upsert'), /JSON/);
    }
  } finally { await db.close(); }
});
