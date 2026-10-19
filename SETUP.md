# Koldrop setup — accounts + Supabase Storage

Koldrop now has real accounts. Anyone can sign up with email + password or Google, and each
person only ever sees their own files. Files live in a private Supabase Storage bucket instead
of Vercel Blob, so there are no more Blob "advanced operation" limits.

**Free-plan limits to know about (Supabase):** 1 GB of files in total across all users, and
50 MB per file. Longer screen recordings over 50 MB will be rejected with a clear message. If
you outgrow that, the Pro plan raises both; bump `NEXT_PUBLIC_MAX_UPLOAD_MB` and the bucket's
file size limit to match.

---

## 1. Database and storage (automatic)

Your Vercel project gets its Supabase variables from Vercel's Supabase integration, so there is
nothing to copy. Every build runs `scripts/setup-db.mjs` first, which applies
[`supabase/setup.sql`](supabase/setup.sql) (the `user_files` table and its row-level security)
and creates the private `files` bucket. Look for `[setup-db]` lines in the Vercel build log.

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

Already set by the Supabase integration: `NEXT_PUBLIC_SUPABASE_URL`,
`NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` and the `POSTGRES_*` URLs.
The service-role key is only used on the server, for storage, after the app has checked that the
file belongs to the signed-in user.

## 5. Move your old files into your account

1. Open the deployed app and **create your account**.
2. In Vercel, add the env var `MIGRATE_BLOB_TO_EMAIL=<that email>` and redeploy.
   The build copies every Blob file into your account (folders, names and dates kept) and the
   build log lists anything it couldn't copy, e.g. files over 50 MB. Safe to run again.
3. Remove `MIGRATE_BLOB_TO_EMAIL`, check your files, then you can delete the Blob store and drop
   the old table with `drop table if exists public.files;`.

(You can also run `scripts/migrate-blob-to-supabase.mjs` locally — see the comment at its top.)

## Local development

```
cp .env.local.example .env.local   # fill in the two values
npm install
npm run dev
```

## How it works

- **Sign-in:** Supabase Auth with cookie sessions (`@supabase/ssr`). `middleware.js` refreshes
  the session and sends signed-out visitors to `/login`.
- **Uploads:** `POST /api/upload-url` gives the browser a one-time signed upload URL for
  `<user id>/<random id>.<ext>`; the bytes go straight to Supabase (no Vercel 4.5 MB body limit),
  then `POST /api/files` records the folder and name.
- **Viewing/downloading:** each file has a stable link `/api/f/<id>` that checks it's yours and
  redirects to a 1-hour signed URL. The bucket itself is private.
- **Isolation:** row-level security on `user_files` means a user can only see or delete their own
  rows; the bucket is private with no storage policies, so the only way in is a signed URL the
  server hands out after that check.

## Email (Gmail SMTP)

Login/sign-up emails and bug-report emails are sent through a Gmail app password.

- **Supabase** → Authentication → Emails → SMTP Settings: host `smtp.gmail.com`, port `465`,
  username/sender = the Gmail address, password = the app password, sender name `Koldrop`.
- **Vercel** env vars (Production): `SMTP_USER` (the Gmail address) and `SMTP_PASS` (app password,
  Sensitive). Optional `FEEDBACK_TO` changes who receives bug reports (default the owner).
  Reports are also kept in the `feedback` table and shown in Settings → Reports for admins.
