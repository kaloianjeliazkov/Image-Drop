import { list, del } from '@vercel/blob';
import { NextResponse } from 'next/server';
import { readFolderRegistry, writeFolderRegistry } from '../../../lib/folderRegistry';

export const dynamic = 'force-dynamic';

const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// Cache the file list in-memory for 20 seconds to prevent wasting free operations on duplicate requests
let cachedFiles = null;
let cachedFolders = [];
let lastCacheTime = 0;
const CACHE_TTL_MS = 20 * 1000; // 20s

// Internal meta blobs (the folder registry) must never show up as user files
const isMetaBlob = (pathname) => pathname.startsWith('_meta/');

export async function GET(request) {
  try {
    const url = new URL(request.url);
    const forceFresh = url.searchParams.get('fresh') === '1';
    const now = Date.now();

    if (!forceFresh && cachedFiles && (now - lastCacheTime < CACHE_TTL_MS)) {
      return NextResponse.json({ files: cachedFiles, folders: cachedFolders });
    }

    const { blobs } = await list();
    const activeBlobs = [];
    const expiredUrls = [];
    const folderMap = {};

    for (const blob of blobs) {
      if (isMetaBlob(blob.pathname)) continue;

      const uploadedAt = new Date(blob.uploadedAt).getTime();
      if (now - uploadedAt > MAX_AGE_MS) {
        expiredUrls.push(blob.url);
      } else {
        // extract folder from pathname like "folder/filename.jpg"
        const parts = blob.pathname.split('/');
        const folder = parts.length > 1 ? parts[0] : 'general';
        const name = parts.length > 1 ? parts.slice(1).join('/') : parts[0];
        const isVideo = /\.(mp4|mov|webm|mkv)$/i.test(blob.pathname);

        folderMap[folder] = (folderMap[folder] || 0) + 1;

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

    // Folders come from the server-side registry (shared by every device) merged
    // with folders that currently hold files. This keeps the ios/android folder
    // tabs visible when the page is opened from an iOS home screen bookmark,
    // where localStorage is empty or was evicted by Safari.
    const registryFolders = await readFolderRegistry();

    // Self-heal: learn any folder that still has files but is missing from the registry
    const missing = Object.keys(folderMap).filter(name => !registryFolders.includes(name));
    if (missing.length > 0) {
      await writeFolderRegistry([...registryFolders, ...missing]);
    }

    const folders = Array.from(new Set([...registryFolders, ...missing, ...Object.keys(folderMap)]))
      .map(name => ({ name, count: folderMap[name] || 0 }))
      .sort((a, b) => a.name.localeCompare(b.name));

    // Cache result
    cachedFiles = activeBlobs;
    cachedFolders = folders;
    lastCacheTime = now;

    return NextResponse.json({ files: activeBlobs, folders });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function DELETE(request) {
  try {
    const { url, urls, folder, all } = await request.json();

    // Wipe everything: all user files + reset the folder registry
    if (all) {
      const { blobs } = await list();
      const allUrls = blobs.filter(b => !isMetaBlob(b.pathname)).map(b => b.url);
      if (allUrls.length > 0) await del(allUrls);
      await writeFolderRegistry([]);
      cachedFiles = null;
      cachedFolders = [];
      lastCacheTime = 0;
      return NextResponse.json({ success: true });
    }

    // Delete an entire folder: every file inside + its registry entry
    if (folder) {
      const { blobs } = await list();
      const folderUrls = blobs
        .filter(b => !isMetaBlob(b.pathname) && b.pathname.split('/')[0] === folder)
        .map(b => b.url);
      if (folderUrls.length > 0) await del(folderUrls);

      const remaining = (await readFolderRegistry()).filter(name => name !== folder);
      await writeFolderRegistry(remaining);

      cachedFiles = null;
      cachedFolders = [];
      lastCacheTime = 0;
      return NextResponse.json({ success: true });
    }

    if (urls && Array.isArray(urls)) {
      await del(urls);
    } else if (url) {
      await del(url);
    }
    // Invalidate cache immediately so UI shows deleted files immediately
    cachedFiles = null;
    cachedFolders = [];
    lastCacheTime = 0;
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
