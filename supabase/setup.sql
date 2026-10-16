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

-- 2) The private "files" bucket is created by scripts/setup-db.mjs through the Storage API.
--    It has NO storage policies on purpose: browsers never talk to storage with their own
--    rights. The server checks ownership via user_files (above) and then hands out one-time
--    signed upload/download URLs.

-- The old single-user index table ("files") is no longer used. After you've run the
-- migration script and checked your files, you can drop it:
--   drop table if exists public.files;
