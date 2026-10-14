'use client';

import { useEffect, useState } from 'react';
import { createClient } from '../../lib/supabase/browser';
import { isValidEmail } from '../../lib/email';

// mode: 'signin' | 'signup' | 'forgot'
export default function LoginPage() {
  const [mode, setMode] = useState('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const err = new URLSearchParams(window.location.search).get('error');
    if (err) setError(err);
  }, []);

  const nextPath = () => {
    const next = new URLSearchParams(window.location.search).get('next') || '/';
    return next.startsWith('/') && !next.startsWith('//') ? next : '/';
  };

  const callbackUrl = (next) =>
    `${window.location.origin}/auth/callback?next=${encodeURIComponent(next)}`;

  const switchMode = (m) => {
    setMode(m);
    setError('');
    setNotice('');
  };

  const onSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setNotice('');
    if (!email || (mode !== 'forgot' && !password)) {
      setError(mode === 'forgot' ? 'Enter your email.' : 'Enter your email and password.');
      return;
    }
    if (mode === 'signup' && !isValidEmail(email)) {
      setError('Enter a valid email address, like name@example.com.');
      return;
    }
    if (mode === 'signup' && password.length < 8) {
      setError('Use at least 8 characters for your password.');
      return;
    }

    setBusy(true);
    const supabase = createClient();
    try {
      if (mode === 'signin') {
        const { error: err } = await supabase.auth.signInWithPassword({ email, password });
        if (err) throw err;
        window.location.href = nextPath();
        return;
      }

      if (mode === 'signup') {
        const { data, error: err } = await supabase.auth.signUp({
          email: email.trim(),
          password,
          options: { emailRedirectTo: callbackUrl('/') },
        });
        if (err) throw err;
        if (data.session) {
          // Email confirmation is turned off in Supabase: the account is ready right away.
          window.location.href = '/';
          return;
        }
        setNotice('Check your inbox and click the link to confirm your account.');
        setMode('signin');
        return;
      }

      // forgot password
      const { error: err } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: callbackUrl('/reset-password'),
      });
      if (err) throw err;
      setNotice('If that email has an account, a reset link is on its way.');
      setMode('signin');
    } catch (err) {
      setError(err?.message || 'Something went wrong. Try again.');
    } finally {
      setBusy(false);
    }
  };

  const onGoogle = async () => {
    setError('');
    setBusy(true);
    const supabase = createClient();
    const { error: err } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: callbackUrl(nextPath()) },
    });
    if (err) {
      setError(err.message);
      setBusy(false);
    }
    // On success the browser is sent to Google, so there is nothing else to do here.
  };

  const inputStyle = {
    width: '100%', padding: '12px 14px', borderRadius: '10px', border: '1px solid #333',
    background: '#1a1a1a', color: '#e8e8e8', fontSize: '15px', outline: 'none',
    boxSizing: 'border-box',
  };
  const labelStyle = { display: 'block', fontSize: '13px', color: '#aaa', marginBottom: '6px' };
  const linkStyle = {
    background: 'none', border: 'none', padding: 0, color: '#8f88ff', cursor: 'pointer',
    fontSize: '13px',
  };

  const title = mode === 'signup' ? 'Create your account' : mode === 'forgot' ? 'Reset your password' : 'Sign in to access your files';
  const cta = mode === 'signup' ? 'Create account' : mode === 'forgot' ? 'Send reset link' : 'Sign in';
  const ctaBusy = mode === 'signup' ? 'Creating account…' : mode === 'forgot' ? 'Sending…' : 'Signing in…';

  return (
    <div
      style={{
        minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: '#0d0d0d', color: '#e8e8e8', fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
        padding: '16px', boxSizing: 'border-box',
      }}
    >
      <form
        onSubmit={onSubmit}
        style={{
          background: '#161616', border: '1px solid #282828', borderRadius: '16px',
          padding: '36px 32px', width: '100%', maxWidth: '340px', boxSizing: 'border-box',
          boxShadow: '0 20px 60px rgba(0,0,0,0.5)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '6px' }}>
          <img src="/icon.svg" alt="" width={38} height={38} style={{ borderRadius: '10px' }} />
          <h1 style={{ margin: 0, fontSize: '24px', fontWeight: 700 }}>Koldrop</h1>
        </div>
        <p style={{ margin: '0 0 22px', color: '#888', fontSize: '13px' }}>{title}</p>

        {mode !== 'forgot' && (
          <>
            <button
              type="button"
              onClick={onGoogle}
              disabled={busy}
              style={{
                width: '100%', padding: '11px', borderRadius: '10px', border: '1px solid #333',
                background: '#fff', color: '#1f1f1f', fontSize: '15px', fontWeight: 600, cursor: 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '10px',
                opacity: busy ? 0.6 : 1,
              }}
            >
              <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
                <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>
                <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>
                <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>
                <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>
              </svg>
              Continue with Google
            </button>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', margin: '18px 0', color: '#555', fontSize: '12px' }}>
              <div style={{ flex: 1, height: '1px', background: '#2a2a2a' }} />
              or
              <div style={{ flex: 1, height: '1px', background: '#2a2a2a' }} />
            </div>
          </>
        )}

        <label style={labelStyle}>Email</label>
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoComplete="email"
          style={{ ...inputStyle, marginBottom: '14px' }}
        />

        {mode !== 'forgot' && (
          <>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
              <label style={labelStyle}>Password</label>
              {mode === 'signin' && (
                <button type="button" style={linkStyle} onClick={() => switchMode('forgot')}>
                  Forgot?
                </button>
              )}
            </div>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
              style={{ ...inputStyle, marginBottom: '18px' }}
            />
          </>
        )}

        {error && (
          <div
            style={{
              background: 'rgba(232,64,87,0.12)', color: '#ff6b6b', border: '1px solid rgba(232,64,87,0.4)',
              borderRadius: '8px', padding: '10px 12px', fontSize: '13px', marginBottom: '14px',
            }}
          >
            {error}
          </div>
        )}
        {notice && (
          <div
            style={{
              background: 'rgba(76,175,80,0.12)', color: '#7ddc82', border: '1px solid rgba(76,175,80,0.4)',
              borderRadius: '8px', padding: '10px 12px', fontSize: '13px', marginBottom: '14px',
            }}
          >
            {notice}
          </div>
        )}

        <button
          type="submit"
          disabled={busy}
          style={{
            width: '100%', padding: '12px', borderRadius: '10px', border: 'none', cursor: 'pointer',
            background: '#6c63ff', color: '#fff', fontSize: '15px', fontWeight: 600,
            opacity: busy ? 0.6 : 1,
          }}
        >
          {busy ? ctaBusy : cta}
        </button>

        <p style={{ margin: '18px 0 0', textAlign: 'center', fontSize: '13px', color: '#888' }}>
          {mode === 'signin' ? (
            <>New here? <button type="button" style={linkStyle} onClick={() => switchMode('signup')}>Create an account</button></>
          ) : (
            <><button type="button" style={linkStyle} onClick={() => switchMode('signin')}>Back to sign in</button></>
          )}
        </p>
        <p style={{ margin: '14px 0 0', textAlign: 'center', fontSize: '12px', color: '#666' }}>
          <a href="/privacy" style={{ color: '#888' }}>Privacy</a>
          {' · '}
          <a href="/terms" style={{ color: '#888' }}>Terms</a>
        </p>
      </form>
    </div>
  );
}
