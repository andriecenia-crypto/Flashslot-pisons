-- =====================================================================
-- FlashSlot demo data. Run AFTER schema.sql.
--
-- Tip: sign up at least one account on the site first. The last block of
-- this file then creates a few cancelled appointments with live Flash Slots
-- (owned by that account) so the homepage is populated straight away.
-- Safe to re-run.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Businesses (unowned demo listings; owners create their own via the app)
-- ---------------------------------------------------------------------
insert into public.businesses (id, owner_id, name, category, description, address, image_url) values
  ('11111111-1111-1111-1111-111111111111', null,
   'Fade & Co. Barbershop', 'barbershop',
   'Classic cuts, hot-towel shaves and sharp fades in a relaxed corner shop.',
   'Colon Street, Cebu City',
   'https://images.unsplash.com/photo-1503951914875-452162b0f3f1?auto=format&fit=crop&w=1200&q=80'),
  ('22222222-2222-2222-2222-222222222222', null,
   'BrightSmile Dental Clinic', 'dental',
   'Gentle family dentistry: cleanings, whitening and same-week check-ups.',
   'IT Park, Lahug, Cebu City',
   'https://images.unsplash.com/photo-1606811841689-23dfddce3e95?auto=format&fit=crop&w=1200&q=80'),
  ('33333333-3333-3333-3333-333333333333', null,
   'Paws & Bubbles Pet Grooming', 'grooming',
   'Bath, trim and spa treatments for dogs and cats, done with patience.',
   'Banilad, Cebu City',
   'https://images.unsplash.com/photo-1587300003388-59208cc962cb?auto=format&fit=crop&w=1200&q=80')
on conflict (id) do nothing;

