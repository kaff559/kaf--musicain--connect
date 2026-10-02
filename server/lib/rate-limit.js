'use strict';

// Minimal in-memory rate limiter — no dependencies, same "zero-npm" style as
// the rest of this backend. Buckets are keyed by a caller-chosen string
// (typically the request's IP, sometimes IP+email for tighter per-account
// limits on top of the per-IP one) and reset on a fixed window.
//
// This is good enough for a single-instance deploy like this app's current
// Render setup. Two things to know if the app ever outgrows this:
//  - It resets on every server restart/redeploy, so a determined attacker
//    just has to wait one out. Fine for "slow down casual bots and scripts"
//    which is the actual goal here, not a hard security boundary.
//  - If this app ever runs as more than one server instance, each instance
//    would track its own buckets independently (no shared state), which
//    effectively multiplies the limits by the instance count. At that point
//    this would need to move to a shared store (e.g. Redis) instead.

const buckets = new Map(); // key -> { count, resetAt }

// Render (and most PaaS hosts) sit behind a proxy, so the socket's own
// remoteAddress is the proxy, not the visitor — the real client IP arrives
// in x-forwarded-for as "client, proxy1, proxy2"; take the first entry.
// Falls back to the socket address for local/dev runs with no proxy.
function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return String(fwd).split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

// Sweeps expired buckets periodically so the map doesn't grow unbounded on
// a long-running process. unref() so this timer never keeps the process
// alive on its own (it shouldn't block a clean shutdown).
const SWEEP_MS = 5 * 60 * 1000;
const sweepTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}, SWEEP_MS);
if (typeof sweepTimer.unref === 'function') sweepTimer.unref();

// Fixed-window counter: `max` hits allowed per `windowMs`, per key. Not
// perfectly smooth (a burst can land right at a window boundary), but
// simple, cheap, and plenty for slowing down scripted abuse.
function hit(key, max, windowMs) {
  const now = Date.now();
  let bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    bucket = { count: 0, resetAt: now + windowMs };
    buckets.set(key, bucket);
  }
  bucket.count++;
  const allowed = bucket.count <= max;
  const retryAfterSeconds = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
  return { allowed, retryAfterSeconds };
}

function formatWait(seconds) {
  if (seconds < 60) return `${seconds}s`;
  return `${Math.ceil(seconds / 60)}m`;
}

// Builds a per-route limiter: `rateLimit({ max, windowMs, keyPrefix, keyFn })`
// returns a function you call as the first line of a route handler with the
// request ctx. It throws HttpError(429) (and sets Retry-After) once the key
// exceeds `max` hits within `windowMs`. `keyFn(ctx)` customizes the bucket
// beyond plain IP (e.g. IP+email, so a login brute force against one
// account from many IPs is still caught); defaults to IP alone.
function rateLimit({ max, windowMs, keyPrefix, keyFn }) {
  const { HttpError } = require('./router');
  return function enforce(ctx) {
    const ip = clientIp(ctx.req);
    const suffix = keyFn ? keyFn(ctx) : ip;
    const key = `${keyPrefix}:${suffix}`;
    const { allowed, retryAfterSeconds } = hit(key, max, windowMs);
    if (!allowed) {
      ctx.res.setHeader('Retry-After', String(retryAfterSeconds));
      throw new HttpError(429, `Too many attempts — try again in ${formatWait(retryAfterSeconds)}.`);
    }
  };
}

module.exports = { clientIp, hit, rateLimit };
