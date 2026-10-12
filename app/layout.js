export const metadata = {
  title: 'Image Drop',
  description: 'Upload images & screen recordings seamlessly across phone and laptop',
  viewport: 'width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no',
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
