'use strict';

// Minimal PayPal helper built on Node's native fetch — no npm dependency,
// same "nothing but what ships in Node" pattern as lib/email.js and the old
// lib/stripe.js this replaces. Talks to PayPal's REST API directly
// (https://developer.paypal.com/api/rest/) with an OAuth2 bearer token,
// instead of pulling in the official PayPal Checkout Server SDK.
//
// Configure via environment variables on the host (Render -> Environment):
//   PAYPAL_CLIENT_ID      - required for real orders/authorizations/payouts.
//   PAYPAL_CLIENT_SECRET  - required alongside it. Keep this one secret —
//                            it never goes to the frontend.
//   PAYPAL_ENV            - "sandbox" (default) or "live". Use sandbox while
//                            testing; switch to live only when ready to
//                            actually move real money.
//
// If PAYPAL_CLIENT_ID/PAYPAL_CLIENT_SECRET aren't set, every function below
// runs in "demo mode": it fabricates fake order/authorization/capture/payout
// ids instead of calling PayPal at all. That keeps the whole booking/rental
// flow working end to end with zero setup, the same way email sending
// degrades to a server-log line when RESEND_API_KEY is unset. Setting the
// real credentials is the only thing that switches this from demo to live;
// nothing else in the app needs to change.
//
// Payment model: "authorize now, capture at acceptance" (see lib/payments.js)
// maps onto PayPal's Orders v2 API with intent=AUTHORIZE:
//   1. Server creates an order for the amount (createOrder).
//   2. The buyer approves it in the browser via PayPal's JS SDK buttons
//      (PayPal or Credit/Debit Card funding source) — this is PayPal's own
//      equivalent of Stripe's 3D Secure challenge; nothing further is
//      needed from the server for strong authentication.
//   3. Server authorizes the now-approved order (authorizeOrder), which
//      places the hold and returns an authorization id.
//   4. Server captures that authorization (captureAuthorization) the moment
//      the musician/equipment owner accepts — this is what actually moves
//      money — or voids it (voidAuthorization) if declined/cancelled first.
//   5. A captured charge can be refunded in full or in part (refundCapture).
// Sellers are paid out via the Payouts API (sendPayout) to the PayPal email
// address they give us — no separate onboarding/account-linking step is
// needed the way Stripe Connect required one.

function apiBase() {
  if (process.env.PAYPAL_API_BASE) return process.env.PAYPAL_API_BASE;
  return process.env.PAYPAL_ENV === 'live'
    ? 'https://api-m.paypal.com'
    : 'https://api-m.sandbox.paypal.com';
}

function isConfigured() {
  return !!(process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET);
}

// The frontend needs this (not the client secret!) to load PayPal's JS SDK
// and render the Pay with PayPal / Pay with Debit or Credit Card buttons.
// Safe to expose — client ids are meant to be public, same role as Stripe's
// publishable key. No id configured means no payment buttons in the UI at
// all; see server/routes/paypal.js's /api/paypal/public-config.
function clientId() {
  return process.env.PAYPAL_CLIENT_ID || null;
}

function randomId(prefix) {
  return `${prefix}_demo_${require('crypto').randomBytes(8).toString('hex')}`;
}

// Caches the OAuth2 access token in memory until shortly before it expires —
// client-credentials tokens are good for several hours, no reason to fetch a
// fresh one on every request.
let cachedToken = null; // { token, expiresAt }
async function getAccessToken() {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 30_000) {
    return cachedToken.token;
  }
  const basic = Buffer.from(`${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`).toString('base64');
  const res = await fetch(`${apiBase()}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw Object.assign(new Error(data.error_description || `PayPal auth error ${res.status}`), { statusCode: 502 });
  }
  cachedToken = { token: data.access_token, expiresAt: Date.now() + (data.expires_in || 300) * 1000 };
  return cachedToken.token;
}

async function paypalRequest(method, path, body) {
  const token = await getAccessToken();
  const res = await fetch(`${apiBase()}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  // PayPal returns 204 No Content for e.g. voiding an authorization.
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const message = (data.details && data.details[0] && data.details[0].description)
      || data.message || `PayPal API error ${res.status}`;
    throw Object.assign(new Error(message), { statusCode: 502 });
  }
  return data;
}

function money(amountDollars, currency = 'USD') {
  return { currency_code: currency, value: (Math.round(amountDollars * 100) / 100).toFixed(2) };
}

