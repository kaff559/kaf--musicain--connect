'use strict';

const db = require('../db');
const { HttpError } = require('./router');

const SERVICE_FEE_RATE = 0.10;

function requireAuth(ctx) {
  if (!ctx.user) throw new HttpError(401, 'Login required');
  if (ctx.user.suspended) throw new HttpError(403, 'Account suspended: ' + (ctx.user.suspension_reason || 'contact support'));
  return ctx.user;
}

function requireRole(ctx, ...roles) {
  const u = requireAuth(ctx);
  if (!roles.includes(u.role)) throw new HttpError(403, 'Not authorized for this action');
  return u;
}

function notify(userId, message, type = 'info') {
  db.prepare('INSERT INTO notifications (user_id, message, type) VALUES (?, ?, ?)').run(userId, message, type);
}

function calcServiceFee(amount) {
  return Math.round(amount * SERVICE_FEE_RATE * 100) / 100;
}

function parseJsonSafe(str, fallback) {
  try { return JSON.parse(str); } catch (e) { return fallback; }
}

function musicianProfileForUser(userId) {
  return db.prepare('SELECT * FROM musician_profiles WHERE user_id = ?').get(userId);
}

function equipmentOwnerProfileForUser(userId) {
  return db.prepare('SELECT * FROM equipment_owner_profiles WHERE user_id = ?').get(userId);
}

function serializeMusicianProfile(p) {
  if (!p) return null;
  const stats = db.prepare('SELECT COUNT(*) AS cnt, AVG(rating) AS avg FROM reviews WHERE musician_profile_id = ?').get(p.id);
  return {
    id: p.id,
    userId: p.user_id,
    stageName: p.stage_name,
    instruments: parseJsonSafe(p.instruments, []),
    genres: parseJsonSafe(p.genres, []),
    bio: p.bio,
    hourlyRate: p.hourly_rate,
    city: p.city,
    state: p.state,
    country: p.country,
    lat: p.lat,
    lng: p.lng,
    emergencyAvailable: !!p.emergency_available,
    hasInsurance: !!p.has_insurance,
    idVerified: !!p.id_verified,
    backupForProfileId: p.backup_for_profile_id,
    strikes: p.strikes,
    mediaUrls: parseJsonSafe(p.media_urls, []),
    videoUrl: p.video_url,
    photoUrl: p.photo_url || null,
    eventTypes: parseJsonSafe(p.event_types, []),
    reviewCount: stats.cnt || 0,
    avgRating: stats.avg ? Math.round(stats.avg * 10) / 10 : null,
    createdAt: p.created_at,
  };
}

function serializeEquipment(e) {
  if (!e) return null;
  return {
    id: e.id,
    ownerProfileId: e.owner_profile_id,
    category: e.category,
    title: e.title,
    description: e.description,
    dailyRate: e.daily_rate,
    securityDeposit: e.security_deposit,
    photos: parseJsonSafe(e.photos, []),
    available: !!e.available,
    createdAt: e.created_at,
  };
}

function serializeBooking(b) {
  return {
    id: b.id,
    musicianProfileId: b.musician_profile_id,
    clientUserId: b.client_user_id,
    eventDate: b.event_date,
    eventTime: b.event_time,
    durationHours: b.duration_hours,
    location: b.location,
    offeredRate: b.offered_rate,
    status: b.status,
    isEmergency: !!b.is_emergency,
    isGroup: !!b.is_group,
    groupDetails: b.group_details,
    eventType: b.event_type,
    serviceFee: b.service_fee,
    total: b.total,
    counterRate: b.counter_rate,
    counterNote: b.counter_note,
    cancellationReason: b.cancellation_reason,
    noShowReport: b.no_show_report,
    noShowParty: b.no_show_party,
    createdAt: b.created_at,
    updatedAt: b.updated_at,
  };
}

function serializeRental(r) {
  return {
    id: r.id,
    equipmentId: r.equipment_id,
    clientUserId: r.client_user_id,
    startDate: r.start_date,
    endDate: r.end_date,
    status: r.status,
    dailyRate: r.daily_rate,
    days: r.days,
    rentalFee: r.rental_fee,
    serviceFee: r.service_fee,
    deposit: r.deposit,
    total: r.total,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

module.exports = {
  SERVICE_FEE_RATE,
  requireAuth,
  requireRole,
  notify,
  calcServiceFee,
  parseJsonSafe,
  musicianProfileForUser,
  equipmentOwnerProfileForUser,
  serializeMusicianProfile,
  serializeEquipment,
  serializeBooking,
  serializeRental,
};
