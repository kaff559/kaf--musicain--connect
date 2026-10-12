'use strict';

// TEMPORARY diagnostic route (2026-10-12) — tracking down why some users
// rows seem to come back with every column NULL. Not linked from anywhere,
// requires a long random key as a query param, and is meant to be removed
// again as soon as the investigation is done. Do not leave this deployed
// longer than necessary.

const db = require('../db');

const DEBUG_KEY = '14e6dcf65049f0c85b4eb9a930a20f92ac0d11328221010d';

function register(router) {
  router.get('/api/_temp_debug_users', async (ctx) => {
    if (ctx.query.key !== DEBUG_KEY) {
      return { error: 'not found' };
    }
    const rows = db.prepare(
      'SELECT id, email, role, name, created_at FROM users ORDER BY id DESC LIMIT 20'
    ).all();
    const count = db.prepare('SELECT COUNT(*) AS n FROM users').get();
    return { count: count.n, rows };
  });
}

module.exports = { register };
