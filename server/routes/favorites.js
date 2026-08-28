'use strict';

const db = require('../db');
const { HttpError } = require('../lib/router');
const { requireRole, serializeMusicianProfile } = require('../lib/helpers');

function register(router) {
  router.post('/api/favorites/:musicianProfileId', async (ctx) => {
    const user = requireRole(ctx, 'client');
    const profileId = ctx.params.musicianProfileId;
    const profile = db.prepare('SELECT * FROM musician_profiles WHERE id = ?').get(profileId);
    if (!profile) throw new HttpError(404, 'Musician not found');
    const existing = db.prepare('SELECT id FROM favorites WHERE client_user_id = ? AND musician_profile_id = ?').get(user.id, profileId);
    if (existing) {
      db.prepare('DELETE FROM favorites WHERE id = ?').run(existing.id);
      return { favorited: false };
    }
    db.prepare('INSERT INTO favorites (client_user_id, musician_profile_id) VALUES (?, ?)').run(user.id, profileId);
    return { favorited: true };
  });

  router.get('/api/favorites/mine', async (ctx) => {
    const user = requireRole(ctx, 'client');
    const rows = db.prepare(
      `SELECT mp.*, u.name as user_name FROM favorites f
       JOIN musician_profiles mp ON mp.id = f.musician_profile_id
       JOIN users u ON u.id = mp.user_id
       WHERE f.client_user_id = ? ORDER BY f.created_at DESC`
    ).all(user.id);
    return { profiles: rows.map((r) => ({ ...serializeMusicianProfile(r), name: r.user_name })) };
  });
}

module.exports = { register };