// Creates an order the buyer approves client-side (via the PayPal JS SDK's
// createOrder callback) before anything is held on their card/PayPal
// balance. intent: AUTHORIZE (not CAPTURE) so money only moves later, at
// acceptance — see authorizeOrder/captureAuthorization below.
async function createOrder({ amountDollars, currency = 'USD', description }) {
  if (!isConfigured()) {
    const id = randomId('order');
    console.log(`[paypal] demo mode — created fake order ${id} for $${amountDollars.toFixed(2)} instead of calling PayPal.`);
    return { id, demo: true };
  }
  const order = await paypalRequest('POST', '/v2/checkout/orders', {
    intent: 'AUTHORIZE',
    purchase_units: [{ description: description || 'Musician Connect', amount: money(amountDollars, currency) }],
  });
  return { id: order.id, demo: false };
}

// Looks up an order's approved amount — used right before authorizing it so
// a client can never get a lower amount authorized than the booking/rental
// actually costs (the order is created client-controlled, before the
// booking exists, so this check is the thing that keeps that safe).
async function getOrderAmount(orderId) {
  if (!isConfigured() || String(orderId).startsWith('order_demo_')) {
    return null; // nothing real to check in demo mode
  }
  const order = await paypalRequest('GET', `/v2/checkout/orders/${orderId}`);
  const unit = order.purchase_units && order.purchase_units[0];
  return unit && unit.amount ? parseFloat(unit.amount.value) : null;
}

// Places the actual hold on a buyer-approved order and returns the
// authorization id used for every later step (capture/void). Throws if the
// order was never approved by the buyer (status stays CREATED, not
// APPROVED) or doesn't exist.
async function authorizeOrder(orderId) {
  if (!isConfigured() || String(orderId).startsWith('order_demo_')) {
    const id = randomId('auth');
    console.log(`[paypal] demo mode — authorizing fake order ${orderId || '(none)'} as ${id} instead of placing a real hold.`);
    return { id, status: 'CREATED', demo: true };
  }
  const result = await paypalRequest('POST', `/v2/checkout/orders/${orderId}/authorize`, {});
  const unit = result.purchase_units && result.purchase_units[0];
  const authorization = unit && unit.payments && unit.payments.authorizations && unit.payments.authorizations[0];
  if (!authorization) {
    throw Object.assign(new Error('PayPal did not return an authorization for this order.'), { statusCode: 502 });
  }
  return { id: authorization.id, status: authorization.status, amount: parseFloat(authorization.amount.value), demo: false };
}

// Charges the held amount — call this the moment the musician/equipment
// owner accepts, never before. Returns the capture id, which replaces the
// authorization id as the reference used for any later refund.
async function captureAuthorization(authorizationId) {
  if (!isConfigured() || String(authorizationId).startsWith('auth_demo_')) {
    const id = randomId('capture');
    return { id, status: 'COMPLETED', demo: true };
  }
  const capture = await paypalRequest('POST', `/v2/payments/authorizations/${authorizationId}/capture`, {});
  return { id: capture.id, status: capture.status, demo: false };
}

// Releases a hold without ever charging — used when a request is declined
// or cancelled before acceptance.
async function voidAuthorization(authorizationId) {
  if (!isConfigured() || String(authorizationId).startsWith('auth_demo_')) {
    console.log(`[paypal] demo mode — "voiding" fake authorization ${authorizationId}.`);
    return { demo: true };
  }
  await paypalRequest('POST', `/v2/payments/authorizations/${authorizationId}/void`, undefined);
  return { demo: false };
}

// Returns some or all of an already-captured charge to the buyer — used for
// a musician no-show (full refund), a cancellation after acceptance (full
// refund), and a rental's refundable security deposit at completion
// (partial refund). Omit amountDollars for a full refund.
async function refundCapture({ captureId, amountDollars, currency = 'USD' }) {
  if (!isConfigured() || String(captureId).startsWith('capture_demo_')) {
    const id = randomId('refund');
    console.log(`[paypal] demo mode — faking a refund ${id} on ${captureId}${amountDollars != null ? ` of $${amountDollars.toFixed(2)}` : ' (full)'}.`);
    return { id, demo: true };
  }
  const body = amountDollars != null ? { amount: money(amountDollars, currency) } : {};
  const refund = await paypalRequest('POST', `/v2/payments/captures/${captureId}/refund`, body);
  return { id: refund.id, demo: false };
}

