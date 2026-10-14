import { createClient } from '@supabase/supabase-js';
import { SUPABASE_URL } from './config';

// Server-only client with the service-role key. Used ONLY for storage calls, and only after the
// caller's ownership of the file has been checked through the user's own (RLS-limited) client.
// Never import this from client components.
let admin = null;

export function getAdmin() {
  if (admin) return admin;
  const url = process.env.SUPABASE_URL || SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) throw new Error('SUPABASE_SERVICE_ROLE_KEY is not configured');
  admin = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  return admin;
}
