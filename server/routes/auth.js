'use strict';

const crypto = require('crypto');
const db = require('../db');
const { HttpError } = require('../lib/router');
const auth = require('../lib/auth');
const { requireAuth, musicianProfileForUser, equipmentOwnerProfileForUser, serializeMusicianProfile, notify } = require('../lib/helpers');
const { sendEmail } = require('../lib/email');

const VALID_ROLES = ['musician', 'client', 'equipment_owner'];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DOB_RE = /^\d{4}-\d{2}-\d{2}$/;
const CONSENT_TTL_MS = 14 * 24 * 60 * 60 * 1000; // 2 weeks to give a guardian time to respond

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

// Age in whole years as of today, from a 'YYYY-MM-DD' string — computed
// server-side so a client can't just lie about being 18+.
function calcAge(dobStr) {
  const dob = new Date(`${dobStr}T00:00:00Z`);
  if (Number.isNaN(dob.getTime())) return null;
  const now = new Date();
  let age = now.getUTCFullYear() - dob.getUTCFullYear();
  const monthDiff = now.getUTCMonth() - dob.getUTCMonth();
  if (monthDiff < 0 || (monthDiff === 0 && now.getUTCDate() < dob.getUTCDate())) age--;
  return age;
}

function register(router) {
  router.post('/api/auth/signup', async (ctx) => {
    const { email, password, role, name, phone, dateOfBirth, guardianName, guardianEmail, termsAccepted } = ctx.body;
    if (!email || !EMAIL_RE.test(String(email))) throw new HttpError(400, 'Valid email is required');
    if (!password || String(password).length < 8) throw new HttpError(400, 'Password must be at least 8 characters');
    if (!name || !String(name).trim()) throw new HttpError(400, 'Name is required');
    if (!VALID_ROLES.includes(role)) throw new HttpError(400, 'Role must be musician, client, or equipment_owner');
    if (!termsAccepted) throw new HttpError(400, 'You must agree to the Terms of Service to create an account');
    if (!dateOfBirth || !DOB_RE.test(String(dateOfBirth))) throw new HttpError(400, 'Date of birth is required');

    const age = calcAge(dateOfBirth);
    if (age == null || age < 0 || age > 120) throw new HttpError(400, 'Please enter a valid date of birth');

    const isMinor = age < 18;
    let guardianNameTrim = null;
    let guardianEmailLower = null;
    if (isMinor) {
      if (!guardianName || !String(guardianName).trim()) throw new HttpError(400, "A parent or guardian's name is required for accounts under 18");
      if (!guardianEmail || !EMAIL_RE.test(String(guardianEmail))) throw new HttpError(400, 'A valid parent or guardian email is required for accounts under 18');
      guardianNameTrim = String(guardianName).trim();
      guardianEmailLower = String(guardianEmail).toLowerCase();
      if (guardianEmailLower === String(email).toLowerCase()) {
        throw new HttpError(400, 'The parent/guardian email must be different from your own account email');
      }
    }

    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(String(email).toLowerCase());
    if (existing) throw new HttpError(409, 'An account with this email already exists');

    const { hash, salt } = auth.hashPassword(password);
    const consentStatus = isMinor ? 'pending' : 'not_required';
    const info = db.prepare(
      `INSERT INTO users (email, password_hash, password_salt, role, name, phone, date_of_birth, guardian_name, guardian_email, consent_status, terms_accepted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
    ).run(
      String(email).toLowerCase(), hash, salt, role, String(name).trim(), phone || null,
      String(dateOfBirth), guardianNameTrim, guardianEmailLower, consentStatus
    );

    const userId = Number(info.lastInsertRowid);

    if (role === 'musician') {
      db.prepare(
        'INSERT INTO musician_profiles (user_id, stage_name, hourly_rate) VALUES (?, ?, ?)'
      ).run(userId, String(name).trim(), 0);
    } else if (role === 'equipment_owner') {
      db.prepare(
        'INSERT INTO equipment_owner_profiles (user_id, business_name) VALUES (?, ?)'
      ).run(userId, String(name).trim());
    }

    const session = auth.createSession(userId);
    auth.setSessionCookie(ctx.res, session.token);
    notify(userId, `Welcome to Musician Connect, ${String(name).trim()}!`, 'welcome');

    if (isMinor) {
      const token = crypto.randomBytes(32).toString('hex');
      const expiresAt = new Date(Date.now() + CONSENT_TTL_MS).toISOString();
      db.prepare(
        'INSERT INTO parental_consent_tokens (user_id, token_hash, expires_at) VALUES (?, ?, ?)'
      ).run(userId, hashToken(token), expiresAt);

      const proto = ctx.req.headers['x-forwarded-proto'] || 'http';
      const origin = `${proto}://${ctx.req.headers.host}`;
      const link = `${origin}/?consentToken=${token}`;
      const trimmedName = String(name).trim();

      await sendEmail({
        to: guardianEmailLower,
        subject: `${trimmedName} wants to join Kaf Musician Connect — your approval is needed`,
        html: `
          <p>Hi ${guardianNameTrim},</p>
          <p>${trimmedName} (age ${age}) listed you as their parent or guardian and signed up for
          Kaf Musician Connect, a marketplace for booking musicians, singers, DJs, MCs and event equipment.</p>
          <p>Because they're under 18, we need your approval before the account can post a profile, apply to or
          post jobs, or make bookings. Review the request and respond here:</p>
          <p><a href="${link}">${link}</a></p>
          <p>If you didn't expect this or don't approve, you can decline on that page and the account will stay restricted.
          This link expires in 14 days.</p>
        `,
      });
      notify(userId, `We emailed ${guardianNameTrim} at ${guardianEmailLower} for approval. Your account is limited until they confirm.`, 'info');
    }

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    return { user: auth.sanitizeUser(user) };
  });

  // Public lookup so the consent landing page can show who/what it's
  // confirming before the guardian decides — no login required, the token
  // itself (emailed only to the guardian) is the credential.
  router.get('/api/auth/consent/:token', async (ctx) => {
    const row = db.prepare(
      `SELECT * FROM parental_consent_tokens WHERE token_hash = ? AND expires_at > datetime('now')`
    ).get(hashToken(ctx.params.token));
    if (!row) throw new HttpError(400, 'This approval link is invalid or has expired.');
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(row.user_id);
    if (!user) throw new HttpError(404, 'Account not found');
    return {
      minorName: user.name, minorEmail: user.email, role: user.role,
      guardianName: user.guardian_name, status: user.consent_status,
    };
  });

  router.post('/api/auth/consent/confirm', async (ctx) => {
    const { token, decision } = ctx.body;
    if (!token || !['approve', 'deny'].includes(decision)) throw new HttpError(400, 'Invalid request');
    const row = db.prepare(
      `SELECT * FROM parental_consent_tokens WHERE token_hash = ? AND expires_at > datetime('now')`
    ).get(hashToken(token));
    if (!row) throw new HttpError(400, 'This approval link is invalid or has expired.');
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(row.user_id);
    if (!user) throw new HttpError(404, 'Account not found');

    const newStatus = decision === 'approve' ? 'approved' : 'denied';
    db.prepare('UPDATE users SET consent_status = ? WHERE id = ?').run(newStatus, user.id);
    db.prepare('DELETE FROM parental_consent_tokens WHERE user_id = ?').run(user.id);
    notify(
      user.id,
      decision === 'approve'
        ? 'Your parent/guardian approved your account — you have full access now.'
        : 'Your parent/guardian did not approve your account. Contact support if this seems wrong.',
      decision === 'approve' ? 'success' : 'warning'
    );
    return { ok: true, status: newStatus, minorName: user.name };
  });

  router.post('/api/auth/login', async (ctx) => {
    const { email, password } = ctx.body;
    if (!email || !password) throw new HttpError(400, 'Email and password are required');
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(String(email).toLowerCase());
    if (!user || !user.password_salt || !user.password_hash || !auth.verifyPassword(password, user.password_salt, user.password_hash)) {
      throw new HttpError(401, 'Invalid email or password');
    }
    const session = auth.createSession(user.id);
    auth.setSessionCookie(ctx.res, session.token);
    return { user: auth.sanitizeUser(user) };
  });

  router.post('/api/auth/logout', async (ctx) => {
    const cookies = auth.parseCookies(ctx.req);
    const token = cookies[auth.SESSION_COOKIE];
    if (token) auth.destroySession(token);
    auth.clearSessionCookie(ctx.res);
    return { ok: true };
  });

  router.get('/api/auth/me', async (ctx) => {
    if (!ctx.user) return { user: null };
    const result = { user: auth.sanitizeUser(ctx.user) };
    if (ctx.user.role === 'musician') {
      result.musicianProfile = serializeMusicianProfile(musicianProfileForUser(ctx.user.id));
    } else if (ctx.user.role === 'equipment_owner') {
      const p = equipmentOwnerProfileForUser(ctx.user.id);
      result.equipmentOwnerProfile = p ? {
        id: p.id, businessName: p.business_name, bio: p.bio, city: p.city, state: p.state,
        country: p.country, photoUrl: p.photo_url || null,
        idVerified: !!p.id_verified,
        stripeConnected: !!p.stripe_account_id,
        stripePayoutsEnabled: !!p.stripe_payouts_enabled,
        createdAt: p.created_at,
      } : null;
    }
    return result;
  });
}

module.exports = { register };
