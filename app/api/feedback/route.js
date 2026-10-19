import { NextResponse } from 'next/server';
import nodemailer from 'nodemailer';
import { createClient, getUser } from '../../../lib/supabase/server';
import { getAdmin } from '../../../lib/supabase/admin';
import { isAdmin } from '../../../lib/quota';

export const dynamic = 'force-dynamic';

const KINDS = { bug: 'Bug report', suggestion: 'Suggestion' };
// Where reports go. Change with FEEDBACK_TO in Vercel → Environment Variables.
const TO = () => process.env.FEEDBACK_TO || 'kaloianjeliazkov@gmail.com';

// Sends the report by email. Uses Gmail SMTP when SMTP_USER + SMTP_PASS (an app password) are
// set; otherwise FormSubmit (free relay, needs one confirmation click in the first email).
async function sendEmail({ kind, message, from, page }) {
  const subject = `Koldrop ${KINDS[kind].toLowerCase()} from ${from}`;
  const text = `${KINDS[kind]} from ${from}\n\n${message}\n\n—\nSent from Koldrop ${page || ''}`.trim();

  if (process.env.SMTP_USER && process.env.SMTP_PASS) {
    const transport = nodemailer.createTransport({
      host: process.env.SMTP_HOST || 'smtp.gmail.com',
      port: Number(process.env.SMTP_PORT || 465),
      secure: Number(process.env.SMTP_PORT || 465) === 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
    await transport.sendMail({
      from: `Koldrop <${process.env.SMTP_USER}>`,
      to: TO(),
      replyTo: from,
      subject,
      text,
    });
    return;
  }

  const res = await fetch(`https://formsubmit.co/ajax/${encodeURIComponent(TO())}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', Referer: 'https://koldrop.vercel.app/feedback' },
    body: JSON.stringify({ _subject: subject, _template: 'box', _captcha: 'false', _replyto: from, type: KINDS[kind], from, message }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || String(data.success) === 'false') throw new Error(data.message || `Email relay failed (${res.status})`);
}

export async function POST(request) {
  const supabase = createClient();
  const user = await getUser(supabase);
  if (!user) return NextResponse.json({ error: 'Please sign in again.' }, { status: 401 });

  const body = await request.json().catch(() => ({}));
  const kind = KINDS[body.kind] ? body.kind : 'bug';
  const message = String(body.message || '').trim().slice(0, 5000);
  if (!message) return NextResponse.json({ error: 'Please write something first.' }, { status: 400 });

  // Keep a copy first, so a report is never lost even if the email fails.
  // (Service role, because users may add feedback but not read it back.)
  const admin = getAdmin();
  const { data: row } = await admin
    .from('feedback')
    .insert({ user_id: user.id, email: user.email, kind, message })
    .select('id')
    .maybeSingle();

  try {
    await sendEmail({ kind, message, from: user.email, page: body.page });
    if (row?.id) {
      await admin.from('feedback').update({ emailed: true }).eq('id', row.id);
    }
  } catch (e) {
    console.error('[feedback] Email failed:', e.message);
    if (!row) return NextResponse.json({ error: 'Could not send right now. Please try again later.' }, { status: 502 });
  }
  return NextResponse.json({ ok: true });
}

// Admin accounts only: the reports inbox in Settings.
async function requireAdmin() {
  const user = await getUser(createClient());
  if (!user) return [null, NextResponse.json({ error: 'Please sign in again.' }, { status: 401 })];
  if (!isAdmin(user)) return [null, NextResponse.json({ error: 'Not allowed' }, { status: 403 })];
  return [user, null];
}

export async function GET() {
  const [, denied] = await requireAdmin();
  if (denied) return denied;
  const { data, error } = await getAdmin()
    .from('feedback')
    .select('id, email, kind, message, created_at')
    .order('created_at', { ascending: false })
    .limit(200);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ reports: data || [] });
}

export async function DELETE(request) {
  const [, denied] = await requireAdmin();
  if (denied) return denied;
  const { id } = await request.json().catch(() => ({}));
  if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400 });
  const { error } = await getAdmin().from('feedback').delete().eq('id', id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
