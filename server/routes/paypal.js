'use strict';

const db = require('../db');
const { HttpError } = require('../lib/router');
const { requireAuth, requireRole, requireConsentCleared, musicianProfileForUser, equipmentOwnerProfileForUser, notify, SERVICE_FEE_RATE } = require('../lib/helpers');
const paypal = require('../lib/paypal');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Loose upper bound on a single PayPal order — just enough to stop someone
// from spamming the create-order endpoint with wildly out-of-range amounts;
// the real safety check (that an order's approved amount actually covers
// the booking/rental it's used for) lives in lib/payments.js.
const MAX_ORDER_DOLLARS = 50000;

function profileConfigFor(role) {
  if (role === 'musician') return { table: 'musician_profiles', getProfile: musicianProfileForUser };
  if (role === 'equipment_owner') return { table: 'equipment_owner_profiles', getProfile: equipmentOwnerProfileForUser };
  return null;
}

function register(router) {
  // Public, unauthenticated config the frontend needs before a client even
  // starts a booking/rental request:
  //  - configured/clientId: whether to load PayPal's JS SDK and render
  //    payment buttons at all. Until PAYPAL_CLIENT_ID/PAYPAL_CLIENT_SECRET
  //    are set on the server, configured is false and every request runs
  //    through the demo-mode payment flow instead.
  //  - serviceFeeRate: the live take rate (see SERVICE_FEE_RATE in
  //    lib/helpers.js — 0 for now), so the cost estimate shown before
  //    submitting never drifts from what the server will actually charge.
  router.get('/api/paypal/public-config', async () => {
    return { configured: paypal.isConfigured(), clientId: paypal.clientId(), serviceFeeRate: SERVICE_FEE_RATE };
  });

  // Creates a PayPal order for the buyer to approve client-side (via the
  // PayPal JS SDK's createOrder callback) — used before a booking/rental
  // exists yet, and again for a counter-offer's new total. Requires login
  // so this can't be hit fully anonymously, but intentionally doesn't tie
  // the order to any specific booking/rental yet; see lib/payments.js for
  // where the resulting order id gets checked against a real total.
  router.post('/api/paypal/orders', async (ctx) => {
    requireAuth(ctx);
    const amountDollars = parseFloat(ctx.body.amountDollars);
    if (!Number.isFinite(amountDollars) || amountDollars <= 0 || amountDollars > MAX_ORDER_DOLLARS) {
      throw new HttpError(400, 'amountDollars must be a positive number');
    }
    const order = await paypal.createOrder({ amountDollars, description: 'Kaf Musician Connect' });
    return { orderId: order.id };
  });

  // Apple Pay (see the "Apple Pay Advanced Integration" section of
  // lib/paypal.js) rides on top of the same order created above — these two
  // endpoints just do the two server-side steps Safari's ApplePaySession
  // can't do itself: vouching for the merchant to Apple, then attaching the
  // resulting payment token to that order.
  router.post('/api/paypal/apple-pay/validate-merchant', async (ctx) => {
    requireAuth(ctx);
    const validationUrl = ctx.body.validationUrl;
    if (!validationUrl) throw new HttpError(400, 'validationUrl is required');
    const merchantSession = await paypal.validateApplePayMerchant(validationUrl);
    return { merchantSession };
  });

  router.post('/api/paypal/apple-pay/confirm', async (ctx) => {
    requireAuth(ctx);
    const { orderId, token } = ctx.body;
    if (!orderId || !token) throw new HttpError(400, 'orderId and token are required');
    await paypal.confirmApplePayOrder({ orderId, token });
    return { ok: true };
  });

  // Current payout-connection status for the logged-in seller's own profile
  // — used by the dashboard to show "Add your PayPal email" vs. "Connected".
  router.get('/api/paypal/connect/status', async (ctx) => {
    const user = requireRole(ctx, 'musician', 'equipment_owner');
    const cfg = profileConfigFor(user.role);
    const profile = cfg.getProfile(user.id);
    if (!profile) throw new HttpError(404, 'Profile not found');
    return { connected: !!profile.paypal_email, email: profile.paypal_email || null };
  });

  // Saves (or updates) the PayPal email address a seller's payouts should
  // go to. Unlike the old Stripe Connect flow this is just an email address
  // — no hosted onboarding, no redirect back to the app. We don't verify the
  // address is a real/working PayPal account up front; a payout to a bad
  // address simply fails at payout time and the seller is notified (see
  // the /complete handlers in routes/bookings.js and routes/rentals.js).
  router.post('/api/paypal/connect', async (ctx) => {
    const user = requireRole(ctx, 'musician', 'equipment_owner');
    // Connecting a payout destination is a financial action, same category
    // as posting a profile or accepting a booking — block it for an account
    // still waiting on (or turned down for) guardian approval.
    requireConsentCleared(user);
    const email = (ctx.body.email || '').trim();
    if (!EMAIL_RE.test(email)) throw new HttpError(400, 'Enter a valid email address');
    const cfg = profileConfigFor(user.role);
    const profile = cfg.getProfile(user.id);
    if (!profile) throw new HttpError(404, 'Profile not found');
    db.prepare(`UPDATE ${cfg.table} SET paypal_email = ? WHERE user_id = ?`).run(email, user.id);
    notify(user.id, 'Your PayPal payout email is saved — you can now be paid out for completed bookings/rentals.', 'success');
    return { connected: true, email };
  });
}

module.exports = { register };