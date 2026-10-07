'use strict';

// Shared "authorize now, capture at acceptance" logic used by both
// bookings.js and rentals.js — the two resources differ in what they're
// paying for, but the PayPal lifecycle around that payment is identical.
//
// The buyer approves a PayPal order (PayPal balance or a guest debit/credit
// card, via the JS SDK buttons in public/app.js) *before* calling the
// server at all — see server/routes/paypal.js's POST /api/paypal/orders.
// That means, unlike the old Stripe integration, there's no further async
// "requires_action" step on this side: PayPal's own approval flow already
// covers strong buyer authentication.

const { HttpError } = require('./router');
const paypal = require('./paypal');

// Places a hold for `amountDollars` by authorizing a PayPal order the buyer
// already approved client-side. Verifies the order was actually approved
// for at least that amount first — the order is created before the
// booking/rental exists (so its amount is client-reported), and this check
// is what keeps a client from getting a smaller amount authorized than the
// booking/rental actually costs.
async function authorizePayment({ amountDollars, paypalOrderId, metadata }) {
  if (paypal.isConfigured() && !paypalOrderId) {
    throw new HttpError(400, 'A PayPal payment approval is required');
  }
  const approvedAmount = await paypal.getOrderAmount(paypalOrderId);
  if (approvedAmount != null && approvedAmount < amountDollars - 0.01) {
    throw new HttpError(402, 'The approved payment amount does not match the request total — please try again.');
  }
  let authorization;
  try {
    authorization = await paypal.authorizeOrder(paypalOrderId);
  } catch (err) {
    throw new HttpError(402, 'Your PayPal payment could not be authorized. Please try again.');
  }
  return { paymentIntentId: authorization.id, paymentStatus: 'authorized' };
}

// Used when a counter-offer changes the final price before acceptance.
// PayPal has no way to silently change an already-approved order's amount,
// so the buyer has to approve a brand-new order for the new total client-
// side first (see openCounterRespondModal in public/app.js) — this voids
// the original hold and authorizes+captures that new order in its place,
// since a counter-offer being accepted *is* the acceptance for that
// booking/rental.
async function reauthorizeAndCapture({ paymentIntentId, newPaypalOrderId, newAmountDollars }) {
  if (!paymentIntentId) throw new HttpError(400, 'No payment is attached to this request');
  if (paypal.isConfigured() && !newPaypalOrderId) {
    throw new HttpError(400, 'A new PayPal payment approval is required for the counter-offer amount');
  }
  const approvedAmount = await paypal.getOrderAmount(newPaypalOrderId);
  if (approvedAmount != null && approvedAmount < newAmountDollars - 0.01) {
    throw new HttpError(402, 'The approved payment amount does not match the counter-offer total — please try again.');
  }
  let authorization;
  try {
    authorization = await paypal.authorizeOrder(newPaypalOrderId);
  } catch (err) {
    throw new HttpError(402, 'The new amount could not be authorized on PayPal. Please try again.');
  }
  const capture = await paypal.captureAuthorization(authorization.id);
  if (capture.status !== 'COMPLETED' && !capture.demo) {
    throw new HttpError(402, 'Could not charge for the new amount.');
  }
  // Only release the old hold once the new one is safely captured — voiding
  // first and having the new authorization fail would leave the booking
  // accepted with no payment behind it at all.
  await paypal.voidAuthorization(paymentIntentId).catch((err) => {
    console.error(`[payments] failed to void superseded authorization ${paymentIntentId}:`, err.message);
  });
  return { paymentStatus: 'captured', paymentIntentId: capture.id };
}

// Actually charges the held amount — call this the moment the seller
// accepts. Returns the new (capture) id alongside the status since PayPal,
// unlike Stripe, uses a different id at each stage of the payment's life;
// callers must persist the returned paymentIntentId, not just the status.
async function capture(paymentIntentId) {
  if (!paymentIntentId) throw new HttpError(400, 'No payment is attached to this request');
  const result = await paypal.captureAuthorization(paymentIntentId);
  if (result.status !== 'COMPLETED' && !result.demo) {
    throw new HttpError(402, 'Could not capture payment — ask the client to try again.');
  }
  return { paymentStatus: 'captured', paymentIntentId: result.id };
}

// Best-effort release/refund used from cancel/decline/no-show paths — logs
// instead of throwing on failure so a PayPal hiccup never blocks the
// booking/rental state change itself (the workflow status is the source of
// truth; this is a side effect of it).
async function releaseOrRefund(paymentIntentId, currentPaymentStatus) {
  if (!paymentIntentId) return currentPaymentStatus;
  try {
    if (currentPaymentStatus === 'captured') {
      await paypal.refundCapture({ captureId: paymentIntentId });
      return 'refunded';
    }
    if (currentPaymentStatus === 'authorized') {
      await paypal.voidAuthorization(paymentIntentId);
      return 'canceled';
    }
  } catch (err) {
    console.error(`[payments] failed to release/refund ${paymentIntentId}:`, err.message);
  }
  return currentPaymentStatus;
}

// Refunds just part of an already-captured charge — used for a rental's
// refundable security deposit at completion. Throws (rather than
// swallowing) so the caller can tell the seller it needs a retry, mirroring
// the old Stripe behavior for this one call site.
async function refundPartial(paymentIntentId, amountDollars) {
  if (!paymentIntentId) throw new HttpError(400, 'No payment is attached to this request');
  const refund = await paypal.refundCapture({ captureId: paymentIntentId, amountDollars });
  return refund.id;
}

// Pays a seller their share of a completed booking/rental out to the
// PayPal email address on their profile.
async function payout({ amountDollars, recipientEmail, note }) {
  const result = await paypal.sendPayout({ amountDollars, recipientEmail, note });
  return result.id;
}

module.exports = {
  authorizePayment, reauthorizeAndCapture, capture, releaseOrRefund, refundPartial, payout,
};