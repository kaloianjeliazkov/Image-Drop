import { NextResponse } from 'next/server';
import { createClient, getUser } from '../../../lib/supabase/server';
import { getAdmin } from '../../../lib/supabase/admin';
import { isUnlimited } from '../../../lib/quota';
import { pruneActivity } from '../../../lib/activity';

export const dynamic = 'force-dynamic';

// Owner only (OWNER_EMAILS): everyone's accounts and what they did in the last 30 days.
export async function GET() {
  const user = await getUser(createClient());
  if (!user) return NextResponse.json({ error: 'Please sign in again.' }, { status: 401 });
  if (!isUnlimited(user)) return NextResponse.json({ error: 'Not allowed' }, { status: 403 });

  const admin = getAdmin();
  await pruneActivity().catch(() => {});
  const [summary, recent] = await Promise.all([
    admin.rpc('koldrop_activity_summary'),
    admin
      .from('activity_log')
      .select('id, email, action, file_name, folder, size, created_at')
      .order('created_at', { ascending: false })
      .limit(150),
  ]);
  if (summary.error) return NextResponse.json({ error: summary.error.message }, { status: 500 });
  if (recent.error) return NextResponse.json({ error: recent.error.message }, { status: 500 });
  return NextResponse.json({ users: summary.data || [], recent: recent.data || [] });
}
