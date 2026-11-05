'use strict';
// db.js — хранилище на встроенном node:sqlite, без внешних зависимостей
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(path.join(DATA_DIR, 'uploads'), { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'tavern.db'));
db.exec(`PRAGMA journal_mode = WAL;`);

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  pass_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  is_admin INTEGER NOT NULL DEFAULT 0,
  daily_limit_usd REAL,
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
  avatar TEXT NOT NULL DEFAULT '',
  deleted INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS worlds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  emoji TEXT NOT NULL DEFAULT '🌍',
  cover TEXT NOT NULL DEFAULT '',
  prompt TEXT NOT NULL DEFAULT '',
  accent TEXT NOT NULL DEFAULT '',
  position INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS rooms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  world_id INTEGER NOT NULL DEFAULT 1,
  title TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'forum',
  category TEXT NOT NULL DEFAULT 'Локации',
  description TEXT NOT NULL DEFAULT '',
  cover TEXT NOT NULL DEFAULT '',
  auto_ai_char_id INTEGER,
  position INTEGER NOT NULL DEFAULT 0,
  chronicle TEXT NOT NULL DEFAULT '',
  chronicle_at INTEGER,
  archived INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS room_ai (
  room_id INTEGER NOT NULL,
  ai_char_id INTEGER NOT NULL,
  PRIMARY KEY (room_id, ai_char_id)
);
CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id INTEGER NOT NULL,
  user_id INTEGER,
  persona_id INTEGER,
  ai_char_id INTEGER,
  body TEXT NOT NULL,
  image TEXT NOT NULL DEFAULT '',
  is_ooc INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  edited_at INTEGER,
  deleted INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_posts_room ON posts(room_id, id);
CREATE TABLE IF NOT EXISTS ai_chars (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  world_id INTEGER,                    -- NULL = доступен во всех мирах
  name TEXT NOT NULL,
  emoji TEXT NOT NULL DEFAULT '🤖',
  color TEXT NOT NULL DEFAULT '#7c5cff',
  avatar TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL,
  system_prompt TEXT NOT NULL DEFAULT '',
  temperature REAL NOT NULL DEFAULT 0.9,
  max_tokens INTEGER NOT NULL DEFAULT 1200,
  context_posts INTEGER NOT NULL DEFAULT 40,
  deleted INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS lorebooks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  world_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS lore_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id INTEGER NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  keys TEXT NOT NULL DEFAULT '',       -- ключи через запятую
  content TEXT NOT NULL DEFAULT '',
  always_on INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  position INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_lore_book ON lore_entries(book_id);
CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  persona_id INTEGER NOT NULL,
  kind TEXT NOT NULL DEFAULT 'вещь',    -- 'одежда' | 'транспорт' | 'вещь'
  name TEXT NOT NULL,
  descr TEXT NOT NULL DEFAULT '',
  image TEXT NOT NULL DEFAULT '',
  equipped INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_items_persona ON items(persona_id);
CREATE TABLE IF NOT EXISTS extensions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  css TEXT NOT NULL DEFAULT '',
  js TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1
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
  kind TEXT NOT NULL DEFAULT 'post',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`);

// ---------- миграции со старой схемы (v1) ----------
function addCol(table, colDef) {
  try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${colDef}`); } catch { /* уже есть */ }
}
addCol('rooms', `world_id INTEGER NOT NULL DEFAULT 1`);
addCol('rooms', `cover TEXT NOT NULL DEFAULT ''`);
addCol('rooms', `auto_ai_char_id INTEGER`);
addCol('posts', `image TEXT NOT NULL DEFAULT ''`);
addCol('ai_chars', `world_id INTEGER`);
addCol('ai_chars', `avatar TEXT NOT NULL DEFAULT ''`);
addCol('personas', `avatar TEXT NOT NULL DEFAULT ''`);
addCol('personas', `memory TEXT NOT NULL DEFAULT '[]'`);     // память персонажа (JSON-массив строк)
addCol('personas', `needs TEXT NOT NULL DEFAULT '{}'`);      // потребности {need:{v,at}}
addCol('personas', `realism INTEGER NOT NULL DEFAULT 0`);    // симсовский режим: потребности проседают
addCol('worlds', `map TEXT NOT NULL DEFAULT ''`);            // картинка карты мира
addCol('rooms', `map_x REAL`);                               // метка на карте, % по ширине
addCol('rooms', `map_y REAL`);

