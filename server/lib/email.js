'use strict';

// Tiny transactional-email helper built on Node's native fetch — no npm
// dependency. Uses Resend's HTTP API (https://resend.com) because it has a
// generous free tier and the simplest possible integration: one POST with a
// bearer token, no SDK to install.
//
// Configure via environment variables on the host (Render → Environment):
//   RESEND_API_KEY  - required for real emails to actually send
//   RESEND_FROM     - optional, e.g. "Kaf Musician Connect <noreply@yourdomain.com>"
//                      Defaults to Resend's shared sandbox sender, which only
//                      delivers to the email address on the Resend account
//                      itself until you verify a domain in the Resend
//                      dashboard. Verify a domain before relying on this for
//                      real users.
//
// If RESEND_API_KEY isn't set, sendEmail() logs the message instead of
// throwing, so the rest of the password-reset flow still works end to end
// during local dev / before the key is configured — the reset link just
// shows up in the server logs instead of an inbox.

async function sendEmail({ to, subject, html }) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM || 'Kaf Musician Connect <onboarding@resend.dev>';

  if (!apiKey) {
    console.log(`[email] RESEND_API_KEY not set — not sending. Would have emailed ${to}: "${subject}"`);
    console.log(`[email] body:\n${html}`);
    return { sent: false, reason: 'no_api_key' };
  }

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from, to, subject, html }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.error(`[email] Resend API error ${res.status}: ${text}`);
      return { sent: false, reason: 'api_error' };
    }
    return { sent: true };
  } catch (err) {
    console.error('[email] failed to send via Resend:', err.message);
    return { sent: false, reason: 'network_error' };
  }
}

module.exports = { sendEmail };
