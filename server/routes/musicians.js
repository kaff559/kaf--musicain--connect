'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('../db');
const { HttpError } = require('../lib/router');
const { requireRole, serializeMusicianProfile, parseJsonSafe } = require('../lib/helpers');

// Demo files (short audio/video clips musicians upload from their dashboard)
// live on the same persistent disk as the SQLite database — see DEPLOY.md.
const UPLOADS_DIR = path.join(__dirname, '..', '..', 'data', 'uploads', 'demos');
const MAX_DEMO_BYTES = 10 * 1024 * 1024; // 10MB decoded file size
const DEMO_EXT_BY_MIME = {
  'audio/mpeg': '.mp3', 'audio/mp3': '.mp3', 'audio/wav': '.wav', 'audio/x-wav': '.wav',
  'audio/mp4': '.m4a', 'audio/x-m4a': '.m4a', 'audio/ogg': '.ogg',
  'video/mp4': '.mp4', 'video/quicktime': '.mov', 'video/webm': '.webm',
};

// Profile pictures — same "same persistent disk, only the URL lives in the
// DB" approach as demo files above, just a separate subfolder and a much
// smaller size cap since these are single still images.
const AVATAR_UPLOADS_DIR = path.join(__dirname, '..', '..', 'data', 'uploads', 'avatars');
const MAX_PHOTO_BYTES = 5 * 1024 * 1024; // 5MB decoded file size
const PHOTO_EXT_BY_MIME = {
  'image/jpeg': '.jpg', 'image/jpg': '.jpg', 'image/png': '.png',
  'image/webp': '.webp', 'image/gif': '.gif',
};

