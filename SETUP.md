# Koldrop setup — accounts + Supabase Storage

Koldrop now has real accounts. Anyone can sign up with email + password or Google, and each
person only ever sees their own files. Files live in a private Supabase Storage bucket instead
of Vercel Blob, so there are no more Blob "advanced operation" limits.

**Free-plan limits to know about (Supabase):** 1 GB of files in total across all users, and
50 MB per file. Longer screen recordings over 50 MB will be rejected with a clear message. If
you outgrow that, the Pro plan raises both; bump `NEXT_PUBLIC_MAX_UPLOAD_MB` and the bucket's
file size limit to match.

---

## 1. Create the table, bucket and security rules

Supabase → **SQL Editor** → paste all of [`supabase/setup.sql`](supabase/setup.sql) → **Run**.

That creates the `user_files` table, the private `files` bucket, and rules so each user can only
read, upload and delete under their own folder.

## 2. Tell Supabase where the app lives

Supabase → **Authentication → URL Configuration**:

- **Site URL:** `https://YOUR-APP.vercel.app` (your production domain)
- **Redirect URLs** — add:
  - `https://YOUR-APP.vercel.app/auth/callback`
  - `http://localhost:3000/auth/callback` (for local dev)
  - optional, for preview deploys: `https://*-YOUR-VERCEL-TEAM.vercel.app/auth/callback`

Supabase → **Authentication → Sign In / Providers → Email**: leave **Confirm email** on if you
want people to verify their address (recommended for a public app), or turn it off so new
accounts work instantly.

> Supabase's built-in email sender only sends a few emails per hour. If you expect real sign-up
> traffic, add your own SMTP (e.g. Resend) under **Authentication → Emails → SMTP Settings**.

## 3. Turn on Google sign-in

1. Google Cloud Console → **APIs & Services → Credentials → Create credentials → OAuth client ID**
   (set up the consent screen first if asked; "External", app name "Koldrop").
2. Application type **Web application**.
3. **Authorized JavaScript origins:** `https://YOUR-APP.vercel.app` (and `http://localhost:3000`).
4. **Authorized redirect URIs:** the callback URL Supabase shows you in
   **Authentication → Sign In / Providers → Google** — it looks like
   `https://YOUR-PROJECT-ref.supabase.co/auth/v1/callback`.
5. Copy the Client ID and Client Secret into that Google provider page in Supabase and enable it.

## 4. Vercel environment variables

Vercel → project → **Settings → Environment Variables** (Production, Preview, Development):

```
NEXT_PUBLIC_SUPABASE_URL=https://YOUR-PROJECT-ref.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-or-publishable-key
```

Both are in Supabase → **Project Settings → API keys**. Use the **anon / publishable** key here,
never the service-role / secret key.

You can delete these old variables — nothing reads them any more:
`APP_USERNAME`, `APP_PASSWORD`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`.
Keep `BLOB_READ_WRITE_TOKEN` until the migration below is done.

Redeploy.

## 5. Move your old files into your account

1. Open the deployed app and **create your account** (same email you'll use below).
2. On your computer, in the project folder, run `npm install`, then create `.env.migrate`:

   ```
   BLOB_READ_WRITE_TOKEN=...        # Vercel → Storage → your Blob store → .env.local tab
   SUPABASE_URL=https://YOUR-PROJECT-ref.supabase.co
   SUPABASE_SERVICE_ROLE_KEY=...    # Supabase → Project Settings → API keys → secret / service_role
   OWNER_EMAIL=you@example.com
   ```

   (`.env.migrate` is gitignored — never commit the service-role key.)

3. Run:

   ```
   node --env-file=.env.migrate scripts/migrate-blob-to-supabase.mjs
   ```

   It copies every Blob file into your account, keeps folder names, file names and upload dates,
   and lists anything it couldn't copy (e.g. files over 50 MB). It's safe to run again.

4. Check your files in the app. Then you can disconnect/delete the Blob store in Vercel, remove
   `BLOB_READ_WRITE_TOKEN`, and drop the old table in Supabase with
   `drop table if exists public.files;`.

## Local development

```
cp .env.local.example .env.local   # fill in the two values
npm install
npm run dev
```

## How it works

- **Sign-in:** Supabase Auth with cookie sessions (`@supabase/ssr`). `middleware.js` refreshes
  the session and sends signed-out visitors to `/login`.
- **Uploads:** the browser uploads straight to Supabase Storage under `<user id>/<random id>.<ext>`
  (no Vercel 4.5 MB body limit), then `POST /api/files` records the folder and name.
- **Viewing/downloading:** each file has a stable link `/api/f/<id>` that checks it's yours and
  redirects to a 1-hour signed URL. The bucket itself is private.
- **Isolation:** row-level security on `user_files` and on storage objects — even with the public
  anon key, a user can only reach their own rows and objects.
