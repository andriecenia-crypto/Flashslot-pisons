-- =====================================================================
-- FlashSlot schema for Supabase (PostgreSQL)
-- Run the whole file in: Supabase Dashboard -> SQL Editor -> New query
-- Safe to re-run: it drops and recreates the FlashSlot tables.
-- =====================================================================

create extension if not exists "pgcrypto";

drop table if exists public.notifications cascade;
drop table if exists public.flash_slots   cascade;
drop table if exists public.waitlist      cascade;
drop table if exists public.appointments  cascade;
drop table if exists public.staff         cascade;
drop table if exists public.services      cascade;
drop table if exists public.businesses    cascade;
drop table if exists public.users         cascade;

-- ---------------------------------------------------------------------
-- 1. users  (profile row for every Supabase auth user)
-- ---------------------------------------------------------------------
create table public.users (
  id         uuid primary key references auth.users(id) on delete cascade,
  email      text not null unique,
  full_name  text not null default '',
  role       text not null default 'customer' check (role in ('admin', 'customer')),
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- 2. businesses
-- ---------------------------------------------------------------------
create table public.businesses (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid references public.users(id) on delete set null,
  name        text not null,
  category    text not null default 'other'
              check (category in ('barbershop', 'dental', 'grooming', 'other')),
  description text not null default '',
  address     text not null default '',
  image_url   text not null default '',
  created_at  timestamptz not null default now()
);
create index idx_businesses_owner    on public.businesses(owner_id);
create index idx_businesses_category on public.businesses(category);

-- ---------------------------------------------------------------------
-- 3. services
-- ---------------------------------------------------------------------
create table public.services (
  id               uuid primary key default gen_random_uuid(),
  business_id      uuid not null references public.businesses(id) on delete cascade,
  name             text not null,
  description      text not null default '',
  duration_minutes integer not null default 30 check (duration_minutes > 0),
  price            numeric(10,2) not null default 0 check (price >= 0),
  created_at       timestamptz not null default now()
);
create index idx_services_business on public.services(business_id);

-- ---------------------------------------------------------------------
-- 4. staff
-- ---------------------------------------------------------------------
create table public.staff (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  name        text not null,
  role        text not null default '',
  avatar_url  text not null default '',
  created_at  timestamptz not null default now()
);
create index idx_staff_business on public.staff(business_id);

-- ---------------------------------------------------------------------
-- 5. appointments
--    service_id / staff_id become NULL if the service or staff member is
--    deleted, so booking history is never lost.
-- ---------------------------------------------------------------------
create table public.appointments (
  id          uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.users(id) on delete cascade,
  business_id uuid not null references public.businesses(id) on delete cascade,
  service_id  uuid references public.services(id) on delete set null,
  staff_id    uuid references public.staff(id) on delete set null,
  slot_time   timestamptz not null,
  status      text not null default 'booked'
              check (status in ('booked', 'completed', 'cancelled')),
  created_at  timestamptz not null default now()
);
create index idx_appointments_customer on public.appointments(customer_id, slot_time);
create index idx_appointments_business on public.appointments(business_id, slot_time);
create index idx_appointments_staff    on public.appointments(staff_id, slot_time);
-- Database-level guard against double booking the same staff member at the same start time
create unique index uq_appointments_staff_slot
  on public.appointments(staff_id, slot_time) where status = 'booked';

-- ---------------------------------------------------------------------
-- 6. waitlist  (service_id NULL = "any service")
-- ---------------------------------------------------------------------
create table public.waitlist (
  id             uuid primary key default gen_random_uuid(),
  customer_id    uuid not null references public.users(id) on delete cascade,
  business_id    uuid not null references public.businesses(id) on delete cascade,
  service_id     uuid references public.services(id) on delete cascade,
  preferred_date date not null,
  status         text not null default 'active'
                 check (status in ('active', 'notified', 'expired')),
  created_at     timestamptz not null default now()
);
create index idx_waitlist_customer on public.waitlist(customer_id);
create index idx_waitlist_match    on public.waitlist(business_id, service_id, preferred_date, status);

-- ---------------------------------------------------------------------
-- 7. flash_slots
-- ---------------------------------------------------------------------
create table public.flash_slots (
  id                  uuid primary key default gen_random_uuid(),
  appointment_id      uuid not null references public.appointments(id) on delete cascade,
  business_id         uuid not null references public.businesses(id) on delete cascade,
  discount_percentage integer not null check (discount_percentage between 1 and 90),
  flash_price         numeric(10,2) not null check (flash_price >= 0),
  expires_at          timestamptz not null,
  status              text not null default 'active'
                      check (status in ('active', 'claimed', 'expired')),
  created_at          timestamptz not null default now()
);
create index idx_flash_status_expiry on public.flash_slots(status, expires_at);
create index idx_flash_business      on public.flash_slots(business_id);
create unique index uq_flash_active_per_appointment
  on public.flash_slots(appointment_id) where status = 'active';

-- ---------------------------------------------------------------------
-- 8. notifications (extra table): the mock alert records sent to waitlisted users
-- ---------------------------------------------------------------------
create table public.notifications (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references public.users(id) on delete cascade,
  waitlist_id   uuid references public.waitlist(id) on delete set null,
  flash_slot_id uuid references public.flash_slots(id) on delete cascade,
  channel       text not null default 'in_app',
  message       text not null,
  is_read       boolean not null default false,
  created_at    timestamptz not null default now()
);
create index idx_notifications_user on public.notifications(user_id, created_at desc);

-- ---------------------------------------------------------------------
-- Auto-create a profile row whenever someone signs up.
-- New accounts are ALWAYS customers; owners are promoted by the backend
-- (/api/auth/become-admin) after presenting the owner invite code.
-- ---------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.users (id, email, full_name, role)
  values (new.id, new.email, coalesce(new.raw_user_meta_data->>'full_name', ''), 'customer')
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Back-fill profiles for accounts that already exist
insert into public.users (id, email, full_name, role)
select id, email, coalesce(raw_user_meta_data->>'full_name', ''), 'customer'
from auth.users
on conflict (id) do nothing;

-- ---------------------------------------------------------------------
-- Helper functions for RLS (security definer avoids recursive policies)
-- ---------------------------------------------------------------------
create or replace function public.is_admin()
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists (select 1 from public.users where id = auth.uid() and role = 'admin');
$$;

create or replace function public.owns_business(bid uuid)
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists (select 1 from public.businesses where id = bid and owner_id = auth.uid());
$$;

-- ---------------------------------------------------------------------
-- Row Level Security
-- The Flask backend uses the service-role key (bypasses RLS) for writes.
-- These policies protect direct access from the browser (anon key).
-- ---------------------------------------------------------------------
alter table public.users         enable row level security;
alter table public.businesses    enable row level security;
alter table public.services      enable row level security;
alter table public.staff         enable row level security;
alter table public.appointments  enable row level security;
alter table public.waitlist      enable row level security;
alter table public.flash_slots   enable row level security;
alter table public.notifications enable row level security;

-- users: read your own profile. Roles can only be changed by the backend.
create policy "users_select_own" on public.users
  for select using (id = auth.uid());

-- businesses: public catalogue, owner-managed
create policy "businesses_public_read" on public.businesses
  for select using (true);
create policy "businesses_owner_insert" on public.businesses
  for insert with check (owner_id = auth.uid() and public.is_admin());
create policy "businesses_owner_update" on public.businesses
  for update using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy "businesses_owner_delete" on public.businesses
  for delete using (owner_id = auth.uid());

-- services: public read, owner-managed
create policy "services_public_read" on public.services
  for select using (true);
create policy "services_owner_write" on public.services
  for all using (public.owns_business(business_id))
  with check (public.owns_business(business_id));

-- staff: public read, owner-managed
create policy "staff_public_read" on public.staff
  for select using (true);
create policy "staff_owner_write" on public.staff
  for all using (public.owns_business(business_id))
  with check (public.owns_business(business_id));

-- appointments: customers see/manage their own, owners see/manage their business's
create policy "appointments_customer_select" on public.appointments
  for select using (customer_id = auth.uid());
create policy "appointments_owner_select" on public.appointments
  for select using (public.owns_business(business_id));
create policy "appointments_customer_insert" on public.appointments
  for insert with check (customer_id = auth.uid());
create policy "appointments_customer_update" on public.appointments
  for update using (customer_id = auth.uid()) with check (customer_id = auth.uid());
create policy "appointments_owner_update" on public.appointments
  for update using (public.owns_business(business_id))
  with check (public.owns_business(business_id));
create policy "appointments_owner_delete" on public.appointments
  for delete using (public.owns_business(business_id));

-- waitlist: customers manage their own entries, owners can read theirs
create policy "waitlist_customer_all" on public.waitlist
  for all using (customer_id = auth.uid()) with check (customer_id = auth.uid());
create policy "waitlist_owner_select" on public.waitlist
  for select using (public.owns_business(business_id));

-- flash_slots: public can browse, owners manage
create policy "flash_public_read" on public.flash_slots
  for select using (true);
create policy "flash_owner_write" on public.flash_slots
  for all using (public.owns_business(business_id))
  with check (public.owns_business(business_id));

-- notifications: each user sees and updates only their own alerts
create policy "notifications_select_own" on public.notifications
  for select using (user_id = auth.uid());
create policy "notifications_update_own" on public.notifications
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());
