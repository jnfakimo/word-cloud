# 資料庫備份與復原流程

> 2026-08-25 建立。變更本流程時請一併更新 `AGENTS.md` 的 Database 段。
>
> **這份是執行層**：怎麼跑、怎麼解密、怎麼還原。治理層——核准流程、責任分工、
> RPO／RTO 目標、驗收清單與證據表——在 `Obsidian/07-資料庫備份與復原流程.md`。
> 正式環境的復原一律依該文件的核准流程進行，不要只照這份的指令操作。

## 為什麼需要這個

本流程建立於 2026-08-25 當時的 Free 環境。2026-09-06 已查核雲端組織顯示
**Pro**，Dashboard 有七份每日 physical backup；**PITR 尚未啟用**。平台備份
不含 Storage 附件，因此仍需本流程的獨立加密匯出。`trg_prevent_removal` 能擋下
`DELETE` 與 `TRUNCATE`，但擋不住錯誤的 `UPDATE`。

Schema 本身是安全的：`system/sql/` 與 `supabase/migrations/` 都在版控裡，而且是
idempotent 的，可依流程重建。資料與附件仍需持續備份並實際驗證復原。

## 備份包含什麼

| 項目 | 是否備份 | 說明 |
| --- | --- | --- |
| `public` schema 全部資料表 | ✅ | 依執行時目錄取得；2026-09-06 為 76 表／479,056 列。以 `row_to_json` 匯出 NDJSON，主鍵游標分頁 |
| Storage 附件 | ✅ | `floorplans`、`repair-files`、`handover-attachments`、`vehicle-dispatch-files`、`inspection-photos` |
| Schema／RLS 政策 | ➖ | 不在備份裡，因為已經在版控中（見 `AGENTS.md` 的套用順序） |
| **`auth.users` 帳號** | ❌ | **見下方警告** |
| 資料庫 cluster 角色 | ❌ | 需要另一組權限；RLS 政策本身在 migrations 裡 |

> **⚠️ 帳號不在備份範圍內。**
> 復原後 `public.users` 會有完整的人員資料，但 Supabase Auth 那側的帳號不會回來，
> 也就是**所有人都無法登入**，必須由管理員重新建立帳號並重新綁定 `auth_id`。
> 這是刻意的取捨：帳號身分牽涉密碼雜湊與 MFA 狀態，不適合和業務資料放在同一份
> 檔案裡流通。如果日後要納入，需要另外評估存放與權限。

## 備份怎麼運作

`.github/workflows/database-backup.yml`，每天台北時間凌晨 2 點執行，也可以手動
觸發（Actions → Database backup → Run workflow）。

1. `tools/database-backup.mjs` 透過 Management API **唯讀**查詢，逐表分頁匯出
2. `tools/database-backup-verify.mjs` 比對 sha256 與行數，對不上就讓流程失敗
3. 打包後以 **AES256 對稱加密**，明文檔在 runner 上就刪掉
4. 確認產物確實是密文（解不開成 tar）才上傳
5. 上傳成 artifact，保留 **90 天**

### 為什麼一定要加密

**本 repo 是 public，artifact 任何人都下載得到。** 備份含全公司人員個資與巡檢／
報修紀錄，所以未加密的備份絕不允許離開 runner。缺少 `BACKUP_PASSPHRASE` 時流程
會直接失敗，不會退而求其次產生未加密的檔案。

## 首次設定（只需做一次）

備份流程需要一個 GitHub secret。**請自行設定，不要交給任何人代設**——持有密語
的人就能解開全公司的個資。

```bash
gh secret set BACKUP_PASSPHRASE
```

執行後貼上一組夠長的密語（建議 20 字元以上）。

> **密語必須另外抄一份，保存在 GitHub 以外的地方。** 密語只存在於 GitHub secret，
> 而 secret 是無法讀回來的。一旦遺失，所有既有備份都永久解不開；GitHub 帳號本身
> 出事時，也需要靠這份離線抄本才能救回資料。

## 取得與解密備份

```bash
gh run list --workflow=database-backup.yml --limit 5
```

