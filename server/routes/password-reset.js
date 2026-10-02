'use strict';

const crypto = require('crypto');
const db = require('../db');
const { HttpError } = require('../lib/router');
const auth = require('../lib/auth');
const { sendEmail } = require('../lib/email');
const { rateLimit } = require('../lib/rate-limit');

const RESET_TTL_MS = 60 * 60 * 1000; // 1 hour

// This endpoint sends an email per request, so beyond the usual
// brute-force concern it's also a cost/abuse vector on its own (someone
// could use it to spam an inbox with reset emails). Limit by IP and,
// separately, by the target email so the same inbox can't be flooded from
// many IPs either.
const forgotLimiterIp = rateLimit({ max: 10, windowMs: 60 * 60 * 1000, keyPrefix: 'forgot-ip' });
const forgotLimiterEmail = rateLimit({
  max: 4, windowMs: 60 * 60 * 1000, keyPrefix: 'forgot-email',
  keyFn: (ctx) => String(ctx.body.email || '').toLowerCase(),
});
// Reset tokens are unguessable 256-bit secrets, so this is defense-in-depth
// against a script just trying many random tokens.
const resetLimiterIp = rateLimit({ max: 20, windowMs: 15 * 60 * 1000, keyPrefix: 'reset-ip' });

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function register(router) {
  // Always responds with the same generic message whether or not the email
  // is registered — otherwise this endpoint would let anyone check which
  // emails have accounts.
  router.post('/api/auth/forgot-password', async (ctx) => {
    forgotLimiterIp(ctx);
    const generic = { ok: true, message: 'If an account exists for that email, a reset link has been sent.' };
    const { email } = ctx.body;
    if (!email) return generic;
    // Keyed on the actual target address, so this runs after the empty-email
    // short-circuit above (no point bucketing "" requests together).
    forgotLimiterEmail(ctx);

    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(String(email).toLowerCase());
    if (!user) return generic;

    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + RESET_TTL_MS).toISOString();
    // Only one active reset link per user at a time — a new request
    // invalidates any earlier one.
    db.prepare('DELETE FROM password_reset_tokens WHERE user_id = ?').run(user.id);
    db.prepare(
      'INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES (?, ?, ?)'
    ).run(user.id, hashToken(token), expiresAt);

    const proto = ctx.req.headers['x-forwarded-proto'] || 'http';
    const origin = `${proto}://${ctx.req.headers.host}`;
    const link = `${origin}/?resetToken=${token}`;

    await sendEmail({
      to: user.email,
      subject: 'Reset your Kaf Musician Connect password',
      html: `
        <p>Hi ${user.name},</p>
        <p>We got a request to reset your Kaf Musician Connect password. Click the link below to
        choose a new one. This link works once and expires in 1 hour.</p>
        <p><a href="${link}">${link}</a></p>
        <p>If you didn't request this, you can safely ignore this email — your password won't change.</p>
      `,
    });

    return generic;
  });

  router.post('/api/auth/reset-password', async (ctx) => {
    resetLimiterIp(ctx);
    const { token, password } = ctx.body;
    if (!token || !password) throw new HttpError(400, 'Reset token and new password are required');
    if (String(password).length < 8) throw new HttpError(400, 'Password must be at least 8 characters');

    const row = db.prepare(
      `SELECT * FROM password_reset_tokens WHERE token_hash = ? AND expires_at > datetime('now')`
    ).get(hashToken(token));
    if (!row) throw new HttpError(400, 'This reset link is invalid or has expired. Request a new one.');

    const { hash, salt } = auth.hashPassword(password);

    db.exec('BEGIN');
    try {
      db.prepare('UPDATE users SET password_hash = ?, password_salt = ? WHERE id = ?').run(hash, salt, row.user_id);
      db.prepare('DELETE FROM password_reset_tokens WHERE user_id = ?').run(row.user_id);
      // Sign the account out everywhere — if someone else triggered this
      // reset maliciously, this also kicks them out of any active session.
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(row.user_id);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }

    return { ok: true, message: 'Password updated — you can log in with your new password now.' };
  });
}

module.exports = { register };
