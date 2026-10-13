import { list, del } from '@vercel/blob';
import { NextResponse } from 'next/server';
import { supabaseAdmin, FILES_TABLE } from '../../../lib/supabase';

export const dynamic = 'force-dynamic';

// Short in-memory cache so duplicate requests don't hit Supabase repeatedly
let cachedFiles = null;
let lastCacheTime = 0;
const CACHE_TTL_MS = 20 * 1000;

// "android/image.jpg" -> { folder: "android", name: "image.jpg" }
const parsePathname = (pathname) => {
  const parts = String(pathname).split('/');
  return {
    folder: parts.length > 1 ? parts[0] : 'general',
    name: parts.length > 1 ? parts.slice(1).join('/') : parts[0],
  };
};

const isVideoPath = (pathname) => /\.(mp4|mov|webm|mkv)$/i.test(pathname);

const rowToFile = (row) => ({
  url: row.url,
  downloadUrl: row.download_url,
  pathname: row.pathname,
  folder: row.folder,
  name: row.name,
  size: row.size,
  uploadedAt: row.uploaded_at,
  isVideo: row.is_video,
});

// List Vercel Blob directly — used as a fallback and for the one-time index import
const listBlobFiles = async () => {
  const { blobs } = await list();
  return blobs.map((blob) => {
    const { folder, name } = parsePathname(blob.pathname);
    return {
      url: blob.url,
      downloadUrl: blob.downloadUrl,
      pathname: blob.pathname,
      folder,
      name,
      size: blob.size,
      uploadedAt: blob.uploadedAt,
      isVideo: isVideoPath(blob.pathname),
    };
  });
};

// Import files that were uploaded before the index existed (runs only while the table is empty)
const seedIndexFromBlob = async () => {
  const { blobs } = await list();
  if (!blobs.length) return 0;
  const rows = blobs.map((blob) => {
    const { folder, name } = parsePathname(blob.pathname);
    return {
      pathname: blob.pathname,
      url: blob.url,
      download_url: blob.downloadUrl ?? null,
      folder,
      name,
      size: blob.size ?? 0,
      uploaded_at: blob.uploadedAt ?? new Date().toISOString(),
      is_video: isVideoPath(blob.pathname),
    };
  });
  const { error } = await supabaseAdmin.from(FILES_TABLE).upsert(rows, { onConflict: 'pathname' });
  if (error) throw error;
  return rows.length;
};

export async function GET(request) {
  try {
    const url = new URL(request.url);
    const forceFresh = url.searchParams.get('fresh') === '1';
    const now = Date.now();

    if (!forceFresh && cachedFiles && now - lastCacheTime < CACHE_TTL_MS) {
      return NextResponse.json({ files: cachedFiles });
    }

    // No Supabase configured: keep the old behaviour exactly (read straight from Blob)
    if (!supabaseAdmin) {
      const files = await listBlobFiles();
      cachedFiles = files;
      lastCacheTime = now;
      return NextResponse.json({ files });
    }

    // First run for this store: pull the existing blobs into the index once
    const { count, error: countError } = await supabaseAdmin
      .from(FILES_TABLE)
      .select('pathname', { count: 'exact', head: true });
    if (countError) throw countError;
    if (!count) await seedIndexFromBlob();

    const { data, error } = await supabaseAdmin
      .from(FILES_TABLE)
      .select('*')
      .order('uploaded_at', { ascending: false });
    if (error) throw error;

    const files = (data || []).map(rowToFile);
    cachedFiles = files;
    lastCacheTime = now;
    return NextResponse.json({ files });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

// Index a freshly uploaded blob. The client calls this right after a successful upload.
export async function POST(request) {
  try {
    if (!supabaseAdmin) return NextResponse.json({ skipped: true });
    const { pathname, url, downloadUrl, size } = await request.json();
    if (!pathname || !url) {
      return NextResponse.json({ error: 'pathname and url are required' }, { status: 400 });
    }
    const { folder, name } = parsePathname(pathname);
    const { error } = await supabaseAdmin.from(FILES_TABLE).upsert({
      pathname,
      url,
      download_url: downloadUrl ?? null,
      folder,
      name,
      size: Number(size) || 0,
      uploaded_at: new Date().toISOString(),
      is_video: isVideoPath(pathname),
    }, { onConflict: 'pathname' });
    if (error) throw error;
    cachedFiles = null;
    lastCacheTime = 0;
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function DELETE(request) {
  try {
    const { url, urls } = await request.json();
    const urlList = urls && Array.isArray(urls) ? urls : url ? [url] : [];
    if (!urlList.length) return NextResponse.json({ success: true });

    await del(urlList); // deleting blobs is free, so this no longer costs advanced operations

    if (supabaseAdmin) {
      const { error } = await supabaseAdmin.from(FILES_TABLE).delete().in('url', urlList);
      if (error) throw error;
    }

    cachedFiles = null;
    lastCacheTime = 0;
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
