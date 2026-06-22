-- ============================================================
-- 場域位置資料庫 — 臺北農產 設備巡檢維修系統
-- Version 1.0  |  Run ONCE in Supabase SQL Editor
-- ============================================================

-- ── 1. Markets ─────────────────────────────────────────────
create table if not exists markets (
  market_id   text primary key,
  name        text not null,
  short_name  text,
  sort_order  int  not null default 0,
  status      text not null default 'active' check (status in ('active','inactive'))
);

-- ── 2. Locations (flat 4-level hierarchy) ──────────────────
-- market_id → floor → area → detail
create table if not exists locations (
  location_id  uuid primary key default gen_random_uuid(),
  market_id    text not null references markets(market_id),
  floor        text not null,
  floor_order  int  not null default 0,
  area         text not null,
  area_order   int  not null default 0,
  detail       text not null default '',   -- '' = area-level, else detail-level
  detail_order int  not null default 0,
  status       text not null default 'active' check (status in ('active','inactive')),
  created_at   timestamptz default now(),
  created_by   uuid references users(user_id),
  constraint uq_location unique (market_id, floor, area, detail)
);

create index if not exists idx_loc_mfa on locations(market_id, floor, area);

-- ── 3. Departments / Org tree ──────────────────────────────
create table if not exists departments (
  dept_id    uuid primary key default gen_random_uuid(),
  parent_id  uuid references departments(dept_id) on delete set null,
  name       text not null,
  code       text unique,
  level      int  not null default 1,
  sort_order int  default 0,
  status     text default 'active' check (status in ('active','inactive')),
  created_at timestamptz default now()
);

-- ── 4. Extend existing tables ──────────────────────────────
alter table inspection_records add column if not exists location_id uuid references locations(location_id);
alter table repair_requests    add column if not exists location_id uuid references locations(location_id);
alter table users              add column if not exists dept_id     uuid references departments(dept_id);

-- ── 5. RLS ─────────────────────────────────────────────────
alter table markets     enable row level security;
alter table locations   enable row level security;
alter table departments enable row level security;

create policy "allow_all_for_now" on markets     for all using (true);
create policy "allow_all_for_now" on locations   for all using (true);
create policy "allow_all_for_now" on departments for all using (true);

-- ============================================================
-- Seed: Markets
-- ============================================================
insert into markets (market_id, name, short_name, sort_order) values
('market1','第一果菜市場','第一市場',1),
('market2','第二果菜市場','第二市場',2),
('fish',   '魚類批發市場','魚市場',  3),
('admin',  '行政大樓',   '行政',    4)
on conflict do nothing;

-- ============================================================
-- Seed: Locations — 第一市場 B1 地下室
-- ============================================================
insert into locations (market_id,floor,floor_order,area,area_order,detail,detail_order) values
-- 垃圾處理區
('market1','B1',10,'垃圾處理區', 10,'有機垃圾處理設備區',10),
('market1','B1',10,'垃圾處理區', 10,'無機垃圾處理設備區',20),
('market1','B1',10,'垃圾處理區', 10,'投料口區',          30),
('market1','B1',10,'垃圾處理區', 10,'輸送設備區',        40),
-- 配電室
('market1','B1',10,'配電室',     20,'高壓盤區',          10),
('market1','B1',10,'配電室',     20,'低壓盤區',          20),
('market1','B1',10,'配電室',     20,'變壓器區',          30),
('market1','B1',10,'配電室',     20,'電容器區',          40),
-- 發電機房
('market1','B1',10,'發電機房',   30,'發電機1號機',        10),
('market1','B1',10,'發電機房',   30,'發電機2號機',        20),
('market1','B1',10,'發電機房',   30,'油槽區',            30),
-- 弱電機房
('market1','B1',10,'弱電機房',   40,'網路設備區',        10),
('market1','B1',10,'弱電機房',   40,'監控設備區',        20),
('market1','B1',10,'弱電機房',   40,'通訊設備區',        30),
-- 消防機房
('market1','B1',10,'消防機房',   50,'消防泵浦區',        10),
('market1','B1',10,'消防機房',   50,'消防控制盤區',      20),
('market1','B1',10,'消防機房',   50,'消防水池區',        30),
-- 排風機房
('market1','B1',10,'排風機房',   60,'排風機A區',         10),
('market1','B1',10,'排風機房',   60,'排風機B區',         20),
-- 自來水箱區
('market1','B1',10,'自來水箱區', 70,'自來水箱1區',       10),
('market1','B1',10,'自來水箱區', 70,'自來水箱2區',       20)
on conflict (market_id,floor,area,detail) do nothing;

