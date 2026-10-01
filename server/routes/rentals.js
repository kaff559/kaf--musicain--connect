'use strict';

const db = require('../db');
const { HttpError } = require('../lib/router');
const { requireRole, requireAuth, requireConsentCleared, notify, calcServiceFee, serializeRental, equipmentOwnerProfileForUser } = require('../lib/helpers');
const stripe = require('../lib/stripe');
const payments = require('../lib/payments');

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
    requireConsentCleared(user);
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
    const rentalId = info.lastInsertRowid;

    let auth;
    try {
      auth = await payments.authorizePayment({
        amountDollars: total,
        paymentMethodId: b.paymentMethodId,
        metadata: { kind: 'rental', rentalId: String(rentalId) },
      });
    } catch (err) {
      db.prepare('DELETE FROM rentals WHERE id = ?').run(rentalId);
      throw err;
    }
    db.prepare('UPDATE rentals SET payment_intent_id = ?, payment_status = ? WHERE id = ?')
      .run(auth.paymentIntentId, auth.paymentStatus, rentalId);

    const owner = db.prepare('SELECT * FROM equipment_owner_profiles WHERE id = ?').get(item.owner_profile_id);
    notify(owner.user_id, `New rental request for "${item.title}" (${b.startDate} to ${b.endDate}) from ${user.name}`, 'rental');
    const result = { rental: serializeRental(loadRental(rentalId)) };
    if (auth.requiresAction) {
      result.requiresAction = true;
      result.clientSecret = auth.clientSecret;
    }
    return result;
  });

  router.post('/api/rentals/:id/confirm-payment', async (ctx) => {
    const user = requireRole(ctx, 'client');
    const rental = loadRental(ctx.params.id);
    if (rental.client_user_id !== user.id) throw new HttpError(403, 'Not your rental');
    if (rental.payment_status !== 'requires_action') {
      return { rental: serializeRental(rental) };
    }
    const newStatus = await payments.confirmPaymentAfterAction(rental.payment_intent_id);
    db.prepare("UPDATE rentals SET payment_status = ?, updated_at = datetime('now') WHERE id = ?").run(newStatus, rental.id);
    if (newStatus === 'failed') {
      db.prepare("UPDATE rentals SET status = 'cancelled', updated_at = datetime('now') WHERE id = ?").run(rental.id);
    }
    return { rental: serializeRental(loadRental(rental.id)) };
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

    let paymentStatus = rental.payment_status;
    let moneyNote = '';
    if (action === 'accept') {
      if (rental.payment_status === 'requires_action') {
        throw new HttpError(400, "The client's payment hasn't finished authorizing yet — try again in a moment.");
      }
      if (rental.payment_status !== 'authorized') {
        throw new HttpError(400, 'This rental has no valid payment hold to charge — the client may need to re-request.');
      }
      paymentStatus = await payments.capture(rental.payment_intent_id);
      moneyNote = ` Your card has been charged $${rental.total.toFixed(2)}.`;
    } else {
      paymentStatus = await payments.releaseOrRefund(rental.payment_intent_id, rental.payment_status);
      moneyNote = ' The hold on your card has been released.';
    }
    const newStatus = action === 'accept' ? 'accepted' : 'declined';
    db.prepare("UPDATE rentals SET status=?, payment_status=?, updated_at=datetime('now') WHERE id=?").run(newStatus, paymentStatus, rental.id);
    notify(rental.client_user_id, `Your rental request for "${item.title}" was ${newStatus}.${moneyNote}`, 'rental');
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
    const paymentStatus = await payments.releaseOrRefund(rental.payment_intent_id, rental.payment_status);
    db.prepare("UPDATE rentals SET status='cancelled', payment_status=?, updated_at=datetime('now') WHERE id=?").run(paymentStatus, rental.id);
    const ownerUserId = db.prepare('SELECT user_id FROM equipment_owner_profiles WHERE id=?').get(item.owner_profile_id).user_id;
    const notifyUserId = isClient ? ownerUserId : rental.client_user_id;
    const moneyNote = paymentStatus === 'refunded' ? ' The client has been refunded in full.' : '';
    notify(notifyUserId, `Rental for "${item.title}" was cancelled.${moneyNote}`, 'rental');
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

    const ownerProfile = db.prepare('SELECT * FROM equipment_owner_profiles WHERE id = ?').get(item.owner_profile_id);
    let paymentStatus = rental.payment_status;
    let depositRefundId = rental.deposit_refund_id;
    if (rental.payment_status === 'captured') {
      // The security deposit is refundable by design (see the "refundable
      // deposit" copy shown at request time) — return just that portion to
      // the client; the rental fee itself is what gets paid out below.
      if (rental.deposit > 0) {
        try {
          const refund = await stripe.createRefund({
            paymentIntentId: rental.payment_intent_id,
            amount: Math.round(rental.deposit * 100),
            metadata: { kind: 'rental_deposit', rentalId: String(rental.id) },
          });
          depositRefundId = refund.id;
          notify(rental.client_user_id, `Your $${rental.deposit.toFixed(2)} security deposit for "${item.title}" has been refunded.`, 'success');
        } catch (err) {
          console.error(`[rentals] deposit refund failed for rental ${rental.id}:`, err.message);
          notify(rental.client_user_id, `We couldn't automatically refund your security deposit for "${item.title}" — contact support.`, 'error');
        }
      }
      if (ownerProfile.stripe_account_id && ownerProfile.stripe_payouts_enabled) {
        try {
          const payoutAmount = Math.round(rental.rental_fee * 100);
          const transfer = await stripe.createTransfer({
            amount: payoutAmount, destination: ownerProfile.stripe_account_id,
            metadata: { kind: 'rental', rentalId: String(rental.id) },
          });
          db.prepare('UPDATE rentals SET transfer_id = ? WHERE id = ?').run(transfer.id, rental.id);
          paymentStatus = 'transferred';
          notify(ownerProfile.user_id, `Payout sent for your "${item.title}" rental: $${(payoutAmount / 100).toFixed(2)}.`, 'success');
        } catch (err) {
          console.error(`[rentals] payout failed for rental ${rental.id}:`, err.message);
          notify(ownerProfile.user_id, `We couldn't send your payout for the "${item.title}" rental automatically — contact support.`, 'error');
        }
      } else {
        notify(ownerProfile.user_id, `Connect a Stripe account from your dashboard's Payments tab to receive your payout for the "${item.title}" rental.`, 'info');
      }
    }
    db.prepare("UPDATE rentals SET status='completed', payment_status=?, deposit_refund_id=?, updated_at=datetime('now') WHERE id=?")
      .run(paymentStatus, depositRefundId, rental.id);
    return { rental: serializeRental(loadRental(rental.id)) };
  });
}

module.exports = { register };
