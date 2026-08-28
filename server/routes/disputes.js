'use strict';

const db = require('../db');
const { HttpError } = require('../lib/router');
const { requireAuth } = require('../lib/helpers');

function register(router) {
  router.post('/api/disputes', async (ctx) => {
    const user = requireAuth(ctx);
    const { bookingId, rentalId, reason } = ctx.body;
    if (!reason || !String(reason).trim()) throw new HttpError(400, 'reason is required');
    if (!bookingId && !rentalId) throw new HttpError(400, 'bookingId or rentalId is required');
    if (bookingId) {
      const b = db.prepare('SELECT * FROM bookings WHERE id = ?').get(bookingId);
      if (!b) throw new HttpError(404, 'Booking not found');
    }
    if (rentalId) {
      const r = db.prepare('SELECT * FROM rentals WHERE id = ?').get(rentalId);
      if (!r) throw new HttpError(404, 'Rental not found');
    }
    const info = db.prepare(
      'INSERT INTO disputes (booking_id, rental_id, filed_by_user_id, reason) VALUES (?, ?, ?, ?)'
    ).run(bookingId || null, rentalId || null, user.id, String(reason).trim());
    return { id: Number(info.lastInsertRowid), ok: true };
  });

  router.get('/api/disputes/mine', async (ctx) => {
    const user = requireAuth(ctx);
    const rows = db.prepare('SELECT * FROM disputes WHERE filed_by_user_id = ? ORDER BY created_at DESC').all(user.id);
    return {
      disputes: rows.map((d) => ({
        id: d.id, bookingId: d.booking_id, rentalId: d.rental_id, reason: d.reason,
        status: d.status, resolution: d.resolution, createdAt: d.created_at,
      })),
    };
  });
}

module.exports = { register };
