// Per-user storage limit. Owners listed in OWNER_EMAILS have no limit.
// Change both in Vercel → Settings → Environment Variables without touching code:
//   USER_QUOTA_MB=175
//   OWNER_EMAILS=kaloianjeliazkov@gmail.com,another@example.com
//
// Plus a hard cap on ALL files together, so Cloudflare R2 never goes past its free 10 GB:
//   STORAGE_CAP_GB=9
import { FILES_TABLE } from './supabase/config';
import { getAdmin } from './supabase/admin';

export const QUOTA_BYTES = Number(process.env.USER_QUOTA_MB || 175) * 1000 * 1000;
export const STORAGE_CAP_BYTES = Number(process.env.STORAGE_CAP_GB || 9) * 1000 * 1000 * 1000;

const owners = () =>
  (process.env.OWNER_EMAILS || 'kaloianjeliazkov@gmail.com')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);

export const isUnlimited = (user) => owners().includes(String(user?.email || '').toLowerCase());

// Accounts that see the total storage used by everyone (Settings). Change with
//   ADMIN_EMAILS=kaloianjeliazkov@gmail.com,kzhptech@gmail.com
const admins = () =>
  (process.env.ADMIN_EMAILS || 'kaloianjeliazkov@gmail.com,kzhptech@gmail.com')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);

export const isAdmin = (user) => admins().includes(String(user?.email || '').toLowerCase());

// Bytes the user currently stores (row-level security limits the sum to their own files).
export async function usedBytes(supabase) {
  const { data, error } = await supabase.rpc('my_storage_bytes');
  if (!error) return Number(data) || 0;
  // Fallback if the database function isn't there yet
  const { data: rows, error: err2 } = await supabase.from(FILES_TABLE).select('size');
  if (err2) throw err2;
  return (rows || []).reduce((sum, r) => sum + (Number(r.size) || 0), 0);
}

// Bytes stored by everyone together.
export async function totalStoredBytes() {
  const { data, error } = await getAdmin().rpc('total_storage_bytes');
  if (error) throw error;
  return Number(data) || 0;
}

// Error message if `extra` more bytes would push everyone's storage past the hard cap, else null.
// Applies to every account, owners included — it exists to keep the storage bill at zero.
export async function capMessage(extra) {
  const total = await totalStoredBytes();
  if (total + Number(extra || 0) <= STORAGE_CAP_BYTES) return null;
  return "Koldrop's shared storage is full right now. Uploads open again as people download files, and after Sunday's weekly wipe.";
}

// { used, limit } for the UI; limit is null for unlimited users.
export async function quotaFor(supabase, user) {
  const used = await usedBytes(supabase);
  return { used, limit: isUnlimited(user) ? null : QUOTA_BYTES };
}

const mb = (bytes) => `${Math.round(bytes / 1e5) / 10} MB`;

export const quotaMessage = (used, limit) =>
  `Storage full: you're using ${mb(used)} of ${mb(limit)}. Delete or download some files to upload more.`;
