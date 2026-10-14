import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { createClient, getUser } from '../../../lib/supabase/server';
import { getAdmin } from '../../../lib/supabase/admin';
import { BUCKET, MAX_UPLOAD_BYTES } from '../../../lib/supabase/config';
import { quotaFor, quotaMessage } from '../../../lib/quota';

export const dynamic = 'force-dynamic';

// Hands the browser a one-time signed URL to upload a single file into the user's own folder
// ("<user id>/<uuid>.<ext>"). The file bytes go straight to Supabase, not through Vercel.
export async function POST(request) {
  const supabase = createClient();
  const user = await getUser(supabase);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  try {
    const { filename, size, thumb } = await request.json();
    if (thumb) {
      // Gallery preview: always a small JPEG next to the user's files
      if (Number(size) > 2 * 1000 * 1000) {
        return NextResponse.json({ error: 'Thumbnail too large' }, { status: 413 });
      }
      const key = `${user.id}/thumbs/${randomUUID()}.jpg`;
      const { data, error } = await getAdmin().storage.from(BUCKET).createSignedUploadUrl(key);
      if (error) throw error;
      return NextResponse.json({ key, token: data.token });
    }
    if (Number(size) > MAX_UPLOAD_BYTES) {
      return NextResponse.json(
        { error: `File is too large (max ${Math.round(MAX_UPLOAD_BYTES / 1e6)} MB)` },
        { status: 413 }
      );
    }
    // Quick check against the per-user limit (enforced again with the real size when saving)
    const { used, limit } = await quotaFor(supabase, user);
    if (limit !== null && used + Number(size || 0) > limit) {
      return NextResponse.json({ error: quotaMessage(used, limit) }, { status: 413 });
    }

    const name = String(filename || '');
    const dot = name.lastIndexOf('.');
    const ext = dot >= 0 ? name.slice(dot).toLowerCase().replace(/[^a-z0-9.]/g, '').slice(0, 10) : '';
    const key = `${user.id}/${randomUUID()}${ext}`;

    const { data, error } = await getAdmin().storage.from(BUCKET).createSignedUploadUrl(key);
    if (error) throw error;

    return NextResponse.json({ key, token: data.token });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
