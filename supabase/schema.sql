-- =====================================================================
-- GSASG registry — database setup for Supabase
-- Paste this whole file into Supabase → SQL Editor → New query → Run.
-- Safe to run more than once.
--
-- Access model, enforced by the database itself:
--   * INI accounts (role 'ini_admin') read and write every site.
--   * Site accounts (role 'site_user') read and write only their own site.
--   * New sign-ups start as 'pending' with no access until INI approves them,
--     except the very first account, which becomes the first INI admin.
--   * The audit log is append-only: nobody can edit or delete it.
-- =====================================================================

-- ---------- sites ----------
create table if not exists public.sites (
  name        text primary key,
  short_name  text not null,
  created_at  timestamptz not null default now()
);
insert into public.sites (name, short_name) values
  ('Neurosurgery & Spine Group — Santa Monica', 'Neurosurgery & Spine Group'),
  ('Pacific Coast Spine Institute — San Diego',  'Pacific Coast Spine Institute'),
  ('Lakeshore Spine Center — Chicago',           'Lakeshore Spine Center'),
  ('Riverbend Neurosurgery — Austin',            'Riverbend Neurosurgery'),
  ('Harborview Spine Associates — Boston',       'Harborview Spine Associates')
on conflict (name) do nothing;

-- ---------- people ----------
create table if not exists public.profiles (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  email       text not null,
  full_name   text,
  role        text not null default 'pending' check (role in ('ini_admin','site_user','pending')),
  site        text references public.sites(name),
  created_at  timestamptz not null default now(),
  constraint site_users_have_a_site check (role <> 'site_user' or site is not null)
);

-- invitations: INI adds an email with a role and site; the person then signs up
create table if not exists public.invites (
  email       text primary key,
  role        text not null check (role in ('ini_admin','site_user')),
  site        text references public.sites(name),
  full_name   text,
  invited_by  uuid default auth.uid(),
  created_at  timestamptz not null default now(),
  constraint invited_site_users_have_a_site check (role <> 'site_user' or site is not null)
);

-- ---------- registry records ----------
create sequence if not exists public.case_number_seq start 1000;

create table if not exists public.cases (
  id          text primary key,
  site        text not null references public.sites(name),
  data        jsonb not null,
  created_by  uuid default auth.uid(),
  created_at  timestamptz not null default now(),
  updated_by  uuid,
  updated_at  timestamptz not null default now()
);
create index if not exists cases_site_idx on public.cases(site);

create table if not exists public.audit_log (
  id          bigserial primary key,
  at          timestamptz not null default now(),
  user_id     uuid default auth.uid(),
  user_email  text,
  case_id     text,
  site        text,
  action      text not null,
  detail      jsonb
);
create index if not exists audit_case_idx on public.audit_log(case_id);

create table if not exists public.export_log (
  id          bigserial primary key,
  at          timestamptz not null default now(),
  user_id     uuid default auth.uid(),
  user_email  text,
  scope       text not null,
  what        text not null,
  patients    int
);

-- registry-wide benchmark distribution, published by INI. Aggregate and
-- de-identified (one number per surgeon or site, no names), so every approved
-- user may read it while still seeing only their own site's patients.
create table if not exists public.benchmarks (
  id            int primary key default 1 check (id = 1),
  data          jsonb not null,
  published_at  timestamptz not null default now(),
  published_by  text
);

-- ---------- who is asking ----------
-- security definer so the policies below can read profiles without recursion
create or replace function public.my_role() returns text
  language sql stable security definer set search_path = public as $$
  select role from public.profiles where user_id = auth.uid()
$$;
create or replace function public.my_site() returns text
  language sql stable security definer set search_path = public as $$
  select site from public.profiles where user_id = auth.uid()
$$;
create or replace function public.can_see_site(s text) returns boolean
  language sql stable security definer set search_path = public as $$
  select coalesce(
    (select role = 'ini_admin' or (role = 'site_user' and site = s)
       from public.profiles where user_id = auth.uid()), false)
$$;

-- next case number, shared across sites so IDs never collide
create or replace function public.next_case_id() returns text
  language sql volatile security definer set search_path = public as $$
  select case when public.my_role() in ('ini_admin','site_user')
              then 'MPSR-' || nextval('public.case_number_seq')::text end
$$;

-- ---------- new accounts ----------
create or replace function public.handle_new_user() returns trigger
  language plpgsql security definer set search_path = public as $$
declare inv public.invites;
begin
  select * into inv from public.invites where lower(email) = lower(new.email);
  if found then
    insert into public.profiles(user_id, email, full_name, role, site)
    values (new.id, new.email, coalesce(inv.full_name, new.raw_user_meta_data->>'full_name'), inv.role, inv.site)
    on conflict (user_id) do nothing;
  elsif not exists (select 1 from public.profiles where role = 'ini_admin') then
    -- the first person to sign up becomes the first INI administrator
    insert into public.profiles(user_id, email, full_name, role)
    values (new.id, new.email, new.raw_user_meta_data->>'full_name', 'ini_admin')
    on conflict (user_id) do nothing;
  else
    insert into public.profiles(user_id, email, full_name, role)
    values (new.id, new.email, new.raw_user_meta_data->>'full_name', 'pending')
    on conflict (user_id) do nothing;
  end if;
  return new;
