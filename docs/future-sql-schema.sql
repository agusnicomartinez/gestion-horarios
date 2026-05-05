-- Gestión de Horarios - FUTURE SQL Schema (not used in v0)
--
-- v0 uses localStorage only — see src/lib/db.ts.
-- This file is kept as the canonical reference for the planned migration to
-- Supabase / Postgres. When we cut over, this is what gets executed in the
-- Supabase SQL Editor (Project → SQL Editor → New query).

-- =========================================================================
-- EXTENSIONS
-- =========================================================================
create extension if not exists pgcrypto;

-- =========================================================================
-- ENUMS
-- =========================================================================
do $$ begin
  create type shift_type as enum ('morning', 'afternoon', 'both');
exception when duplicate_object then null; end $$;

do $$ begin
  create type request_type as enum ('vacation', 'personal', 'holiday');
exception when duplicate_object then null; end $$;

do $$ begin
  create type request_status as enum ('pending', 'approved', 'rejected');
exception when duplicate_object then null; end $$;

do $$ begin
  create type shift_value as enum ('morning', 'afternoon', 'off');
exception when duplicate_object then null; end $$;

do $$ begin
  create type schedule_status as enum ('draft', 'published');
exception when duplicate_object then null; end $$;

do $$ begin
  create type entry_source as enum ('auto', 'manual', 'request');
exception when duplicate_object then null; end $$;

-- =========================================================================
-- TABLES
-- =========================================================================

create table if not exists supervisors (
  id uuid primary key default gen_random_uuid(),
  dni text unique not null,
  full_name text not null,
  created_at timestamptz not null default now()
);

create table if not exists employees (
  id uuid primary key default gen_random_uuid(),
  dni text unique not null,
  full_name text not null,
  shift_type shift_type not null default 'both',
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists global_settings (
  id smallint primary key default 1,
  vacation_days_per_year integer not null default 31,
  personal_days_per_year integer not null default 3,
  holiday_days_per_year integer not null default 14,
  updated_at timestamptz not null default now(),
  constraint single_row check (id = 1)
);

create table if not exists public_holidays (
  id uuid primary key default gen_random_uuid(),
  date date unique not null,
  description text not null default ''
);

create table if not exists day_requests (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references employees(id) on delete cascade,
  type request_type not null,
  start_date date not null,
  end_date date not null,
  status request_status not null default 'pending',
  target_month date not null,
  created_at timestamptz not null default now(),
  reviewed_at timestamptz,
  reviewed_by uuid references supervisors(id),
  constraint date_order check (end_date >= start_date)
);

create index if not exists day_requests_employee_idx on day_requests(employee_id);
create index if not exists day_requests_target_month_idx on day_requests(target_month);
create index if not exists day_requests_status_idx on day_requests(status);

create table if not exists schedules (
  id uuid primary key default gen_random_uuid(),
  month date unique not null,
  status schedule_status not null default 'draft',
  published_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists schedule_entries (
  id uuid primary key default gen_random_uuid(),
  schedule_id uuid not null references schedules(id) on delete cascade,
  employee_id uuid not null references employees(id) on delete cascade,
  date date not null,
  shift shift_value not null,
  source entry_source not null default 'auto',
  unique (schedule_id, employee_id, date)
);

create index if not exists schedule_entries_date_idx on schedule_entries(date);
create index if not exists schedule_entries_employee_idx on schedule_entries(employee_id);

-- =========================================================================
-- SEED
-- =========================================================================

insert into global_settings (id) values (1) on conflict do nothing;

-- Seed supervisor (replace DNI/name with real values after first login)
insert into supervisors (dni, full_name)
values ('00000000A', 'Supervisor')
on conflict (dni) do nothing;

-- Festivos oficiales Barcelona 2026 (Catalunya + locales)
insert into public_holidays (date, description) values
  ('2026-01-01', 'Cap d''Any'),
  ('2026-01-06', 'Reis'),
  ('2026-04-03', 'Divendres Sant'),
  ('2026-04-06', 'Dilluns de Pasqua Florida'),
  ('2026-05-01', 'Festa del Treball'),
  ('2026-05-25', 'Pasqua Granada'),
  ('2026-06-24', 'Sant Joan'),
  ('2026-08-15', 'L''Assumpció'),
  ('2026-09-11', 'Diada Nacional de Catalunya'),
  ('2026-09-24', 'La Mercè'),
  ('2026-10-12', 'Festa Nacional d''Espanya'),
  ('2026-11-02', 'Tots Sants (trasllat)'),
  ('2026-12-08', 'La Immaculada'),
  ('2026-12-25', 'Nadal')
on conflict (date) do nothing;

-- =========================================================================
-- ROW LEVEL SECURITY
-- =========================================================================
-- NOTE on auth model:
-- This first version uses DNI-based identification without Supabase Auth (issue #3
-- in the GitHub repo tracks adding password auth). RLS is enabled with permissive
-- policies for the anon role so the client can read/write using the public anon key.
-- All authorization is enforced in the application layer (lookup of DNI on login,
-- session in localStorage, role check before mutations). When issue #3 lands, swap
-- these policies for ones based on auth.uid() or a custom JWT claim with the DNI.

alter table supervisors enable row level security;
alter table employees enable row level security;
alter table global_settings enable row level security;
alter table public_holidays enable row level security;
alter table day_requests enable row level security;
alter table schedules enable row level security;
alter table schedule_entries enable row level security;

drop policy if exists "anon all supervisors" on supervisors;
create policy "anon all supervisors" on supervisors for all to anon using (true) with check (true);

drop policy if exists "anon all employees" on employees;
create policy "anon all employees" on employees for all to anon using (true) with check (true);

drop policy if exists "anon all global_settings" on global_settings;
create policy "anon all global_settings" on global_settings for all to anon using (true) with check (true);

drop policy if exists "anon all public_holidays" on public_holidays;
create policy "anon all public_holidays" on public_holidays for all to anon using (true) with check (true);

drop policy if exists "anon all day_requests" on day_requests;
create policy "anon all day_requests" on day_requests for all to anon using (true) with check (true);

drop policy if exists "anon all schedules" on schedules;
create policy "anon all schedules" on schedules for all to anon using (true) with check (true);

drop policy if exists "anon all schedule_entries" on schedule_entries;
create policy "anon all schedule_entries" on schedule_entries for all to anon using (true) with check (true);
