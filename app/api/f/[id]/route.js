import { NextResponse } from 'next/server';
import { createClient } from '../../../../lib/supabase/server';
import { FILES_TABLE } from '../../../../lib/supabase/config';
import { signDownload } from '../../../../lib/storage';

export const dynamic = 'force-dynamic';

const SIGNED_URL_SECONDS = 60 * 60;

// Stable link for one file. Checks the file belongs to the signed-in user (via RLS), then
// redirects to a short-lived signed URL on Supabase Storage. The browser caches the redirect,
// so thumbnails don't hit this route on every render.
export async function GET(request, { params }) {
  const supabase = createClient();

  const { data: row, error } = await supabase
    .from(FILES_TABLE)
    .select('storage_key, thumb_key, name')
    .eq('id', params.id)
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!row) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const params2 = new URL(request.url).searchParams;
  const download = params2.get('download') === '1';
  // ?thumb=1 serves the small gallery preview when there is one
  const key = params2.get('thumb') === '1' && row.thumb_key ? row.thumb_key : row.storage_key;
  // Ownership was just checked through RLS above, so signing with the service role is safe.
  let signedUrl;
  try {
    signedUrl = await signDownload(key, SIGNED_URL_SECONDS, download ? row.name : undefined);
  } catch (e) {
    return NextResponse.json({ error: e?.message || 'Could not sign URL' }, { status: 500 });
  }

  const res = NextResponse.redirect(signedUrl, 302);
  // Slightly shorter than the signed URL's lifetime so a cached redirect never points at an expired link.
  res.headers.set('Cache-Control', `private, max-age=${SIGNED_URL_SECONDS - 300}`);
  return res;
}
