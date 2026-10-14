// Public Supabase settings. Both values are safe to expose to the browser: every table and the
// storage bucket are protected by row-level security, so a signed-in user only ever reaches
// their own rows and files.
export const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
export const SUPABASE_ANON_KEY =
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

export const BUCKET = 'files';
export const FILES_TABLE = 'user_files';

// Supabase's free plan caps a single upload at 50 MB. Raise this if you move to a paid plan
// (and raise the bucket's file size limit in Supabase to match).
export const MAX_UPLOAD_BYTES = Number(process.env.NEXT_PUBLIC_MAX_UPLOAD_MB || 50) * 1024 * 1024;
