'use client';

import { createClient } from './supabase/browser';
import { BUCKET, MAX_UPLOAD_BYTES } from './supabase/config';

const formatMB = (bytes) => `${Math.round(bytes / (1024 * 1024))} MB`;

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

  const { file: saved } = await postJSON('/api/files', { key, pathname, size: file.size, contentType });
  return saved;
}
