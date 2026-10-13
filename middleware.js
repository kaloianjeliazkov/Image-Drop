import { NextResponse } from 'next/server';
import { SESSION_COOKIE, sessionToken } from './lib/session';

// Public routes that must stay reachable without a session.
const PUBLIC_PATHS = ['/login', '/api/login', '/api/logout'];

export async function middleware(request) {
  const { pathname } = request.nextUrl;
  const token = request.cookies.get(SESSION_COOKIE)?.value;
  const expected = await sessionToken();

  if (PUBLIC_PATHS.includes(pathname)) {
    // Already signed in? Don't show the login page again.
    if (pathname === '/login' && token === expected) {
      return NextResponse.redirect(new URL('/', request.url));
    }
    return NextResponse.next();
  }

  if (token !== expected) {
    if (pathname.startsWith('/api/')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const url = new URL('/login', request.url);
    url.searchParams.set('next', pathname === '/' ? '/' : pathname);
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

// Gate everything except static assets and the Next.js internals.
export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|icon.svg|manifest.webmanifest).*)'],
};