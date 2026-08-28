# Deploying Musician Connect

This app is a single Node.js process with a SQLite file on disk — no
separate database service to provision. The one thing that matters for
*any* host you pick: **the `data/` folder has to live on persistent
storage**, or your data disappears on every redeploy/restart.

## Option A: Railway (recommended — simplest)

1. Install the CLI and log in:
   ```bash
   npm install -g @railway/cli   # run this on your own machine, not in this sandbox
   railway login
   ```
2. From the `musician-connect-app` folder:
   ```bash
   railway init
   railway up
   ```
   Railway detects `package.json`, installs nothing (there are no
   dependencies), and runs the `start` script (`node --experimental-sqlite
   server/server.js`).
3. **Add a persistent volume** (do this once, before real users sign up):
   - In the Railway dashboard, open your service → create a Volume →
     attach it to this service.
   - Set its mount path to `/app/data` (Railway builds your app into
     `/app`, and this app writes its database to `./data/app.db` relative
     to the project root).
   - Without this step, `data/app.db` lives on the container's ephemeral
     disk and every deploy wipes it.
4. Railway sets `PORT` automatically; the server already reads
   `process.env.PORT`, so no config needed there.
5. Create your admin account against the deployed app:
   ```bash
   railway run npm run create-admin -- you@yourdomain.com "a-strong-password" "Your Name"
   ```
6. Open the generated `*.up.railway.app` URL (or attach a custom domain in
   the dashboard) — that's the whole app, frontend and API together.

## Option B: Render

1. Push this project to a GitHub repo.
2. In Render, create a new **Web Service** from that repo.
   - Build command: (leave blank — nothing to build)
   - Start command: `npm start`
3. Under the service's **Disks** tab, add a persistent disk mounted at
   `/opt/render/project/src/data` (Render's default project path — check
   the path Render shows for your service if it differs).
4. Once deployed, open a shell for the service (or use a one-off job) to
   run `npm run create-admin -- you@yourdomain.com "a-strong-password" "Your Name"`.

## A note on Node version

Both platforms build from `package.json`'s `engines` field, which this
project sets to `>=22.5.0` — that's the version `node:sqlite` requires. If
a host's build logs show it picked an older Node, set the version
explicitly in that platform's settings (Railway: `NIXPACKS_NODE_VERSION`
environment variable; Render: the `NODE_VERSION` environment variable).

## Before you invite real users

- **No payment processor is wired up.** Booking/rental totals, service
  fees, and deposits are all calculated and stored, but no money actually
  moves. Add Stripe (or similar) before charging anyone for real.
- **Back up `data/app.db` regularly** once it holds real data — it's a
  single SQLite file, so `railway volume` snapshots or a simple scheduled
  `sqlite3 data/app.db ".backup ..."` job both work fine.
- Rotate in a real `SESSION` story if you ever run more than one server
  instance behind a load balancer — right now sessions live in the same
  SQLite file the rest of the app uses, which is fine for a single
  instance but won't be shared across multiple.

Sources:
- [Deploy & Host Node.js | Railway](https://railway.com/deploy/node-js)
- [Volumes | Railway Docs](https://docs.railway.com/guides/volumes)
