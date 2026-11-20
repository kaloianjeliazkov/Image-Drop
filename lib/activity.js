// Activity log (Settings → Activity, owner only). Best-effort: logging never breaks an
// upload or delete. Only names, folders and sizes are recorded — never file contents.
import { getAdmin } from './supabase/admin';

const KEEP_DAYS = 30;

export async function logActivity(user, action, items) {
  try {
    const rows = (items || []).map((it) => ({
      user_id: user?.id || null,
      email: user?.email || null,
      action,
      file_name: it?.name ? String(it.name).slice(0, 200) : null,
      folder: it?.folder ? String(it.folder).slice(0, 100) : null,
      size: Number(it?.size) || 0,
    }));
    if (!rows.length) return;
    const { error } = await getAdmin().from('activity_log').insert(rows);
    if (error) console.warn('[activity] log failed:', error.message);
  } catch (e) {
    console.warn('[activity] log failed:', e.message);
  }
}

// Drops entries older than 30 days.
export async function pruneActivity() {
  const cutoff = new Date(Date.now() - KEEP_DAYS * 86400000).toISOString();
  await getAdmin().from('activity_log').delete().lt('created_at', cutoff);
}
