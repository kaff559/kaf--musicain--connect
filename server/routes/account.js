'use strict';

const crypto = require('crypto');
const db = require('../db');
const { HttpError } = require('../lib/router');
const auth = require('../lib/auth');
const { requireAuth } = require('../lib/helpers');

// Account deletion: required by both the App Store and Google Play (a user
// must be able to delete their account from inside the app, not just by
// emailing support).
//
// We don't hard-delete the `users` row itself, because other tables
// (disputes, reports) reference a user without ON DELETE CASCADE — those
// records need to survive so the other party's history/disputes still make
// sense. Instead we:
//   1. Delete everything that's clearly "theirs to delete" and cascades
//      cleanly (their public profile/listings, which cascades to reviews
//      about them, bookings/rentals tied to that profile, etc).
//   2. Delete their favorites, notifications, and sessions.
//   3. Anonymize the user row itself (name -> "Deleted User", email -> an
//      unreachable placeholder, password -> a random value nobody knows) so
//      the account can never be logged into again and no longer displays
//      any personal information anywhere in the app.
function register(router) {
  router.post('/api/account/delete', async (ctx) => {
    const user = requireAuth(ctx);

    if (user.role === 'admin') {
      throw new HttpError(400, "Admin accounts can't be self-deleted here. Ask another admin to remove this account from the Admin panel.");
    }

    const { password } = ctx.body || {};
    if (!password) throw new HttpError(400, 'Enter your password to confirm account deletion');
    if (!auth.verifyPassword(password, user.password_salt, user.password_hash)) {
      throw new HttpError(401, 'Incorrect password');
    }

    db.exec('BEGIN');
    try {
      if (user.role === 'musician') {
        db.prepare('DELETE FROM musician_profiles WHERE user_id = ?').run(user.id);
      } else if (user.role === 'equipment_owner') {
        db.prepare('DELETE FROM equipment_owner_profiles WHERE user_id = ?').run(user.id);
      }
      db.prepare('DELETE FROM favorites WHERE client_user_id = ?').run(user.id);
      db.prepare('DELETE FROM notifications WHERE user_id = ?').run(user.id);
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);

      const { hash, salt } = auth.hashPassword(crypto.randomBytes(32).toString('hex'));
      const anonEmail = `deleted-${user.id}-${Date.now()}@deleted.local`;
      db.prepare(
        'UPDATE users SET email = ?, name = ?, phone = NULL, password_hash = ?, password_salt = ? WHERE id = ?'
      ).run(anonEmail, 'Deleted User', hash, salt, user.id);

      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }

    auth.clearSessionCookie(ctx.res);
    return { ok: true };
  });
}

module.exports = { register };
