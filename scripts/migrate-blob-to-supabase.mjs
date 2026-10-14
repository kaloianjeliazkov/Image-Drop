// One-time copy of everything in Vercel Blob into one Koldrop account on Supabase.
//
// 1. Sign up in the new app first (so your account exists).
// 2. Create a file called .env.migrate in the project folder with:
//      BLOB_READ_WRITE_TOKEN=...        (Vercel → Storage → your Blob store → .env.local tab)
//      SUPABASE_URL=https://xxxx.supabase.co
//      SUPABASE_SERVICE_ROLE_KEY=...    (Supabase → Project Settings → API keys → secret/service_role)
//      OWNER_EMAIL=you@example.com      (the account the files should belong to)
// 3. Run:  node --env-file=.env.migrate scripts/migrate-blob-to-supabase.mjs
//
// Safe to re-run: files already in the account (same folder + name) are skipped.
// Nothing is deleted from Vercel Blob — remove the Blob store yourself once you've checked.

import { randomUUID } from 'node:crypto';
import { list } from '@vercel/blob';
import { createClient } from '@supabase/supabase-js';

const BUCKET = 'files';
const TABLE = 'user_files';
const MAX_BYTES = Number(process.env.MAX_UPLOAD_MB || 50) * 1024 * 1024;

const { BLOB_READ_WRITE_TOKEN, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, OWNER_EMAIL } = process.env;
for (const [k, v] of Object.entries({ BLOB_READ_WRITE_TOKEN, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, OWNER_EMAIL })) {
  if (!v) {
    console.error(`Missing ${k} — see the comment at the top of this script.`);
    process.exit(1);
  }
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function findUserId(email) {
  const wanted = email.trim().toLowerCase();
  for (let page = 1; ; page++) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw error;
    const hit = data.users.find((u) => (u.email || '').toLowerCase() === wanted);
    if (hit) return hit.id;
    if (data.users.length < 1000) return null;
  }
}

async function listAllBlobs() {
  const all = [];
  let cursor;
  do {
    const res = await list({ cursor, limit: 1000, token: BLOB_READ_WRITE_TOKEN });
    all.push(...res.blobs);
    cursor = res.hasMore ? res.cursor : undefined;
  } while (cursor);
  return all;
}

const splitPath = (pathname) => {
  const i = pathname.indexOf('/');
  return i > 0
    ? { folder: pathname.slice(0, i), name: pathname.slice(i + 1) }
    : { folder: 'general', name: pathname };
};

const isVideo = (name) => /\.(mp4|mov|webm|mkv|m4v)$/i.test(name);

const userId = await findUserId(OWNER_EMAIL);
if (!userId) {
  console.error(`No Supabase account for ${OWNER_EMAIL}. Sign up in the app first, then re-run.`);
  process.exit(1);
}

const { data: existingRows, error: existingError } = await supabase
  .from(TABLE)
  .select('folder, name')
  .eq('user_id', userId);
if (existingError) {
  console.error('Could not read user_files — did you run supabase/setup.sql?', existingError.message);
  process.exit(1);
}
const existing = new Set(existingRows.map((r) => `${r.folder}/${r.name}`.toLowerCase()));

const blobs = await listAllBlobs();
console.log(`Found ${blobs.length} file(s) in Vercel Blob. Copying to ${OWNER_EMAIL}…`);

let copied = 0;
let skipped = 0;
const failed = [];

for (const blob of blobs) {
  const { folder, name } = splitPath(blob.pathname);
  const label = `${folder}/${name}`;

  if (existing.has(label.toLowerCase())) {
    skipped++;
    continue;
  }
  if (blob.size > MAX_BYTES) {
    failed.push(`${label} (${Math.round(blob.size / 1048576)} MB — over the ${Math.round(MAX_BYTES / 1048576)} MB limit)`);
    continue;
  }

  try {
    const res = await fetch(blob.url);
    if (!res.ok) throw new Error(`download HTTP ${res.status}`);
    const body = await res.arrayBuffer();
    const contentType = res.headers.get('content-type') || 'application/octet-stream';

    const dot = name.lastIndexOf('.');
    const ext = dot >= 0 ? name.slice(dot).toLowerCase().replace(/[^a-z0-9.]/g, '') : '';
    const key = `${userId}/${randomUUID()}${ext}`;

    const { error: upErr } = await supabase.storage
      .from(BUCKET)
      .upload(key, body, { contentType, upsert: false, cacheControl: '31536000' });
    if (upErr) throw upErr;

    const { error: rowErr } = await supabase.from(TABLE).insert({
      user_id: userId,
      storage_key: key,
      folder,
      name,
      size: blob.size ?? body.byteLength,
      content_type: contentType,
      is_video: isVideo(name),
      uploaded_at: blob.uploadedAt ? new Date(blob.uploadedAt).toISOString() : new Date().toISOString(),
    });
    if (rowErr) {
      await supabase.storage.from(BUCKET).remove([key]);
      throw rowErr;
    }

    existing.add(label.toLowerCase());
    copied++;
    console.log(`  ✓ ${label}`);
  } catch (err) {
    failed.push(`${label} (${err.message})`);
    console.log(`  ✗ ${label}: ${err.message}`);
  }
}

console.log(`\nDone. Copied ${copied}, already there ${skipped}, failed ${failed.length}.`);
if (failed.length) {
  console.log('Not copied:');
  failed.forEach((f) => console.log(`  - ${f}`));
  process.exitCode = 1;
}
