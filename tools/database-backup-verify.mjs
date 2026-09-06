#!/usr/bin/env node

/**
 * 檢查備份目錄與 manifest 記載是否一致，不一致就讓流程失敗。
 *
 * 備份最糟的失效方式是「檔案有產生、內容卻是殘的」——分頁少抓一頁、某張表寫到
 * 一半斷線，這些都不會拋錯，要等到真的需要還原那天才發現。所以每次備份完都比
 * 對一次 sha256 與行數，寧可當下就紅燈。
 */

import { verifyBackup } from './database-backup.mjs';

const dir = process.env.BACKUP_OUT_DIR || process.argv[2] || '';
if (!dir) {
  console.error('::error::請以 BACKUP_OUT_DIR 或參數指定備份目錄。');
  process.exit(1);
}

const { manifest, problems, warnings } = await verifyBackup(dir);
for (const warning of warnings) console.warn(`::warning::${warning}`);

if (problems.length) {
  console.error('::error::備份完整性檢查未通過：');
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

const empty = manifest.tables.filter(t => t.rows === 0).length;
console.log(
  `完整性檢查通過：${manifest.totals.tables} 張表、${manifest.totals.rows} 筆` +
  `（其中 ${empty} 張表為空）、${manifest.totals.storage_objects} 個 Storage 物件。`,
);

// 全部的表都空代表查詢權限或流程出了問題，不該當成一次成功的備份。
if (manifest.totals.rows === 0) {
  console.error('::error::所有資料表都是空的，視為備份失敗。');
  process.exit(1);
}
