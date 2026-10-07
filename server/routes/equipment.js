'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('../db');
const { HttpError } = require('../lib/router');
const { requireRole, requireConsentCleared, equipmentOwnerProfileForUser, serializeEquipment, parseJsonSafe } = require('../lib/helpers');

// Profile pictures for equipment-owner business accounts — same approach and
// disk location as musician profile photos (server/routes/musicians.js).
const AVATAR_UPLOADS_DIR = path.join(__dirname, '..', '..', 'data', 'uploads', 'avatars');
const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
const PHOTO_EXT_BY_MIME = {
  'image/jpeg': '.jpg', 'image/jpg': '.jpg', 'image/png': '.png',
  'image/webp': '.webp', 'image/gif': '.gif',
};

function serializeOwnerProfile(p) {
  return {
    id: p.id, businessName: p.business_name, bio: p.bio, city: p.city, state: p.state,
    country: p.country, photoUrl: p.photo_url || null, idVerified: !!p.id_verified,
    paypalConnected: !!p.paypal_email,
  };
}

function register(router) {
  router.post('/api/equipment-owner/profile', async (ctx) => {
    const user = requireRole(ctx, 'equipment_owner');
    const p = equipmentOwnerProfileForUser(user.id);
    if (!p) throw new HttpError(404, 'Profile not found');
    const b = ctx.body;
    db.prepare('UPDATE equipment_owner_profiles SET business_name=?, bio=?, city=?, state=?, country=? WHERE id=?')
      .run(b.businessName || p.business_name, b.bio != null ? b.bio : p.bio, b.city != null ? b.city : p.city, b.state != null ? b.state : p.state, b.country != null ? b.country : p.country, p.id);
    const updated = equipmentOwnerProfileForUser(user.id);
    return { profile: serializeOwnerProfile(updated) };
  });

  router.post('/api/equipment-owner/photo-upload', async (ctx) => {
    const user = requireRole(ctx, 'equipment_owner');
    const p = equipmentOwnerProfileForUser(user.id);
    if (!p) throw new HttpError(404, 'Profile not found');
    const b = ctx.body;
    if (!b.dataBase64 || !b.mimeType) throw new HttpError(400, 'dataBase64 and mimeType are required');
    if (!/^image\//.test(b.mimeType)) throw new HttpError(400, 'Only image files can be used as a profile photo');
    let buffer;
    try {
      buffer = Buffer.from(b.dataBase64, 'base64');
    } catch (e) {
      throw new HttpError(400, 'Could not decode file data');
    }
    if (!buffer.length) throw new HttpError(400, 'File appears to be empty');
    if (buffer.length > MAX_PHOTO_BYTES) throw new HttpError(413, 'Profile photos must be under 5MB');

    const ext = PHOTO_EXT_BY_MIME[b.mimeType] || path.extname(b.fileName || '') || '';
    const safeName = `owner-${p.id}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}${ext}`;
    fs.mkdirSync(AVATAR_UPLOADS_DIR, { recursive: true });
    fs.writeFileSync(path.join(AVATAR_UPLOADS_DIR, safeName), buffer);

    const oldUrl = p.photo_url;
    db.prepare('UPDATE equipment_owner_profiles SET photo_url = ? WHERE id = ?').run(`/uploads/avatars/${safeName}`, p.id);
    if (oldUrl && oldUrl.startsWith('/uploads/avatars/')) {
      fs.unlink(path.join(AVATAR_UPLOADS_DIR, path.basename(oldUrl)), () => {});
    }
    const updated = equipmentOwnerProfileForUser(user.id);
    return { profile: serializeOwnerProfile(updated) };
  });

  router.post('/api/equipment-owner/photo-delete', async (ctx) => {
    const user = requireRole(ctx, 'equipment_owner');
    const p = equipmentOwnerProfileForUser(user.id);
    if (!p) throw new HttpError(404, 'Profile not found');
    if (p.photo_url && p.photo_url.startsWith('/uploads/avatars/')) {
      fs.unlink(path.join(AVATAR_UPLOADS_DIR, path.basename(p.photo_url)), () => {});
    }
    db.prepare('UPDATE equipment_owner_profiles SET photo_url = NULL WHERE id = ?').run(p.id);
    const updated = equipmentOwnerProfileForUser(user.id);
    return { profile: serializeOwnerProfile(updated) };
  });

  router.post('/api/equipment-owner/verify-id', async (ctx) => {
    const user = requireRole(ctx, 'equipment_owner');
    const p = equipmentOwnerProfileForUser(user.id);
    if (!p) throw new HttpError(404, 'Profile not found');
    db.prepare('UPDATE equipment_owner_profiles SET id_verified = 1 WHERE id = ?').run(p.id);
    return { ok: true };
  });

  router.post('/api/equipment', async (ctx) => {
    const user = requireRole(ctx, 'equipment_owner');
    requireConsentCleared(user);
    const owner = equipmentOwnerProfileForUser(user.id);
    if (!owner) throw new HttpError(404, 'Equipment owner profile not found');
    const b = ctx.body;
    if (!b.title || !b.category) throw new HttpError(400, 'title and category are required');
    if (b.dailyRate == null || parseFloat(b.dailyRate) <= 0) throw new HttpError(400, 'dailyRate must be greater than 0');
    const info = db.prepare(
      `INSERT INTO equipment (owner_profile_id, category, title, description, daily_rate, security_deposit, photos)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      owner.id, b.category, b.title, b.description || '', parseFloat(b.dailyRate),
      b.securityDeposit != null ? parseFloat(b.securityDeposit) : 0,
      JSON.stringify(Array.isArray(b.photos) ? b.photos : [])
    );
    const row = db.prepare('SELECT * FROM equipment WHERE id = ?').get(info.lastInsertRowid);
    return { equipment: serializeEquipment(row) };
  });

  router.get('/api/equipment', async (ctx) => {
    let rows = db.prepare(
      `SELECT e.*, eop.business_name, eop.city, eop.state, eop.country, eop.photo_url AS owner_photo_url FROM equipment e
       JOIN equipment_owner_profiles eop ON eop.id = e.owner_profile_id
       WHERE e.available = 1`
    ).all();
    const category = ctx.query.category;
    const maxDaily = ctx.query.maxDaily ? parseFloat(ctx.query.maxDaily) : null;
    const q = (ctx.query.q || '').toLowerCase().trim();
    if (category) rows = rows.filter((r) => r.category.toLowerCase() === category.toLowerCase());
    if (maxDaily != null) rows = rows.filter((r) => r.daily_rate <= maxDaily);
    if (q) rows = rows.filter((r) => `${r.title} ${r.description} ${r.category}`.toLowerCase().includes(q));
    return { equipment: rows.map((r) => ({ ...serializeEquipment(r), ownerBusinessName: r.business_name, ownerCity: r.city, ownerState: r.state, ownerCountry: r.country, ownerPhotoUrl: r.owner_photo_url || null })) };
  });

  router.get('/api/equipment/mine', async (ctx) => {
    const user = requireRole(ctx, 'equipment_owner');
    const owner = equipmentOwnerProfileForUser(user.id);
    if (!owner) return { equipment: [] };
    const rows = db.prepare('SELECT * FROM equipment WHERE owner_profile_id = ? ORDER BY created_at DESC').all(owner.id);
    return { equipment: rows.map(serializeEquipment) };
  });

  router.get('/api/equipment/:id', async (ctx) => {
    const row = db.prepare(
      `SELECT e.*, eop.business_name, eop.city, eop.state, eop.country, eop.id_verified, eop.photo_url AS owner_photo_url FROM equipment e
       JOIN equipment_owner_profiles eop ON eop.id = e.owner_profile_id WHERE e.id = ?`
    ).get(ctx.params.id);
    if (!row) throw new HttpError(404, 'Equipment not found');
    return { equipment: { ...serializeEquipment(row), ownerBusinessName: row.business_name, ownerCity: row.city, ownerState: row.state, ownerCountry: row.country, ownerIdVerified: !!row.id_verified, ownerPhotoUrl: row.owner_photo_url || null } };
  });

  router.patch('/api/equipment/:id', async (ctx) => {
    const user = requireRole(ctx, 'equipment_owner');
    const owner = equipmentOwnerProfileForUser(user.id);
    const row = db.prepare('SELECT * FROM equipment WHERE id = ?').get(ctx.params.id);
    if (!row) throw new HttpError(404, 'Equipment not found');
    if (!owner || row.owner_profile_id !== owner.id) throw new HttpError(403, 'Not your listing');
    const b = ctx.body;
    db.prepare(
      `UPDATE equipment SET title=?, description=?, daily_rate=?, security_deposit=?, category=?, available=?, photos=? WHERE id=?`
    ).run(
      b.title != null ? b.title : row.title,
      b.description != null ? b.description : row.description,
      b.dailyRate != null ? parseFloat(b.dailyRate) : row.daily_rate,
      b.securityDeposit != null ? parseFloat(b.securityDeposit) : row.security_deposit,
      b.category != null ? b.category : row.category,
      b.available != null ? (b.available ? 1 : 0) : row.available,
      JSON.stringify(Array.isArray(b.photos) ? b.photos : parseJsonSafe(row.photos, [])),
      row.id
    );
    return { equipment: serializeEquipment(db.prepare('SELECT * FROM equipment WHERE id = ?').get(row.id)) };
  });

  router.delete('/api/equipment/:id', async (ctx) => {
    const user = requireRole(ctx, 'equipment_owner');
    const owner = equipmentOwnerProfileForUser(user.id);
    const row = db.prepare('SELECT * FROM equipment WHERE id = ?').get(ctx.params.id);
    if (!row) throw new HttpError(404, 'Equipment not found');
    if (!owner || row.owner_profile_id !== owner.id) throw new HttpError(403, 'Not your listing');
    db.prepare('DELETE FROM equipment WHERE id = ?').run(row.id);
    return { ok: true };
  });
}

module.exports = { register };