-- ============================================================
-- Org structure update (idempotent / re-runnable)
--   - add username/email to users
--   - rename + extend departments to match new org structure
-- Department codes match the seed in locations_schema.sql
-- ============================================================

-- 1. Add username and email columns to users
ALTER TABLE users ADD COLUMN IF NOT EXISTS username TEXT UNIQUE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT;

-- 2. Ensure departments has a status column (older deployments may lack it)
ALTER TABLE departments ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'active';
UPDATE departments SET status = 'active' WHERE status IS NULL;

-- 3. Rename existing departments (correct codes from locations_schema.sql)
UPDATE departments SET name = '勞安室' WHERE code = 'LABOR-SAFE';
UPDATE departments SET name = '人事室' WHERE code = 'MGMT-HR';

-- 4. Add new L1 departments
INSERT INTO departments (name, code, parent_id, level, sort_order) VALUES
  ('董事室',   'BOARD', NULL, 1,  5),
  ('總經理室', 'GM',    NULL, 1,  6),
  ('秘書室',   'SECRE', NULL, 1,  7),
  ('資訊部',   'IT',    NULL, 1, 50),
  ('業務部',   'BIZ',   NULL, 1, 60)
ON CONFLICT (code) DO NOTHING;

-- 5. Add L2 under 資訊部
INSERT INTO departments (name, code, parent_id, level, sort_order)
SELECT '系統課', 'IT-SYS',   dept_id, 2, 1 FROM departments WHERE code = 'IT'
ON CONFLICT (code) DO NOTHING;
INSERT INTO departments (name, code, parent_id, level, sort_order)
SELECT '維護課', 'IT-MAINT', dept_id, 2, 2 FROM departments WHERE code = 'IT'
ON CONFLICT (code) DO NOTHING;

-- 6. Add L2 under 業務部
INSERT INTO departments (name, code, parent_id, level, sort_order)
SELECT '貿易課', 'BIZ-TRADE', dept_id, 2, 1 FROM departments WHERE code = 'BIZ'
ON CONFLICT (code) DO NOTHING;
INSERT INTO departments (name, code, parent_id, level, sort_order)
SELECT '水果課', 'BIZ-FRUIT', dept_id, 2, 2 FROM departments WHERE code = 'BIZ'
ON CONFLICT (code) DO NOTHING;
INSERT INTO departments (name, code, parent_id, level, sort_order)
SELECT '蔬菜課', 'BIZ-VEG',   dept_id, 2, 3 FROM departments WHERE code = 'BIZ'
ON CONFLICT (code) DO NOTHING;

-- 7. Add 法務 under 管理部 (人事課 is renamed to 人事室 in step 3)
INSERT INTO departments (name, code, parent_id, level, sort_order)
SELECT '法務', 'MGMT-LEGAL', dept_id, 2, 14 FROM departments WHERE code = 'MGMT'
ON CONFLICT (code) DO NOTHING;

-- 8. Fix display order under 管理部: 總務課 → 出納課 → 法務 → 人事室
UPDATE departments SET sort_order = 11 WHERE code = 'MGMT-GEN';  -- 總務課
UPDATE departments SET sort_order = 12 WHERE code = 'MGMT-FIN';  -- 出納課
UPDATE departments SET sort_order = 13 WHERE code = 'MGMT-LEGAL';-- 法務
UPDATE departments SET sort_order = 14 WHERE code = 'MGMT-HR';   -- 人事室

-- 9. Clean up duplicate 人事室 (MGMT-HR2) created by an earlier buggy migration.
--    Reassign any references to the correct 人事室 (MGMT-HR), then delete it.
DO $$
DECLARE v_keep uuid; v_dup uuid;
BEGIN
  SELECT dept_id INTO v_keep FROM departments WHERE code = 'MGMT-HR';
  SELECT dept_id INTO v_dup  FROM departments WHERE code = 'MGMT-HR2';
  IF v_dup IS NOT NULL THEN
    UPDATE users            SET dept_id = v_keep WHERE dept_id = v_dup;
    UPDATE handover_records SET dept_id = v_keep WHERE dept_id = v_dup;
    DELETE FROM departments WHERE dept_id = v_dup;
  END IF;
END $$;

-- 10. system_settings table (used by admin.html settings page)
CREATE TABLE IF NOT EXISTS system_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE system_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "allow_all_for_now" ON system_settings;
CREATE POLICY "allow_all_for_now" ON system_settings FOR ALL USING (true);

INSERT INTO system_settings (key, value) VALUES
  ('org_name',  '臺北農產運銷股份有限公司'),
  ('site_name', '第一果菜市場')
ON CONFLICT (key) DO NOTHING;
