'use strict';

// Shared "authorize now, capture at acceptance" logic used by both
// bookings.js and rentals.js — the two resources differ in what they're
// paying for, but the Stripe lifecycle around that payment is identical.

const { HttpError } = require('./router');
const stripe = require('./stripe');

// Places a hold for `amountDollars` on the client's card. Returns the fields
// to store on the booking/rental row. Throws a 402 if the card is flatly
// declined; returns requiresAction: true (with a clientSecret the frontend
// must resolve via stripe.confirmCardPayment) if the card needs 3D Secure
// first — the caller should still save the row in that case and finish
// confirming once the frontend reports back via confirmPaymentAfterAction.
async function authorizePayment({ amountDollars, paymentMethodId, metadata }) {
  if (stripe.isConfigured() && !paymentMethodId) {
    throw new HttpError(400, 'A payment method is required');
  }
  const amountCents = Math.round(amountDollars * 100);
  const result = await stripe.createPaymentIntent({ amount: amountCents, paymentMethodId, metadata });

  if (result.demo || result.status === 'requires_capture') {
    return { paymentIntentId: result.id, paymentStatus: 'authorized', requiresAction: false };
  }
  if (result.status === 'requires_action') {
    return {
      paymentIntentId: result.id, paymentStatus: 'requires_action',
      requiresAction: true, clientSecret: result.clientSecret,
    };
  }
  throw new HttpError(402, 'Your card could not be authorized. Please check your card details and try again.');
}

// Called once the frontend finishes a 3D Secure challenge with Stripe
// directly — re-checks the PaymentIntent's real status rather than trusting
// the client's word for it.
async function confirmPaymentAfterAction(paymentIntentId) {
  const pi = await stripe.retrievePaymentIntent(paymentIntentId);
  if (pi.status === 'requires_capture') return 'authorized';
  return 'failed';
}

// Raises (or lowers) the held amount on a not-yet-captured authorization —
// used when a counter-offer changes the final price before acceptance — and
// immediately captures it, since a counter-offer being accepted *is* the
// acceptance for that booking.
async function reauthorizeAndCapture({ paymentIntentId, newAmountDollars }) {
  if (!paymentIntentId) throw new HttpError(400, 'No payment is attached to this request');
  await stripe.updatePaymentIntentAmount(paymentIntentId, Math.round(newAmountDollars * 100));
  const captured = await stripe.capturePaymentIntent(paymentIntentId);
  if (captured.demo || captured.status === 'succeeded') return 'captured';
  throw new HttpError(402, 'Could not charge the card for the new amount.');
}

async function capture(paymentIntentId) {
  if (!paymentIntentId) throw new HttpError(400, 'No payment is attached to this request');
  const result = await stripe.capturePaymentIntent(paymentIntentId);
  if (result.demo || result.status === 'succeeded') return 'captured';
  throw new HttpError(402, 'Could not capture payment — ask the client to try again with a different card.');
}

// Best-effort release/refund used from cancel/decline paths — logs instead
// of throwing on failure so a Stripe hiccup never blocks the booking/rental
// state change itself (the workflow status is the source of truth; this is
// a side effect of it).
async function releaseOrRefund(paymentIntentId, currentPaymentStatus) {
  if (!paymentIntentId) return currentPaymentStatus;
  try {
    if (currentPaymentStatus === 'captured') {
      await stripe.createRefund({ paymentIntentId });
      return 'refunded';
    }
    if (['authorized', 'requires_action'].includes(currentPaymentStatus)) {
      await stripe.cancelPaymentIntent(paymentIntentId);
      return 'canceled';
    }
  } catch (err) {
    console.error(`[payments] failed to release/refund ${paymentIntentId}:`, err.message);
  }
  return currentPaymentStatus;
}

module.exports = { authorizePayment, confirmPaymentAfterAction, reauthorizeAndCapture, capture, releaseOrRefund };
