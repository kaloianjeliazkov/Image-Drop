import { NextResponse } from 'next/server';
import { createClient } from '../../../../lib/supabase/server';
import { BUCKET, FILES_TABLE } from '../../../../lib/supabase/config';

export const dynamic = 'force-dynamic';

const SIGNED_URL_SECONDS = 60 * 60;

// Stable link for one file. Checks the file belongs to the signed-in user (via RLS), then
// redirects to a short-lived signed URL on Supabase Storage. The browser caches the redirect,
// so thumbnails don't hit this route on every render.
export async function GET(request, { params }) {
  const supabase = createClient();

  const { data: row, error } = await supabase
    .from(FILES_TABLE)
    .select('storage_key, name')
    .eq('id', params.id)
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!row) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const download = new URL(request.url).searchParams.get('download') === '1';
  const { data, error: signError } = await supabase.storage
    .from(BUCKET)
    .createSignedUrl(row.storage_key, SIGNED_URL_SECONDS, download ? { download: row.name } : undefined);
  if (signError || !data?.signedUrl) {
    return NextResponse.json({ error: signError?.message || 'Could not sign URL' }, { status: 500 });
  }

  const res = NextResponse.redirect(data.signedUrl, 302);
  // Slightly shorter than the signed URL's lifetime so a cached redirect never points at an expired link.
  res.headers.set('Cache-Control', `private, max-age=${SIGNED_URL_SECONDS - 300}`);
  return res;
}
