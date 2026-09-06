import { createHash } from 'node:crypto';
import { readFile, readdir, lstat } from 'node:fs/promises';
import path from 'node:path';

export function backupObjectPath(root, bucket, name) {
  if (typeof bucket !== 'string' || !bucket || /[\\/:]/.test(bucket) || ['.', '..'].includes(bucket)) {
    throw new Error('Storage bucket 路徑無效。');
  }
  if (typeof name !== 'string' || !name || /[\\:\x00]/.test(name) || name.split('/').some(p => !p || p === '.' || p === '..')) {
    throw new Error('Storage 物件路徑無效。');
  }
  const base = path.resolve(root);
  const result = path.resolve(base, bucket, name);
  if (!result.startsWith(base + path.sep)) throw new Error('Storage 路徑超出備份目錄。');
  return result;
}

async function inventory(root) {
  const found = new Map();
  async function visit(dir, prefix = '') {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const relative = prefix + entry.name;
      const file = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) throw new Error('Storage 備份不得包含符號連結。');
      if (entry.isDirectory()) await visit(file, relative + '/');
      else if (entry.isFile()) found.set(relative, (await lstat(file)).size);
      else throw new Error('Storage 備份包含非一般檔案。');
    }
  }
  try { await visit(root); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return found;
}

export async function verifyStorage(dir, manifest) {
  const problems = [], warnings = [];
  const root = path.join(dir, 'storage');
  const actual = await inventory(root);
  const buckets = manifest.storage || [];
  if (!manifest.scope?.storage_objects) {
    if (actual.size || buckets.length || manifest.totals.storage_objects || manifest.totals.storage_bytes) {
      problems.push('Storage 未納入備份，但清單或檔案非空。');
    }
    return { problems, warnings };
  }
  let expectedCount = 0, expectedBytes = 0;
  const seenBuckets = new Set();
  for (const bucket of buckets) {
    backupObjectPath(root, bucket.bucket, '_check');
    if (seenBuckets.has(bucket.bucket)) problems.push('Storage bucket 清單重複。');
    seenBuckets.add(bucket.bucket);
    const files = [...actual].filter(([name]) => name.startsWith(bucket.bucket + '/'));
    if (files.length !== bucket.objects || files.reduce((sum, [, size]) => sum + size, 0) !== bucket.bytes) {
      problems.push('Storage bucket 檔案數量或總大小不符。');
    }
    expectedCount += bucket.objects;
    expectedBytes += bucket.bytes;
    if (!Array.isArray(bucket.files)) {
      if (manifest.version >= 2) problems.push('Storage 缺少逐檔雜湊清單。');
      else warnings.push('舊版 Storage 僅能核對數量與總大小，沒有逐檔 SHA-256。');
      continue;
    }
    const seenFiles = new Set();
    let listedBytes = 0;
    for (const entry of bucket.files) {
      const file = backupObjectPath(root, bucket.bucket, entry.name);
      if (seenFiles.has(entry.name)) problems.push('Storage 物件清單重複。');
      seenFiles.add(entry.name);
      listedBytes += entry.bytes;
      try {
        const body = await readFile(file);
        if (body.length !== entry.bytes || createHash('sha256').update(body).digest('hex') !== entry.sha256) {
          problems.push('Storage 物件大小或 SHA-256 不符。');
        }
      } catch { problems.push('Storage 物件無法讀取。'); }
    }
    if (seenFiles.size !== bucket.objects || listedBytes !== bucket.bytes) problems.push('Storage 逐檔清單與 bucket 統計不符。');
    if (files.some(([name]) => !seenFiles.has(name.slice(bucket.bucket.length + 1)))) problems.push('Storage 含清單外檔案。');
  }
  if (actual.size !== expectedCount || manifest.totals.storage_objects !== expectedCount || manifest.totals.storage_bytes !== expectedBytes) {
    problems.push('Storage 總計與檔案或 bucket 清單不符。');
  }
  return { problems, warnings: [...new Set(warnings)] };
}
