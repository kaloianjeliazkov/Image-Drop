import { NextResponse } from 'next/server';
import { createClient } from '../../../lib/supabase/server';

// Landing point for Google sign-in, email confirmation links and password-reset links.
// Supabase sends the browser here with a one-time ?code=, which we swap for a session cookie.
export async function GET(request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get('code');
  const rawNext = searchParams.get('next') || '/';
  // Only allow same-site relative paths so this can't be used as an open redirect.
  const next = rawNext.startsWith('/') && !rawNext.startsWith('//') ? rawNext : '/';

  if (code) {
    const supabase = createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) return NextResponse.redirect(`${origin}${next}`);
    return NextResponse.redirect(`${origin}/login?error=${encodeURIComponent(error.message)}`);
  }

  const description = searchParams.get('error_description') || 'Sign-in link is invalid or expired';
  return NextResponse.redirect(`${origin}/login?error=${encodeURIComponent(description)}`);
}
