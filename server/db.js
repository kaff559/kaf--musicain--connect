// db.js — persistent storage using Node's built-in SQLite module (node:sqlite).
// No npm dependency required. Node >= 22.5 needed (run with --experimental-sqlite
// on Node versions where it isn't unflagged yet).
'use strict';

const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = path.join(DATA_DIR, 'app.db');

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('musician','client','equipment_owner','admin')),
  name TEXT NOT NULL,
  phone TEXT,
  suspended INTEGER NOT NULL DEFAULT 0,
  suspension_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS musician_profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  stage_name TEXT NOT NULL,
  instruments TEXT NOT NULL DEFAULT '[]',
  genres TEXT NOT NULL DEFAULT '[]',
  bio TEXT DEFAULT '',
  hourly_rate REAL NOT NULL DEFAULT 0,
  city TEXT,
  state TEXT,
  -- Free-text so this works for any country's state/province/region naming,
  -- not just US 2-letter codes.
  country TEXT,
  -- Optional self-reported coordinates (set via the browser's geolocation
  -- API on the profile form, same mechanism as the searcher's own "search
  -- near me" button) — used for real distance search worldwide instead of
  -- the old US-only state-centroid approximation. NULL means "distance
  -- unknown," which radius search treats as "don't exclude."
  lat REAL,
  lng REAL,
  emergency_available INTEGER NOT NULL DEFAULT 0,
  has_insurance INTEGER NOT NULL DEFAULT 0,
  id_verified INTEGER NOT NULL DEFAULT 0,
  backup_for_profile_id INTEGER REFERENCES musician_profiles(id),
  strikes INTEGER NOT NULL DEFAULT 0,
  media_urls TEXT NOT NULL DEFAULT '[]',
  video_url TEXT,
  -- Event categories this talent is open to being found for (JSON array of
  -- keys like "church", "wedding_ceremony", "bar_nightlife", ...). An empty
  -- array means "open to all event types" — this lets e.g. a worship
  -- vocalist opt out of ever showing up in bar/nightlife searches.
  event_types TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  musician_profile_id INTEGER NOT NULL REFERENCES musician_profiles(id) ON DELETE CASCADE,
  client_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rating INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5),
  comment TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS bookings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  musician_profile_id INTEGER NOT NULL REFERENCES musician_profiles(id) ON DELETE CASCADE,
  client_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_date TEXT NOT NULL,
  event_time TEXT,
  duration_hours REAL NOT NULL DEFAULT 1,
  location TEXT,
  offered_rate REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  is_emergency INTEGER NOT NULL DEFAULT 0,
  is_group INTEGER NOT NULL DEFAULT 0,
  group_details TEXT,
  service_fee REAL,
  total REAL,
  counter_rate REAL,
  counter_note TEXT,
  cancellation_reason TEXT,
  no_show_report TEXT,
  no_show_party TEXT,
  -- What kind of event this booking is for (church, wedding_ceremony, ...) —
  -- same key set as musician_profiles.event_types. Optional/free-text-ish;
  -- not enforced against a fixed list at the DB level.
  event_type TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS favorites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  musician_profile_id INTEGER NOT NULL REFERENCES musician_profiles(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(client_user_id, musician_profile_id)
);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message TEXT NOT NULL,
  type TEXT DEFAULT 'info',
  is_read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS disputes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  booking_id INTEGER REFERENCES bookings(id) ON DELETE CASCADE,
  rental_id INTEGER REFERENCES rentals(id) ON DELETE CASCADE,
  filed_by_user_id INTEGER NOT NULL REFERENCES users(id),
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  resolution TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS equipment_owner_profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  business_name TEXT NOT NULL,
  bio TEXT DEFAULT '',
  city TEXT,
  state TEXT,
  country TEXT,
  id_verified INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS equipment (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_profile_id INTEGER NOT NULL REFERENCES equipment_owner_profiles(id) ON DELETE CASCADE,
  category TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT DEFAULT '',
  daily_rate REAL NOT NULL,
  security_deposit REAL NOT NULL DEFAULT 0,
  photos TEXT NOT NULL DEFAULT '[]',
  available INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS rentals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  equipment_id INTEGER NOT NULL REFERENCES equipment(id) ON DELETE CASCADE,
  client_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  daily_rate REAL NOT NULL,
  days INTEGER NOT NULL,
  rental_fee REAL NOT NULL,
  service_fee REAL NOT NULL,
  deposit REAL NOT NULL,
  total REAL NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reporter_user_id INTEGER NOT NULL REFERENCES users(id),
  reported_user_id INTEGER REFERENCES users(id),
  reported_musician_profile_id INTEGER REFERENCES musician_profiles(id),
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_bookings_musician ON bookings(musician_profile_id);
CREATE INDEX IF NOT EXISTS idx_bookings_client ON bookings(client_user_id);
CREATE INDEX IF NOT EXISTS idx_rentals_equipment ON rentals(equipment_id);
CREATE INDEX IF NOT EXISTS idx_rentals_client ON rentals(client_user_id);
CREATE INDEX IF NOT EXISTS idx_reviews_musician ON reviews(musician_profile_id);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id);
CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_hash ON password_reset_tokens(token_hash);
CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_user ON password_reset_tokens(user_id);
`);

// --- Lightweight migrations ---------------------------------------------
// CREATE TABLE IF NOT EXISTS above only shapes a brand-new database. A
// database that already existed before a column was added needs that column
// bolted on explicitly — ALTER TABLE ADD COLUMN, guarded by a check so this
// is safe to run on every boot (adding an already-present column errors).
function ensureColumn(table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
}
ensureColumn('musician_profiles', 'event_types', "event_types TEXT NOT NULL DEFAULT '[]'");
ensureColumn('bookings', 'event_type', 'event_type TEXT');
ensureColumn('musician_profiles', 'country', 'country TEXT');
ensureColumn('musician_profiles', 'lat', 'lat REAL');
ensureColumn('musician_profiles', 'lng', 'lng REAL');
ensureColumn('equipment_owner_profiles', 'country', 'country TEXT');
// Profile picture — a URL under /uploads/avatars/, same pattern as the demo
// media files (stored on the persistent disk, only the URL lives in the DB).
ensureColumn('musician_profiles', 'photo_url', 'photo_url TEXT');
ensureColumn('equipment_owner_profiles', 'photo_url', 'photo_url TEXT');

module.exports = db;