// дефолтный мир + перенос старого общего промпта мира
if (db.prepare('SELECT COUNT(*) AS n FROM worlds').get().n === 0) {
  const old = db.prepare(`SELECT value FROM settings WHERE key = 'world_prompt'`).get();
  db.prepare(`INSERT INTO worlds(id, title, emoji, prompt, position) VALUES (1, 'Основной мир', '🕯️', ?, 0)`)
    .run(old ? old.value : '');
}

const now = () => Date.now();

function getSetting(key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}
function setSetting(key, value) {
  db.prepare(`INSERT INTO settings(key, value) VALUES(?, ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, String(value));
}

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
  insertPersona: db.prepare('INSERT INTO personas(user_id, name, emoji, color, bio, avatar) VALUES (?,?,?,?,?,?)'),
  updatePersona: db.prepare('UPDATE personas SET name=?, emoji=?, color=?, bio=?, avatar=? WHERE id=? AND user_id=?'),
  setPersonaMemory: db.prepare('UPDATE personas SET memory=? WHERE id=?'),
  setPersonaNeeds: db.prepare('UPDATE personas SET needs=?, realism=? WHERE id=?'),
  deletePersona: db.prepare('UPDATE personas SET deleted = 1 WHERE id=? AND user_id=?'),
  allPersonas: db.prepare(`SELECT p.*, u.username FROM personas p JOIN users u ON u.id = p.user_id WHERE p.deleted = 0`),

  allWorlds: db.prepare('SELECT * FROM worlds WHERE archived = 0 ORDER BY position, id'),
  worldById: db.prepare('SELECT * FROM worlds WHERE id = ?'),
  insertWorld: db.prepare('INSERT INTO worlds(title, emoji, cover, prompt, accent, position) VALUES (?,?,?,?,?,?)'),
  updateWorld: db.prepare('UPDATE worlds SET title=?, emoji=?, cover=?, prompt=?, accent=?, position=?, archived=?, map=? WHERE id=?'),

  allRooms: db.prepare('SELECT * FROM rooms WHERE archived = 0 ORDER BY category, position, id'),
  roomsByWorld: db.prepare('SELECT * FROM rooms WHERE world_id = ? AND archived = 0 ORDER BY category, position, id'),
  roomById: db.prepare('SELECT * FROM rooms WHERE id = ?'),
  insertRoom: db.prepare('INSERT INTO rooms(world_id, title, kind, category, description, cover, position) VALUES (?,?,?,?,?,?,?)'),
  updateRoom: db.prepare(`UPDATE rooms SET title=?, kind=?, category=?, description=?, cover=?, auto_ai_char_id=?, position=?, archived=?, map_x=?, map_y=? WHERE id=?`),
  setChronicle: db.prepare('UPDATE rooms SET chronicle=?, chronicle_at=? WHERE id=?'),

  roomAi: db.prepare('SELECT ai_char_id FROM room_ai WHERE room_id = ?'),
  clearRoomAi: db.prepare('DELETE FROM room_ai WHERE room_id = ?'),
  addRoomAi: db.prepare('INSERT OR IGNORE INTO room_ai(room_id, ai_char_id) VALUES (?,?)'),

  insertPost: db.prepare(`INSERT INTO posts(room_id, user_id, persona_id, ai_char_id, body, image, is_ooc, created_at)
                          VALUES (?,?,?,?,?,?,?,?)`),
  postById: db.prepare('SELECT * FROM posts WHERE id = ?'),
  editPost: db.prepare('UPDATE posts SET body = ?, edited_at = ? WHERE id = ?'),
  deletePost: db.prepare('UPDATE posts SET deleted = 1 WHERE id = ?'),
  lastPosts: db.prepare(`SELECT * FROM posts WHERE room_id = ? AND deleted = 0 ORDER BY id DESC LIMIT ?`),
  postsBefore: db.prepare(`SELECT * FROM posts WHERE room_id = ? AND deleted = 0 AND id < ? ORDER BY id DESC LIMIT ?`),
  lastPostTimes: db.prepare(`SELECT room_id, MAX(created_at) AS last_at, COUNT(*) AS n
                             FROM posts WHERE deleted = 0 GROUP BY room_id`),
  lastPostPreviews: db.prepare(`SELECT room_id, body, persona_id, ai_char_id FROM posts
                                WHERE deleted = 0 AND id IN (SELECT MAX(id) FROM posts WHERE deleted = 0 GROUP BY room_id)`),

  itemsByPersona: db.prepare('SELECT * FROM items WHERE persona_id = ? ORDER BY kind, id'),
  itemById: db.prepare('SELECT * FROM items WHERE id = ?'),
  insertItem: db.prepare('INSERT INTO items(persona_id, kind, name, descr, image, equipped, created_at) VALUES (?,?,?,?,?,?,?)'),
  updateItem: db.prepare('UPDATE items SET kind=?, name=?, descr=?, image=?, equipped=? WHERE id=?'),
  deleteItem: db.prepare('DELETE FROM items WHERE id=?'),
  equippedByPersona: db.prepare('SELECT * FROM items WHERE persona_id = ? AND equipped = 1 ORDER BY kind, id'),

  aiChars: db.prepare('SELECT * FROM ai_chars WHERE deleted = 0 ORDER BY id'),
  aiCharById: db.prepare('SELECT * FROM ai_chars WHERE id = ?'),
  insertAiChar: db.prepare(`INSERT INTO ai_chars(world_id, name, emoji, color, avatar, model, system_prompt, temperature, max_tokens, context_posts)
                            VALUES (?,?,?,?,?,?,?,?,?,?)`),
  updateAiChar: db.prepare(`UPDATE ai_chars SET world_id=?, name=?, emoji=?, color=?, avatar=?, model=?, system_prompt=?, temperature=?, max_tokens=?, context_posts=?, deleted=? WHERE id=?`),

  booksByWorld: db.prepare('SELECT * FROM lorebooks WHERE world_id = ? ORDER BY id'),
  bookById: db.prepare('SELECT * FROM lorebooks WHERE id = ?'),
  insertBook: db.prepare('INSERT INTO lorebooks(world_id, name, enabled) VALUES (?,?,1)'),
  updateBook: db.prepare('UPDATE lorebooks SET name=?, enabled=? WHERE id=?'),
  deleteBook: db.prepare('DELETE FROM lorebooks WHERE id=?'),
  entriesByBook: db.prepare('SELECT * FROM lore_entries WHERE book_id = ? ORDER BY position, id'),
  activeEntriesByWorld: db.prepare(`SELECT e.* FROM lore_entries e JOIN lorebooks b ON b.id = e.book_id
                                    WHERE b.world_id = ? AND b.enabled = 1 AND e.enabled = 1 ORDER BY e.position, e.id`),
  entryById: db.prepare('SELECT * FROM lore_entries WHERE id = ?'),
  insertEntry: db.prepare('INSERT INTO lore_entries(book_id, title, keys, content, always_on, enabled, position) VALUES (?,?,?,?,?,?,?)'),
  updateEntry: db.prepare('UPDATE lore_entries SET title=?, keys=?, content=?, always_on=?, enabled=?, position=? WHERE id=?'),
  deleteEntry: db.prepare('DELETE FROM lore_entries WHERE id=?'),
  deleteBookEntries: db.prepare('DELETE FROM lore_entries WHERE book_id=?'),

  allExtensions: db.prepare('SELECT * FROM extensions ORDER BY id'),
  enabledExtensions: db.prepare('SELECT * FROM extensions WHERE enabled = 1 ORDER BY id'),
  extensionById: db.prepare('SELECT * FROM extensions WHERE id = ?'),
  insertExtension: db.prepare('INSERT INTO extensions(name, css, js, enabled) VALUES (?,?,?,1)'),
  updateExtension: db.prepare('UPDATE extensions SET name=?, css=?, js=?, enabled=? WHERE id=?'),
  deleteExtension: db.prepare('DELETE FROM extensions WHERE id=?'),

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