```bash
gh run download <run-id> --dir ./restore-workspace
```

```bash
gpg --decrypt --output backup.tar.gz ./restore-workspace/*/inspection-backup-*.tar.gz.gpg
```

```bash
mkdir -p backup && tar -xzf backup.tar.gz -C backup
```

解開後的結構：

```
backup/
  manifest.json            備份時間、每張表的筆數與 sha256
  tables/<表名>.ndjson      每行一筆 JSON
  storage/<bucket>/<路徑>   附件原始檔
```

先看 `manifest.json` 的 `created_at` 與 `totals`，確認拿到的是預期的那份。

## 還原

`tools/database-restore.mjs`。**這支不接任何 workflow，只能由人手動執行**，而且
預設是演練模式。

還原一律採 upsert 或 insert-missing，**永遠不刪除**：它補回缺的、蓋回被改壞的，
但不會清掉備份之後才新增的資料。

### 情境 A：某張表被寫壞（最常見）

先演練，確認影響範圍：

```bash
SUPABASE_ACCESS_TOKEN=<token> node tools/database-restore.mjs --dir=backup --tables=locations
```

輸出會列出筆數、批次與主鍵。確認無誤後才實際寫入：

```bash
SUPABASE_ACCESS_TOKEN=<token> node tools/database-restore.mjs --dir=backup --tables=locations --execute --confirm=qztffronusdhgxhjjubt
```

`--confirm` 必須與目標專案 ref 一致，否則拒絕執行——這是避免把備份倒進錯的專案。

只想補回遺失的列、不覆蓋現有內容時，加 `--mode=insert-missing`。

### 情境 B：整個專案要重建（災難復原）

1. 建立新的 Supabase 專案
2. 依 `AGENTS.md` 的 **Database** 段順序套用 schema，`permanent_data_protection.sql`
   一定放最後
3. 還原資料。**先關掉排程**（`patrol-timeout-check` 等 cron）避免半途的資料觸發通知
4. 由於有外鍵約束，`--all` 不保證順序正確。建議先還原被參照的主檔
   （`users`、`locations`、`floor_spaces`、`equipment`），再還原其餘：

   ```bash
   node tools/database-restore.mjs --dir=backup --tables=users,locations,floor_spaces,equipment --execute --confirm=<ref>
   ```

   ```bash
   node tools/database-restore.mjs --dir=backup --all --execute --confirm=<ref>
   ```

   第二道會把已還原的表再跑一次，upsert 是幂等的，重複執行不會產生問題。
5. 上傳 `backup/storage/` 底下的附件到對應 bucket，並確認 bucket 的公開／私有設定
   與 migrations 一致（`floorplans` 必須是私有）
6. **重建 Auth 帳號**並重新綁定 `public.users.auth_id`（見上方警告）
7. 更新前端的 Supabase 專案 ref 與金鑰

## 限制與已知風險

- **artifact 只保留 90 天。** 超過就沒了。長期保存需要定期下載歸檔到公司內部，
  建議每季一次，與其他備援資料放在一起。
- **備份與 GitHub 帳號綁在一起。** GitHub 帳號本身出事時，只剩下你手上的離線歸檔。
  這是選用 artifact 而非外部儲存的取捨；要真正的異地備援得另外接物件儲存。
- **每日一次代表最多可能損失 24 小時的資料。**
- `audit_logs` 目前約 8,700 筆、14 MB，佔備份大半且會持續成長。日後如果拖慢備份，
  可考慮改為只保留近 N 個月，或與其他表分開排程。
- 還原用的是 Management API，單批 200 筆。極大的表會需要較長時間。

## 定期演練

備份沒有驗證過就不算數。建議**每季**做一次：

1. 手動觸發一次備份，下載並解密
2. 檢查 `manifest.json` 的筆數是否與正式庫接近
3. 挑一張小表跑演練模式（不加 `--execute`），確認流程可用
4. 確認密語的離線抄本還在、還讀得到

不要在正式專案上演練實際寫入。要驗證完整還原，請另開一個測試專案。
