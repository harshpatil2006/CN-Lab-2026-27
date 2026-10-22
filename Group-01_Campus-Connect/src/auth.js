'use strict';
// Accounts, passwords and login sessions.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const { parseCookie } = require('cookie');
const { q, DATA_DIR } = require('./db');

const COOKIE = 'cc_session';
const SESSION_MS = 7 * 24 * 60 * 60 * 1000;
const IS_PROD = process.env.NODE_ENV === 'production';

// The secret comes from the SESSION_SECRET variable. If it is missing, make one and keep it in the data folder.
function loadSecret() {
  if (process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 16) return process.env.SESSION_SECRET;
  const file = path.join(DATA_DIR, '.session_secret');
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch (_) {
    const s = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(file, s, { mode: 0o600 });
    return s;
  }
}
const SECRET = loadSecret();

const hashToken = (token) => crypto.createHmac('sha256', SECRET).update(token).digest('hex');
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10); // makes "unknown user" take as long as "wrong password"

function validateRegistration({ displayName, username, password }) {
  const errors = {};
  const name = typeof displayName === 'string' ? displayName.trim().replace(/\s+/g, ' ') : '';
  const user = typeof username === 'string' ? username.trim().toLowerCase() : '';
  if (name.length < 2 || name.length > 50) errors.displayName = 'Enter your name (2 to 50 characters).';
  else if (/[<>\u0000-\u001f]/.test(name)) errors.displayName = 'Your name contains characters that are not allowed.';
  if (!/^[a-z0-9_.]{3,24}$/.test(user)) errors.username = 'Username: 3 to 24 letters, numbers, dots or underscores.';
  if (typeof password !== 'string' || password.length < 8) errors.password = 'Password must be at least 8 characters.';
  else if (Buffer.byteLength(password) > 72) errors.password = 'Password is too long (72 characters at most).';
  return { errors, name, user };
}

async function createUser(name, username, password) {
  const hash = await bcrypt.hash(password, 10);
  const r = q.run('INSERT INTO users (username, display_name, password_hash, created_at) VALUES (?,?,?,?)', username, name, hash, Date.now());
  return Number(r.lastInsertRowid);
}

async function checkLogin(username, password) {
  const u = q.get('SELECT id, password_hash FROM users WHERE username = ?', String(username || '').trim().toLowerCase());
  const ok = await bcrypt.compare(String(password || ''), u ? u.password_hash : DUMMY_HASH);
  return ok && u ? u.id : null;
}

function startSession(res, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  q.run('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?,?,?,?)', hashToken(token), userId, now, now + SESSION_MS);
  q.run('DELETE FROM sessions WHERE expires_at < ?', now);
  res.cookie(COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: IS_PROD, maxAge: SESSION_MS, path: '/' });
}

function tokenFromCookieHeader(header) {
  if (!header) return null;
  return parseCookie(header)[COOKIE] || null;
}

function userFromToken(token) {
  if (!token) return null;
  const row = q.get(
    `SELECT u.id, u.username, u.display_name AS displayName, s.expires_at AS exp
       FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`, hashToken(token));
  if (!row || row.exp < Date.now()) return null;
  return { id: row.id, username: row.username, displayName: row.displayName };
}

function endSession(token) {
  if (token) q.run('DELETE FROM sessions WHERE token_hash = ?', hashToken(token));
}

// Express middleware: only logged-in users get through.
function requireAuth(req, res, next) {
  const token = tokenFromCookieHeader(req.headers.cookie);
  const user = userFromToken(token);
  if (!user) return res.status(401).json({ error: 'Please sign in.' });
  req.user = user;
  req.sessionToken = token;
  next();
}

module.exports = {
  COOKIE, validateRegistration, createUser, checkLogin, startSession, endSession,
  tokenFromCookieHeader, userFromToken, requireAuth,
};
