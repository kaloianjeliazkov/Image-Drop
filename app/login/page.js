'use client';

import { useState } from 'react';

export default function LoginPage() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const onSubmit = async (e) => {
    e.preventDefault();
    if (!username || !password) {
      setError('Enter your username and password.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      if (res.ok) {
        const next = new URLSearchParams(window.location.search).get('next') || '/';
        window.location.href = next;
        return;
      }
      setError('Incorrect username or password.');
    } catch {
      setError('Could not reach the server. Try again.');
    } finally {
      setBusy(false);
    }
  };

  const inputStyle = {
    width: '100%', padding: '12px 14px', borderRadius: '10px', border: '1px solid #333',
    background: '#1a1a1a', color: '#e8e8e8', fontSize: '15px', outline: 'none',
    boxSizing: 'border-box',
  };

  return (
    <div
      style={{
        minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: '#0d0d0d', color: '#e8e8e8', fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
      }}
    >
      <form
        onSubmit={onSubmit}
        style={{
          background: '#161616', border: '1px solid #282828', borderRadius: '16px',
          padding: '36px 32px', width: '320px', boxShadow: '0 20px 60px rgba(0,0,0,0.5)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '6px' }}>
          <img src="/icon.svg" alt="" width={38} height={38} style={{ borderRadius: '10px' }} />
          <h1 style={{ margin: 0, fontSize: '24px', fontWeight: 700 }}>Koldrop</h1>
        </div>
        <p style={{ margin: '0 0 22px', color: '#888', fontSize: '13px' }}>
          Sign in to access your files
        </p>

        <label style={{ display: 'block', fontSize: '13px', color: '#aaa', marginBottom: '6px' }}>
          Username
        </label>
        <input
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoComplete="username"
          style={{ ...inputStyle, marginBottom: '14px' }}
        />

        <label style={{ display: 'block', fontSize: '13px', color: '#aaa', marginBottom: '6px' }}>
          Password
        </label>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
          style={{ ...inputStyle, marginBottom: '18px' }}
        />

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

        <button
          type="submit"
          disabled={busy}
          style={{
            width: '100%', padding: '12px', borderRadius: '10px', border: 'none', cursor: 'pointer',
            background: '#6c63ff', color: '#fff', fontSize: '15px', fontWeight: 600,
            opacity: busy ? 0.6 : 1,
          }}
        >
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}