-- ---------------------------------------------------------------------
-- Services
-- ---------------------------------------------------------------------
insert into public.services (id, business_id, name, description, duration_minutes, price) values
  ('a1000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'Signature Haircut', 'Consultation, cut and styling.', 45, 350),
  ('a1000000-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111', 'Hot Towel Shave', 'Straight-razor shave with a warm towel finish.', 30, 280),
  ('a1000000-0000-0000-0000-000000000003', '11111111-1111-1111-1111-111111111111', 'Cut + Beard Trim', 'Haircut with beard shaping and line-up.', 60, 520),
  ('a2000000-0000-0000-0000-000000000001', '22222222-2222-2222-2222-222222222222', 'Dental Cleaning', 'Scaling, polishing and a quick check-up.', 45, 1200),
  ('a2000000-0000-0000-0000-000000000002', '22222222-2222-2222-2222-222222222222', 'Teeth Whitening', 'In-chair whitening, up to four shades brighter.', 60, 3500),
  ('a2000000-0000-0000-0000-000000000003', '22222222-2222-2222-2222-222222222222', 'Consultation', 'Examination and treatment plan.', 30, 600),
  ('a3000000-0000-0000-0000-000000000001', '33333333-3333-3333-3333-333333333333', 'Bath & Blow-dry', 'Shampoo, conditioner, blow-dry and brush-out.', 60, 800),
  ('a3000000-0000-0000-0000-000000000002', '33333333-3333-3333-3333-333333333333', 'Full Groom', 'Bath, haircut, nail trim and ear cleaning.', 90, 1400),
  ('a3000000-0000-0000-0000-000000000003', '33333333-3333-3333-3333-333333333333', 'Nail Trim & Spa Paws', 'Nail trim, paw balm and a quick tidy.', 30, 350)
on conflict (id) do nothing;

-- ---------------------------------------------------------------------
-- Staff
-- ---------------------------------------------------------------------
insert into public.staff (id, business_id, name, role, avatar_url) values
  ('b1000000-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'Marco Villanueva', 'Master Barber', 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?auto=format&fit=crop&w=200&h=200&q=80'),
  ('b1000000-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111', 'Jun Dela Cruz', 'Barber', 'https://images.unsplash.com/photo-1472099645785-5658abf4ff4e?auto=format&fit=crop&w=200&h=200&q=80'),
  ('b2000000-0000-0000-0000-000000000001', '22222222-2222-2222-2222-222222222222', 'Dr. Annika Reyes', 'Dentist', 'https://images.unsplash.com/photo-1494790108377-be9c29b29330?auto=format&fit=crop&w=200&h=200&q=80'),
  ('b2000000-0000-0000-0000-000000000002', '22222222-2222-2222-2222-222222222222', 'Dr. Paolo Tan', 'Orthodontist', 'https://images.unsplash.com/photo-1500648767791-00dcc994a43e?auto=format&fit=crop&w=200&h=200&q=80'),
  ('b3000000-0000-0000-0000-000000000001', '33333333-3333-3333-3333-333333333333', 'Bea Santos', 'Senior Groomer', 'https://images.unsplash.com/photo-1438761681033-6461ffad8d80?auto=format&fit=crop&w=200&h=200&q=80'),
  ('b3000000-0000-0000-0000-000000000002', '33333333-3333-3333-3333-333333333333', 'Carlo Mendoza', 'Groomer', 'https://images.unsplash.com/photo-1519085360753-af0119f7cbe7?auto=format&fit=crop&w=200&h=200&q=80')
on conflict (id) do nothing;

-- ---------------------------------------------------------------------
-- Demo Flash Slots: needs at least one registered account.
-- Creates three cancelled appointments (one per business) and a live flash
-- slot for each, expiring a few hours from now.
-- ---------------------------------------------------------------------
do $$
declare
  demo_user uuid;
begin
  select id into demo_user from public.users order by created_at limit 1;

  if demo_user is null then
    raise notice 'No users yet: sign up on the site, then re-run this file to add demo flash slots.';
    return;
  end if;

  insert into public.appointments (id, customer_id, business_id, service_id, staff_id, slot_time, status) values
    ('c1000000-0000-0000-0000-000000000001', demo_user, '11111111-1111-1111-1111-111111111111',
     'a1000000-0000-0000-0000-000000000001', 'b1000000-0000-0000-0000-000000000001',
     date_trunc('hour', now()) + interval '4 hours', 'cancelled'),
    ('c1000000-0000-0000-0000-000000000002', demo_user, '22222222-2222-2222-2222-222222222222',
     'a2000000-0000-0000-0000-000000000001', 'b2000000-0000-0000-0000-000000000001',
     date_trunc('hour', now()) + interval '6 hours', 'cancelled'),
    ('c1000000-0000-0000-0000-000000000003', demo_user, '33333333-3333-3333-3333-333333333333',
     'a3000000-0000-0000-0000-000000000002', 'b3000000-0000-0000-0000-000000000001',
     date_trunc('hour', now()) + interval '9 hours', 'cancelled')
  on conflict (id) do update set slot_time = excluded.slot_time, status = 'cancelled';

  delete from public.flash_slots
   where id in ('d1000000-0000-0000-0000-000000000001',
                'd1000000-0000-0000-0000-000000000002',
                'd1000000-0000-0000-0000-000000000003');

  insert into public.flash_slots (id, appointment_id, business_id, discount_percentage, flash_price, expires_at, status) values
    ('d1000000-0000-0000-0000-000000000001', 'c1000000-0000-0000-0000-000000000001',
     '11111111-1111-1111-1111-111111111111', 30, 245,
     date_trunc('hour', now()) + interval '4 hours' - interval '15 minutes', 'active'),
    ('d1000000-0000-0000-0000-000000000002', 'c1000000-0000-0000-0000-000000000002',
     '22222222-2222-2222-2222-222222222222', 40, 720,
     date_trunc('hour', now()) + interval '6 hours' - interval '15 minutes', 'active'),
    ('d1000000-0000-0000-0000-000000000003', 'c1000000-0000-0000-0000-000000000003',
     '33333333-3333-3333-3333-333333333333', 25, 1050,
     date_trunc('hour', now()) + interval '9 hours' - interval '15 minutes', 'active');
end $$;
