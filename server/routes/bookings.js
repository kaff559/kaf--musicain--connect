'use strict';

const db = require('../db');
const { HttpError } = require('../lib/router');
const {
  requireAuth, requireRole, requireConsentCleared, notify, calcServiceFee, serializeBooking,
} = require('../lib/helpers');
const payments = require('../lib/payments');

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
  // Create a booking request (client -> musician). The client already
  // approved a PayPal order for the full amount client-side (see
  // POST /api/paypal/orders and the PayPal buttons in public/app.js) — that
  // order is authorized (held, not charged) right away, and only actually
  // charged once the musician accepts, in /respond below.
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
    const bookingId = info.lastInsertRowid;

    let auth;
    try {
      auth = await payments.authorizePayment({
        amountDollars: total,
        paypalOrderId: b.paypalOrderId,
        metadata: { kind: 'booking', bookingId: String(bookingId) },
      });
    } catch (err) {
      // No usable hold — don't leave a booking request sitting around that
      // the musician could accept with nothing actually backing it.
      db.prepare('DELETE FROM bookings WHERE id = ?').run(bookingId);
      throw err;
    }
    db.prepare('UPDATE bookings SET payment_intent_id = ?, payment_status = ? WHERE id = ?')
      .run(auth.paymentIntentId, auth.paymentStatus, bookingId);

    const booking = loadBooking(bookingId);
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
      if (booking.payment_status !== 'authorized') {
        throw new HttpError(400, 'This booking has no valid payment hold to charge — the client may need to re-request.');
      }
      const { paymentStatus, paymentIntentId } = await payments.capture(booking.payment_intent_id);
      db.prepare("UPDATE bookings SET status='accepted', payment_status=?, payment_intent_id=?, updated_at=datetime('now') WHERE id=?")
        .run(paymentStatus, paymentIntentId, booking.id);
      notify(booking.client_user_id, `Your booking request for ${booking.event_date} was accepted! Your card has been charged $${booking.total.toFixed(2)}.`, 'booking');
    } else if (action === 'decline') {
      const paymentStatus = await payments.releaseOrRefund(booking.payment_intent_id, booking.payment_status);
      db.prepare("UPDATE bookings SET status='declined', payment_status=?, updated_at=datetime('now') WHERE id=?").run(paymentStatus, booking.id);
      notify(booking.client_user_id, `Your booking request for ${booking.event_date} was declined. The hold on your card has been released.`, 'booking');
    } else {
      if (counterRate == null) throw new HttpError(400, 'counterRate is required for a counter-offer');
      db.prepare("UPDATE bookings SET status='countered', counter_rate=?, counter_note=?, updated_at=datetime('now') WHERE id=?")
        .run(parseFloat(counterRate), counterNote || null, booking.id);
      notify(booking.client_user_id, `Counter-offer received for your ${booking.event_date} booking: $${counterRate}/hr`, 'booking');
    }
    return { booking: serializeBooking(loadBooking(booking.id)) };
  });

  // Client responds to a counter-offer: accept | decline. Accepting at a
  // new rate means a new total, and PayPal has no way to silently change
  // an already-authorized amount — so the client approves a brand-new
  // PayPal order for the new total client-side first (see
  // openCounterRespondModal in public/app.js) and sends its id here as
  // paypalOrderId.
  router.post('/api/bookings/:id/counter-response', async (ctx) => {
    const user = requireRole(ctx, 'client');
    const booking = loadBooking(ctx.params.id);
    if (booking.client_user_id !== user.id) throw new HttpError(403, 'Not your booking');
    if (booking.status !== 'countered') throw new HttpError(400, 'No active counter-offer on this booking');
    const { action, paypalOrderId } = ctx.body;
    const profile = db.prepare('SELECT * FROM musician_profiles WHERE id = ?').get(booking.musician_profile_id);

    if (action === 'accept') {
      const subtotal = booking.counter_rate * booking.duration_hours;
      const serviceFee = calcServiceFee(subtotal);
      const total = Math.round((subtotal + serviceFee) * 100) / 100;
      // Accepting a counter-offer *is* the acceptance for this booking — the
      // original hold was for the old total, so void it and authorize+
      // capture the newly-approved order for the new one in the same step
      // rather than waiting for a separate accept action that doesn't exist
      // on this path.
      const { paymentStatus, paymentIntentId } = await payments.reauthorizeAndCapture({
        paymentIntentId: booking.payment_intent_id, newPaypalOrderId: paypalOrderId, newAmountDollars: total,
      });
      db.prepare(
        "UPDATE bookings SET status='accepted', offered_rate=?, service_fee=?, total=?, payment_status=?, payment_intent_id=?, updated_at=datetime('now') WHERE id=?"
      ).run(booking.counter_rate, serviceFee, total, paymentStatus, paymentIntentId, booking.id);
      notify(profile.user_id, `Your counter-offer for ${booking.event_date} was accepted! The client's card has been charged $${total.toFixed(2)}.`, 'booking');
    } else if (action === 'decline') {
      const paymentStatus = await payments.releaseOrRefund(booking.payment_intent_id, booking.payment_status);
      db.prepare("UPDATE bookings SET status='declined', payment_status=?, updated_at=datetime('now') WHERE id=?").run(paymentStatus, booking.id);
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
    // Releases the hold if nothing was charged yet, or refunds the client in
    // full if the booking had already been accepted (and therefore
    // captured) before this cancellation.
    const paymentStatus = await payments.releaseOrRefund(booking.payment_intent_id, booking.payment_status);
    db.prepare("UPDATE bookings SET status='cancelled', cancellation_reason=?, payment_status=?, updated_at=datetime('now') WHERE id=?")
      .run(ctx.body.reason || null, paymentStatus, booking.id);
    const notifyUserId = isClient ? profile.user_id : booking.client_user_id;
    const moneyNote = paymentStatus === 'refunded' ? ' The client has been refunded in full.' : '';
    notify(notifyUserId, `Booking for ${booking.event_date} was cancelled by the ${isClient ? 'client' : 'musician'}.${moneyNote}`, 'booking');
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

    let paymentStatus = booking.payment_status;
    if (booking.payment_status === 'captured') {
      if (profile.paypal_email) {
        try {
          const payoutAmount = Math.round((booking.total - booking.service_fee) * 100) / 100;
          const transferId = await payments.payout({
            amountDollars: payoutAmount, recipientEmail: profile.paypal_email,
            note: `Payout for your ${booking.event_date} booking`,
          });
          db.prepare('UPDATE bookings SET transfer_id = ? WHERE id = ?').run(transferId, booking.id);
          paymentStatus = 'transferred';
          notify(profile.user_id, `Payout sent for your ${booking.event_date} booking: $${payoutAmount.toFixed(2)}.`, 'success');
        } catch (err) {
          // Don't let a payout failure block marking the booking complete —
          // the service happened; the money side can be retried/resolved
          // separately. Leaves payment_status at 'captured' (funds held by
          // the platform) rather than silently losing track of it.
          console.error(`[bookings] payout failed for booking ${booking.id}:`, err.message);
          notify(profile.user_id, `We couldn't send your payout for the ${booking.event_date} booking automatically — contact support.`, 'error');
        }
      } else {
        // No payout email on file yet — the charge is already held by the
        // platform; nothing to send it to. Flagged rather than solved:
        // there's no background job here that retries this once the
        // musician does add one, so this payout needs to be sent by hand
        // (or the musician needs to connect, then an admin needs a way to
        // trigger it) — out of scope for this pass.
        notify(profile.user_id, `Add your PayPal email from your dashboard's Payments tab to receive your payout for the ${booking.event_date} booking.`, 'info');
      }
    }
    db.prepare("UPDATE bookings SET status='completed', payment_status=?, updated_at=datetime('now') WHERE id=?").run(paymentStatus, booking.id);
    return { booking: serializeBooking(loadBooking(booking.id)) };
  });

  // No-show reporting & consequences:
  // - musician no-show: client is refunded, musician forfeits the service
  //   fee and takes a strike.
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

    let paymentStatus = booking.payment_status;
    if (party === 'musician' && booking.payment_status === 'captured') {
      // Full refund — the musician never performed, so the platform fee is
      // forfeited along with the rest rather than kept.
      paymentStatus = await payments.releaseOrRefund(booking.payment_intent_id, booking.payment_status);
    }
    // Client no-show: intentionally no refund and no payout — the captured
    // total stays held by the platform. There's no automated path here to
    // pay the musician their share anyway (the musician didn't necessarily
    // render the service if the client never showed to receive it); that's
    // a manual/business decision, not something this flow resolves.

    db.prepare("UPDATE bookings SET status=?, no_show_report=?, no_show_party=?, payment_status=?, updated_at=datetime('now') WHERE id=?")
      .run(newStatus, report || null, party, paymentStatus, booking.id);

    if (party === 'musician') {
      db.prepare('UPDATE musician_profiles SET strikes = strikes + 1 WHERE id = ?').run(profile.id);
      notify(booking.client_user_id, `Musician no-show confirmed for ${booking.event_date}. You've been refunded in full and the platform fee is forfeited by the musician.`, 'no_show');
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