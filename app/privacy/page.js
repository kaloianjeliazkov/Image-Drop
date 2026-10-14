import LegalPage from '../_legal/LegalPage';

export const metadata = { title: 'Privacy – Koldrop' };

const h2 = { fontSize: '17px', color: '#fff', margin: '28px 0 8px' };

export default function PrivacyPage() {
  return (
    <LegalPage title="Privacy Policy">
      <p>
        Koldrop lets you move images and screen recordings between your own devices. This page
        explains what it stores and why.
      </p>

      <h2 style={h2}>What we store</h2>
      <ul>
        <li>Your account: email address, and your name and profile picture if you sign in with Google.</li>
        <li>The files you upload, with their folder, name, size and upload time.</li>
      </ul>

      <h2 style={h2}>How it is used</h2>
      <p>
        Only to sign you in and show you your own files. Files are kept in private storage and
        can be opened only by the account that uploaded them. We don&apos;t sell your data, show
        ads, or share it with anyone, apart from the services that run the app: Vercel (hosting)
        and Supabase (accounts, database and file storage).
      </p>

      <h2 style={h2}>Google sign-in</h2>
      <p>
        If you continue with Google, Koldrop receives only your basic profile (name, email and
        picture) to create your account. It does not access your Google Drive, Gmail or any
        other Google data.
      </p>

      <h2 style={h2}>Keeping and deleting data</h2>
      <p>
        Files stay until you delete them in the app; deleting removes them from storage. To
        delete your account and everything in it, email{' '}
        <a href="mailto:kaloianjeliazkov@gmail.com" style={{ color: '#8f88ff' }}>kaloianjeliazkov@gmail.com</a>.
      </p>
    </LegalPage>
  );
}
