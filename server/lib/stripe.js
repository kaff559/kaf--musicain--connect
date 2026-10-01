'use strict';

// Minimal Stripe Connect helper built on Node's native fetch — no npm
// dependency, same pattern as lib/email.js. Talks to Stripe's REST API
// directly (https://stripe.com/docs/api) with a bearer token, instead of
// pulling in the official stripe-node SDK.
//
// Configure via an environment variable on the host (Render -> Environment):
//   STRIPE_SECRET_KEY  - required for real Stripe accounts/links/charges.
//                          Use a test-mode secret key (sk_test_...) first,
//                          then a live key (sk_live_...) when ready to
//                          actually go live with real payouts.
//
// If STRIPE_SECRET_KEY isn't set, every function below runs in "demo mode":
// it fabricates a fake acct_demo_... account and a same-origin link that
// marks the seller as connected as soon as they click through, instead of
// calling Stripe at all. That keeps onboarding — and signup, which never
// touches this file — working end to end with zero setup, the same way
// email sending degrades to a server-log line when RESEND_API_KEY is unset.
// Setting the real key is the only thing that switches this from demo to
// live; nothing else in the app needs to change.

const STRIPE_API = 'https://api.stripe.com/v1';

function isConfigured() {
  return !!process.env.STRIPE_SECRET_KEY;
}

// Stripe's form-encoded API uses PHP-style bracket notation for nested
// objects, e.g. capabilities[transfers][requested]=true.
function encodeParams(obj, prefix) {
  const parts = [];
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined || value === null) continue;
    const fullKey = prefix ? `${prefix}[${key}]` : key;
    if (typeof value === 'object' && !Array.isArray(value)) {
      const nested = encodeParams(value, fullKey);
      if (nested) parts.push(nested);
    } else {
      parts.push(`${encodeURIComponent(fullKey)}=${encodeURIComponent(value)}`);
    }
  }
  return parts.join('&');
}

