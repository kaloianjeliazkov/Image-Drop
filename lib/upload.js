'use client';

import { createClient } from './supabase/browser';
import { BUCKET, MAX_UPLOAD_BYTES } from './supabase/config';
import { thumbnailFromFile, thumbnailFromImage } from './thumbnail';

const formatMB = (bytes) => `${Math.round(bytes / 1e6)} MB`;

const postJSON = async (url, body) => {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    window.location.href = '/login';
    throw new Error('Your session expired. Please sign in again.');
  }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
};

// Upload a File/Blob straight from the browser to Supabase Storage (no Vercel body limits),
// then record it in the user's file list.
//
// `pathname` is the display path, e.g. "android/screenshot.png". The stored object gets a random
// key under the user's own prefix, so any file name works — spaces, Cyrillic, emoji.
export async function uploadFile(pathname, file) {
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new Error(`File is too large (max ${formatMB(MAX_UPLOAD_BYTES)})`);
  }

  const contentType = file.type || 'application/octet-stream';
  // Make the gallery preview first (images only; null if the browser can't decode it)
  const thumbKey = await uploadThumbnail(await thumbnailFromFile(file));
  const { key, token } = await postJSON('/api/upload-url', { filename: pathname, size: file.size });

  const { error } = await createClient()
    .storage.from(BUCKET)
    .uploadToSignedUrl(key, token, file, { contentType, cacheControl: '31536000' });
  if (error) {
    const msg = /exceeded|too large|413/i.test(error.message)
      ? `File is too large (max ${formatMB(MAX_UPLOAD_BYTES)})`
      : error.message;
    throw new Error(msg);
  }

  const { file: saved } = await postJSON('/api/files', { key, thumbKey, pathname, size: file.size, contentType });
  return saved;
}

// Uploads a thumbnail blob and returns its storage key, or null. Never throws: a missing
// thumbnail only means the gallery shows the full image instead.
async function uploadThumbnail(blob) {
  if (!blob) return null;
  try {
    const { key, token } = await postJSON('/api/upload-url', { thumb: true, size: blob.size });
    const { error } = await createClient()
      .storage.from(BUCKET)
      .uploadToSignedUrl(key, token, blob, { contentType: 'image/jpeg', cacheControl: '31536000' });
    return error ? null : key;
  } catch {
    return null;
  }
}

// One-time backfill for images uploaded before thumbnails existed: makes a preview from the
// <img> the gallery just loaded and attaches it to the file. Runs one at a time.
let backfillQueue = Promise.resolve();
const backfillStarted = new Set();
export function backfillThumbnail(file, img) {
  if (!file?.url || file.thumbUrl || backfillStarted.has(file.url)) return;
  backfillStarted.add(file.url);
  backfillQueue = backfillQueue.then(async () => {
    const thumbKey = await uploadThumbnail(await thumbnailFromImage(img));
    if (!thumbKey) return;
    await fetch('/api/files', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: file.url, thumbKey }),
    }).catch(() => {});
  });
}
