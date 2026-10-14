'use client';

import { useState } from 'react';
import { createClient } from '../../lib/supabase/browser';

// Reached from the password-reset email (via /auth/callback, which signs the user in first).
export default function ResetPasswordPage() {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const onSubmit = async (e) => {
    e.preventDefault();
    setError('');
    if (password.length < 8) {
      setError('Use at least 8 characters for your password.');
      return;
    }
    setBusy(true);
    const { error: err } = await createClient().auth.updateUser({ password });
    if (err) {
      setError(err.message.includes('session')
        ? 'This reset link has expired. Request a new one from the sign-in page.'
        : err.message);
      setBusy(false);
      return;
    }
    window.location.href = '/';
  };

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
        }}
      >
        <h1 style={{ margin: '0 0 6px', fontSize: '22px', fontWeight: 700 }}>Choose a new password</h1>
        <p style={{ margin: '0 0 22px', color: '#888', fontSize: '13px' }}>At least 8 characters.</p>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="new-password"
          style={{
            width: '100%', padding: '12px 14px', borderRadius: '10px', border: '1px solid #333',
            background: '#1a1a1a', color: '#e8e8e8', fontSize: '15px', outline: 'none',
            boxSizing: 'border-box', marginBottom: '18px',
          }}
        />
        {error && (
          <div style={{ color: '#ff6b6b', fontSize: '13px', marginBottom: '14px' }}>{error}</div>
        )}
        <button
          type="submit"
          disabled={busy}
          style={{
            width: '100%', padding: '12px', borderRadius: '10px', border: 'none', cursor: 'pointer',
            background: '#6c63ff', color: '#fff', fontSize: '15px', fontWeight: 600, opacity: busy ? 0.6 : 1,
          }}
        >
          {busy ? 'Saving…' : 'Save password'}
        </button>
      </form>
    </div>
  );
}
