'use strict';

const db = require('../db');
const { HttpError } = require('../lib/router');
const { requireAuth } = require('../lib/helpers');

function register(router) {
  router.get('/api/notifications/mine', async (ctx) => {
    const user = requireAuth(ctx);
    const rows = db.prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 100').all(user.id);
    return {
      notifications: rows.map((n) => ({
        id: n.id, message: n.message, type: n.type, read: !!n.is_read, createdAt: n.created_at,
      })),
      unreadCount: rows.filter((n) => !n.is_read).length,
    };
  });

  router.post('/api/notifications/:id/read', async (ctx) => {
    const user = requireAuth(ctx);
    const n = db.prepare('SELECT * FROM notifications WHERE id = ?').get(ctx.params.id);
    if (!n || n.user_id !== user.id) throw new HttpError(404, 'Notification not found');
    db.prepare('UPDATE notifications SET is_read = 1 WHERE id = ?').run(n.id);
    return { ok: true };
  });

  router.post('/api/notifications/read-all', async (ctx) => {
    const user = requireAuth(ctx);
    db.prepare('UPDATE notifications SET is_read = 1 WHERE user_id = ?').run(user.id);
    return { ok: true };
  });
}

module.exports = { register };
