# Supabase file index

Koldrop stores file **bytes** in Vercel Blob and keeps the **file list** in Supabase
Postgres. That is deliberate: Vercel Blob counts `list()` (and `put()`) as *Advanced
Operations*, and the Hobby plan only includes 2,000 of those per month, while Supabase
Postgres queries are effectively free at this scale.

`del()` is free in Blob, and uploads still cost one `put` each — nothing can remove that
without moving the bytes too. What this removes is the `list()` call that ran on every
page load, every refresh, and after every upload/delete.

If the two environment variables below are **not** set, the app falls back to listing
Vercel Blob directly, so this feature is opt-in and cannot break a deployment.

## 1. Create the table

In your Supabase project, open **SQL Editor** and run:

```sql
create table if not exists public.files (
  pathname     text primary key,
  url          text not null,
  download_url text,
  folder       text not null default 'general',
  name         text not null,
  size         bigint not null default 0,
  uploaded_at  timestamptz not null default now(),
  is_video     boolean not null default false
);

create index if not exists files_folder_idx on public.files (folder);
create index if not exists files_uploaded_at_idx on public.files (uploaded_at desc);

alter table public.files enable row level security;
-- No policies on purpose: only the service role key (used server-side) can reach this table.
```

## 2. Set the environment variables

Grab the **Project URL** and the **service_role** key from
*Project Settings → API*. (Use the `service_role` secret, not the anon key — all access
happens on the server.)

In the Vercel project (**Settings → Environment Variables**, project `image-drop-8gfc`):

```
SUPABASE_URL=https://YOUR-PROJECT-ref.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
```

For local development, copy `.env.local.example` to `.env.local` and fill it in.
`.env.local` is gitignored — never commit the service role key.

Then redeploy (or run `npm run dev` locally).

## 3. What happens on first load

The first time the file list is requested, the index is empty, so the app does a single
`list()` against Vercel Blob and imports everything it finds into the `files` table
(including files uploaded before the index existed). After that, the list comes straight
from Postgres and no `list()` calls happen.

## 4. Notes

- Uploads are indexed from the client right after a successful upload
  (`POST /api/files`), so no Blob webhook is required.
- Deleting files removes the rows with the blobs; `del()` is free in Blob.
- The previous "delete files older than 7 days" behaviour was removed at the owner's
  request — files now stay until deleted.
