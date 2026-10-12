export const metadata = {
  title: 'Image Drop',
  description: 'Upload images & screen recordings seamlessly across phone and laptop',
  icons: {
    icon: '/icon.svg',
    shortcut: '/icon.svg',
    apple: '/icon.svg',
  },
  // Make home screen bookmarks behave like a standalone app on iOS/Android
  appleWebApp: {
    capable: true,
    statusBarStyle: 'black-translucent',
    title: 'Image Drop',
  },
  mobileWebAppCapable: true,
};

export const viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, padding: 0, background: '#0f0f0f', color: '#e8e8e8', fontFamily: '-apple-system, BlinkMacSystemFont, Segoe UI, Roboto, sans-serif' }}>
        {children}
      </body>
    </html>
  );
}
