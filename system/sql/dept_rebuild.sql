-- ============================================================
-- 部門結構重建（清除舊資料，重新建立）
-- 可重複執行：先清空再重建
-- ============================================================

-- 1. 清除使用者的部門外鍵參照
UPDATE users SET dept_id = NULL;

-- 2. 清除交接紀錄的部門外鍵（如欄位存在）
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name='handover_records' AND column_name='dept_id') THEN
    EXECUTE 'UPDATE handover_records SET dept_id = NULL';
  END IF;
END $$;

-- 3. 刪除所有舊部門
DELETE FROM departments;

-- 4. 建立第一層部門
INSERT INTO departments (name, code, parent_id, level, sort_order) VALUES
  ('董事長室',         'BOARD',      NULL, 1,  10),
  ('總經理室',         'GM',         NULL, 1,  20),
  ('副總經理室',       'VGM',        NULL, 1,  30),
  ('秘書室',           'SECRE',      NULL, 1,  40),
  ('稽核室',           'AUDIT',      NULL, 1,  50),
  ('勞工安全衛生室',   'LABOR-SAFE', NULL, 1,  60),
  ('管理部',           'MGMT',       NULL, 1,  70),
  ('業務部',           'BIZ',        NULL, 1,  80),
  ('資訊部',           'IT',         NULL, 1,  90),
  ('企劃部',           'PLAN',       NULL, 1, 100),
  ('財務部',           'FIN',        NULL, 1, 110),
  ('第二市場',         'MKT2',       NULL, 1, 120),
  ('第一市場',         'MKT1',       NULL, 1, 130),
  ('改建辦公室',       'RENO',       NULL, 1, 140);

-- 5. 第二層：管理部
INSERT INTO departments (name, code, parent_id, level, sort_order)
SELECT '總務課', 'MGMT-GEN',  dept_id, 2, 1 FROM departments WHERE code='MGMT';
INSERT INTO departments (name, code, parent_id, level, sort_order)
SELECT '人事課', 'MGMT-HR',   dept_id, 2, 2 FROM departments WHERE code='MGMT';
INSERT INTO departments (name, code, parent_id, level, sort_order)
SELECT '出納課', 'MGMT-FIN',  dept_id, 2, 3 FROM departments WHERE code='MGMT';
INSERT INTO departments (name, code, parent_id, level, sort_order)
SELECT '機電課', 'MGMT-MECH', dept_id, 2, 4 FROM departments WHERE code='MGMT';

-- 6. 第二層：業務部
INSERT INTO departments (name, code, parent_id, level, sort_order)
SELECT '蔬菜課',     'BIZ-VEG',       dept_id, 2, 1 FROM departments WHERE code='BIZ';
INSERT INTO departments (name, code, parent_id, level, sort_order)
SELECT '貿易課',     'BIZ-TRADE',     dept_id, 2, 2 FROM departments WHERE code='BIZ';
INSERT INTO departments (name, code, parent_id, level, sort_order)
SELECT '營業管理課', 'BIZ-SALES',     dept_id, 2, 3 FROM departments WHERE code='BIZ';
INSERT INTO departments (name, code, parent_id, level, sort_order)
SELECT '有機蔬果課', 'BIZ-ORG',       dept_id, 2, 4 FROM departments WHERE code='BIZ';
INSERT INTO departments (name, code, parent_id, level, sort_order)
SELECT '蔬菜採購課', 'BIZ-VEG-BUY',  dept_id, 2, 5 FROM departments WHERE code='BIZ';
INSERT INTO departments (name, code, parent_id, level, sort_order)
SELECT '水果採購課', 'BIZ-FRUIT-BUY',dept_id, 2, 6 FROM departments WHERE code='BIZ';
INSERT INTO departments (name, code, parent_id, level, sort_order)
SELECT '物流運輸課', 'BIZ-LOGI',      dept_id, 2, 7 FROM departments WHERE code='BIZ';
INSERT INTO departments (name, code, parent_id, level, sort_order)
SELECT '電商行銷課', 'BIZ-ECOM',      dept_id, 2, 8 FROM departments WHERE code='BIZ';

-- 7. 第二層：資訊部
INSERT INTO departments (name, code, parent_id, level, sort_order)
SELECT '系統管理課', 'IT-SYS',  dept_id, 2, 1 FROM departments WHERE code='IT';
INSERT INTO departments (name, code, parent_id, level, sort_order)
SELECT '資訊管理課', 'IT-MGMT', dept_id, 2, 2 FROM departments WHERE code='IT';

-- 8. 第二層：企劃部
INSERT INTO departments (name, code, parent_id, level, sort_order)
SELECT '企劃推廣課', 'PLAN-PROMO', dept_id, 2, 1 FROM departments WHERE code='PLAN';
INSERT INTO departments (name, code, parent_id, level, sort_order)
SELECT '研究發展課', 'PLAN-RD',    dept_id, 2, 2 FROM departments WHERE code='PLAN';

-- 9. 第二層：財務部
INSERT INTO departments (name, code, parent_id, level, sort_order)
SELECT '財務一課', 'FIN-1', dept_id, 2, 1 FROM departments WHERE code='FIN';
INSERT INTO departments (name, code, parent_id, level, sort_order)
SELECT '財務二課', 'FIN-2', dept_id, 2, 2 FROM departments WHERE code='FIN';

-- 10. 第二層：第二市場
INSERT INTO departments (name, code, parent_id, level, sort_order)
SELECT '蔬菜組', 'MKT2-VEG',   dept_id, 2, 1 FROM departments WHERE code='MKT2';
INSERT INTO departments (name, code, parent_id, level, sort_order)
SELECT '水果組', 'MKT2-FRUIT', dept_id, 2, 2 FROM departments WHERE code='MKT2';
INSERT INTO departments (name, code, parent_id, level, sort_order)
SELECT '業管組', 'MKT2-ADMIN', dept_id, 2, 3 FROM departments WHERE code='MKT2';
INSERT INTO departments (name, code, parent_id, level, sort_order)
SELECT '駐衛隊', 'MKT2-GUARD', dept_id, 2, 4 FROM departments WHERE code='MKT2';

-- 11. 第二層：第一市場
INSERT INTO departments (name, code, parent_id, level, sort_order)
SELECT '水果組', 'MKT1-FRUIT', dept_id, 2, 1 FROM departments WHERE code='MKT1';
INSERT INTO departments (name, code, parent_id, level, sort_order)
SELECT '蔬菜組', 'MKT1-VEG',   dept_id, 2, 2 FROM departments WHERE code='MKT1';
INSERT INTO departments (name, code, parent_id, level, sort_order)
SELECT '業管組', 'MKT1-ADMIN', dept_id, 2, 3 FROM departments WHERE code='MKT1';
INSERT INTO departments (name, code, parent_id, level, sort_order)
SELECT '駐衛隊', 'MKT1-GUARD', dept_id, 2, 4 FROM departments WHERE code='MKT1';
