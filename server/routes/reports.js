'use strict';

const db = require('../db');
const { HttpError } = require('../lib/router');
const { requireAuth } = require('../lib/helpers');

function register(router) {
  // Trust & Safety: report a user or a musician profile.
  router.post('/api/reports', async (ctx) => {
    const user = requireAuth(ctx);
    const { reportedUserId, reportedMusicianProfileId, reason } = ctx.body;
    if (!reason || !String(reason).trim()) throw new HttpError(400, 'reason is required');
    if (!reportedUserId && !reportedMusicianProfileId) throw new HttpError(400, 'reportedUserId or reportedMusicianProfileId is required');
    db.prepare(
      'INSERT INTO reports (reporter_user_id, reported_user_id, reported_musician_profile_id, reason) VALUES (?, ?, ?, ?)'
    ).run(user.id, reportedUserId || null, reportedMusicianProfileId || null, String(reason).trim());
    return { ok: true };
  });

  router.get('/api/reports/mine', async (ctx) => {
    const user = requireAuth(ctx);
    const rows = db.prepare('SELECT * FROM reports WHERE reporter_user_id = ? ORDER BY created_at DESC').all(user.id);
    return { reports: rows.map((r) => ({ id: r.id, reason: r.reason, status: r.status, createdAt: r.created_at })) };
  });
}

module.exports = { register };
