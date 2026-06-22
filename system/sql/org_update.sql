-- Org structure update: add username/email to users, update departments

-- 1. Add username and email columns to users
ALTER TABLE users ADD COLUMN IF NOT EXISTS username TEXT UNIQUE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT;

-- 2. Add status column to departments (needed by locations.html queries)
ALTER TABLE departments ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';

-- 3. Rename existing departments
UPDATE departments SET name = '勞安室' WHERE code = 'OHS';
UPDATE departments SET name = '人事室' WHERE code = 'MGMT-HR';

-- 4. Add new L1 departments
INSERT INTO departments (name, code, parent_id, sort_order) VALUES
  ('董事室',   'BOARD',  NULL, 10),
  ('總經理室', 'GM',     NULL, 20),
  ('秘書室',   'SECRE',  NULL, 30),
  ('資訊部',   'IT',     NULL, 60),
  ('業務部',   'BIZ',    NULL, 70)
ON CONFLICT (code) DO NOTHING;

-- 5. Add L2 under 資訊部
INSERT INTO departments (name, code, parent_id, sort_order)
SELECT '系統課', 'IT-SYS',   dept_id, 1 FROM departments WHERE code = 'IT'
ON CONFLICT (code) DO NOTHING;

INSERT INTO departments (name, code, parent_id, sort_order)
SELECT '維護課', 'IT-MAINT',  dept_id, 2 FROM departments WHERE code = 'IT'
ON CONFLICT (code) DO NOTHING;

-- 6. Add L2 under 業務部
INSERT INTO departments (name, code, parent_id, sort_order)
SELECT '貿易課', 'BIZ-TRADE', dept_id, 1 FROM departments WHERE code = 'BIZ'
ON CONFLICT (code) DO NOTHING;

INSERT INTO departments (name, code, parent_id, sort_order)
SELECT '水果課', 'BIZ-FRUIT', dept_id, 2 FROM departments WHERE code = 'BIZ'
ON CONFLICT (code) DO NOTHING;

INSERT INTO departments (name, code, parent_id, sort_order)
SELECT '蔬菜課', 'BIZ-VEG',   dept_id, 3 FROM departments WHERE code = 'BIZ'
ON CONFLICT (code) DO NOTHING;

-- 7. Add additional L2 under 管理部
INSERT INTO departments (name, code, parent_id, sort_order)
SELECT '法務', 'MGMT-LEGAL', dept_id, 5 FROM departments WHERE code = 'MGMT'
ON CONFLICT (code) DO NOTHING;

INSERT INTO departments (name, code, parent_id, sort_order)
SELECT '人事室', 'MGMT-HR2', dept_id, 6 FROM departments WHERE code = 'MGMT'
ON CONFLICT (code) DO NOTHING;