async function stripeRequest(method, path, params) {
  const res = await fetch(`${STRIPE_API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params ? encodeParams(params) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = (data.error && data.error.message) || `Stripe API error ${res.status}`;
    throw Object.assign(new Error(message), { statusCode: 502 });
  }
  return data;
}

function demoAccountId() {
  return `acct_demo_${require('crypto').randomBytes(8).toString('hex')}`;
}

// Creates a new Express connected account for a seller (musician or
// equipment owner) who doesn't have one yet. Express accounts use Stripe's
// own hosted onboarding form (collects identity/bank details) and dashboard
// — the least integration work for us, at the cost of a little less control
// over the onboarding UI than a Custom account would give.
async function createExpressAccount({ email }) {
  if (!isConfigured()) {
    const id = demoAccountId();
    console.log(`[stripe] STRIPE_SECRET_KEY not set — created demo account ${id} for ${email} instead of a real Stripe account.`);
    return { id, demo: true };
  }
  const account = await stripeRequest('POST', '/accounts', {
    type: 'express',
    email,
    capabilities: { transfers: { requested: true }, card_payments: { requested: true } },
  });
  return { id: account.id, demo: false };
}

// Account Links are single-use, short-lived URLs to Stripe's hosted
// onboarding (or re-onboarding) flow. refreshUrl is where Stripe sends the
// seller back if the link expires mid-flow (just restart); returnUrl is
// where Stripe sends them after they finish — whether or not every
// requirement was actually satisfied, so the account's real status still
// needs a separate lookup afterward (see retrieveAccount below).
async function createAccountLink({ accountId, refreshUrl, returnUrl }) {
  if (!isConfigured() || String(accountId).startsWith('acct_demo_')) {
    // No real Stripe account to send them to — simulate instant onboarding
    // by linking straight back to returnUrl with a flag the frontend
    // recognizes as "treat this as completed," so the rest of the flow
    // (including automated tests) can exercise the connected/payouts-enabled
    // state without a real browser trip through connect.stripe.com.
    const sep = returnUrl.includes('?') ? '&' : '?';
    console.log(`[stripe] demo mode — skipping real onboarding for ${accountId}, linking straight back to ${returnUrl}`);
    return { url: `${returnUrl}${sep}stripeDemo=1`, demo: true };
  }
  const link = await stripeRequest('POST', '/account_links', {
    account: accountId,
    refresh_url: refreshUrl,
    return_url: returnUrl,
    type: 'account_onboarding',
  });
  return { url: link.url, demo: false };
}

// Looks up an account's current onboarding status. details_submitted and
// payouts_enabled only go true once Stripe has everything it needs (identity
// verification, bank details, etc.) — a seller can click through the
// onboarding form and still come back with payouts_enabled: false if Stripe
// needs more from them, so this (not just "did they click the button") is
// what should actually drive the "connected" flag.
async function retrieveAccount(accountId) {
  if (!isConfigured() || String(accountId).startsWith('acct_demo_')) {
    // Demo accounts are considered fully onboarded the moment the seller
    // clicks through (see createAccountLink above) — there's no real Stripe
    // account to check requirements against.
    return { id: accountId, details_submitted: true, payouts_enabled: true, demo: true };
  }
  const account = await stripeRequest('GET', `/accounts/${accountId}`);
  return { id: account.id, details_submitted: !!account.details_submitted, payouts_enabled: !!account.payouts_enabled, demo: false };
}

// The frontend needs this (not the secret key!) to initialize Stripe.js and
// collect card details. Safe to expose — publishable keys are meant to be
// public. No key configured means no card collection in the UI at all; see
// server/routes/stripe-connect.js's /api/stripe/public-config.
function publishableKey() {
  return process.env.STRIPE_PUBLISHABLE_KEY || null;
}

function demoPaymentIntentId() {
  return `pi_demo_${require('crypto').randomBytes(8).toString('hex')}`;
}

// Places a hold on the client's card for `amount` (integer cents) without
// charging it yet (capture_method: 'manual') — this is the "authorize at
// request, charge at acceptance" design: the booking/rental is created with
// this hold in place, and a separate capturePaymentIntent call (below) is
// what actually moves the money, triggered only once the seller accepts.
async function createPaymentIntent({ amount, currency = 'usd', paymentMethodId, metadata }) {
  if (!isConfigured()) {
    const id = demoPaymentIntentId();
    console.log(`[stripe] demo mode — authorizing a fake PaymentIntent ${id} for $${(amount / 100).toFixed(2)} instead of charging a real card.`);
    return { id, status: 'requires_capture', demo: true };
  }
  const pi = await stripeRequest('POST', '/payment_intents', {
    amount: Math.round(amount),
    currency,
    payment_method: paymentMethodId,
    confirm: true,
    capture_method: 'manual',
    // allow_redirects: 'never' keeps this to payment methods (cards) that
    // can confirm without leaving the page — a redirect-based method would
    // need a very different, multi-step frontend flow this app doesn't have.
    automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
    metadata,
  });
  return { id: pi.id, status: pi.status, clientSecret: pi.client_secret, demo: false };
}

async function retrievePaymentIntent(id) {
  if (!isConfigured() || String(id).startsWith('pi_demo_')) {
    return { id, status: 'requires_capture', demo: true };
  }
  const pi = await stripeRequest('GET', `/payment_intents/${id}`);
  return { id: pi.id, status: pi.status, demo: false };
}

// Changes the held amount on a not-yet-captured PaymentIntent — used when a
// counter-offer is accepted and the final price differs from what was
// originally authorized.
async function updatePaymentIntentAmount(id, amount) {
  if (!isConfigured() || String(id).startsWith('pi_demo_')) {
    console.log(`[stripe] demo mode — "re-authorizing" fake PaymentIntent ${id} for $${(amount / 100).toFixed(2)}.`);
    return { id, status: 'requires_capture', demo: true };
  }
  const pi = await stripeRequest('POST', `/payment_intents/${id}`, { amount: Math.round(amount) });
  return { id: pi.id, status: pi.status, demo: false };
}

// Actually charges the card for the held amount — call this the moment the
// seller accepts, never before.
async function capturePaymentIntent(id) {
  if (!isConfigured() || String(id).startsWith('pi_demo_')) {
    return { id, status: 'succeeded', demo: true };
  }
  const pi = await stripeRequest('POST', `/payment_intents/${id}/capture`, {});
  return { id: pi.id, status: pi.status, demo: false };
}

// Releases a hold without ever charging the card — used when a request is
// declined or cancelled before acceptance.
async function cancelPaymentIntent(id) {
  if (!isConfigured() || String(id).startsWith('pi_demo_')) {
    return { id, status: 'canceled', demo: true };
  }
  const pi = await stripeRequest('POST', `/payment_intents/${id}/cancel`, {});
  return { id: pi.id, status: pi.status, demo: false };
}

// Returns some or all of an already-captured charge to the client — used for
// a musician no-show (full refund) and a rental's refundable security
// deposit at completion (partial refund). Omit `amount` for a full refund.
async function createRefund({ paymentIntentId, amount, metadata }) {
  if (!isConfigured() || String(paymentIntentId).startsWith('pi_demo_')) {
    const id = `re_demo_${require('crypto').randomBytes(8).toString('hex')}`;
    console.log(`[stripe] demo mode — faking a refund ${id} on ${paymentIntentId}${amount != null ? ` of $${(amount / 100).toFixed(2)}` : ' (full)'}.`);
    return { id, demo: true };
  }
  const params = { payment_intent: paymentIntentId, metadata };
  if (amount != null) params.amount = Math.round(amount);
  const refund = await stripeRequest('POST', '/refunds', params);
  return { id: refund.id, demo: false };
}

// Pays a connected seller their share of a completed booking/rental out of
// the platform's own Stripe balance — the "separate charges and transfers"
// pattern, chosen (over a destination charge) specifically so the transfer
// can be timed independently, at completion rather than at the original
// charge.
async function createTransfer({ amount, currency = 'usd', destination, metadata }) {
  if (!isConfigured() || String(destination).startsWith('acct_demo_')) {
    const id = `tr_demo_${require('crypto').randomBytes(8).toString('hex')}`;
    console.log(`[stripe] demo mode — faking a payout Transfer ${id} of $${(amount / 100).toFixed(2)} to ${destination}.`);
    return { id, demo: true };
  }
  const transfer = await stripeRequest('POST', '/transfers', { amount: Math.round(amount), currency, destination, metadata });
  return { id: transfer.id, demo: false };
}

module.exports = {
  isConfigured, publishableKey,
  createExpressAccount, createAccountLink, retrieveAccount,
  createPaymentIntent, retrievePaymentIntent, updatePaymentIntentAmount,
  capturePaymentIntent, cancelPaymentIntent, createRefund, createTransfer,
};
