import { NextResponse } from 'next/server';
import {
  APP_USERNAME,
  APP_PASSWORD,
  SESSION_COOKIE,
  SESSION_DAYS,
  sessionToken,
} from '../../../lib/session';

export async function POST(request) {
  try {
    const { username, password } = await request.json();
    const okUser = typeof username === 'string' && username === APP_USERNAME();
    const okPass = typeof password === 'string' && password === APP_PASSWORD();
    if (!okUser || !okPass) {
      return NextResponse.json({ error: 'Incorrect username or password' }, { status: 401 });
    }

    const token = await sessionToken();
    const res = NextResponse.json({ ok: true });
    res.cookies.set(SESSION_COOKIE, token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      maxAge: SESSION_DAYS * 24 * 60 * 60, // stays signed in
    });
    return res;
  } catch {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }
}