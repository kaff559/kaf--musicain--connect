'use strict';

const db = require('../db');
const { HttpError } = require('../lib/router');
const { requireRole, requireConsentCleared, musicianProfileForUser, equipmentOwnerProfileForUser, notify, SERVICE_FEE_RATE } = require('../lib/helpers');
const stripe = require('../lib/stripe');

// Only sellers (musicians, equipment owners) have a Connect account — a
// client never needs one, since clients pay rather than get paid out.
function profileConfigFor(role) {
  if (role === 'musician') return { table: 'musician_profiles', getProfile: musicianProfileForUser };
  if (role === 'equipment_owner') return { table: 'equipment_owner_profiles', getProfile: equipmentOwnerProfileForUser };
  return null;
}

function register(router) {
  // Public, unauthenticated config the frontend needs before a client even
  // starts a booking/rental request:
  //  - configured/publishableKey: whether to load Stripe.js and collect a
  //    real card at all. Until STRIPE_SECRET_KEY/STRIPE_PUBLISHABLE_KEY are
  //    set on the server, configured is false and every request runs
  //    through the demo-mode payment flow instead.
  //  - serviceFeeRate: the live take rate (see SERVICE_FEE_RATE in
  //    lib/helpers.js — 0 for now), so the rental cost estimate shown
  //    before submitting never drifts from what the server will actually
  //    charge.
  router.get('/api/stripe/public-config', async () => {
    return { configured: stripe.isConfigured(), publishableKey: stripe.publishableKey(), serviceFeeRate: SERVICE_FEE_RATE };
  });

  // Current connect status for the logged-in seller's own profile — used by
  // the dashboard to show "Connect with Stripe" vs. "Connected ✓".
  router.get('/api/stripe/connect/status', async (ctx) => {
    const user = requireRole(ctx, 'musician', 'equipment_owner');
    const cfg = profileConfigFor(user.role);
    const profile = cfg.getProfile(user.id);
    if (!profile) throw new HttpError(404, 'Profile not found');
    return {
      connected: !!profile.stripe_account_id,
      payoutsEnabled: !!profile.stripe_payouts_enabled,
      demo: !stripe.isConfigured(),
    };
  });

  // Starts (or resumes) onboarding: creates an Express account the first
  // time this seller connects, then always issues a fresh Account Link —
  // those expire quickly, so the account itself is reused but a new link is
  // generated on every click.
  router.post('/api/stripe/connect/start', async (ctx) => {
    const user = requireRole(ctx, 'musician', 'equipment_owner');
    // Connecting a real payout/bank account is a financial action, same
    // category as posting a profile or accepting a booking — block it for
    // an account still waiting on (or turned down for) guardian approval.
    // Note: Stripe's own terms separately require the account holder to be
    // an adult, which this doesn't attempt to enforce — that's a real gap
    // if an *approved* minor account tries to connect, flagged here rather
    // than solved, since it needs its own decision about how to handle it.
    requireConsentCleared(user);
    const cfg = profileConfigFor(user.role);
    const profile = cfg.getProfile(user.id);
    if (!profile) throw new HttpError(404, 'Profile not found');

    let accountId = profile.stripe_account_id;
    if (!accountId) {
      const account = await stripe.createExpressAccount({ email: user.email });
      accountId = account.id;
      db.prepare(`UPDATE ${cfg.table} SET stripe_account_id = ? WHERE user_id = ?`).run(accountId, user.id);
    }

    const proto = ctx.req.headers['x-forwarded-proto'] || 'http';
    const origin = `${proto}://${ctx.req.headers.host}`;
    // Both land back on the home route — the SPA figures out where to send
    // the seller from the stripeConnectReturn query param, same pattern as
    // ?resetToken=/?consentToken= already in use for the other email-style
    // redirect flows.
    const returnUrl = `${origin}/?stripeConnectReturn=1`;
    const refreshUrl = `${origin}/?stripeConnectRefresh=1`;

    const link = await stripe.createAccountLink({ accountId, refreshUrl, returnUrl });
    return { url: link.url };
  });

  // Called when the seller lands back from onboarding (real or demo) — asks
  // Stripe (or, in demo mode, assumes) whether the account is actually fully
  // set up, and caches that on the profile so the dashboard — and later, the
  // payout step of a completed booking/rental — don't need to call Stripe on
  // every request.
  router.post('/api/stripe/connect/refresh', async (ctx) => {
    const user = requireRole(ctx, 'musician', 'equipment_owner');
    const cfg = profileConfigFor(user.role);
    const profile = cfg.getProfile(user.id);
    if (!profile || !profile.stripe_account_id) throw new HttpError(400, 'No Stripe account connected yet');

    const account = await stripe.retrieveAccount(profile.stripe_account_id);
    const payoutsEnabled = !!account.payouts_enabled;
    db.prepare(`UPDATE ${cfg.table} SET stripe_payouts_enabled = ? WHERE user_id = ?`).run(payoutsEnabled ? 1 : 0, user.id);

    if (payoutsEnabled && !profile.stripe_payouts_enabled) {
      notify(user.id, 'Your Stripe account is connected — you can now be paid out for completed bookings/rentals.', 'success');
    }
    return { connected: true, payoutsEnabled, demo: !stripe.isConfigured() };
  });
}

module.exports = { register };
