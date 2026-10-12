import { list, del } from '@vercel/blob';
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// Cache the file list in-memory for 20 seconds to prevent wasting free operations on duplicate requests
let cachedFiles = null;
let lastCacheTime = 0;
const CACHE_TTL_MS = 20 * 1000; // 20s

export async function GET(request) {
  try {
    const url = new URL(request.url);
    const forceFresh = url.searchParams.get('fresh') === '1';
    const now = Date.now();

    if (!forceFresh && cachedFiles && (now - lastCacheTime < CACHE_TTL_MS)) {
      return NextResponse.json({ files: cachedFiles });
    }

    const { blobs } = await list();
    const activeBlobs = [];
    const expiredUrls = [];

    for (const blob of blobs) {
      const uploadedAt = new Date(blob.uploadedAt).getTime();
      if (now - uploadedAt > MAX_AGE_MS) {
        expiredUrls.push(blob.url);
      } else {
        // extract folder from pathname like "folder/filename.jpg"
        const parts = blob.pathname.split('/');
        const folder = parts.length > 1 ? parts[0] : 'general';
        const name = parts.length > 1 ? parts.slice(1).join('/') : parts[0];
        const isVideo = /\.(mp4|mov|webm|mkv)$/i.test(blob.pathname);

        activeBlobs.push({
          url: blob.url,
          downloadUrl: blob.downloadUrl,
          pathname: blob.pathname,
          folder,
          name,
          size: blob.size,
          uploadedAt: blob.uploadedAt,
          isVideo
        });
      }
    }

    // Auto-cleanup files older than 7 days in the background
    if (expiredUrls.length > 0) {
      del(expiredUrls).catch(err => console.error('Failed to cleanup old blobs:', err));
    }

    // Cache result
    cachedFiles = activeBlobs;
    lastCacheTime = now;

    return NextResponse.json({ files: activeBlobs });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function DELETE(request) {
  try {
    const { url, urls } = await request.json();
    if (urls && Array.isArray(urls)) {
      await del(urls);
    } else if (url) {
      await del(url);
    }
    // Invalidate cache immediately so UI shows deleted files immediately
    cachedFiles = null;
    lastCacheTime = 0;
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
