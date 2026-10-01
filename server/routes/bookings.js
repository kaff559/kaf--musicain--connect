'use strict';

const db = require('../db');
const { HttpError } = require('../lib/router');
const {
  requireAuth, requireRole, requireConsentCleared, notify, calcServiceFee, serializeBooking,
} = require('../lib/helpers');

function loadBooking(id) {
  const b = db.prepare('SELECT * FROM bookings WHERE id = ?').get(id);
  if (!b) throw new HttpError(404, 'Booking not found');
  return b;
}

function musicianProfileOwnerCheck(user, profileId) {
  const p = db.prepare('SELECT * FROM musician_profiles WHERE id = ?').get(profileId);
  if (!p || p.user_id !== user.id) throw new HttpError(403, 'Not your musician profile');
  return p;
}

function register(router) {
  // Create a booking request (client -> musician)
  router.post('/api/bookings', async (ctx) => {
    const user = requireRole(ctx, 'client');
    requireConsentCleared(user);
    const b = ctx.body;
    const profile = db.prepare('SELECT * FROM musician_profiles WHERE id = ?').get(b.musicianProfileId);
    if (!profile) throw new HttpError(404, 'Musician not found');
    if (!b.eventDate) throw new HttpError(400, 'eventDate is required');
    if (b.isEmergency && !profile.emergency_available) {
      throw new HttpError(400, 'This musician has not opted into emergency/last-minute bookings');
    }
    const offeredRate = b.offeredRate != null ? parseFloat(b.offeredRate) : profile.hourly_rate;
    const duration = b.durationHours ? parseFloat(b.durationHours) : 1;
    const subtotal = offeredRate * duration;
    const serviceFee = calcServiceFee(subtotal);
    const total = Math.round((subtotal + serviceFee) * 100) / 100;

    const info = db.prepare(
      `INSERT INTO bookings (musician_profile_id, client_user_id, event_date, event_time, duration_hours,
       location, offered_rate, is_emergency, is_group, group_details, service_fee, total, event_type, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`
    ).run(
      profile.id, user.id, b.eventDate, b.eventTime || null, duration, b.location || null,
      offeredRate, b.isEmergency ? 1 : 0, b.isGroup ? 1 : 0, b.groupDetails || null, serviceFee, total,
      b.eventType || null
    );
    const booking = loadBooking(info.lastInsertRowid);
    notify(profile.user_id, `New${b.isEmergency ? ' EMERGENCY' : ''} booking request from ${user.name} for ${b.eventDate}`, b.isEmergency ? 'urgent' : 'booking');
    return { booking: serializeBooking(booking) };
  });

  // List bookings relevant to the current user (as client, or as musician via their profile)
  router.get('/api/bookings/mine', async (ctx) => {
    const user = requireAuth(ctx);
    let rows;
    if (user.role === 'client') {
      rows = db.prepare('SELECT * FROM bookings WHERE client_user_id = ? ORDER BY created_at DESC').all(user.id);
    } else if (user.role === 'musician') {
      const profile = db.prepare('SELECT * FROM musician_profiles WHERE user_id = ?').get(user.id);
      rows = profile ? db.prepare('SELECT * FROM bookings WHERE musician_profile_id = ? ORDER BY created_at DESC').all(profile.id) : [];
    } else {
      throw new HttpError(403, 'Not applicable for this role');
    }
    return { bookings: rows.map(serializeBooking) };
  });

  // Musician responds: accept | decline | counter
  router.post('/api/bookings/:id/respond', async (ctx) => {
    const user = requireRole(ctx, 'musician');
    const booking = loadBooking(ctx.params.id);
    musicianProfileOwnerCheck(user, booking.musician_profile_id);
    if (booking.status !== 'pending') throw new HttpError(400, `Booking is already ${booking.status}`);
    const { action, counterRate, counterNote } = ctx.body;
    if (!['accept', 'decline', 'counter'].includes(action)) throw new HttpError(400, 'action must be accept, decline, or counter');

    if (action === 'accept') {
      db.prepare("UPDATE bookings SET status='accepted', updated_at=datetime('now') WHERE id=?").run(booking.id);
      notify(booking.client_user_id, `Your booking request for ${booking.event_date} was accepted!`, 'booking');
    } else if (action === 'decline') {
      db.prepare("UPDATE bookings SET status='declined', updated_at=datetime('now') WHERE id=?").run(booking.id);
      notify(booking.client_user_id, `Your booking request for ${booking.event_date} was declined.`, 'booking');
    } else {
      if (counterRate == null) throw new HttpError(400, 'counterRate is required for a counter-offer');
      db.prepare("UPDATE bookings SET status='countered', counter_rate=?, counter_note=?, updated_at=datetime('now') WHERE id=?")
        .run(parseFloat(counterRate), counterNote || null, booking.id);
      notify(booking.client_user_id, `Counter-offer received for your ${booking.event_date} booking: $${counterRate}/hr`, 'booking');
    }
    return { booking: serializeBooking(loadBooking(booking.id)) };
  });

  // Client responds to a counter-offer: accept | decline
  router.post('/api/bookings/:id/counter-response', async (ctx) => {
    const user = requireRole(ctx, 'client');
    const booking = loadBooking(ctx.params.id);
    if (booking.client_user_id !== user.id) throw new HttpError(403, 'Not your booking');
    if (booking.status !== 'countered') throw new HttpError(400, 'No active counter-offer on this booking');
    const { action } = ctx.body;
    const profile = db.prepare('SELECT * FROM musician_profiles WHERE id = ?').get(booking.musician_profile_id);

    if (action === 'accept') {
      const subtotal = booking.counter_rate * booking.duration_hours;
      const serviceFee = calcServiceFee(subtotal);
      const total = Math.round((subtotal + serviceFee) * 100) / 100;
      db.prepare(
        "UPDATE bookings SET status='accepted', offered_rate=?, service_fee=?, total=?, updated_at=datetime('now') WHERE id=?"
      ).run(booking.counter_rate, serviceFee, total, booking.id);
      notify(profile.user_id, `Your counter-offer for ${booking.event_date} was accepted!`, 'booking');
    } else if (action === 'decline') {
      db.prepare("UPDATE bookings SET status='declined', updated_at=datetime('now') WHERE id=?").run(booking.id);
      notify(profile.user_id, `Your counter-offer for ${booking.event_date} was declined.`, 'booking');
    } else {
      throw new HttpError(400, 'action must be accept or decline');
    }
    return { booking: serializeBooking(loadBooking(booking.id)) };
  });

  router.post('/api/bookings/:id/cancel', async (ctx) => {
    const user = requireAuth(ctx);
    const booking = loadBooking(ctx.params.id);
    const profile = db.prepare('SELECT * FROM musician_profiles WHERE id = ?').get(booking.musician_profile_id);
    const isClient = booking.client_user_id === user.id;
    const isMusician = profile && profile.user_id === user.id;
    if (!isClient && !isMusician) throw new HttpError(403, 'Not your booking');
    if (['cancelled', 'completed', 'declined'].includes(booking.status)) throw new HttpError(400, `Booking is already ${booking.status}`);
    db.prepare("UPDATE bookings SET status='cancelled', cancellation_reason=?, updated_at=datetime('now') WHERE id=?")
      .run(ctx.body.reason || null, booking.id);
    const notifyUserId = isClient ? profile.user_id : booking.client_user_id;
    notify(notifyUserId, `Booking for ${booking.event_date} was cancelled by the ${isClient ? 'client' : 'musician'}.`, 'booking');
    return { booking: serializeBooking(loadBooking(booking.id)) };
  });

  router.post('/api/bookings/:id/complete', async (ctx) => {
    const user = requireAuth(ctx);
    const booking = loadBooking(ctx.params.id);
    const profile = db.prepare('SELECT * FROM musician_profiles WHERE id = ?').get(booking.musician_profile_id);
    const isClient = booking.client_user_id === user.id;
    const isMusician = profile && profile.user_id === user.id;
    if (!isClient && !isMusician) throw new HttpError(403, 'Not your booking');
    if (booking.status !== 'accepted') throw new HttpError(400, 'Only accepted bookings can be marked complete');
    db.prepare("UPDATE bookings SET status='completed', updated_at=datetime('now') WHERE id=?").run(booking.id);
    return { booking: serializeBooking(loadBooking(booking.id)) };
  });

  // No-show reporting & consequences:
  // - musician no-show: client is refunded (conceptually — no real payment
  //   processor here), musician forfeits the service fee and takes a strike.
  // - client no-show: musician may invoice separately; no refund is owed.
  router.post('/api/bookings/:id/no-show', async (ctx) => {
    const user = requireAuth(ctx);
    const booking = loadBooking(ctx.params.id);
    const profile = db.prepare('SELECT * FROM musician_profiles WHERE id = ?').get(booking.musician_profile_id);
    const isClient = booking.client_user_id === user.id;
    const isMusician = profile && profile.user_id === user.id;
    if (!isClient && !isMusician) throw new HttpError(403, 'Not your booking');
    if (booking.status !== 'accepted') throw new HttpError(400, 'Only accepted bookings can be reported as a no-show');
    const { party, report } = ctx.body; // party = 'client' | 'musician' — who failed to show
    if (!['client', 'musician'].includes(party)) throw new HttpError(400, 'party must be client or musician');

    const newStatus = party === 'musician' ? 'no_show_musician' : 'no_show_client';
    db.prepare("UPDATE bookings SET status=?, no_show_report=?, no_show_party=?, updated_at=datetime('now') WHERE id=?")
      .run(newStatus, report || null, party, booking.id);

    if (party === 'musician') {
      db.prepare('UPDATE musician_profiles SET strikes = strikes + 1 WHERE id = ?').run(profile.id);
      notify(booking.client_user_id, `Musician no-show confirmed for ${booking.event_date}. You'll be refunded in full and the platform fee is forfeited by the musician.`, 'no_show');
      notify(profile.user_id, `A no-show was reported against you for ${booking.event_date}. This adds a strike to your profile.`, 'no_show');
    } else {
      notify(profile.user_id, `Client no-show confirmed for ${booking.event_date}. No refund is owed; you may invoice the client separately outside the platform.`, 'no_show');
      notify(booking.client_user_id, `A no-show was reported against you for ${booking.event_date}.`, 'no_show');
    }
    return { booking: serializeBooking(loadBooking(booking.id)) };
  });

  router.post('/api/bookings/:id/review', async (ctx) => {
    const user = requireRole(ctx, 'client');
    const booking = loadBooking(ctx.params.id);
    if (booking.client_user_id !== user.id) throw new HttpError(403, 'Not your booking');
    if (booking.status !== 'completed') throw new HttpError(400, 'Only completed bookings can be reviewed');
    const { rating, comment } = ctx.body;
    const r = parseInt(rating, 10);
    if (!r || r < 1 || r > 5) throw new HttpError(400, 'rating must be 1-5');
    const existing = db.prepare('SELECT id FROM reviews WHERE musician_profile_id = ? AND client_user_id = ?').get(booking.musician_profile_id, user.id);
    if (existing) throw new HttpError(409, 'You already reviewed this musician');
    db.prepare('INSERT INTO reviews (musician_profile_id, client_user_id, rating, comment) VALUES (?, ?, ?, ?)')
      .run(booking.musician_profile_id, user.id, r, comment || null);
    const profile = db.prepare('SELECT * FROM musician_profiles WHERE id = ?').get(booking.musician_profile_id);
    notify(profile.user_id, `${user.name} left you a ${r}-star review.`, 'review');
    return { ok: true };
  });
}

module.exports = { register };
