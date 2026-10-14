import { NextResponse } from 'next/server';
import { getAdmin } from '../../../../lib/supabase/admin';
import { BUCKET, FILES_TABLE } from '../../../../lib/supabase/config';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

// Weekly wipe of EVERY user's files, called by Vercel Cron (vercel.json).
// Vercel sends "Authorization: Bearer $CRON_SECRET"; anything else is refused.
export async function GET(request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const admin = getAdmin();

  // 1) Every object in the bucket (files and thumbnails, including any orphans)
  const { error: emptyError } = await admin.storage.emptyBucket(BUCKET);
  if (emptyError) {
    console.error('[weekly-wipe] Emptying storage failed:', emptyError.message);
    return NextResponse.json({ error: emptyError.message }, { status: 500 });
  }

  // 2) Every row in the file list
  const { count, error: rowsError } = await admin
    .from(FILES_TABLE)
    .delete({ count: 'exact' })
    .not('id', 'is', null);
  if (rowsError) {
    console.error('[weekly-wipe] Clearing file list failed:', rowsError.message);
    return NextResponse.json({ error: rowsError.message }, { status: 500 });
  }

  console.log(`[weekly-wipe] Removed ${count ?? 0} file(s).`);
  return NextResponse.json({ success: true, removed: count ?? 0 });
}
