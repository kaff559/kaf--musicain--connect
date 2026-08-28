'use strict';

const db = require('../db');
const { HttpError } = require('../lib/router');
const { requireRole, equipmentOwnerProfileForUser, serializeEquipment, parseJsonSafe } = require('../lib/helpers');

function register(router) {
  router.post('/api/equipment-owner/profile', async (ctx) => {
    const user = requireRole(ctx, 'equipment_owner');
    const p = equipmentOwnerProfileForUser(user.id);
    if (!p) throw new HttpError(404, 'Profile not found');
    const b = ctx.body;
    db.prepare('UPDATE equipment_owner_profiles SET business_name=?, bio=?, city=?, state=? WHERE id=?')
      .run(b.businessName || p.business_name, b.bio != null ? b.bio : p.bio, b.city != null ? b.city : p.city, b.state != null ? b.state : p.state, p.id);
    const updated = equipmentOwnerProfileForUser(user.id);
    return { profile: { id: updated.id, businessName: updated.business_name, bio: updated.bio, city: updated.city, state: updated.state, idVerified: !!updated.id_verified } };
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
      `SELECT e.*, eop.business_name, eop.city, eop.state FROM equipment e
       JOIN equipment_owner_profiles eop ON eop.id = e.owner_profile_id
       WHERE e.available = 1`
    ).all();
    const category = ctx.query.category;
    const maxDaily = ctx.query.maxDaily ? parseFloat(ctx.query.maxDaily) : null;
    const q = (ctx.query.q || '').toLowerCase().trim();
    if (category) rows = rows.filter((r) => r.category.toLowerCase() === category.toLowerCase());
    if (maxDaily != null) rows = rows.filter((r) => r.daily_rate <= maxDaily);
    if (q) rows = rows.filter((r) => `${r.title} ${r.description} ${r.category}`.toLowerCase().includes(q));
    return { equipment: rows.map((r) => ({ ...serializeEquipment(r), ownerBusinessName: r.business_name, ownerCity: r.city, ownerState: r.state })) };
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
      `SELECT e.*, eop.business_name, eop.city, eop.state, eop.id_verified FROM equipment e
       JOIN equipment_owner_profiles eop ON eop.id = e.owner_profile_id WHERE e.id = ?`
    ).get(ctx.params.id);
    if (!row) throw new HttpError(404, 'Equipment not found');
    return { equipment: { ...serializeEquipment(row), ownerBusinessName: row.business_name, ownerCity: row.city, ownerState: row.state, ownerIdVerified: !!row.id_verified } };
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
