'use strict';

const db = require('../db');
const { HttpError } = require('../lib/router');
const { requireRole, serializeMusicianProfile, parseJsonSafe } = require('../lib/helpers');

// crude US state-centroid table for "within N miles" approximation, mirrors the
// original static prototype's travel-distance logic.
const STATE_CENTROIDS = require('../lib/state-centroids');

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
    const emergencyOnly = ctx.query.emergency === '1' || ctx.query.emergency === 'true';
    const parsed = parseSmartQuery(q);
    const maxRate = explicitMaxRate != null && !Number.isNaN(explicitMaxRate) ? explicitMaxRate : parsed.maxRate;

    let rows = db.prepare(
      `SELECT mp.*, u.name AS user_name, u.suspended AS user_suspended
       FROM musician_profiles mp JOIN users u ON u.id = mp.user_id
       WHERE u.suspended = 0`
    ).all();

    if (maxRate != null) rows = rows.filter((r) => r.hourly_rate <= maxRate);
    if (explicitState) rows = rows.filter((r) => (r.state || '').toLowerCase() === String(explicitState).toLowerCase());
    if (explicitCity) rows = rows.filter((r) => (r.city || '').toLowerCase().includes(String(explicitCity).toLowerCase()));
    if (emergencyOnly) rows = rows.filter((r) => !!r.emergency_available);

    if (parsed.keywords.length) {
      rows = rows.filter((r) => {
        const haystack = [
          r.stage_name, r.bio, r.city, r.state,
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
    if (ctx.query.lat && ctx.query.lng) {
      const originLat = parseFloat(ctx.query.lat);
      const originLng = parseFloat(ctx.query.lng);
      const radius = parsed.radiusMiles != null ? parsed.radiusMiles : (ctx.query.radius ? parseFloat(ctx.query.radius) : null);
      if (radius != null) {
        rows = rows.filter((r) => {
          const c = STATE_CENTROIDS[(r.state || '').toUpperCase()];
          if (!c) return true; // unknown state, don't exclude
          return haversineMiles(originLat, originLng, c.lat, c.lng) <= radius;
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
      `UPDATE musician_profiles SET stage_name=?, instruments=?, genres=?, bio=?, hourly_rate=?, city=?, state=?,
       emergency_available=?, has_insurance=?, media_urls=?, video_url=? WHERE id=?`
    ).run(
      b.stageName || p.stage_name,
      JSON.stringify(Array.isArray(b.instruments) ? b.instruments : parseJsonSafe(p.instruments, [])),
      JSON.stringify(Array.isArray(b.genres) ? b.genres : parseJsonSafe(p.genres, [])),
      b.bio != null ? b.bio : p.bio,
      b.hourlyRate != null ? parseFloat(b.hourlyRate) : p.hourly_rate,
      b.city != null ? b.city : p.city,
      b.state != null ? b.state : p.state,
      b.emergencyAvailable != null ? (b.emergencyAvailable ? 1 : 0) : p.emergency_available,
      b.hasInsurance != null ? (b.hasInsurance ? 1 : 0) : p.has_insurance,
      JSON.stringify(Array.isArray(b.mediaUrls) ? b.mediaUrls : parseJsonSafe(p.media_urls, [])),
      b.videoUrl != null ? b.videoUrl : p.video_url,
      p.id
    );
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
