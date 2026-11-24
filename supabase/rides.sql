-- Ride history. Every rider can only see, add and delete their own rides.
-- Run once in the Supabase dashboard: SQL Editor → New query → paste → Run.

create table public.rides (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  started_at timestamptz not null,
  route text not null,
  finished boolean not null default false,
  start_m real not null default 0,       -- where on the route the ride began
  distance_m real not null,
  duration_s real not null,              -- moving time
  climbed_m real not null,
  avg_power real,
  np real,                               -- normalised power
  max_power real,
  avg_hr real,
  max_hr real,
  avg_cadence real,
  weight_kg real,
  best jsonb,                            -- best average watts per duration: {"5":..,"60":..,"300":..,"1200":..,"3600":..}
  samples jsonb,                         -- one value a second: {"p":[..],"hr":[..],"cad":[..],"d":[..]}
  created_at timestamptz not null default now()
);

create index rides_user_started on public.rides (user_id, started_at desc);

alter table public.rides enable row level security;

create policy "riders read their own rides" on public.rides
  for select to authenticated using (user_id = (select auth.uid()));
create policy "riders add their own rides" on public.rides
  for insert to authenticated with check (user_id = (select auth.uid()));
create policy "riders delete their own rides" on public.rides
  for delete to authenticated using (user_id = (select auth.uid()));