-- ============================================================
-- Seed: Locations — 第一市場 1F 一樓
-- ============================================================
insert into locations (market_id,floor,floor_order,area,area_order,detail,detail_order) values
('market1','1F',20,'蔬菜零批場',     10,'A區',       10),
('market1','1F',20,'蔬菜零批場',     10,'B區',       20),
('market1','1F',20,'蔬菜零批場',     10,'C區',       30),
('market1','1F',20,'水果零批場',     20,'A區',       10),
('market1','1F',20,'水果零批場',     20,'B區',       20),
('market1','1F',20,'水果零批場',     20,'C區',       30),
('market1','1F',20,'水果拍賣場',     30,'拍賣台區',  10),
('market1','1F',20,'水果拍賣場',     30,'作業區',    20),
('market1','1F',20,'水果拍賣場',     30,'公共走道區',30),
('market1','1F',20,'有機垃圾處理場', 40,'投料口區',  10),
('market1','1F',20,'有機垃圾處理場', 40,'操作區',    20),
('market1','1F',20,'無機垃圾處理場', 50,'投料口區',  10),
('market1','1F',20,'無機垃圾處理場', 50,'操作區',    20),
('market1','1F',20,'排風機房',       60,'排風設備區',10),
('market1','1F',20,'排風機房',       60,'控制盤區',  20),
('market1','1F',20,'卸貨區',         70,'北側卸貨區',10),
('market1','1F',20,'卸貨區',         70,'南側卸貨區',20),
('market1','1F',20,'理貨區',         80,'東側理貨區',10),
('market1','1F',20,'理貨區',         80,'西側理貨區',20),
('market1','1F',20,'公共區域',       90,'電梯出入口',10),
('market1','1F',20,'公共區域',       90,'樓梯出入口',20),
('market1','1F',20,'公共區域',       90,'公共走道',  30),
('market1','1F',20,'公共區域',       90,'廁所區域',  40)
on conflict (market_id,floor,area,detail) do nothing;

-- ============================================================
-- Seed: Locations — 第一市場 2F 二樓
-- ============================================================
insert into locations (market_id,floor,floor_order,area,area_order,detail,detail_order) values
-- 蔬菜承銷區
('market1','2F',30,'蔬菜承銷區', 10,'蔬菜理貨間',  10),
('market1','2F',30,'蔬菜承銷區', 10,'蔬菜冷藏間',  20),
('market1','2F',30,'蔬菜承銷區', 10,'主通道',      30),
-- 果品承銷區
('market1','2F',30,'果品承銷區', 20,'拍賣台區',    10),
('market1','2F',30,'果品承銷區', 20,'作業區',      20),
-- 物流作業區
('market1','2F',30,'物流作業區', 30,'裝卸月台',    10),
('market1','2F',30,'物流作業區', 30,'暫存區',      20)
on conflict (market_id,floor,area,detail) do nothing;

-- ============================================================
-- Seed: Locations — 第一市場 3F 三樓
-- ============================================================
insert into locations (market_id,floor,floor_order,area,area_order,detail,detail_order) values
-- 花卉交易區
('market1','3F',40,'花卉交易區',   10,'花卉冷藏間',  10),
('market1','3F',40,'花卉交易區',   10,'花卉交易A',   20),
('market1','3F',40,'花卉交易區',   10,'花卉交易B',   30),
-- 市場管理辦公
('market1','3F',40,'市場管理辦公', 20,'主任辦公室',  10),
('market1','3F',40,'市場管理辦公', 20,'會議室A',     20),
('market1','3F',40,'市場管理辦公', 20,'會議室B',     30),
-- 公共服務區
('market1','3F',40,'公共服務區',   30,'展覽廳',      10),
('market1','3F',40,'公共服務區',   30,'員工餐廳',    20),
('market1','3F',40,'公共服務區',   30,'廁所',        30)
on conflict (market_id,floor,area,detail) do nothing;

-- ============================================================
-- Seed: Locations — 第一市場 4F 四樓（機電層）
-- ============================================================
insert into locations (market_id,floor,floor_order,area,area_order,detail,detail_order) values
-- 機電設備層
('market1','4F',50,'機電設備層', 10,'主機組A',    10),
('market1','4F',50,'機電設備層', 10,'主機組B',    20),
('market1','4F',50,'機電設備層', 10,'控制室',     30),
('market1','4F',50,'機電設備層', 10,'工具間',     40),
('market1','4F',50,'機電設備層', 10,'水塔區',     50),
('market1','4F',50,'機電設備層', 10,'AHU機組',    60),
-- 冷凍機房
('market1','4F',50,'冷凍機房',   20,'冷凍壓縮機', 10),
('market1','4F',50,'冷凍機房',   20,'冷卻水塔',   20),
-- 擴充預留區
('market1','4F',50,'擴充預留區', 30,'預留空間A',  10),
('market1','4F',50,'擴充預留區', 30,'預留空間B',  20)
on conflict (market_id,floor,area,detail) do nothing;

-- ============================================================
-- Seed: Departments / Org structure
-- ============================================================
do $$
declare v_mgmt uuid;
begin
  insert into departments (name,code,level,sort_order)
    values ('管理部','MGMT',1,10) on conflict(code) do nothing;
  select dept_id into v_mgmt from departments where code='MGMT';

  insert into departments (parent_id,name,code,level,sort_order) values
    (v_mgmt,'總務課','MGMT-GEN',2,11),
    (v_mgmt,'人事課','MGMT-HR', 2,12),
    (v_mgmt,'出納課','MGMT-FIN',2,13)
  on conflict(code) do nothing;

  insert into departments (name,code,level,sort_order) values
    ('第一市場改建室','MKT1-RENOV',1,20),
    ('勞工安全衛生室','LABOR-SAFE',1,30),
    ('稽核室',        'AUDIT',     1,40)
  on conflict(code) do nothing;
end $$;
