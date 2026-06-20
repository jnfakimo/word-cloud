-- ============================================================
-- 設備巡檢與維修管理系統 — Supabase Schema
-- ============================================================

-- 1. 使用者 / Users
create table if not exists users (
  user_id   uuid primary key default gen_random_uuid(),
  auth_id   uuid unique references auth.users(id) on delete set null,
  name      text not null,
  phone     text,
  department text,
  role      text not null check (role in ('admin','inspector','maintenance','supervisor')),
  status    text not null default 'active' check (status in ('active','inactive')),
  created_at timestamptz default now(),
  created_by uuid references users(user_id)
);

-- 2. 設備主檔 / Equipment
create table if not exists equipment (
  equipment_id  uuid primary key default gen_random_uuid(),
  name          text not null,
  location      text,
  qr_code       text unique not null,
  purchase_cost numeric(12,2),
  purchase_date date,
  status        text not null default 'active' check (status in ('active','inactive','retired')),
  created_at    timestamptz default now(),
  created_by    uuid references users(user_id)
);

-- 3. 巡檢週期設定 / Inspection Cycle
create table if not exists inspection_cycles (
  cycle_id    uuid primary key default gen_random_uuid(),
  cycle_type  text not null check (cycle_type in ('daily','shift','weekly')),
  started_at  timestamptz not null,
  ended_at    timestamptz,
  created_by  uuid references users(user_id)
);

-- 4. 巡檢記錄 / InspectionRecord
create table if not exists inspection_records (
  record_id     uuid primary key default gen_random_uuid(),
  equipment_id  uuid not null references equipment(equipment_id),
  inspector_id  uuid not null references users(user_id),
  cycle_id      uuid references inspection_cycles(cycle_id),
  inspect_time  timestamptz default now(),
  location_point text,
  run_status    text not null check (run_status in ('normal','abnormal')),
  abnormal_note text,
  light_status  text not null default 'green' check (light_status in ('red','green'))
);

-- 5. 報修單 / RepairRequest
create table if not exists repair_requests (
  request_id          uuid primary key default gen_random_uuid(),
  source              text not null check (source in ('inspection','direct')),
  inspection_record_id uuid references inspection_records(record_id),
  equipment_id        uuid not null references equipment(equipment_id),
  reporter            text not null,
  phone               text,
  department          text,
  fault_desc          text not null,
  status              text not null default 'pending' check (status in ('pending','transferred','closed')),
  created_at          timestamptz default now(),
  created_by          uuid references users(user_id)
);

-- 6. 維修單 / MaintenanceOrder
create table if not exists maintenance_orders (
  order_id      uuid primary key default gen_random_uuid(),
  request_id    uuid not null references repair_requests(request_id),
  equipment_id  uuid not null references equipment(equipment_id),
  assignee_id   uuid references users(user_id),
  status        text not null default 'pending' check (status in ('pending','in_progress','pending_review','completed','closed')),
  result_desc   text,
  start_time    timestamptz,
  finish_time   timestamptz,
  created_at    timestamptz default now()
);

-- 7. 費用紀錄 / CostRecord
create table if not exists cost_records (
  cost_id       uuid primary key default gen_random_uuid(),
  equipment_id  uuid not null references equipment(equipment_id),
  order_id      uuid references maintenance_orders(order_id),
  cost_type     text not null check (cost_type in ('purchase','outsource','parts','labor','other')),
  amount        numeric(12,2) not null,
  vendor        text,
  cost_date     date default current_date,
  note          text,
  created_at    timestamptz default now(),
  created_by    uuid references users(user_id)
);

-- 8. 稽核異動記錄 / AuditLog
create table if not exists audit_logs (
  audit_id    uuid primary key default gen_random_uuid(),
  table_name  text not null,
  record_id   text not null,
  action      text not null check (action in ('insert','update','status_change')),
  changes     jsonb,
  operator_id uuid references users(user_id),
  operated_at timestamptz default now(),
  source      text
);

-- ============================================================
-- RLS Policies (enable after setting up auth)
-- ============================================================
alter table users               enable row level security;
alter table equipment           enable row level security;
alter table inspection_records  enable row level security;
alter table repair_requests     enable row level security;
alter table maintenance_orders  enable row level security;
alter table cost_records        enable row level security;
alter table audit_logs          enable row level security;
alter table inspection_cycles   enable row level security;

-- Allow anon/service role to select (lock down properly in prod)
create policy "allow_all_for_now" on users               for all using (true);
create policy "allow_all_for_now" on equipment           for all using (true);
create policy "allow_all_for_now" on inspection_records  for all using (true);
create policy "allow_all_for_now" on repair_requests     for all using (true);
create policy "allow_all_for_now" on maintenance_orders  for all using (true);
create policy "allow_all_for_now" on cost_records        for all using (true);
create policy "allow_all_for_now" on audit_logs          for all using (true);
create policy "allow_all_for_now" on inspection_cycles   for all using (true);

-- ============================================================
-- Seed demo data
-- ============================================================
insert into inspection_cycles (cycle_type, started_at)
values ('daily', now())
on conflict do nothing;
