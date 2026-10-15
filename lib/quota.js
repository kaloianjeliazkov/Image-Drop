// Per-user storage limit. Owners listed in OWNER_EMAILS have no limit.
// Change both in Vercel → Settings → Environment Variables without touching code:
//   USER_QUOTA_MB=200
//   OWNER_EMAILS=kaloianjeliazkov@gmail.com,another@example.com
import { FILES_TABLE } from './supabase/config';

export const QUOTA_BYTES = Number(process.env.USER_QUOTA_MB || 200) * 1000 * 1000;

const owners = () =>
  (process.env.OWNER_EMAILS || 'kaloianjeliazkov@gmail.com')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);

export const isUnlimited = (user) => owners().includes(String(user?.email || '').toLowerCase());

// Bytes the user currently stores (row-level security limits the sum to their own files).
export async function usedBytes(supabase) {
  const { data, error } = await supabase.from(FILES_TABLE).select('size');
  if (error) throw error;
  return (data || []).reduce((sum, r) => sum + (Number(r.size) || 0), 0);
}

// { used, limit } for the UI; limit is null for unlimited users.
export async function quotaFor(supabase, user) {
  const used = await usedBytes(supabase);
  return { used, limit: isUnlimited(user) ? null : QUOTA_BYTES };
}

const mb = (bytes) => `${Math.round(bytes / 1e5) / 10} MB`;

export const quotaMessage = (used, limit) =>
  `Storage full: you're using ${mb(used)} of ${mb(limit)}. Delete or download some files to upload more.`;

// Only owners may have a second sign-in with a DIFFERENT email (e.g. a second Google
// account). For everyone else, any linked login whose email differs from the account's own
// email is removed. Same-email logins (email + Google with the same address) are kept.
export async function enforceSingleLogin(supabase, user) {
  if (!user || isUnlimited(user)) return;
  const own = String(user.email || '').toLowerCase();
  const foreign = (user.identities || []).filter(
    (i) => String(i.identity_data?.email || '').toLowerCase() !== own
  );
  for (const identity of foreign) {
    const { error } = await supabase.auth.unlinkIdentity(identity);
    if (error) console.warn('[single-login] Could not unlink identity:', error.message);
  }
}
