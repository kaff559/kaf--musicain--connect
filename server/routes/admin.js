'use strict';

const db = require('../db');
const { HttpError } = require('../lib/router');
const { requireRole, notify } = require('../lib/helpers');
const auth = require('../lib/auth');

function register(router) {
  router.get('/api/admin/users', async (ctx) => {
    requireRole(ctx, 'admin');
    const rows = db.prepare('SELECT * FROM users ORDER BY created_at DESC').all();
    return { users: rows.map(auth.sanitizeUser) };
  });

  router.post('/api/admin/users/:id/suspend', async (ctx) => {
    requireRole(ctx, 'admin');
    const target = db.prepare('SELECT * FROM users WHERE id = ?').get(ctx.params.id);
    if (!target) throw new HttpError(404, 'User not found');
    const reason = ctx.body.reason || 'Policy violation';
    db.prepare('UPDATE users SET suspended = 1, suspension_reason = ? WHERE id = ?').run(reason, target.id);

    // Auto-refund: cancel any pending/accepted bookings or rentals tied to this
    // user and notify the counterparty that a refund is due, mirroring the
    // static prototype's auto-refund-on-suspension behavior.
    if (target.role === 'musician') {
      const profile = db.prepare('SELECT * FROM musician_profiles WHERE user_id = ?').get(target.id);
      if (profile) {
        const affected = db.prepare("SELECT * FROM bookings WHERE musician_profile_id = ? AND status IN ('pending','accepted')").all(profile.id);
        affected.forEach((b) => {
          db.prepare("UPDATE bookings SET status='cancelled', cancellation_reason='Musician account suspended', updated_at=datetime('now') WHERE id=?").run(b.id);
          notify(b.client_user_id, `Your booking for ${b.event_date} was cancelled because the musician's account was suspended. You will be refunded in full.`, 'admin');
        });
      }
    } else if (target.role === 'client') {
      const affectedBookings = db.prepare("SELECT * FROM bookings WHERE client_user_id = ? AND status IN ('pending','accepted')").all(target.id);
      affectedBookings.forEach((b) => {
        const profile = db.prepare('SELECT * FROM musician_profiles WHERE id = ?').get(b.musician_profile_id);
        db.prepare("UPDATE bookings SET status='cancelled', cancellation_reason='Client account suspended', updated_at=datetime('now') WHERE id=?").run(b.id);
        if (profile) notify(profile.user_id, `A booking for ${b.event_date} was cancelled because the client's account was suspended.`, 'admin');
      });
      const affectedRentals = db.prepare("SELECT * FROM rentals WHERE client_user_id = ? AND status IN ('pending','accepted')").all(target.id);
      affectedRentals.forEach((r) => {
        db.prepare("UPDATE rentals SET status='cancelled', updated_at=datetime('now') WHERE id=?").run(r.id);
      });
    } else if (target.role === 'equipment_owner') {
      const owner = db.prepare('SELECT * FROM equipment_owner_profiles WHERE user_id = ?').get(target.id);
      if (owner) {
        const items = db.prepare('SELECT id FROM equipment WHERE owner_profile_id = ?').all(owner.id).map((r) => r.id);
        if (items.length) {
          const placeholders = items.map(() => '?').join(',');
          const affected = db.prepare(`SELECT * FROM rentals WHERE equipment_id IN (${placeholders}) AND status IN ('pending','accepted')`).all(...items);
          affected.forEach((r) => {
            db.prepare("UPDATE rentals SET status='cancelled', updated_at=datetime('now') WHERE id=?").run(r.id);
            notify(r.client_user_id, `Your rental was cancelled because the equipment owner's account was suspended. You will be refunded in full.`, 'admin');
          });
        }
      }
    }

    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(target.id);
    notify(target.id, `Your account has been suspended. Reason: ${reason}`, 'admin');
    return { user: auth.sanitizeUser(db.prepare('SELECT * FROM users WHERE id = ?').get(target.id)) };
  });

  router.post('/api/admin/users/:id/reinstate', async (ctx) => {
    requireRole(ctx, 'admin');
    const target = db.prepare('SELECT * FROM users WHERE id = ?').get(ctx.params.id);
    if (!target) throw new HttpError(404, 'User not found');
    db.prepare('UPDATE users SET suspended = 0, suspension_reason = NULL WHERE id = ?').run(target.id);
    notify(target.id, 'Your account has been reinstated.', 'admin');
    return { user: auth.sanitizeUser(db.prepare('SELECT * FROM users WHERE id = ?').get(target.id)) };
  });

  router.get('/api/admin/reports', async (ctx) => {
    requireRole(ctx, 'admin');
    const rows = db.prepare(
      `SELECT r.*, u1.name AS reporter_name, u2.name AS reported_user_name
       FROM reports r JOIN users u1 ON u1.id = r.reporter_user_id
       LEFT JOIN users u2 ON u2.id = r.reported_user_id
       ORDER BY r.created_at DESC`
    ).all();
    return {
      reports: rows.map((r) => ({
        id: r.id, reason: r.reason, status: r.status, createdAt: r.created_at,
        reporterName: r.reporter_name, reportedUserName: r.reported_user_name,
        reportedMusicianProfileId: r.reported_musician_profile_id,
      })),
    };
  });

  router.post('/api/admin/reports/:id/resolve', async (ctx) => {
    requireRole(ctx, 'admin');
    const r = db.prepare('SELECT * FROM reports WHERE id = ?').get(ctx.params.id);
    if (!r) throw new HttpError(404, 'Report not found');
    db.prepare("UPDATE reports SET status='resolved' WHERE id = ?").run(r.id);
    return { ok: true };
  });

  router.get('/api/admin/disputes', async (ctx) => {
    requireRole(ctx, 'admin');
    const rows = db.prepare(
      `SELECT d.*, u.name AS filed_by_name FROM disputes d JOIN users u ON u.id = d.filed_by_user_id ORDER BY d.created_at DESC`
    ).all();
    return {
      disputes: rows.map((d) => ({
        id: d.id, bookingId: d.booking_id, rentalId: d.rental_id, reason: d.reason,
        status: d.status, resolution: d.resolution, createdAt: d.created_at, filedByName: d.filed_by_name,
      })),
    };
  });

  router.post('/api/admin/disputes/:id/resolve', async (ctx) => {
    requireRole(ctx, 'admin');
    const d = db.prepare('SELECT * FROM disputes WHERE id = ?').get(ctx.params.id);
    if (!d) throw new HttpError(404, 'Dispute not found');
    const resolution = ctx.body.resolution || '';
    db.prepare("UPDATE disputes SET status='resolved', resolution=? WHERE id=?").run(resolution, d.id);
    notify(d.filed_by_user_id, `Your dispute has been resolved: ${resolution}`, 'admin');
    return { ok: true };
  });
}

module.exports = { register };
