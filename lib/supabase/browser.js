'use client';

import { createBrowserClient } from '@supabase/ssr';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config';

let client = null;

// One browser client per tab; it reads and refreshes the session cookies set by the server.
export function createClient() {
  if (!client) client = createBrowserClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  return client;
}
