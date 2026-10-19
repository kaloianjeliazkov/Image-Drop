'use client';

import { useState } from 'react';

const MAX = 5000;

export default function FeedbackPage() {
  const [kind, setKind] = useState('bug');
  const [message, setMessage] = useState('');
  const [status, setStatus] = useState('idle'); // idle | sending | sent | error
  const [error, setError] = useState('');

  const send = async (e) => {
    e.preventDefault();
    if (!message.trim() || status === 'sending') return;
    setStatus('sending');
    setError('');
    try {
      const res = await fetch('/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind, message, page: navigator.userAgent }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Could not send. Please try again.');
      setStatus('sent');
      setMessage('');
    } catch (err) {
      setError(err.message);
      setStatus('error');
    }
  };

  const pill = (id, label) => (
    <button
      type="button"
      onClick={() => setKind(id)}
      style={{
        flex: 1, padding: '9px', borderRadius: '8px', border: 'none', cursor: 'pointer',
        fontSize: '14px', fontWeight: 600,
        background: kind === id ? '#6c63ff' : 'transparent',
        color: kind === id ? '#fff' : '#999',
      }}
    >
      {label}
    </button>
  );

  return (
    <div
      style={{
        minHeight: '100vh', background: '#121212', color: '#e8e8e8',
        fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
        padding: '32px 16px', boxSizing: 'border-box',
      }}
    >
      <main style={{ maxWidth: '560px', margin: '0 auto' }}>
        <a
          href="/?settings"
          style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', color: '#aaa', textDecoration: 'none', fontSize: '14px', marginBottom: '20px' }}
        >
          ← Back to settings
        </a>

        <h1 style={{ fontSize: '22px', margin: '0 0 6px' }}>Report a bug / Suggestion</h1>
        <p style={{ color: '#888', margin: '0 0 20px', fontSize: '14px' }}>
          Tell us what went wrong or what would make Koldrop better. It goes straight to the developer.
        </p>

        {status === 'sent' ? (
          <div style={{ background: '#1e1e1e', border: '1px solid #333', borderRadius: '12px', padding: '24px', textAlign: 'center' }}>
            <div style={{ fontSize: '32px', marginBottom: '8px' }}>✅</div>
            <strong>Thanks — sent!</strong>
            <p style={{ color: '#999', fontSize: '14px', margin: '8px 0 18px' }}>We may reply to your account email.</p>
            <div style={{ display: 'flex', gap: '10px', justifyContent: 'center' }}>
              <button
                onClick={() => setStatus('idle')}
                style={{ padding: '10px 16px', borderRadius: '8px', border: '1px solid #444', background: 'transparent', color: '#ddd', cursor: 'pointer' }}
              >
                Send another
              </button>
              <a href="/?settings" style={{ padding: '10px 16px', borderRadius: '8px', background: '#6c63ff', color: '#fff', textDecoration: 'none' }}>
                Back to settings
              </a>
            </div>
          </div>
        ) : (
          <form onSubmit={send}>
            <div style={{ display: 'flex', gap: '6px', marginBottom: '14px', background: '#1a1a1a', padding: '4px', borderRadius: '10px' }}>
              {pill('bug', '🐞 Bug')}
              {pill('suggestion', '💡 Suggestion')}
            </div>
            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value.slice(0, MAX))}
              placeholder={kind === 'bug'
                ? 'What happened? What did you expect? Steps to make it happen again help a lot.'
                : 'What would you like Koldrop to do?'}
              rows={9}
              autoFocus
              style={{
                width: '100%', boxSizing: 'border-box', background: '#1e1e1e', color: '#e8e8e8',
                border: '1px solid #333', borderRadius: '10px', padding: '12px', fontSize: '15px',
                fontFamily: 'inherit', resize: 'vertical', outline: 'none',
              }}
            />
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '10px', gap: '12px' }}>
              <span style={{ fontSize: '12px', color: status === 'error' ? '#e84057' : '#666' }}>
                {status === 'error' ? error : `${message.length} / ${MAX}`}
              </span>
              <button
                type="submit"
                disabled={!message.trim() || status === 'sending'}
                style={{
                  padding: '10px 22px', borderRadius: '8px', border: 'none', fontWeight: 600, fontSize: '14px',
                  background: '#6c63ff', color: '#fff',
                  cursor: !message.trim() || status === 'sending' ? 'default' : 'pointer',
                  opacity: !message.trim() || status === 'sending' ? 0.5 : 1,
                }}
              >
                {status === 'sending' ? 'Sending…' : 'Send'}
              </button>
            </div>
          </form>
        )}
      </main>
    </div>
  );
}