end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------- automatic audit trail, written by the database ----------
create or replace function public.audit_cases() returns trigger
  language plpgsql security definer set search_path = public as $$
declare email text;
begin
  select p.email into email from public.profiles p where p.user_id = auth.uid();
  if tg_op = 'INSERT' then
    insert into public.audit_log(user_id, user_email, case_id, site, action, detail)
    values (auth.uid(), email, new.id, new.site, 'record created', null);
  elsif tg_op = 'UPDATE' then
    new.updated_at := now();
    new.updated_by := auth.uid();
    insert into public.audit_log(user_id, user_email, case_id, site, action, detail)
    values (auth.uid(), email, new.id, new.site, 'record updated',
      (select jsonb_agg(k) from (
         select key as k from jsonb_each(new.data)
         where new.data->key is distinct from old.data->key) x));
  elsif tg_op = 'DELETE' then
    insert into public.audit_log(user_id, user_email, case_id, site, action, detail)
    values (auth.uid(), email, old.id, old.site, 'record deleted', null);
    return old;
  end if;
  return new;
end $$;
drop trigger if exists cases_audit on public.cases;
create trigger cases_audit before insert or update or delete on public.cases
  for each row execute function public.audit_cases();

-- ---------- row-level security ----------
alter table public.sites      enable row level security;
alter table public.profiles   enable row level security;
alter table public.invites    enable row level security;
alter table public.cases      enable row level security;
alter table public.audit_log  enable row level security;
alter table public.export_log enable row level security;
alter table public.benchmarks enable row level security;

drop policy if exists sites_read on public.sites;
create policy sites_read on public.sites for select to authenticated using (true);

drop policy if exists profiles_read on public.profiles;
create policy profiles_read on public.profiles for select to authenticated
  using (user_id = auth.uid() or public.my_role() = 'ini_admin');
drop policy if exists profiles_admin_update on public.profiles;
create policy profiles_admin_update on public.profiles for update to authenticated
  using (public.my_role() = 'ini_admin') with check (public.my_role() = 'ini_admin');

drop policy if exists invites_admin on public.invites;
create policy invites_admin on public.invites for all to authenticated
  using (public.my_role() = 'ini_admin') with check (public.my_role() = 'ini_admin');

drop policy if exists cases_read on public.cases;
create policy cases_read on public.cases for select to authenticated
  using (public.can_see_site(site));
drop policy if exists cases_insert on public.cases;
create policy cases_insert on public.cases for insert to authenticated
  with check (public.can_see_site(site));
drop policy if exists cases_update on public.cases;
create policy cases_update on public.cases for update to authenticated
  using (public.can_see_site(site)) with check (public.can_see_site(site));
drop policy if exists cases_delete on public.cases;
create policy cases_delete on public.cases for delete to authenticated
  using (public.my_role() = 'ini_admin');

-- audit: readable within your scope; nobody can insert, edit or delete directly
drop policy if exists audit_read on public.audit_log;
create policy audit_read on public.audit_log for select to authenticated
  using (public.my_role() = 'ini_admin' or (site is not null and public.can_see_site(site)));

drop policy if exists bench_read on public.benchmarks;
create policy bench_read on public.benchmarks for select to authenticated
  using (public.my_role() in ('ini_admin','site_user'));
drop policy if exists bench_write on public.benchmarks;
create policy bench_write on public.benchmarks for insert to authenticated
  with check (public.my_role() = 'ini_admin');
drop policy if exists bench_update on public.benchmarks;
create policy bench_update on public.benchmarks for update to authenticated
  using (public.my_role() = 'ini_admin') with check (public.my_role() = 'ini_admin');

drop policy if exists export_read on public.export_log;
create policy export_read on public.export_log for select to authenticated
  using (public.my_role() = 'ini_admin' or user_id = auth.uid());
drop policy if exists export_insert on public.export_log;
create policy export_insert on public.export_log for insert to authenticated
  with check (user_id = auth.uid() and public.my_role() in ('ini_admin','site_user'));

grant usage on schema public to authenticated;
grant select on public.sites to authenticated;
grant select, update on public.profiles to authenticated;
grant select, insert, update, delete on public.invites to authenticated;
grant select, insert, update, delete on public.cases to authenticated;
grant select on public.audit_log to authenticated;
grant select, insert on public.export_log to authenticated;
grant usage on sequence public.export_log_id_seq to authenticated;
grant select, insert, update on public.benchmarks to authenticated;
grant execute on function public.next_case_id() to authenticated;
grant execute on function public.my_role() to authenticated;
grant execute on function public.my_site() to authenticated;
grant execute on function public.can_see_site(text) to authenticated;
revoke all on public.cases, public.profiles, public.invites, public.audit_log, public.export_log from anon;
