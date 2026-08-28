# Musician Connect

A full-stack marketplace connecting musicians, singers, MCs, and DJs with clients
who want to hire them — plus a peer-to-peer equipment rental marketplace
(speakers, mics, drum kits, DJ gear, lighting, etc). This is the real,
persistent version of the app: actual accounts, actual passwords, actual data
that survives a server restart.

## Why this has zero npm dependencies

It's built entirely on what ships inside Node.js itself:

- **`node:http`** — the web server (hand-written router, see `server/lib/router.js`)
- **`node:sqlite`** — the database (real file on disk at `data/app.db`, no separate DB server to run)
- **`node:crypto`** — password hashing (scrypt) and session tokens

No `npm install` step, no `node_modules`, nothing to go out of date. Node 22.5+
is required because that's when `node:sqlite` shipped.

## Running it locally

```bash
node --version   # must be v22.5.0 or newer
npm start         # same as: node --experimental-sqlite server/server.js
```

Then open http://localhost:3000 — the frontend and API are served from the
same process, so there's nothing else to start.

The database file is created automatically at `data/app.db` on first run.
Delete that file (server stopped) to reset all data.

### Creating an admin account

There's no public signup for the admin role, on purpose. Create one from the
command line:

```bash
npm run create-admin -- admin@yourdomain.com "a-strong-password" "Your Name"
```

Running it again with the same email promotes that existing account to admin
instead of erroring.

## What's included

- Real accounts for four roles: musician, client, equipment owner, admin —
  hashed passwords, real login sessions (HttpOnly cookies), not the old demo
  login.
- Musician profiles: instruments, genres, hourly rate, bio, ID verification
  (demo/simulated — no real identity provider is wired up), emergency/last-minute
  availability, self-reported insurance, designated backup musicians.
- Natural-language "smart search" — e.g. *"gospel piano player less than $100
  an hour"* parses out the max rate and keywords automatically.
- Request-to-hire booking flow: pending → accept / decline / counter-offer →
  accepted → completed, with a 10% platform service fee calculated
  automatically.
- No-show handling: musician no-show → client refund (conceptual — no live
  payment processor is wired up) + musician forfeits the fee + strike on
  their profile. Client no-show → no refund, musician may invoice separately.
- Reviews (1–5 stars) on completed bookings, favorites, in-app notifications.
- Equipment rental marketplace: owner profiles, listings with daily rate +
  refundable security deposit, rental requests with a full fee breakdown.
- Trust & Safety reports and a dispute-filing flow.
- Admin panel: suspend/reinstate any account (auto-cancels their pending/active
  bookings or rentals and notifies the other party), resolve reports and
  disputes.
- Installable on Android and iPhone as a Progressive Web App (PWA): open the
  deployed site in Chrome (Android) or Safari (iOS) and use "Add to Home
  Screen" — it launches full-screen with its own icon, no app store needed.
  A service worker (`public/sw.js`) caches the app shell for a faster/more
  resilient load; it never caches `/api/*`, so bookings, search, and auth
  stay live. The layout is also responsive down to phone widths.

## What's *not* wired up (and why)

This app tracks money conceptually (fees, deposits, refunds are all computed
and stored) but does **not** move real money — there's no Stripe/PayPal
integration. Wiring one in is a natural next step once you're ready to take
real payments; the booking/rental records already carry the amounts a payment
integration would need.

ID verification is a one-click demo toggle, not a real identity check.

## Project structure

```
server/
  server.js           entry point — HTTP server + static file serving
  db.js               SQLite schema (auto-created on first run)
  lib/
    router.js          tiny hand-written router + JSON body parsing
    auth.js             password hashing, sessions, cookies
    helpers.js           shared request/response helpers
    state-centroids.js    rough US state coordinates for the mile-radius search
  routes/               one file per API area (auth, musicians, bookings, ...)
  scripts/create-admin.js
public/
  index.html, app.js, styles.css   the whole frontend (vanilla JS, no build step)
data/
  app.db                created automatically, not committed to git
```

See `DEPLOY.md` for how to put this on Railway or Render.
