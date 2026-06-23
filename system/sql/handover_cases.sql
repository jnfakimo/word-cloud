-- ============================================================
-- 電子交接案件管理 - 資料表建立
-- 執行前請確認 users 資料表已存在
-- ============================================================

-- 1. 案件主表
CREATE TABLE IF NOT EXISTS handover_cases (
  case_id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_no           TEXT UNIQUE NOT NULL,
  title             TEXT,
  shift_type        TEXT,
  reporter          TEXT,
  reporter_unit     TEXT,
  incident_time     TIMESTAMPTZ,
  incident_location TEXT,
  anomaly_category  TEXT,
  anomaly_sub       TEXT,
  anomaly_other     TEXT,
  description       TEXT,
  action_taken      TEXT,
  followup          TEXT,
  responsible_unit  TEXT,
  assigned_to       UUID REFERENCES users(user_id) ON DELETE SET NULL,
  status            TEXT NOT NULL DEFAULT 'open',
  due_date          DATE,
  note              TEXT,
  created_by        UUID REFERENCES users(user_id) ON DELETE SET NULL,
  closed_at         TIMESTAMPTZ,
  closed_by         UUID REFERENCES users(user_id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. 案件歷程表（永久保留，禁止 DELETE）
CREATE TABLE IF NOT EXISTS handover_case_logs (
  log_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id     UUID NOT NULL REFERENCES handover_cases(case_id) ON DELETE CASCADE,
  action      TEXT NOT NULL,
  content     TEXT,
  old_data    JSONB,
  new_data    JSONB,
  created_by  UUID REFERENCES users(user_id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 3. 附件表
CREATE TABLE IF NOT EXISTS handover_case_attachments (
  attachment_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id       UUID NOT NULL REFERENCES handover_cases(case_id) ON DELETE CASCADE,
  file_name     TEXT NOT NULL,
  file_type     TEXT,
  file_size     INTEGER,
  storage_path  TEXT NOT NULL,
  uploaded_by   UUID REFERENCES users(user_id) ON DELETE SET NULL,
  uploaded_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 4. RLS 政策
ALTER TABLE handover_cases ENABLE ROW LEVEL SECURITY;
ALTER TABLE handover_case_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE handover_case_attachments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "all_access_cases" ON handover_cases;
DROP POLICY IF EXISTS "all_access_case_logs" ON handover_case_logs;
DROP POLICY IF EXISTS "all_access_attachments" ON handover_case_attachments;

CREATE POLICY "all_access_cases" ON handover_cases FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "all_access_case_logs" ON handover_case_logs FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "all_access_attachments" ON handover_case_attachments FOR ALL USING (true) WITH CHECK (true);

-- ============================================================
-- 5. Supabase Storage 設定（需手動在 Dashboard 建立）
--    Storage > New bucket > 名稱: handover-attachments
--    Public bucket: 開啟（或依需求設為 private）
-- ============================================================
