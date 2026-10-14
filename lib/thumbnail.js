'use client';

// Small JPEG previews for the gallery grid, so opening a folder downloads ~30 KB per image
// instead of the full-size file.

const THUMB_MAX = 480; // longest side in px — sharp on a phone grid (2-3x density)
const THUMB_QUALITY = 0.72;

const drawToBlob = (source, width, height) => {
  const scale = Math.min(1, THUMB_MAX / Math.max(width, height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const ctx = canvas.getContext('2d');
  // White behind transparent PNGs, otherwise JPEG turns transparency black
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', THUMB_QUALITY));
};

// From a File/Blob the user is uploading. Returns null when the browser can't decode it
// (e.g. HEIC on some browsers) — the gallery then just falls back to the full image.
export async function thumbnailFromFile(file) {
  if (!file || !String(file.type).startsWith('image/')) return null;
  try {
    const bitmap = await createImageBitmap(file);
    try {
      return await drawToBlob(bitmap, bitmap.width, bitmap.height);
    } finally {
      bitmap.close?.();
    }
  } catch {
    return null;
  }
}

// From an <img> that's already loaded (used to backfill older files once).
// The image must have been loaded with crossOrigin="anonymous".
export async function thumbnailFromImage(img) {
  try {
    if (!img?.naturalWidth) return null;
    return await drawToBlob(img, img.naturalWidth, img.naturalHeight);
  } catch {
    return null; // tainted canvas or decode problem
  }
}
