-- Koldrop: per-user files on Supabase Storage.
-- Runs automatically on every Vercel build (scripts/setup-db.mjs). Safe to run again.
-- You can also paste it into Supabase → SQL Editor by hand.

-- 1) The file list: one row per file, owned by a user.
create table if not exists public.user_files (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null default auth.uid() references auth.users (id) on delete cascade,
  storage_key  text not null unique,          -- "<user id>/<uuid>.<ext>" inside the "files" bucket
  folder       text not null default 'general',
  name         text not null,
  size         bigint not null default 0,
  content_type text,
  is_video     boolean not null default false,
  uploaded_at  timestamptz not null default now(),
  unique (user_id, folder, name)
);

-- Small JPEG preview for the gallery (added later, so also added to existing tables)
alter table public.user_files add column if not exists thumb_key text;

create index if not exists user_files_user_uploaded_idx
  on public.user_files (user_id, uploaded_at desc);

alter table public.user_files enable row level security;

drop policy if exists "Users read own files"   on public.user_files;
drop policy if exists "Users add own files"    on public.user_files;
drop policy if exists "Users update own files" on public.user_files;
drop policy if exists "Users delete own files" on public.user_files;

create policy "Users read own files" on public.user_files
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "Users add own files" on public.user_files
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "Users update own files" on public.user_files
  for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "Users delete own files" on public.user_files
  for delete to authenticated using ((select auth.uid()) = user_id);

-- Storage totals, summed in the database (a plain select would stop at 1000 rows).
create or replace function public.my_storage_bytes() returns bigint
  language sql stable security invoker set search_path = ''
  as $$ select coalesce(sum(size), 0)::bigint from public.user_files where user_id = (select auth.uid()) $$;

create or replace function public.total_storage_bytes() returns bigint
  language sql stable security definer set search_path = ''
  as $$ select coalesce(sum(size), 0)::bigint from public.user_files $$;
revoke execute on function public.total_storage_bytes() from public, anon, authenticated;
grant execute on function public.total_storage_bytes() to service_role;

-- Live updates: each account may only join / send on its own private channel "koldrop:<user id>"
drop policy if exists "Koldrop own live channel read" on realtime.messages;
drop policy if exists "Koldrop own live channel send" on realtime.messages;
create policy "Koldrop own live channel read" on realtime.messages
  for select to authenticated
  using ((select realtime.topic()) = 'koldrop:' || (select auth.uid())::text);
create policy "Koldrop own live channel send" on realtime.messages
  for insert to authenticated
  with check ((select realtime.topic()) = 'koldrop:' || (select auth.uid())::text);

-- Bug reports and suggestions from Settings. Users can only add their own; nobody reads them
-- through the API (the server emails them to the owner and keeps this copy as a backup).
create table if not exists public.feedback (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid default auth.uid() references auth.users (id) on delete set null,
  email      text,
  kind       text not null default 'bug',
  message    text not null check (char_length(message) between 1 and 5000),
  emailed    boolean not null default false,
  created_at timestamptz not null default now()
);
alter table public.feedback enable row level security;
drop policy if exists "Users send feedback" on public.feedback;
create policy "Users send feedback" on public.feedback
  for insert to authenticated with check ((select auth.uid()) = user_id);

-- Activity log for the owner's Settings → Activity tab: who uploaded, downloaded or deleted
-- what and when (names and sizes only, never the files). Written and read only by the server
-- (service role); no policies, so browsers can't read or write it. Kept for 30 days.
create table if not exists public.activity_log (
  id         bigint generated always as identity primary key,
  user_id    uuid references auth.users (id) on delete set null,
  email      text,
  action     text not null,            -- upload | download | delete
  file_name  text,
  folder     text,
  size       bigint not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists activity_log_created_idx on public.activity_log (created_at desc);
create index if not exists activity_log_user_idx on public.activity_log (user_id, created_at desc);
alter table public.activity_log enable row level security;

-- One row per account for the Activity tab, computed in the database (no 1000-row limit).
create or replace function public.koldrop_activity_summary() returns json
  language sql stable security definer set search_path = ''
  as $$
    select coalesce(json_agg(t order by t.last_activity desc nulls last, t.created_at desc), '[]'::json) from (
      select u.id, u.email, u.created_at, u.last_sign_in_at,
        (select coalesce(sum(f.size), 0) from public.user_files f where f.user_id = u.id) as stored_bytes,
        (select count(*) from public.user_files f where f.user_id = u.id) as stored_files,
        (select count(*) from public.activity_log a where a.user_id = u.id and a.action = 'upload' and a.created_at > now() - interval '7 days') as uploads_7d,
        (select count(*) from public.activity_log a where a.user_id = u.id and a.action = 'download' and a.created_at > now() - interval '7 days') as downloads_7d,
        (select count(*) from public.activity_log a where a.user_id = u.id and a.action = 'delete' and a.created_at > now() - interval '7 days') as deletes_7d,
        (select coalesce(sum(a.size), 0) from public.activity_log a where a.user_id = u.id and a.action = 'upload' and a.created_at > now() - interval '30 days') as uploaded_bytes_30d,
        (select count(*) from public.activity_log a where a.user_id = u.id and a.action = 'upload' and a.created_at > now() - interval '30 days') as uploads_30d,
        (select max(a.created_at) from public.activity_log a where a.user_id = u.id) as last_activity
      from auth.users u
    ) t
  $$;
revoke execute on function public.koldrop_activity_summary() from public, anon, authenticated;
grant execute on function public.koldrop_activity_summary() to service_role;

-- 2) The private "files" bucket is created by scripts/setup-db.mjs through the Storage API.
--    It has NO storage policies on purpose: browsers never talk to storage with their own
--    rights. The server checks ownership via user_files (above) and then hands out one-time
--    signed upload/download URLs.

-- The old single-user index table ("files") is no longer used. After you've run the
-- migration script and checked your files, you can drop it:
--   drop table if exists public.files;
