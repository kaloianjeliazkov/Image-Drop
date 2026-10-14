'use client';

import { createClient } from './supabase/browser';
import { BUCKET, MAX_UPLOAD_BYTES } from './supabase/config';

const formatMB = (bytes) => `${Math.round(bytes / (1024 * 1024))} MB`;

// Upload a File/Blob straight from the browser to Supabase Storage (no Vercel body limits),
// then record it in the user's file list.
//
// `pathname` is the display path, e.g. "android/screenshot.png". The object in storage gets a
// random key under the user's own prefix ("<user id>/<uuid>.png"), so any file name works —
// spaces, Cyrillic, emoji — and nobody can guess another user's paths.
export async function uploadFile(pathname, file) {
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new Error(`File is too large (max ${formatMB(MAX_UPLOAD_BYTES)})`);
  }

  const supabase = createClient();
  const { data: auth } = await supabase.auth.getUser();
  const userId = auth?.user?.id;
  if (!userId) {
    window.location.href = '/login';
    throw new Error('Your session expired. Please sign in again.');
  }

  const dot = pathname.lastIndexOf('.');
  const ext = dot > pathname.lastIndexOf('/') ? pathname.slice(dot).toLowerCase().replace(/[^a-z0-9.]/g, '') : '';
  const key = `${userId}/${crypto.randomUUID()}${ext}`;
  const contentType = file.type || 'application/octet-stream';

  const { error } = await supabase.storage.from(BUCKET).upload(key, file, {
    contentType,
    upsert: false,
    cacheControl: '31536000',
  });
  if (error) {
    const msg = /exceeded|too large|413/i.test(error.message)
      ? `File is too large (max ${formatMB(MAX_UPLOAD_BYTES)})`
      : error.message;
    throw new Error(msg);
  }

  const res = await fetch('/api/files', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key, pathname, size: file.size, contentType }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || 'Could not save the file');
  return body.file;
}