// Pays a seller (musician or equipment owner) their share of a completed
// booking/rental, straight to the PayPal email address they gave us — the
// PayPal Payouts API, chosen over Stripe-Connect-style account linking
// specifically because it needs nothing from the seller but that email
// address; no separate onboarding flow to build or for them to complete.
async function sendPayout({ amountDollars, recipientEmail, currency = 'USD', note }) {
  if (!isConfigured()) {
    const id = randomId('payout');
    console.log(`[paypal] demo mode — faking a payout ${id} of $${amountDollars.toFixed(2)} to ${recipientEmail}.`);
    return { id, demo: true };
  }
  const senderItemId = require('crypto').randomBytes(8).toString('hex');
  const result = await paypalRequest('POST', '/v1/payouts', {
    sender_batch_header: {
      sender_batch_id: senderItemId,
      email_subject: 'You have a payout from Kaf Musician Connect!',
    },
    items: [{
      recipient_type: 'EMAIL',
      amount: money(amountDollars, currency),
      receiver: recipientEmail,
      note: note || 'Payout for a completed booking/rental',
      sender_item_id: senderItemId,
    }],
  });
  const id = (result.batch_header && result.batch_header.payout_batch_id) || senderItemId;
  return { id, demo: false };
}

// --- Apple Pay (via PayPal's "Apple Pay Advanced Integration") -----------
// Apple Pay isn't its own payment processor here — it's another way for the
// buyer to approve a PayPal order (alongside the PayPal/card buttons),
// using Apple's on-device payment sheet instead of PayPal's own UI. Once
// confirmApplePayOrder succeeds below, the order is in the same
// buyer-approved state a PayPal/card approval leaves it in, so the rest of
// the pipeline (authorizeOrder, captureAuthorization, ...) doesn't need to
// know or care which funding source was used.
//
// This requires, on top of PAYPAL_CLIENT_ID/PAYPAL_CLIENT_SECRET:
//   1. Apple Pay enabled for your PayPal business account (PayPal
//      dashboard -> Apple Pay settings) — this is what gives PayPal a
//      merchant identity to validate against Apple.
//   2. The domain-association file PayPal gives you there, served at
//      exactly /.well-known/apple-developer-merchantid-domain-association
//      (drop it in public/.well-known/ — see DEPLOY.md).
//   3. A real HTTPS domain — Apple Pay refuses to even offer itself on
//      localhost or an IP address.
// Until all three are done, the frontend's own feature-detection
// (ApplePaySession availability) simply won't offer the button — nothing
// breaks, it just doesn't appear, same as the PayPal buttons not appearing
// when PAYPAL_CLIENT_ID/SECRET aren't set.

// Asks PayPal to vouch for this merchant to Apple for the on-device payment
// sheet — event.validationURL from Safari's ApplePaySession.onvalidatemerchant
// goes in, and whatever comes back goes straight into the browser's
// session.completeMerchantValidation(...), unexamined.
async function validateApplePayMerchant(validationUrl) {
  if (!isConfigured()) {
    throw Object.assign(new Error('Apple Pay requires a real PayPal account to be configured.'), { statusCode: 400 });
  }
  return paypalRequest('POST', '/v2/payment-source/apple-pay/validate-merchant', {
    validation_url: validationUrl,
    display_name: 'Kaf Musician Connect',
  });
}

// Attaches the Apple Pay payment token Safari produced (event.payment.token
// from session.onpaymentauthorized) to the order as its payment source —
// after this succeeds, the order is approved exactly as if the buyer had
// clicked through PayPal's own button, and authorizeOrder (above) picks up
// from there unchanged.
async function confirmApplePayOrder({ orderId, token }) {
  if (!isConfigured()) {
    throw Object.assign(new Error('Apple Pay requires a real PayPal account to be configured.'), { statusCode: 400 });
  }
  return paypalRequest('POST', `/v2/checkout/orders/${orderId}/confirm-payment-source`, {
    payment_source: { apple_pay: { token } },
  });
}

module.exports = {
  isConfigured, clientId,
  createOrder, getOrderAmount, authorizeOrder, captureAuthorization, voidAuthorization,
  refundCapture, sendPayout,
  validateApplePayMerchant, confirmApplePayOrder,
};