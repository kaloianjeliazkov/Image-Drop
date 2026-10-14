// One-time copy of everything in Vercel Blob into one Koldrop account on Supabase.
//
// Easiest way: set the Vercel env var MIGRATE_BLOB_TO_EMAIL=<your account email> and redeploy.
// The build (scripts/setup-db.mjs) runs this with the credentials Vercel already has, and the
// build log lists what was copied. Remove the variable afterwards.
//
// Or run it locally with a .env.migrate file containing BLOB_READ_WRITE_TOKEN, SUPABASE_URL,
// SUPABASE_SERVICE_ROLE_KEY and OWNER_EMAIL:
//   node --env-file=.env.migrate scripts/migrate-blob-to-supabase.mjs
//
// Safe to re-run: files already in the account (same folder + name) are skipped.
// Nothing is deleted from Vercel Blob.

import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { list } from '@vercel/blob';
import { createClient } from '@supabase/supabase-js';

const BUCKET = 'files';
const TABLE = 'user_files';

const splitPath = (pathname) => {
  const i = pathname.indexOf('/');
  return i > 0
    ? { folder: pathname.slice(0, i), name: pathname.slice(i + 1) }
    : { folder: 'general', name: pathname };
};

const isVideo = (name) => /\.(mp4|mov|webm|mkv|m4v)$/i.test(name);

async function findUserId(supabase, email) {
  const wanted = email.trim().toLowerCase();
  for (let page = 1; ; page++) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw error;
    const hit = data.users.find((u) => (u.email || '').toLowerCase() === wanted);
    if (hit) return hit.id;
    if (data.users.length < 1000) return null;
  }
}

async function listAllBlobs(token) {
  const all = [];
  let cursor;
  do {
    const res = await list({ cursor, limit: 1000, token });
    all.push(...res.blobs);
    cursor = res.hasMore ? res.cursor : undefined;
  } while (cursor);
  return all;
}

export async function migrateBlobToSupabase({
  ownerEmail,
  supabase,
  blobToken = process.env.BLOB_READ_WRITE_TOKEN,
  maxBytes = Number(process.env.NEXT_PUBLIC_MAX_UPLOAD_MB || 50) * 1000 * 1000,
  log = (msg) => console.log(`[migrate] ${msg}`),
}) {
  const userId = await findUserId(supabase, ownerEmail);
  if (!userId) throw new Error(`No account for ${ownerEmail} yet — sign up in the app first.`);

  const { data: existingRows, error: existingError } = await supabase
    .from(TABLE)
    .select('folder, name')
    .eq('user_id', userId);
  if (existingError) throw existingError;
  const existing = new Set(existingRows.map((r) => `${r.folder}/${r.name}`.toLowerCase()));

  const blobs = await listAllBlobs(blobToken);
  log(`Found ${blobs.length} file(s) in Vercel Blob. Copying to ${ownerEmail}…`);

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
    if (blob.size > maxBytes) {
      failed.push(`${label} (${Math.round(blob.size / 1e6)} MB — over the ${Math.round(maxBytes / 1e6)} MB limit)`);
      continue;
    }

    try {
      const res = await fetch(blob.url);
      if (!res.ok) throw new Error(`download HTTP ${res.status}`);
      const body = await res.arrayBuffer();
      const contentType = res.headers.get('content-type') || 'application/octet-stream';

      const dot = name.lastIndexOf('.');
      const ext = dot >= 0 ? name.slice(dot).toLowerCase().replace(/[^a-z0-9.]/g, '').slice(0, 10) : '';
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
      log(`  ✓ ${label}`);
    } catch (err) {
      failed.push(`${label} (${err.message})`);
      log(`  ✗ ${label}: ${err.message}`);
    }
  }

  log(`Done. Copied ${copied}, already there ${skipped}, failed ${failed.length}.`);
  failed.forEach((f) => log(`  not copied: ${f}`));
  return { copied, skipped, failed };
}

// CLI entry point
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
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
  const { failed } = await migrateBlobToSupabase({ ownerEmail: OWNER_EMAIL, supabase });
  if (failed.length) process.exitCode = 1;
}
