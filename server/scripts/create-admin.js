#!/usr/bin/env node
'use strict';

// Usage: node --experimental-sqlite server/scripts/create-admin.js <email> <password> <name>
// Creates (or promotes) an admin account directly in the database. There is
// no public signup path for admins on purpose — this is meant to be run
// once by whoever operates the deployment.

const path = require('path');
const db = require(path.join(__dirname, '..', 'db'));
const auth = require(path.join(__dirname, '..', 'lib', 'auth'));

const [, , email, password, ...nameParts] = process.argv;
const name = nameParts.join(' ') || 'Admin';

if (!email || !password) {
  console.error('Usage: node --experimental-sqlite server/scripts/create-admin.js <email> <password> [name]');
  process.exit(1);
}
if (password.length < 8) {
  console.error('Password must be at least 8 characters.');
  process.exit(1);
}

const existing = db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase());
if (existing) {
  db.prepare('UPDATE users SET role = ? WHERE id = ?').run('admin', existing.id);
  console.log(`Existing user ${email} promoted to admin.`);
} else {
  const { hash, salt } = auth.hashPassword(password);
  db.prepare('INSERT INTO users (email, password_hash, password_salt, role, name) VALUES (?, ?, ?, ?, ?)')
    .run(email.toLowerCase(), hash, salt, 'admin', name);
  console.log(`Admin account created: ${email}`);
}
