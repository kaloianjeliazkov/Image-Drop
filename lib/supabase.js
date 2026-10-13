import { createClient } from '@supabase/supabase-js';

// Server-only Supabase client used purely as the file index (Vercel Blob still stores the bytes).
// It uses the service role key so it bypasses RLS — never import this from client code.
//
// If the env vars are missing the whole app falls back to listing Vercel Blob directly, so adding
// the index is opt-in and cannot break an existing deployment.
const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

export const supabaseAdmin = url && serviceRoleKey
  ? createClient(url, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } })
  : null;

export const FILES_TABLE = 'files';
