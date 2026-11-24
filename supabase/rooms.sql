-- Rooms are private Realtime channels named "sommet-<CODE>".
-- These two rules let signed-in riders, and nobody else, send and receive in them.
-- Run once in the Supabase dashboard: SQL Editor → New query → paste → Run.
-- Then turn off "Allow public access" under Realtime → Settings.

create policy "signed-in riders can receive in rooms"
on realtime.messages for select to authenticated
using (
  realtime.messages.extension = 'broadcast'
  and (select realtime.topic()) like 'sommet-%'
);

create policy "signed-in riders can send in rooms"
on realtime.messages for insert to authenticated
with check (
  realtime.messages.extension = 'broadcast'
  and (select realtime.topic()) like 'sommet-%'
);
