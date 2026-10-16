// Server-only file storage. New files go to Cloudflare R2 when it's configured (free downloads,
// 10 GB free); files stored earlier in Supabase Storage keep working until they're deleted.
//
// Storage keys say where the object lives: "r2:<user id>/<uuid>.jpg" is in R2, a key without
// a prefix ("<user id>/<uuid>.jpg") is in Supabase Storage.
//
// R2 env vars (Vercel → Settings → Environment Variables):
//   R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET (default "koldrop-files")
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { getAdmin } from './supabase/admin';
import { BUCKET as SUPABASE_BUCKET } from './supabase/config';

const R2_PREFIX = 'r2:';
const R2_BUCKET = () => process.env.R2_BUCKET || 'koldrop-files';

export const r2Enabled = () =>
  Boolean(process.env.R2_ACCOUNT_ID && process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY);

let r2 = null;
const r2Client = () => {
  if (!r2) {
    r2 = new S3Client({
      region: 'auto',
      forcePathStyle: true,
      // Browsers upload with a plain PUT, so don't make the SDK demand checksums R2/browsers won't send
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
      endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
      },
    });
  }
  return r2;
};

const isR2 = (key) => String(key).startsWith(R2_PREFIX);
const bare = (key) => (isR2(key) ? String(key).slice(R2_PREFIX.length) : String(key));

// "<user id>/..." regardless of where it's stored — used for ownership checks
export const objectPath = bare;

// Where a new object should go. Returns the full storage key (with prefix when in R2).
export const newKey = (path) => (r2Enabled() ? `${R2_PREFIX}${path}` : path);

// One-time upload target for the browser.
//   R2:       { key, method: 'PUT', url, headers }
//   Supabase: { key, token }  (browser uses supabase.storage.uploadToSignedUrl)
export async function signUpload(key, contentType = 'application/octet-stream') {
  if (isR2(key)) {
    const url = await getSignedUrl(
      r2Client(),
      new PutObjectCommand({ Bucket: R2_BUCKET(), Key: bare(key), ContentType: contentType, CacheControl: 'private, max-age=31536000' }),
      { expiresIn: 15 * 60 }
    );
    return { key, method: 'PUT', url, headers: { 'Content-Type': contentType } };
  }
  const { data, error } = await getAdmin().storage.from(SUPABASE_BUCKET).createSignedUploadUrl(key);
  if (error) throw error;
  return { key, token: data.token };
}

// Short-lived URL to view (or, with downloadName, download) an object.
export async function signDownload(key, seconds, downloadName) {
  if (isR2(key)) {
    return getSignedUrl(
      r2Client(),
      new GetObjectCommand({
        Bucket: R2_BUCKET(),
        Key: bare(key),
        ...(downloadName
          ? { ResponseContentDisposition: `attachment; filename*=UTF-8''${encodeURIComponent(downloadName)}` }
          : {}),
      }),
      { expiresIn: seconds }
    );
  }
  const { data, error } = await getAdmin()
    .storage.from(SUPABASE_BUCKET)
    .createSignedUrl(key, seconds, downloadName ? { download: downloadName } : undefined);
  if (error || !data?.signedUrl) throw error || new Error('Could not sign URL');
  return data.signedUrl;
}

// Real stored size in bytes, or null if the object doesn't exist.
export async function objectSize(key) {
  try {
    if (isR2(key)) {
      const head = await r2Client().send(new HeadObjectCommand({ Bucket: R2_BUCKET(), Key: bare(key) }));
      return Number(head.ContentLength);
    }
    const { data } = await getAdmin().storage.from(SUPABASE_BUCKET).info(key);
    return data ? Number(data.size) : null;
  } catch {
    return null;
  }
}

export async function removeObjects(keys) {
  const list = (keys || []).filter(Boolean);
  const r2Keys = list.filter(isR2).map(bare);
  const sbKeys = list.filter((k) => !isR2(k));
  for (let i = 0; i < r2Keys.length; i += 1000) {
    await r2Client().send(new DeleteObjectsCommand({
      Bucket: R2_BUCKET(),
      Delete: { Objects: r2Keys.slice(i, i + 1000).map((Key) => ({ Key })), Quiet: true },
    }));
  }
  for (let i = 0; i < sbKeys.length; i += 1000) {
    const { error } = await getAdmin().storage.from(SUPABASE_BUCKET).remove(sbKeys.slice(i, i + 1000));
    if (error) console.error('Supabase storage remove failed:', error.message);
  }
}

// Delete every object everywhere (weekly wipe). Returns how many R2 objects were removed.
export async function emptyAllStorage() {
  let removed = 0;
  if (r2Enabled()) {
    let token;
    do {
      const page = await r2Client().send(new ListObjectsV2Command({ Bucket: R2_BUCKET(), ContinuationToken: token }));
      const objects = (page.Contents || []).map((o) => ({ Key: o.Key }));
      if (objects.length) {
        await r2Client().send(new DeleteObjectsCommand({ Bucket: R2_BUCKET(), Delete: { Objects: objects, Quiet: true } }));
        removed += objects.length;
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
  }
  const { error } = await getAdmin().storage.emptyBucket(SUPABASE_BUCKET);
  if (error && !/not found/i.test(error.message)) throw error;
  return removed;
}
