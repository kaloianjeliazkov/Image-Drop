import { cookies } from 'next/headers';
import { createServerClient } from '@supabase/ssr';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config';

// Supabase client for route handlers. It acts AS the signed-in user (their session cookie),
// so row-level security limits every query and storage call to that user's own files.
export function createClient() {
  const cookieStore = cookies();
  return createServerClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options));
        } catch {
          // Called from a context that cannot set cookies; the middleware refreshes them instead.
        }
      },
    },
  });
}

// The verified user for this request, or null.
export async function getUser(supabase) {
  const { data, error } = await supabase.auth.getUser();
  if (error || !data?.user) return null;
  return data.user;
}
