'use strict';
// db.js — хранилище на встроенном node:sqlite, без внешних зависимостей
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'tavern.db'));
db.exec(`PRAGMA journal_mode = WAL;`);

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  pass_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  is_admin INTEGER NOT NULL DEFAULT 0,
  daily_limit_usd REAL,              -- NULL = брать дефолт из settings
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS invites (
  code TEXT PRIMARY KEY,
  created_by INTEGER NOT NULL,
  used_by INTEGER,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS personas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  emoji TEXT NOT NULL DEFAULT '🎭',
  color TEXT NOT NULL DEFAULT '#c9a227',
  bio TEXT NOT NULL DEFAULT '',
  deleted INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS rooms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'forum',           -- 'forum' | 'chat'
  category TEXT NOT NULL DEFAULT 'Локации',
  description TEXT NOT NULL DEFAULT '',
  position INTEGER NOT NULL DEFAULT 0,
  chronicle TEXT NOT NULL DEFAULT '',
  chronicle_at INTEGER,
  archived INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id INTEGER NOT NULL,
  user_id INTEGER,                 -- NULL если пост от ИИ
  persona_id INTEGER,              -- маска игрока
  ai_char_id INTEGER,              -- ИИ-персонаж
  body TEXT NOT NULL,
  is_ooc INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  edited_at INTEGER,
  deleted INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_posts_room ON posts(room_id, id);
CREATE TABLE IF NOT EXISTS ai_chars (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  emoji TEXT NOT NULL DEFAULT '🤖',
  color TEXT NOT NULL DEFAULT '#7c5cff',
  model TEXT NOT NULL,
  system_prompt TEXT NOT NULL DEFAULT '',
  temperature REAL NOT NULL DEFAULT 0.9,
  max_tokens INTEGER NOT NULL DEFAULT 1200,
  context_posts INTEGER NOT NULL DEFAULT 40,
  deleted INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS usage_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  ai_char_id INTEGER,
  room_id INTEGER,
  model TEXT,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  kind TEXT NOT NULL DEFAULT 'post',   -- 'post' | 'chronicle'
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`);

const now = () => Date.now();

// ---------- settings ----------
function getSetting(key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}
function setSetting(key, value) {
  db.prepare(`INSERT INTO settings(key, value) VALUES(?, ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, String(value));
}

// ---------- users / auth ----------
const q = {
  userByName: db.prepare('SELECT * FROM users WHERE username = ?'),
  userById: db.prepare('SELECT * FROM users WHERE id = ?'),
  userCount: db.prepare('SELECT COUNT(*) AS n FROM users'),
  insertUser: db.prepare('INSERT INTO users(username, pass_hash, salt, is_admin, created_at) VALUES (?,?,?,?,?)'),
  allUsers: db.prepare('SELECT id, username, is_admin, daily_limit_usd, created_at FROM users ORDER BY id'),
  setUserLimit: db.prepare('UPDATE users SET daily_limit_usd = ? WHERE id = ?'),

  insertSession: db.prepare('INSERT INTO sessions(token, user_id, created_at) VALUES (?,?,?)'),
  sessionByToken: db.prepare('SELECT * FROM sessions WHERE token = ?'),
  deleteSession: db.prepare('DELETE FROM sessions WHERE token = ?'),

  inviteByCode: db.prepare('SELECT * FROM invites WHERE code = ?'),
  insertInvite: db.prepare('INSERT INTO invites(code, created_by, created_at) VALUES (?,?,?)'),
  useInvite: db.prepare('UPDATE invites SET used_by = ? WHERE code = ?'),
  allInvites: db.prepare(`SELECT i.code, i.created_at, u.username AS used_by_name
                          FROM invites i LEFT JOIN users u ON u.id = i.used_by ORDER BY i.created_at DESC`),

  personasByUser: db.prepare('SELECT * FROM personas WHERE user_id = ? AND deleted = 0 ORDER BY id'),
  personaById: db.prepare('SELECT * FROM personas WHERE id = ?'),
  insertPersona: db.prepare('INSERT INTO personas(user_id, name, emoji, color, bio) VALUES (?,?,?,?,?)'),
  updatePersona: db.prepare('UPDATE personas SET name=?, emoji=?, color=?, bio=? WHERE id=? AND user_id=?'),
  deletePersona: db.prepare('UPDATE personas SET deleted = 1 WHERE id=? AND user_id=?'),
  allPersonas: db.prepare(`SELECT p.*, u.username FROM personas p JOIN users u ON u.id = p.user_id WHERE p.deleted = 0`),

  allRooms: db.prepare('SELECT * FROM rooms WHERE archived = 0 ORDER BY category, position, id'),
  roomById: db.prepare('SELECT * FROM rooms WHERE id = ?'),
  insertRoom: db.prepare('INSERT INTO rooms(title, kind, category, description, position) VALUES (?,?,?,?,?)'),
  updateRoom: db.prepare('UPDATE rooms SET title=?, kind=?, category=?, description=?, position=?, archived=? WHERE id=?'),
  setChronicle: db.prepare('UPDATE rooms SET chronicle=?, chronicle_at=? WHERE id=?'),

  insertPost: db.prepare(`INSERT INTO posts(room_id, user_id, persona_id, ai_char_id, body, is_ooc, created_at)
                          VALUES (?,?,?,?,?,?,?)`),
  postById: db.prepare('SELECT * FROM posts WHERE id = ?'),
  editPost: db.prepare('UPDATE posts SET body = ?, edited_at = ? WHERE id = ?'),
  deletePost: db.prepare('UPDATE posts SET deleted = 1 WHERE id = ?'),
  lastPosts: db.prepare(`SELECT * FROM posts WHERE room_id = ? AND deleted = 0 ORDER BY id DESC LIMIT ?`),
  postsBefore: db.prepare(`SELECT * FROM posts WHERE room_id = ? AND deleted = 0 AND id < ? ORDER BY id DESC LIMIT ?`),
  lastPostTimes: db.prepare(`SELECT room_id, MAX(created_at) AS last_at, COUNT(*) AS n
                             FROM posts WHERE deleted = 0 GROUP BY room_id`),

  aiChars: db.prepare('SELECT * FROM ai_chars WHERE deleted = 0 ORDER BY id'),
  aiCharById: db.prepare('SELECT * FROM ai_chars WHERE id = ?'),
  insertAiChar: db.prepare(`INSERT INTO ai_chars(name, emoji, color, model, system_prompt, temperature, max_tokens, context_posts)
                            VALUES (?,?,?,?,?,?,?,?)`),
  updateAiChar: db.prepare(`UPDATE ai_chars SET name=?, emoji=?, color=?, model=?, system_prompt=?, temperature=?, max_tokens=?, context_posts=?, deleted=? WHERE id=?`),

  insertUsage: db.prepare(`INSERT INTO usage_log(user_id, ai_char_id, room_id, model, prompt_tokens, completion_tokens, cost_usd, kind, created_at)
                           VALUES (?,?,?,?,?,?,?,?,?)`),
  spentSince: db.prepare('SELECT COALESCE(SUM(cost_usd),0) AS s FROM usage_log WHERE user_id = ? AND created_at >= ?'),
  usageByUserSince: db.prepare(`SELECT u.id, u.username, COALESCE(SUM(l.cost_usd),0) AS cost,
                                  COALESCE(SUM(l.prompt_tokens),0) AS pt, COALESCE(SUM(l.completion_tokens),0) AS ct,
                                  COUNT(l.id) AS calls
                                FROM users u LEFT JOIN usage_log l ON l.user_id = u.id AND l.created_at >= ?
                                GROUP BY u.id ORDER BY cost DESC`),
};

module.exports = { db, q, now, getSetting, setSetting, DATA_DIR };
