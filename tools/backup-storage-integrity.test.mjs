import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { backupObjectPath, verifyStorage } from './backup-storage-integrity.mjs';

test('Storage 完整性可偵測等長竄改、遺失、額外檔案及錯誤總計', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'storage-integrity-'));
  const file = backupObjectPath(path.join(dir, 'storage'), 'private-bucket', 'sub/test.txt');
  const body = Buffer.from('original');
  const manifest = { version: 2, scope: { storage_objects: true }, totals: { storage_objects: 1, storage_bytes: body.length },
    storage: [{ bucket: 'private-bucket', objects: 1, bytes: body.length, files: [{ name: 'sub/test.txt', bytes: body.length, sha256: createHash('sha256').update(body).digest('hex') }] }] };
  try {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, body);
    assert.deepEqual(await verifyStorage(dir, manifest), { problems: [], warnings: [] });
    await writeFile(file, 'modified');
    assert.ok((await verifyStorage(dir, manifest)).problems.some(p => p.includes('SHA-256')));
    await rm(file);
    assert.ok((await verifyStorage(dir, manifest)).problems.length > 0);
    await writeFile(file, body);
    await writeFile(path.join(path.dirname(file), 'extra.txt'), 'x');
    assert.ok((await verifyStorage(dir, manifest)).problems.some(p => p.includes('清單外')));
    await rm(path.join(path.dirname(file), 'extra.txt'));
    const wrong = structuredClone(manifest); wrong.totals.storage_bytes++;
    assert.ok((await verifyStorage(dir, wrong)).problems.length > 0);
    const old = structuredClone(manifest); old.version = 1; delete old.storage[0].files;
    const legacy = await verifyStorage(dir, old);
    assert.equal(legacy.problems.length, 0);
    assert.equal(legacy.warnings.length, 1);
    old.version = 2;
    assert.ok((await verifyStorage(dir, old)).problems.length > 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('Storage 路徑拒絕越界與平台分隔符，不輸出原始敏感路徑', () => {
  const root = path.join(tmpdir(), 'safe-backup');
  for (const name of ['../escape', '/absolute', 'a/../../escape', 'a\\..\\escape', 'C:/escape', 'a//b', 'a/./b', '\0']) {
    assert.throws(() => backupObjectPath(root, 'bucket', name), /路徑/);
  }
  for (const bucket of ['..', '.', 'a/b', 'a\\b', 'C:']) assert.throws(() => backupObjectPath(root, bucket, 'x'), /路徑/);
});
