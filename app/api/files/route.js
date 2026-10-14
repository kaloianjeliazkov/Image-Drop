import { NextResponse } from 'next/server';
import { createClient, getUser } from '../../../lib/supabase/server';
import { getAdmin } from '../../../lib/supabase/admin';
import { BUCKET, FILES_TABLE } from '../../../lib/supabase/config';
import { quotaFor, quotaMessage } from '../../../lib/quota';

export const dynamic = 'force-dynamic';

const isVideoName = (name) => /\.(mp4|mov|webm|mkv|m4v)$/i.test(name);

// Each file gets a stable URL in this app. /api/f/<id> checks ownership and redirects to a
// short-lived signed Supabase URL, so files are never publicly reachable.
const fileUrl = (id) => `/api/f/${id}`;
const idFromUrl = (url) => {
  const m = String(url || '').match(/\/api\/f\/([0-9a-f-]{36})/i);
  return m ? m[1] : null;
};

const rowToFile = (row) => ({
  id: row.id,
  url: fileUrl(row.id),
  downloadUrl: `${fileUrl(row.id)}?download=1`,
  pathname: `${row.folder}/${row.name}`,
  folder: row.folder,
  name: row.name,
  size: row.size,
  uploadedAt: row.uploaded_at,
  isVideo: row.is_video,
  // Small preview for the gallery grid (null until one exists — the grid then uses `url`)
  thumbUrl: row.thumb_key ? `${fileUrl(row.id)}?thumb=1` : null,
});

const ownsKey = (user, key) => typeof key === 'string' && key.startsWith(`${user.id}/`) && !key.includes('..');

// The signed-in user's files (row-level security filters to their own rows).
export async function GET() {
  try {
    const supabase = createClient();
    const user = await getUser(supabase);
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { data, error } = await supabase
      .from(FILES_TABLE)
      .select('*')
      .order('uploaded_at', { ascending: false });
    if (error) throw error;

    const files = (data || []).map(rowToFile);
    const used = files.reduce((sum, f) => sum + (Number(f.size) || 0), 0);
    const { limit } = await quotaFor(supabase, user).catch(() => ({ limit: null }));
    return NextResponse.json({
      files,
      user: { email: user.email },
      quota: { used, limit },
    });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

// Record a file the browser just uploaded to storage.
// Body: { key, thumbKey?, pathname: "folder/name.jpg", size, contentType }
export async function POST(request) {
  const supabase = createClient();
  const user = await getUser(supabase);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let key;
  let thumbKey = null;
  try {
    const body = await request.json();
    key = String(body.key || '');
    thumbKey = ownsKey(user, body.thumbKey) ? body.thumbKey : null;
    const pathname = String(body.pathname || '');
    if (!key.startsWith(`${user.id}/`)) {
      return NextResponse.json({ error: 'Invalid storage key' }, { status: 400 });
    }
    const slash = pathname.indexOf('/');
    const folder = (slash > 0 ? pathname.slice(0, slash) : 'general').slice(0, 100);
    const name = (slash > 0 ? pathname.slice(slash + 1) : pathname).slice(0, 200);
    if (!name) return NextResponse.json({ error: 'pathname is required' }, { status: 400 });

    // Use the real stored size (not what the browser claimed) and enforce the per-user limit
    const { data: info } = await getAdmin().storage.from(BUCKET).info(key).catch(() => ({ data: null }));
    const size = Number(info?.size) || Number(body.size) || 0;
    const { used, limit } = await quotaFor(supabase, user);
    if (limit !== null && used + size > limit) {
      await getAdmin().storage.from(BUCKET).remove([key, thumbKey].filter(Boolean)).catch(() => {});
      return NextResponse.json({ error: quotaMessage(used, limit) }, { status: 413 });
    }

    const { data, error } = await supabase
      .from(FILES_TABLE)
      .insert({
        user_id: user.id,
        storage_key: key,
        thumb_key: thumbKey,
        folder,
        name,
        size,
        content_type: body.contentType || null,
        is_video: isVideoName(name),
      })
      .select('*')
      .single();
    if (error) throw error;

    return NextResponse.json({ success: true, file: rowToFile(data) });
  } catch (error) {
    // Don't leave an orphaned object in storage if the row could not be written.
    if (key && key.startsWith(`${user.id}/`)) {
      await getAdmin().storage.from(BUCKET).remove([key, thumbKey].filter(Boolean)).catch(() => {});
    }
    const duplicate = error?.code === '23505';
    return NextResponse.json(
      { error: duplicate ? 'A file with that name already exists in this folder' : error.message },
      { status: duplicate ? 409 : 500 }
    );
  }
}

// Body: { url } or { urls: [...] } — the /api/f/<id> URLs the page already has.
export async function DELETE(request) {
  try {
    const supabase = createClient();
    const user = await getUser(supabase);
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { url, urls } = await request.json();
    const list = Array.isArray(urls) ? urls : url ? [url] : [];
    const ids = list.map(idFromUrl).filter(Boolean);
    if (!ids.length) return NextResponse.json({ success: true });

    // Only rows this user owns come back (RLS), so nobody can delete someone else's files.
    const { data: rows, error } = await supabase
      .from(FILES_TABLE)
      .delete()
      .in('id', ids)
      .select('storage_key, thumb_key');
    if (error) throw error;

    // Remove the files and their thumbnails from storage
    const keys = (rows || []).flatMap((r) => [r.storage_key, r.thumb_key]).filter(Boolean);
    for (let i = 0; i < keys.length; i += 1000) {
      const { error: rmError } = await getAdmin().storage.from(BUCKET).remove(keys.slice(i, i + 1000));
      if (rmError) console.error('Storage remove failed:', rmError.message);
    }

    return NextResponse.json({ success: true, deleted: (rows || []).length });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

// Attach a thumbnail to an existing file (backfill for files uploaded before thumbnails).
// Body: { url: "/api/f/<id>", thumbKey }
export async function PATCH(request) {
  const supabase = createClient();
  const user = await getUser(supabase);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let thumbKey = null;
  try {
    const body = await request.json();
    const id = idFromUrl(body.url);
    thumbKey = ownsKey(user, body.thumbKey) ? body.thumbKey : null;
    if (!id || !thumbKey) return NextResponse.json({ error: 'url and thumbKey are required' }, { status: 400 });

    // Only fills an empty slot, and RLS limits it to the user's own row.
    const { data, error } = await supabase
      .from(FILES_TABLE)
      .update({ thumb_key: thumbKey })
      .eq('id', id)
      .is('thumb_key', null)
      .select('id');
    if (error) throw error;
    if (!data?.length) {
      await getAdmin().storage.from(BUCKET).remove([thumbKey]).catch(() => {});
      return NextResponse.json({ success: true, skipped: true });
    }
    return NextResponse.json({ success: true });
  } catch (error) {
    if (thumbKey) await getAdmin().storage.from(BUCKET).remove([thumbKey]).catch(() => {});
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
