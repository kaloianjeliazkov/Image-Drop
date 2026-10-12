import { list, put } from '@vercel/blob';

// Server-side registry of known upload folders, stored as a small meta blob.
// This makes folder tabs visible on every device and launch method (iOS home
// screen bookmarks, Android shortcuts, desktop), instead of relying on
// per-device localStorage which Safari may not have or may evict.
const REGISTRY_PATH = '_meta/folders.json';

export const sanitizeFolderName = (name) => {
  // Keep it filesystem/URL-safe and prevent collisions with the _meta/ namespace
  const clean = (name || '')
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .replace(/^_+/, '')
    .substring(0, 50);
  return clean || 'general';
};

export async function readFolderRegistry() {
  try {
    const { blobs } = await list({ prefix: REGISTRY_PATH });
    const blob = blobs.find(b => b.pathname === REGISTRY_PATH);
    if (!blob) return [];
    const res = await fetch(blob.url, { cache: 'no-store' });
    if (!res.ok) return [];
    const parsed = await res.json();
    return Array.isArray(parsed.folders) ? parsed.folders : [];
  } catch (err) {
    // Missing blob or restricted environment -> treat as empty registry
    return [];
  }
}

export async function writeFolderRegistry(folders) {
  try {
    const unique = Array.from(new Set(folders.filter(Boolean)));
    await put(REGISTRY_PATH, JSON.stringify({ folders: unique }), {
      access: 'public',
      contentType: 'application/json',
      addRandomSuffix: false,
      cacheControlMaxAge: 0,
    });
    return unique;
  } catch (err) {
    console.error('Failed to save folder registry:', err);
    return folders;
  }
}

export async function addFoldersToRegistry(names) {
  const existing = await readFolderRegistry();
  const missing = names.filter((n) => n && !existing.includes(n));
  if (missing.length === 0) return existing;
  return writeFolderRegistry([...existing, ...missing]);
}
