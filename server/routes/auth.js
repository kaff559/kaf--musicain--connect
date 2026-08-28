'use strict';

const db = require('../db');
const { HttpError } = require('../lib/router');
const auth = require('../lib/auth');
const { requireAuth, musicianProfileForUser, equipmentOwnerProfileForUser, serializeMusicianProfile, notify } = require('../lib/helpers');

const VALID_ROLES = ['musician', 'client', 'equipment_owner'];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function register(router) {
  router.post('/api/auth/signup', async (ctx) => {
    const { email, password, role, name, phone } = ctx.body;
    if (!email || !EMAIL_RE.test(String(email))) throw new HttpError(400, 'Valid email is required');
    if (!password || String(password).length < 8) throw new HttpError(400, 'Password must be at least 8 characters');
    if (!name || !String(name).trim()) throw new HttpError(400, 'Name is required');
    if (!VALID_ROLES.includes(role)) throw new HttpError(400, 'Role must be musician, client, or equipment_owner');

    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(String(email).toLowerCase());
    if (existing) throw new HttpError(409, 'An account with this email already exists');

    const { hash, salt } = auth.hashPassword(password);
    const info = db.prepare(
      'INSERT INTO users (email, password_hash, password_salt, role, name, phone) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(String(email).toLowerCase(), hash, salt, role, String(name).trim(), phone || null);

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

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    return { user: auth.sanitizeUser(user) };
  });

  router.post('/api/auth/login', async (ctx) => {
    const { email, password } = ctx.body;
    if (!email || !password) throw new HttpError(400, 'Email and password are required');
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(String(email).toLowerCase());
    if (!user || !auth.verifyPassword(password, user.password_salt, user.password_hash)) {
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
        idVerified: !!p.id_verified, createdAt: p.created_at,
      } : null;
    }
    return result;
  });
}

module.exports = { register };
