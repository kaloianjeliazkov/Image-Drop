-- Koldrop: per-user files on Supabase Storage.
-- Run this once in Supabase → SQL Editor. It is safe to run again.

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

-- 2) The private storage bucket. 50 MB is the per-file maximum on Supabase's free plan.
insert into storage.buckets (id, name, public, file_size_limit)
values ('files', 'files', false, 52428800)
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit;

-- 3) Storage rules: each user can only touch objects under their own "<user id>/" prefix.
drop policy if exists "Users read own objects"   on storage.objects;
drop policy if exists "Users upload own objects" on storage.objects;
drop policy if exists "Users delete own objects" on storage.objects;

create policy "Users read own objects" on storage.objects
  for select to authenticated
  using (bucket_id = 'files' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "Users upload own objects" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'files' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "Users delete own objects" on storage.objects
  for delete to authenticated
  using (bucket_id = 'files' and (storage.foldername(name))[1] = (select auth.uid())::text);

-- The old single-user index table ("files") is no longer used. After you've run the
-- migration script and checked your files, you can drop it:
--   drop table if exists public.files;
