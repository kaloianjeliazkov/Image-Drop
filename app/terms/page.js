import LegalPage from '../_legal/LegalPage';

export const metadata = { title: 'Terms – Koldrop' };

export default function TermsPage() {
  return (
    <LegalPage title="Terms of Service">
      <p>By using Koldrop you agree to these terms.</p>
      <ul>
        <li>Koldrop is a free personal project, provided as is, with no guarantee of availability.</li>
        <li>Keep your own copies of anything important; uploaded files are not a backup.</li>
        <li>Only upload content you have the right to store. Don&apos;t use Koldrop for anything illegal or abusive.</li>
        <li>Files are limited in size (currently 50 MB each) and total storage is shared, so limits may change.</li>
        <li>Accounts that break these terms may be removed.</li>
      </ul>
      <p>Questions: <a href="mailto:kaloianjeliazkov@gmail.com" style={{ color: '#8f88ff' }}>kaloianjeliazkov@gmail.com</a></p>
    </LegalPage>
  );
}
