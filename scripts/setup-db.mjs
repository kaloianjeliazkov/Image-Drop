// Runs before `next build` (see package.json). Uses the Supabase variables that Vercel's
// Supabase integration already put on the project, so nothing has to be copied by hand:
//   1. applies supabase/setup.sql (table + row-level security), idempotently
//   2. makes sure the private "files" storage bucket exists with the right size limit
//   3. if MIGRATE_BLOB_TO_EMAIL is set, copies the old Vercel Blob files into that account
//
// Without database credentials (e.g. a local `npm run build`) it just skips.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { createClient } from '@supabase/supabase-js';

const BUCKET = 'files';
const MAX_UPLOAD_MB = Number(process.env.NEXT_PUBLIC_MAX_UPLOAD_MB || 50);

const dbUrls = [process.env.POSTGRES_URL_NON_POOLING, process.env.POSTGRES_URL].filter(Boolean);
const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;

if (!dbUrls.length || !supabaseUrl || !serviceKey) {
  console.log('[setup-db] No Supabase credentials in this environment — skipping database setup.');
  process.exit(0);
}

// 1) Schema
const sqlPath = fileURLToPath(new URL('../supabase/setup.sql', import.meta.url));
const sql = await readFile(sqlPath, 'utf8');

// Supabase presents a certificate Node can't verify against its default CA store; the
// connection is still encrypted. Strip sslmode so pg uses the ssl option below.
const toConfig = (url) => ({
  connectionString: url.replace(/([?&])sslmode=[^&]*&?/, '$1').replace(/[?&]$/, ''),
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 15000,
});

// Try the direct connection first, then the pooled one (the direct host can be IPv6-only).
let lastError;
let applied = false;
for (const url of dbUrls) {
  const client = new pg.Client(toConfig(url));
  try {
    await client.connect();
    await client.query(sql);
    applied = true;
    console.log('[setup-db] Database schema is up to date.');
    break;
  } catch (err) {
    lastError = err;
    console.warn(`[setup-db] Database connection attempt failed: ${err.message}`);
  } finally {
    await client.end().catch(() => {});
  }
}
if (!applied) throw lastError;

// 2) Bucket
const supabase = createClient(supabaseUrl, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const bucketOptions = { public: false, fileSizeLimit: `${MAX_UPLOAD_MB}MB` };
const { data: bucket } = await supabase.storage.getBucket(BUCKET);
if (!bucket) {
  const { error } = await supabase.storage.createBucket(BUCKET, bucketOptions);
  if (error && !/already exists/i.test(error.message)) throw error;
  console.log(`[setup-db] Created private storage bucket "${BUCKET}".`);
} else {
  const { error } = await supabase.storage.updateBucket(BUCKET, bucketOptions);
  if (error) console.warn(`[setup-db] Could not update bucket settings: ${error.message}`);
  else console.log(`[setup-db] Storage bucket "${BUCKET}" is ready.`);
}

// 3) Optional one-time migration from Vercel Blob
const ownerEmail = process.env.MIGRATE_BLOB_TO_EMAIL;
if (ownerEmail && process.env.BLOB_READ_WRITE_TOKEN) {
  const { migrateBlobToSupabase } = await import('./migrate-blob-to-supabase.mjs');
  try {
    await migrateBlobToSupabase({ ownerEmail, supabase });
  } catch (err) {
    // Never fail a deploy because of the migration; the log says what happened.
    console.warn(`[migrate] Stopped: ${err.message}`);
  }
}
