// Shared layout for the short public Privacy and Terms pages.
export default function LegalPage({ title, children }) {
  return (
    <div
      style={{
        minHeight: '100vh', background: '#0d0d0d', color: '#d8d8d8',
        fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
        padding: '48px 16px', boxSizing: 'border-box',
      }}
    >
      <main style={{ maxWidth: '640px', margin: '0 auto', lineHeight: 1.6, fontSize: '15px' }}>
        <a href="/" style={{ display: 'flex', alignItems: 'center', gap: '10px', color: '#e8e8e8', textDecoration: 'none', marginBottom: '28px' }}>
          <img src="/icon.svg" alt="" width={30} height={30} style={{ borderRadius: '8px' }} />
          <strong style={{ fontSize: '18px' }}>Koldrop</strong>
        </a>
        <h1 style={{ fontSize: '26px', color: '#fff', margin: '0 0 6px' }}>{title}</h1>
        <p style={{ color: '#777', margin: '0 0 28px', fontSize: '13px' }}>Last updated 14 October 2026</p>
        {children}
        <p style={{ marginTop: '40px', fontSize: '13px', color: '#777' }}>
          <a href="/privacy" style={{ color: '#8f88ff' }}>Privacy</a>
          {' · '}
          <a href="/terms" style={{ color: '#8f88ff' }}>Terms</a>
          {' · '}
          <a href="mailto:kaloianjeliazkov@gmail.com" style={{ color: '#8f88ff' }}>Contact</a>
        </p>
      </main>
    </div>
  );
}
