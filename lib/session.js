// Shared session logic for the login gate.
// Credentials come from env vars so they can be changed without a code deploy;
// defaults keep the app working out of the box (kolec / kolman).

export const SESSION_COOKIE = 'koldrop_session';
export const SESSION_DAYS = 365; // "don't ask again after the first time" -> long-lived cookie

export const APP_USERNAME = () => process.env.APP_USERNAME || 'kolec';
export const APP_PASSWORD = () => process.env.APP_PASSWORD || 'kolman';

// Deterministic, credential-derived session token (SHA-256 of "user:pass").
// Uses Web Crypto so it works in BOTH Edge middleware and Node route handlers.
export async function sessionToken() {
  const data = `${APP_USERNAME()}:${APP_PASSWORD()}`;
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(data));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}