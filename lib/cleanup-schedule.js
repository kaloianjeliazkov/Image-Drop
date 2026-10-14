// The weekly wipe runs from Vercel Cron (see vercel.json): every Sunday at 21:00 UTC,
// which is midnight Bulgarian summer time (23:00 in winter). On the free plan Vercel may start
// it any time within that hour. Keep this in sync with the cron expression in vercel.json.
export const WIPE_UTC_DAY = 0; // Sunday
export const WIPE_UTC_HOUR = 21;

// The next wipe time, as a Date.
export function nextWipe(now = new Date()) {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), WIPE_UTC_HOUR));
  let days = (WIPE_UTC_DAY - d.getUTCDay() + 7) % 7;
  if (days === 0 && now >= new Date(d.getTime() + 60 * 60 * 1000)) days = 7; // this week's already ran
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}
