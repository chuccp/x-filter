const path = require('path');
const fs = require('fs');
const { app } = require('electron');
const crypto = require('crypto');

let db = null;
let dbPath = null;

async function initDatabase() {
  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs();
  const dataDir = path.join(__dirname, '..', '..', 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  dbPath = path.join(dataDir, 'x-filter.db');

  // Load existing DB or create new
  if (fs.existsSync(dbPath)) {
    const buffer = fs.readFileSync(dbPath);
    db = new SQL.Database(buffer);
  } else {
    db = new SQL.Database();
  }

  db.run('PRAGMA journal_mode = WAL');
  db.run('PRAGMA foreign_keys = ON');

  db.run(`
    CREATE TABLE IF NOT EXISTS comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      text TEXT NOT NULL,
      username TEXT NOT NULL,
      source_url TEXT NOT NULL,
      text_hash TEXT UNIQUE NOT NULL,
      post_text TEXT,
      label INTEGER,
      labeled_at TEXT,
      model_prediction REAL,
      collected_at TEXT DEFAULT (datetime('now'))
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS blocked_users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      blocked_at TEXT DEFAULT (datetime('now')),
      source_comment_id INTEGER REFERENCES comments(id)
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS scrape_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_url TEXT NOT NULL,
      started_at TEXT DEFAULT (datetime('now')),
      completed_at TEXT,
      comments_found INTEGER DEFAULT 0,
      status TEXT DEFAULT 'in_progress'
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS block_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_url TEXT NOT NULL,
      started_at TEXT DEFAULT (datetime('now')),
      completed_at TEXT,
      comments_scanned INTEGER DEFAULT 0,
      spam_detected INTEGER DEFAULT 0,
      users_blocked INTEGER DEFAULT 0,
      errors INTEGER DEFAULT 0,
      status TEXT DEFAULT 'in_progress'
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT
    )
  `);

  // Default settings
  const defaults = {
    spam_threshold: '0.8',
    max_scroll: '50',
    scroll_delay: '500',
  };
  for (const [k, v] of Object.entries(defaults)) {
    db.run('INSERT OR IGNORE INTO app_settings (key, value) VALUES (?, ?)', [k, v]);
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS blocklist (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      added_at TEXT DEFAULT (datetime('now'))
    )
  `);

  // Migration: add post_text column to existing databases
  try { db.run('ALTER TABLE comments ADD COLUMN post_text TEXT'); } catch (e) { /* already exists */ }
  // Migration: add is_blocked column to blocklist
  try { db.run('ALTER TABLE blocklist ADD COLUMN is_blocked INTEGER DEFAULT 0'); } catch (e) { /* already exists */ }

  save();
  return db;
}

function save() {
  if (!db || !dbPath) return;
  const data = db.export();
  const buffer = Buffer.from(data);
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(dbPath, buffer);
}

function getDb() {
  return db;
}

function closeDatabase() {
  if (db) {
    save();
    db.close();
  }
}

// ── Comments ────────────────────────────────────────────────

function insertComments(comments) {
  let count = 0;
  for (const c of comments) {
    try {
      const hash = crypto.createHash('sha256').update(c.text).digest('hex');
      db.run(
        'INSERT OR IGNORE INTO comments (text, username, source_url, text_hash, post_text) VALUES (?, ?, ?, ?, ?)',
        [c.text, c.username, c.source_url, hash, c.post_text || null]
      );
      if (db.getRowsModified() > 0) count++;
    } catch (e) {
      // Duplicate, skip
    }
  }
  save();
  return count;
}

function getUnlabeledComments(limit = 20, offset = 0) {
  const stmt = db.prepare('SELECT * FROM comments WHERE label IS NULL ORDER BY id LIMIT ? OFFSET ?');
  stmt.bind([limit, offset]);
  const results = [];
  while (stmt.step()) results.push(stmt.getAsObject());
  stmt.free();
  return results;
}

function getLabeledComments() {
  const stmt = db.prepare('SELECT * FROM comments WHERE label IS NOT NULL ORDER BY labeled_at DESC');
  const results = [];
  while (stmt.step()) results.push(stmt.getAsObject());
  stmt.free();
  return results;
}

function getAllComments(filter = 'all', limit = 50, offset = 0) {
  let sql, params;
  if (filter === 'spam') {
    sql = 'SELECT * FROM comments WHERE label = 1 ORDER BY id DESC LIMIT ? OFFSET ?';
    params = [limit, offset];
  } else if (filter === 'not-spam') {
    sql = 'SELECT * FROM comments WHERE label = 0 ORDER BY id DESC LIMIT ? OFFSET ?';
    params = [limit, offset];
  } else if (filter === 'unlabeled') {
    sql = 'SELECT * FROM comments WHERE label IS NULL ORDER BY id LIMIT ? OFFSET ?';
    params = [limit, offset];
  } else {
    sql = 'SELECT * FROM comments ORDER BY id DESC LIMIT ? OFFSET ?';
    params = [limit, offset];
  }
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const results = [];
  while (stmt.step()) results.push(stmt.getAsObject());
  stmt.free();
  return results;
}

function setLabel(id, label) {
  db.run('UPDATE comments SET label = ?, labeled_at = datetime(\'now\') WHERE id = ?', [label, id]);
  save();
}

function batchSetLabel(ids, label) {
  for (const id of ids) {
    db.run('UPDATE comments SET label = ?, labeled_at = datetime(\'now\') WHERE id = ?', [label, id]);
  }
  save();
}

function getLabelStats() {
  const stmt = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN label = 1 THEN 1 ELSE 0 END) as spam,
      SUM(CASE WHEN label = 0 THEN 1 ELSE 0 END) as not_spam,
      SUM(CASE WHEN label IS NULL THEN 1 ELSE 0 END) as unlabeled
    FROM comments
  `);
  stmt.step();
  const result = stmt.getAsObject();
  stmt.free();
  return result;
}

function exportLabeledComments() {
  const stmt = db.prepare('SELECT text, username, label, post_text FROM comments WHERE label IS NOT NULL');
  const results = [];
  while (stmt.step()) results.push(stmt.getAsObject());
  stmt.free();
  return results;
}

// ── Scrape Sessions ────────────────────────────────────────

function createScrapeSession(sourceUrl) {
  db.run('INSERT INTO scrape_sessions (source_url) VALUES (?)', [sourceUrl]);
  return lastInsertId();
}

function completeScrapeSession(id, commentsFound) {
  db.run(
    'UPDATE scrape_sessions SET completed_at = datetime(\'now\'), comments_found = ?, status = \'completed\' WHERE id = ?',
    [commentsFound, id]
  );
  save();
}

function failScrapeSession(id) {
  db.run('UPDATE scrape_sessions SET completed_at = datetime(\'now\'), status = \'error\' WHERE id = ?', [id]);
  save();
}

// ── Block Sessions ─────────────────────────────────────────

function createBlockSession(sourceUrl) {
  db.run('INSERT INTO block_sessions (source_url) VALUES (?)', [sourceUrl]);
  return lastInsertId();
}

function completeBlockSession(id, summary) {
  db.run(`
    UPDATE block_sessions SET completed_at = datetime('now'),
    comments_scanned = ?, spam_detected = ?, users_blocked = ?, errors = ?, status = 'completed'
    WHERE id = ?
  `, [summary.comments_scanned, summary.spam_detected, summary.users_blocked, summary.errors, id]);
  save();
}

// ── Blocked Users ──────────────────────────────────────────

function isUserBlocked(username) {
  const stmt = db.prepare('SELECT id FROM blocked_users WHERE username = ?');
  stmt.bind([username]);
  const exists = stmt.step();
  stmt.free();
  return exists;
}

function addBlockedUser(username, commentId) {
  db.run('INSERT OR IGNORE INTO blocked_users (username, source_comment_id) VALUES (?, ?)', [username, commentId]);
  save();
}

// ── Settings ───────────────────────────────────────────────

function getSetting(key) {
  const stmt = db.prepare('SELECT value FROM app_settings WHERE key = ?');
  stmt.bind([key]);
  let result = null;
  if (stmt.step()) result = stmt.getAsObject().value;
  stmt.free();
  return result;
}

function setSetting(key, value) {
  db.run('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)', [key, value]);
  save();
}

function getAllSettings() {
  const stmt = db.prepare('SELECT * FROM app_settings');
  const settings = {};
  while (stmt.step()) {
    const row = stmt.getAsObject();
    settings[row.key] = row.value;
  }
  stmt.free();
  return settings;
}

// ── Blocklist ──────────────────────────────────────────────

function getBlocklist() {
  const stmt = db.prepare('SELECT * FROM blocklist ORDER BY added_at DESC');
  const results = [];
  while (stmt.step()) results.push(stmt.getAsObject());
  stmt.free();
  return results;
}

function addToBlocklist(username) {
  const u = username.replace(/^@/, '').trim();
  if (!u) return false;
  db.run('INSERT OR IGNORE INTO blocklist (username) VALUES (?)', [u]);
  const added = db.getRowsModified() > 0;
  save();
  return added;
}

function removeFromBlocklist(username) {
  db.run('DELETE FROM blocklist WHERE username = ?', [username]);
  const removed = db.getRowsModified() > 0;
  save();
  return removed;
}

function clearBlocklist() {
  db.run('DELETE FROM blocklist');
  save();
}

function importBlocklist(usernames) {
  let count = 0;
  for (const raw of usernames) {
    const u = raw.replace(/^@/, '').trim();
    if (!u) continue;
    db.run('INSERT OR IGNORE INTO blocklist (username) VALUES (?)', [u]);
    if (db.getRowsModified() > 0) count++;
  }
  save();
  return count;
}

function isInBlocklist(username) {
  const stmt = db.prepare('SELECT id FROM blocklist WHERE username = ?');
  stmt.bind([username]);
  const exists = stmt.step();
  stmt.free();
  return exists;
}

function markBlockedInBlocklist(username) {
  const u = username.replace(/^@/, '').trim();
  if (!u) return;
  // Insert if not exists, then mark as blocked
  db.run('INSERT OR IGNORE INTO blocklist (username, is_blocked) VALUES (?, 1)', [u]);
  db.run('UPDATE blocklist SET is_blocked = 1 WHERE username = ?', [u]);
  save();
}

function markMultipleBlockedInBlocklist(usernames) {
  for (const raw of usernames) {
    const u = raw.replace(/^@/, '').trim();
    if (!u) continue;
    db.run('INSERT OR IGNORE INTO blocklist (username, is_blocked) VALUES (?, 1)', [u]);
    db.run('UPDATE blocklist SET is_blocked = 1 WHERE username = ?', [u]);
  }
  save();
}

// ── Helpers ────────────────────────────────────────────────

function lastInsertId() {
  const stmt = db.prepare('SELECT last_insert_rowid() as id');
  stmt.step();
  const result = stmt.getAsObject().id;
  stmt.free();
  return result;
}

module.exports = {
  initDatabase,
  closeDatabase,
  getDb,
  save,
  insertComments,
  getUnlabeledComments,
  getLabeledComments,
  getAllComments,
  setLabel,
  batchSetLabel,
  getLabelStats,
  exportLabeledComments,
  createScrapeSession,
  completeScrapeSession,
  failScrapeSession,
  createBlockSession,
  completeBlockSession,
  isUserBlocked,
  addBlockedUser,
  getBlocklist,
  addToBlocklist,
  removeFromBlocklist,
  clearBlocklist,
  importBlocklist,
  isInBlocklist,
  markBlockedInBlocklist,
  markMultipleBlockedInBlocklist,
  getSetting,
  setSetting,
  getAllSettings,
};
