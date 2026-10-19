import { NextResponse } from 'next/server';
import { createClient } from '../../../lib/supabase/server';

// Landing point for links in Koldrop's own emails (sign-up confirmation, password reset,
// email change). The email links straight to koldrop.vercel.app instead of supabase.co,
// which keeps spam filters happy; here we verify the one-time token and sign the user in.
const TYPES = ['signup', 'email', 'recovery', 'invite', 'magiclink', 'email_change'];

export async function GET(request) {
  const { searchParams, origin } = new URL(request.url);
  const tokenHash = searchParams.get('token_hash');
  const type = searchParams.get('type');
  const fallback = type === 'recovery' ? '/reset-password' : '/';
  const rawNext = searchParams.get('next') || fallback;
  // Only same-site relative paths, so this can't be used as an open redirect.
  const next = rawNext.startsWith('/') && !rawNext.startsWith('//') ? rawNext : fallback;

  if (tokenHash && TYPES.includes(type)) {
    const supabase = createClient();
    const { error } = await supabase.auth.verifyOtp({ type: type === 'signup' ? 'email' : type, token_hash: tokenHash });
    if (!error) return NextResponse.redirect(`${origin}${next}`);
    return NextResponse.redirect(`${origin}/login?error=${encodeURIComponent(error.message)}`);
  }
  return NextResponse.redirect(`${origin}/login?error=${encodeURIComponent('This link is invalid or has expired. Please try again.')}`);
}