function haversineMiles(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const R = 3958.8;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Very small "smart search" natural-language parser: pulls out max hourly rate,
// a mile radius, and treats remaining words as keyword matches against
// instruments/genres/stage name/bio.
function parseSmartQuery(q) {
  const result = { maxRate: null, radiusMiles: null, keywords: [] };
  if (!q) return result;
  let text = String(q).toLowerCase();

  const rateMatch = text.match(/(?:less than|under|below|max(?:imum)?)\s*\$?(\d+(?:\.\d+)?)/);
  if (rateMatch) {
    result.maxRate = parseFloat(rateMatch[1]);
    text = text.replace(rateMatch[0], ' ');
  }
  const radiusMatch = text.match(/(\d+)\s*(?:mile|miles|mi)\b/);
  if (radiusMatch) {
    result.radiusMiles = parseInt(radiusMatch[1], 10);
    text = text.replace(radiusMatch[0], ' ');
  }
  text = text.replace(/\bradius\b|\ban hour\b|\bper hour\b|\bhourly\b|\bi need\b|\bthat is\b|\bthat charges\b|\bcharges\b/g, ' ');
  result.keywords = text.split(/[^a-z0-9']+/).map((w) => w.trim()).filter((w) => w.length > 2);
  return result;
}

function register(router) {
  router.get('/api/musicians', async (ctx) => {
    const q = ctx.query.q || ctx.query.query || '';
    const explicitMaxRate = ctx.query.maxRate ? parseFloat(ctx.query.maxRate) : null;
    const explicitState = ctx.query.state || null;
    const explicitCity = ctx.query.city || null;
    const explicitCountry = ctx.query.country || null;
    const emergencyOnly = ctx.query.emergency === '1' || ctx.query.emergency === 'true';
    const category = ctx.query.category || null;
    const eventType = ctx.query.eventType || null;
    const parsed = parseSmartQuery(q);
    const maxRate = explicitMaxRate != null && !Number.isNaN(explicitMaxRate) ? explicitMaxRate : parsed.maxRate;

    let rows = db.prepare(
      `SELECT mp.*, u.name AS user_name, u.suspended AS user_suspended
       FROM musician_profiles mp JOIN users u ON u.id = mp.user_id
       WHERE u.suspended = 0`
    ).all();

    if (maxRate != null) rows = rows.filter((r) => r.hourly_rate <= maxRate);
    // State/region is free text now (not a fixed US dropdown), so this is a
    // partial/substring match like city rather than an exact one.
    if (explicitState) rows = rows.filter((r) => (r.state || '').toLowerCase().includes(String(explicitState).toLowerCase()));
    if (explicitCity) rows = rows.filter((r) => (r.city || '').toLowerCase().includes(String(explicitCity).toLowerCase()));
    if (explicitCountry) rows = rows.filter((r) => (r.country || '').toLowerCase().includes(String(explicitCountry).toLowerCase()));
    if (emergencyOnly) rows = rows.filter((r) => !!r.emergency_available);

    // Exact-match category filter (a role/instrument picked from the
    // checklist, e.g. "DJ" or "Lead vocalist") — distinct from the fuzzy
    // keyword search box below.
    if (category) {
      rows = rows.filter((r) => parseJsonSafe(r.instruments, []).some((i) => i.toLowerCase() === category.toLowerCase()));
    }

    // Event-type filter respects each talent's own opt-in preferences: an
    // empty event_types list means "open to all event types" and always
    // matches; a non-empty list only matches when it includes the type
    // being searched for.
    if (eventType) {
      rows = rows.filter((r) => {
        const prefs = parseJsonSafe(r.event_types, []);
        return prefs.length === 0 || prefs.includes(eventType);
      });
    }

    if (parsed.keywords.length) {
      rows = rows.filter((r) => {
        const haystack = [
          r.stage_name, r.bio, r.city, r.state, r.country,
          ...parseJsonSafe(r.instruments, []),
          ...parseJsonSafe(r.genres, []),
        ].join(' ').toLowerCase();
        return parsed.keywords.some((kw) => haystack.includes(kw));
      });
    }

    // Radius filtering only kicks in once the client supplies an origin
    // point (lat/lng) — usually from the browser's geolocation API. Without
    // an origin we can't compute distance, so a "20 miles" phrase in the
    // smart-search box is otherwise ignored rather than silently wrong.
    // Distance is measured against each musician's own self-reported
    // coordinates (set via "Use my location" on their profile) rather than
    // any US-specific lookup table, so this works anywhere in the world.
    // A profile without coordinates set is never excluded by radius — we
    // simply don't know their distance, so we don't penalize them for it.
    if (ctx.query.lat && ctx.query.lng) {
      const originLat = parseFloat(ctx.query.lat);
      const originLng = parseFloat(ctx.query.lng);
      const radius = parsed.radiusMiles != null ? parsed.radiusMiles : (ctx.query.radius ? parseFloat(ctx.query.radius) : null);
      if (radius != null) {
        rows = rows.filter((r) => {
          if (r.lat == null || r.lng == null) return true; // location unknown, don't exclude
          return haversineMiles(originLat, originLng, r.lat, r.lng) <= radius;
        });
      }
    }

    const profiles = rows.map((r) => ({ ...serializeMusicianProfile(r), name: r.user_name }));
    return { profiles, parsedQuery: parsed };
  });

  router.get('/api/musicians/:id', async (ctx) => {
    const row = db.prepare('SELECT * FROM musician_profiles WHERE id = ?').get(ctx.params.id);
    if (!row) throw new HttpError(404, 'Musician profile not found');
    const user = db.prepare('SELECT name, suspended FROM users WHERE id = ?').get(row.user_id);
    const reviews = db.prepare(
      `SELECT r.*, u.name AS client_name FROM reviews r JOIN users u ON u.id = r.client_user_id
       WHERE r.musician_profile_id = ? ORDER BY r.created_at DESC`
    ).all(row.id);
    const backups = row.id ? db.prepare(
      `SELECT mp.*, u.name as user_name FROM musician_profiles mp JOIN users u ON u.id = mp.user_id
       WHERE mp.backup_for_profile_id = ? AND u.suspended = 0`
    ).all(row.id) : [];
    return {
      profile: { ...serializeMusicianProfile(row), name: user ? user.name : null, accountSuspended: !!(user && user.suspended) },
      reviews: reviews.map((r) => ({ id: r.id, rating: r.rating, comment: r.comment, clientName: r.client_name, createdAt: r.created_at })),
      backups: backups.map((b) => ({ ...serializeMusicianProfile(b), name: b.user_name })),
    };
  });

  router.post('/api/musicians/profile', async (ctx) => {
    const user = requireRole(ctx, 'musician');
    const p = db.prepare('SELECT * FROM musician_profiles WHERE user_id = ?').get(user.id);
    if (!p) throw new HttpError(404, 'Profile not found');
    const b = ctx.body;
    db.prepare(
      `UPDATE musician_profiles SET stage_name=?, instruments=?, genres=?, bio=?, hourly_rate=?, city=?, state=?, country=?,
       lat=?, lng=?, emergency_available=?, has_insurance=?, media_urls=?, video_url=?, event_types=? WHERE id=?`
    ).run(
      b.stageName || p.stage_name,
      JSON.stringify(Array.isArray(b.instruments) ? b.instruments : parseJsonSafe(p.instruments, [])),
      JSON.stringify(Array.isArray(b.genres) ? b.genres : parseJsonSafe(p.genres, [])),
      b.bio != null ? b.bio : p.bio,
      b.hourlyRate != null ? parseFloat(b.hourlyRate) : p.hourly_rate,
      b.city != null ? b.city : p.city,
      b.state != null ? b.state : p.state,
      b.country != null ? b.country : p.country,
      b.lat != null ? parseFloat(b.lat) : p.lat,
      b.lng != null ? parseFloat(b.lng) : p.lng,
      b.emergencyAvailable != null ? (b.emergencyAvailable ? 1 : 0) : p.emergency_available,
      b.hasInsurance != null ? (b.hasInsurance ? 1 : 0) : p.has_insurance,
      JSON.stringify(Array.isArray(b.mediaUrls) ? b.mediaUrls : parseJsonSafe(p.media_urls, [])),
      b.videoUrl != null ? b.videoUrl : p.video_url,
      JSON.stringify(Array.isArray(b.eventTypes) ? b.eventTypes : parseJsonSafe(p.event_types, [])),
      p.id
    );
    const updated = db.prepare('SELECT * FROM musician_profiles WHERE id = ?').get(p.id);
    return { profile: serializeMusicianProfile(updated) };
  });

  // Musicians can attach a short demo (audio or video clip) straight from
  // their dashboard. The file arrives as base64 in a JSON body (the app has
  // zero npm dependencies, so this avoids needing a multipart/form-data
  // parser) and gets written to disk; only its URL is stored in the DB,
  // appended to the same media_urls list used elsewhere for profile media.
  router.post('/api/musicians/demo-upload', async (ctx) => {
    const user = requireRole(ctx, 'musician');
    const p = db.prepare('SELECT * FROM musician_profiles WHERE user_id = ?').get(user.id);
    if (!p) throw new HttpError(404, 'Profile not found');
    const b = ctx.body;
    if (!b.dataBase64 || !b.mimeType) throw new HttpError(400, 'dataBase64 and mimeType are required');
    const isAudioOrVideo = /^(audio|video)\//.test(b.mimeType);
    if (!isAudioOrVideo) throw new HttpError(400, 'Only audio or video files can be uploaded as a demo');
    let buffer;
    try {
      buffer = Buffer.from(b.dataBase64, 'base64');
    } catch (e) {
      throw new HttpError(400, 'Could not decode file data');
    }
    if (!buffer.length) throw new HttpError(400, 'File appears to be empty');
    if (buffer.length > MAX_DEMO_BYTES) throw new HttpError(413, 'Demo files must be under 10MB');

    const ext = DEMO_EXT_BY_MIME[b.mimeType] || path.extname(b.fileName || '') || '';
    const safeName = `${p.id}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}${ext}`;
    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
    fs.writeFileSync(path.join(UPLOADS_DIR, safeName), buffer);

    const mediaUrls = parseJsonSafe(p.media_urls, []);
    mediaUrls.push({ url: `/uploads/demos/${safeName}`, mimeType: b.mimeType, fileName: b.fileName || safeName });
    db.prepare('UPDATE musician_profiles SET media_urls = ? WHERE id = ?').run(JSON.stringify(mediaUrls), p.id);
    const updated = db.prepare('SELECT * FROM musician_profiles WHERE id = ?').get(p.id);
    return { profile: serializeMusicianProfile(updated) };
  });

  router.post('/api/musicians/demo-delete', async (ctx) => {
    const user = requireRole(ctx, 'musician');
    const p = db.prepare('SELECT * FROM musician_profiles WHERE user_id = ?').get(user.id);
    if (!p) throw new HttpError(404, 'Profile not found');
    const b = ctx.body;
    if (!b.url) throw new HttpError(400, 'url is required');
    const mediaUrls = parseJsonSafe(p.media_urls, []);
    const remaining = mediaUrls.filter((m) => m.url !== b.url);
    db.prepare('UPDATE musician_profiles SET media_urls = ? WHERE id = ?').run(JSON.stringify(remaining), p.id);
    // Best-effort cleanup of the file on disk — a missing file here should
    // never block removing the entry from the profile.
    if (b.url.startsWith('/uploads/demos/')) {
      const filePath = path.join(UPLOADS_DIR, path.basename(b.url));
      fs.unlink(filePath, () => {});
    }
    const updated = db.prepare('SELECT * FROM musician_profiles WHERE id = ?').get(p.id);
    return { profile: serializeMusicianProfile(updated) };
  });

  // Profile picture upload — same base64-JSON approach as demo-upload (no
  // multipart parser needed). Replaces any previous photo: the old file is
  // best-effort deleted so uploads/avatars doesn't accumulate orphaned files
  // every time someone changes their picture.
  router.post('/api/musicians/photo-upload', async (ctx) => {
    const user = requireRole(ctx, 'musician');
    const p = db.prepare('SELECT * FROM musician_profiles WHERE user_id = ?').get(user.id);
    if (!p) throw new HttpError(404, 'Profile not found');
    const b = ctx.body;
    if (!b.dataBase64 || !b.mimeType) throw new HttpError(400, 'dataBase64 and mimeType are required');
    if (!/^image\//.test(b.mimeType)) throw new HttpError(400, 'Only image files can be used as a profile photo');
    let buffer;
    try {
      buffer = Buffer.from(b.dataBase64, 'base64');
    } catch (e) {
      throw new HttpError(400, 'Could not decode file data');
    }
    if (!buffer.length) throw new HttpError(400, 'File appears to be empty');
    if (buffer.length > MAX_PHOTO_BYTES) throw new HttpError(413, 'Profile photos must be under 5MB');

    const ext = PHOTO_EXT_BY_MIME[b.mimeType] || path.extname(b.fileName || '') || '';
    const safeName = `${p.id}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}${ext}`;
    fs.mkdirSync(AVATAR_UPLOADS_DIR, { recursive: true });
    fs.writeFileSync(path.join(AVATAR_UPLOADS_DIR, safeName), buffer);

    const oldUrl = p.photo_url;
    db.prepare('UPDATE musician_profiles SET photo_url = ? WHERE id = ?').run(`/uploads/avatars/${safeName}`, p.id);
    if (oldUrl && oldUrl.startsWith('/uploads/avatars/')) {
      fs.unlink(path.join(AVATAR_UPLOADS_DIR, path.basename(oldUrl)), () => {});
    }
    const updated = db.prepare('SELECT * FROM musician_profiles WHERE id = ?').get(p.id);
    return { profile: serializeMusicianProfile(updated) };
  });

  router.post('/api/musicians/photo-delete', async (ctx) => {
    const user = requireRole(ctx, 'musician');
    const p = db.prepare('SELECT * FROM musician_profiles WHERE user_id = ?').get(user.id);
    if (!p) throw new HttpError(404, 'Profile not found');
    if (p.photo_url && p.photo_url.startsWith('/uploads/avatars/')) {
      fs.unlink(path.join(AVATAR_UPLOADS_DIR, path.basename(p.photo_url)), () => {});
    }
    db.prepare('UPDATE musician_profiles SET photo_url = NULL WHERE id = ?').run(p.id);
    const updated = db.prepare('SELECT * FROM musician_profiles WHERE id = ?').get(p.id);
    return { profile: serializeMusicianProfile(updated) };
  });

  // Simulated ID verification (demo only, mirrors the static prototype's
  // "verify" toggle — no real identity provider involved).
  router.post('/api/musicians/verify-id', async (ctx) => {
    const user = requireRole(ctx, 'musician');
    const p = db.prepare('SELECT * FROM musician_profiles WHERE user_id = ?').get(user.id);
    if (!p) throw new HttpError(404, 'Profile not found');
    db.prepare('UPDATE musician_profiles SET id_verified = 1 WHERE id = ?').run(p.id);
    return { profile: serializeMusicianProfile(db.prepare('SELECT * FROM musician_profiles WHERE id = ?').get(p.id)) };
  });
}

module.exports = { register, parseSmartQuery, haversineMiles };
