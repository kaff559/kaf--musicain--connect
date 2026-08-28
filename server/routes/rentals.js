'use strict';

const db = require('../db');
const { HttpError } = require('../lib/router');
const { requireRole, requireAuth, notify, calcServiceFee, serializeRental, equipmentOwnerProfileForUser } = require('../lib/helpers');

function daysBetween(start, end) {
  const s = new Date(start + 'T00:00:00Z');
  const e = new Date(end + 'T00:00:00Z');
  const diff = Math.round((e - s) / (1000 * 60 * 60 * 24));
  return diff + 1; // inclusive of both start and end day
}

function loadRental(id) {
  const r = db.prepare('SELECT * FROM rentals WHERE id = ?').get(id);
  if (!r) throw new HttpError(404, 'Rental request not found');
  return r;
}

function register(router) {
  router.post('/api/rentals', async (ctx) => {
    const user = requireRole(ctx, 'client');
    const b = ctx.body;
    const item = db.prepare('SELECT * FROM equipment WHERE id = ?').get(b.equipmentId);
    if (!item) throw new HttpError(404, 'Equipment not found');
    if (!item.available) throw new HttpError(400, 'This equipment is not currently available');
    if (!b.startDate || !b.endDate) throw new HttpError(400, 'startDate and endDate are required');
    const days = daysBetween(b.startDate, b.endDate);
    if (days < 1) throw new HttpError(400, 'endDate must be on or after startDate');

    const rentalFee = Math.round(item.daily_rate * days * 100) / 100;
    const serviceFee = calcServiceFee(rentalFee);
    const total = Math.round((rentalFee + serviceFee + item.security_deposit) * 100) / 100;

    const info = db.prepare(
      `INSERT INTO rentals (equipment_id, client_user_id, start_date, end_date, daily_rate, days, rental_fee, service_fee, deposit, total, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`
    ).run(item.id, user.id, b.startDate, b.endDate, item.daily_rate, days, rentalFee, serviceFee, item.security_deposit, total);

    const owner = db.prepare('SELECT * FROM equipment_owner_profiles WHERE id = ?').get(item.owner_profile_id);
    notify(owner.user_id, `New rental request for "${item.title}" (${b.startDate} to ${b.endDate}) from ${user.name}`, 'rental');
    return { rental: serializeRental(loadRental(info.lastInsertRowid)) };
  });

  router.get('/api/rentals/mine', async (ctx) => {
    const user = requireAuth(ctx);
    let rows;
    if (user.role === 'client') {
      rows = db.prepare('SELECT * FROM rentals WHERE client_user_id = ? ORDER BY created_at DESC').all(user.id);
    } else if (user.role === 'equipment_owner') {
      const owner = equipmentOwnerProfileForUser(user.id);
      rows = owner ? db.prepare(
        `SELECT r.* FROM rentals r JOIN equipment e ON e.id = r.equipment_id
         WHERE e.owner_profile_id = ? ORDER BY r.created_at DESC`
      ).all(owner.id) : [];
    } else {
      throw new HttpError(403, 'Not applicable for this role');
    }
    return { rentals: rows.map(serializeRental) };
  });

  router.post('/api/rentals/:id/respond', async (ctx) => {
    const user = requireRole(ctx, 'equipment_owner');
    const rental = loadRental(ctx.params.id);
    const item = db.prepare('SELECT * FROM equipment WHERE id = ?').get(rental.equipment_id);
    const owner = equipmentOwnerProfileForUser(user.id);
    if (!owner || item.owner_profile_id !== owner.id) throw new HttpError(403, 'Not your equipment');
    if (rental.status !== 'pending') throw new HttpError(400, `Rental is already ${rental.status}`);
    const { action } = ctx.body;
    if (!['accept', 'decline'].includes(action)) throw new HttpError(400, 'action must be accept or decline');
    const newStatus = action === 'accept' ? 'accepted' : 'declined';
    db.prepare("UPDATE rentals SET status=?, updated_at=datetime('now') WHERE id=?").run(newStatus, rental.id);
    notify(rental.client_user_id, `Your rental request for "${item.title}" was ${newStatus}.`, 'rental');
    return { rental: serializeRental(loadRental(rental.id)) };
  });

  router.post('/api/rentals/:id/cancel', async (ctx) => {
    const user = requireAuth(ctx);
    const rental = loadRental(ctx.params.id);
    const item = db.prepare('SELECT * FROM equipment WHERE id = ?').get(rental.equipment_id);
    const owner = equipmentOwnerProfileForUser(user.id) || {};
    const isClient = rental.client_user_id === user.id;
    const isOwner = item.owner_profile_id === owner.id;
    if (!isClient && !isOwner) throw new HttpError(403, 'Not your rental');
    if (['cancelled', 'completed', 'declined'].includes(rental.status)) throw new HttpError(400, `Rental is already ${rental.status}`);
    db.prepare("UPDATE rentals SET status='cancelled', updated_at=datetime('now') WHERE id=?").run(rental.id);
    const ownerUserId = db.prepare('SELECT user_id FROM equipment_owner_profiles WHERE id=?').get(item.owner_profile_id).user_id;
    const notifyUserId = isClient ? ownerUserId : rental.client_user_id;
    notify(notifyUserId, `Rental for "${item.title}" was cancelled.`, 'rental');
    return { rental: serializeRental(loadRental(rental.id)) };
  });

  router.post('/api/rentals/:id/complete', async (ctx) => {
    const user = requireAuth(ctx);
    const rental = loadRental(ctx.params.id);
    const item = db.prepare('SELECT * FROM equipment WHERE id = ?').get(rental.equipment_id);
    const owner = equipmentOwnerProfileForUser(user.id) || {};
    const isClient = rental.client_user_id === user.id;
    const isOwner = item.owner_profile_id === owner.id;
    if (!isClient && !isOwner) throw new HttpError(403, 'Not your rental');
    if (rental.status !== 'accepted') throw new HttpError(400, 'Only accepted rentals can be marked complete');
    db.prepare("UPDATE rentals SET status='completed', updated_at=datetime('now') WHERE id=?").run(rental.id);
    return { rental: serializeRental(loadRental(rental.id)) };
  });
}

module.exports = { register };
