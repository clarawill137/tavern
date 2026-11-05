'use strict';
// server.js — Таверна-форум: приватная ролевая для своих + ИИ-участники
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { q, now, getSetting, setSetting } = require('./db');
const { aiPost, chronicle, spentToday, dailyLimitFor } = require('./ai');

const PORT = parseInt(process.env.PORT || '8080', 10);
const PUBLIC_DIR = path.join(__dirname, 'public');

// ---------- helpers ----------
const json = (res, code, obj) => {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
};
const err = (res, code, message) => json(res, code, { error: message });

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 2e6) { reject(new Error('too big')); req.destroy(); } });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { reject(new Error('bad json')); } });
    req.on('error', reject);
  });
}

function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach(p => {
    const i = p.indexOf('='); if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}

function hashPass(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

function auth(req) {
  const token = parseCookies(req).tavern_session;
  if (!token) return null;
  const s = q.sessionByToken.get(token);
  if (!s) return null;
  return q.userById.get(s.user_id) || null;
}

function publicUser(u) {
  return { id: u.id, username: u.username, is_admin: !!u.is_admin };
}

function publicPost(p) {
  return {
    id: p.id, room_id: p.room_id, user_id: p.user_id, persona_id: p.persona_id,
    ai_char_id: p.ai_char_id, body: p.body, is_ooc: !!p.is_ooc,
    created_at: p.created_at, edited_at: p.edited_at,
  };
}

// ---------- SSE ----------
const sseClients = new Set();
function broadcast(event) {
  const line = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of sseClients) { try { res.write(line); } catch { sseClients.delete(res); } }
}

// ---------- защита от гонок записи в один момент ----------
const genLocks = new Set(); // room ids, где сейчас генерит ИИ

// ---------- роуты ----------
const routes = [];
function route(method, pattern, handler, { admin = false, open = false } = {}) {
  const keys = [];
  const rx = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '(\\d+)'; }) + '$');
  routes.push({ method, rx, keys, handler, admin, open });
}

async function handleApi(req, res, pathname) {
  for (const r of routes) {
    if (r.method !== req.method) continue;
    const m = pathname.match(r.rx);
    if (!m) continue;
    const params = {};
    r.keys.forEach((k, i) => params[k] = parseInt(m[i + 1], 10));
    let user = null;
    if (!r.open) {
      user = auth(req);
      if (!user) return err(res, 401, 'Не авторизован');
      if (r.admin && !user.is_admin) return err(res, 403, 'Только для админа');
    }
    try {
      await r.handler(req, res, { params, user });
    } catch (e) {
      err(res, e.status || 500, e.message || 'Ошибка сервера');
    }
    return;
  }
  err(res, 404, 'Нет такого эндпоинта');
}

// ----- auth -----
route('POST', '/api/register', async (req, res) => {
  const { invite, username, password } = await readBody(req);
  const name = String(username || '').trim();
  if (!/^[\wа-яА-ЯёЁ.-]{2,30}$/u.test(name)) return err(res, 400, 'Ник: 2–30 букв/цифр без пробелов');
  if (!password || String(password).length < 6) return err(res, 400, 'Пароль минимум 6 символов');
  const isFirst = q.userCount.get().n === 0;
  if (!isFirst) {
    const inv = q.inviteByCode.get(String(invite || '').trim());
    if (!inv || inv.used_by) return err(res, 400, 'Инвайт не существует или уже использован');
  }
  if (q.userByName.get(name)) return err(res, 400, 'Ник занят');
  const salt = crypto.randomBytes(16).toString('hex');
  const r = q.insertUser.run(name, hashPass(String(password), salt), salt, isFirst ? 1 : 0, now());
  const userId = Number(r.lastInsertRowid);
  if (!isFirst) q.useInvite.run(userId, String(invite).trim());
  const token = crypto.randomBytes(32).toString('hex');
  q.insertSession.run(token, userId, now());
  res.setHeader('Set-Cookie', `tavern_session=${token}; HttpOnly; Path=/; Max-Age=31536000; SameSite=Lax`);
  json(res, 200, { ok: true, user: publicUser(q.userById.get(userId)), first_admin: isFirst });
}, { open: true });

route('POST', '/api/login', async (req, res) => {
  const { username, password } = await readBody(req);
  const u = q.userByName.get(String(username || '').trim());
  if (!u || hashPass(String(password || ''), u.salt) !== u.pass_hash) return err(res, 400, 'Неверный ник или пароль');
  const token = crypto.randomBytes(32).toString('hex');
  q.insertSession.run(token, u.id, now());
  res.setHeader('Set-Cookie', `tavern_session=${token}; HttpOnly; Path=/; Max-Age=31536000; SameSite=Lax`);
  json(res, 200, { ok: true, user: publicUser(u) });
}, { open: true });

route('POST', '/api/logout', async (req, res) => {
  const token = parseCookies(req).tavern_session;
  if (token) q.deleteSession.run(token);
  res.setHeader('Set-Cookie', 'tavern_session=; HttpOnly; Path=/; Max-Age=0');
  json(res, 200, { ok: true });
}, { open: true });

// ----- bootstrap -----
route('GET', '/api/state', async (req, res, { user }) => {
  const lastTimes = {};
  for (const r of q.lastPostTimes.all()) lastTimes[r.room_id] = { last_at: r.last_at, n: r.n };
  json(res, 200, {
    me: publicUser(user),
    app_title: getSetting('app_title', 'Таверна'),
    rooms: q.allRooms.all().map(r => ({
      id: r.id, title: r.title, kind: r.kind, category: r.category,
      description: r.description, chronicle: r.chronicle, chronicle_at: r.chronicle_at,
      last_at: lastTimes[r.id]?.last_at || null, post_count: lastTimes[r.id]?.n || 0,
    })),
    my_personas: q.personasByUser.all(user.id),
    all_personas: q.allPersonas.all().map(p => ({ id: p.id, name: p.name, emoji: p.emoji, color: p.color, username: p.username, user_id: p.user_id })),
    ai_chars: q.aiChars.all().map(c => ({ id: c.id, name: c.name, emoji: c.emoji, color: c.color, model: c.model })),
    users: q.allUsers.all().map(u => ({ id: u.id, username: u.username, is_admin: !!u.is_admin })),
    spent_today: spentToday(user.id),
    daily_limit: user.is_admin ? null : dailyLimitFor(user),
  });
});

// ----- SSE -----
route('GET', '/api/events', async (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(':ok\n\n');
  sseClients.add(res);
  const ping = setInterval(() => { try { res.write(':ping\n\n'); } catch {} }, 25000);
  req.on('close', () => { clearInterval(ping); sseClients.delete(res); });
});

// ----- personas -----
route('POST', '/api/personas', async (req, res, { user }) => {
  const { name, emoji, color, bio } = await readBody(req);
  if (!name || !String(name).trim()) return err(res, 400, 'Имя персонажа обязательно');
  const r = q.insertPersona.run(user.id, String(name).trim(), emoji || '🎭', color || '#c9a227', bio || '');
  broadcast({ type: 'personas' });
  json(res, 200, { ok: true, id: Number(r.lastInsertRowid) });
});
route('PATCH', '/api/personas/:id', async (req, res, { params, user }) => {
  const b = await readBody(req);
  const p = q.personaById.get(params.id);
  if (!p || p.user_id !== user.id) return err(res, 404, 'Не твой персонаж');
  q.updatePersona.run(b.name ?? p.name, b.emoji ?? p.emoji, b.color ?? p.color, b.bio ?? p.bio, p.id, user.id);
  broadcast({ type: 'personas' });
  json(res, 200, { ok: true });
});
route('DELETE', '/api/personas/:id', async (req, res, { params, user }) => {
  q.deletePersona.run(params.id, user.id);
  broadcast({ type: 'personas' });
  json(res, 200, { ok: true });
});

// ----- rooms -----
route('POST', '/api/rooms', async (req, res) => {
  const { title, kind, category, description } = await readBody(req);
  if (!title) return err(res, 400, 'Название обязательно');
  const r = q.insertRoom.run(String(title), kind === 'chat' ? 'chat' : 'forum', category || 'Локации', description || '', 0);
  broadcast({ type: 'rooms' });
  json(res, 200, { ok: true, id: Number(r.lastInsertRowid) });
}, { admin: true });

route('PATCH', '/api/rooms/:id', async (req, res, { params }) => {
  const room = q.roomById.get(params.id);
  if (!room) return err(res, 404, 'Нет комнаты');
  const b = await readBody(req);
  q.updateRoom.run(b.title ?? room.title, b.kind ?? room.kind, b.category ?? room.category,
    b.description ?? room.description, b.position ?? room.position,
    b.archived != null ? (b.archived ? 1 : 0) : room.archived, room.id);
  broadcast({ type: 'rooms' });
  json(res, 200, { ok: true });
}, { admin: true });

// ----- posts -----
route('GET', '/api/rooms/:id/posts', async (req, res, { params }) => {
  const url = new URL(req.url, 'http://x');
  const before = parseInt(url.searchParams.get('before') || '0', 10);
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 200);
  const rows = before ? q.postsBefore.all(params.id, before, limit) : q.lastPosts.all(params.id, limit);
  json(res, 200, { posts: rows.reverse().map(publicPost) });
});

route('POST', '/api/rooms/:id/posts', async (req, res, { params, user }) => {
  const room = q.roomById.get(params.id);
  if (!room) return err(res, 404, 'Нет комнаты');
  const { persona_id, body, is_ooc } = await readBody(req);
  if (!body || !String(body).trim()) return err(res, 400, 'Пустой пост');
  let pid = null;
  if (persona_id) {
    const p = q.personaById.get(persona_id);
    if (!p || p.user_id !== user.id) return err(res, 400, 'Не твой персонаж');
    pid = p.id;
  }
  const r = q.insertPost.run(room.id, user.id, pid, null, String(body), is_ooc ? 1 : 0, now());
  const post = publicPost(q.postById.get(Number(r.lastInsertRowid)));
  broadcast({ type: 'post', post });
  json(res, 200, { ok: true, post });
});

route('PATCH', '/api/posts/:id', async (req, res, { params, user }) => {
  const p = q.postById.get(params.id);
  if (!p || p.deleted) return err(res, 404, 'Нет поста');
  if (p.user_id !== user.id && !user.is_admin) return err(res, 403, 'Не твой пост');
  const { body } = await readBody(req);
  if (!body || !String(body).trim()) return err(res, 400, 'Пустой пост');
  q.editPost.run(String(body), now(), p.id);
  const post = publicPost(q.postById.get(p.id));
  broadcast({ type: 'post_edit', post });
  json(res, 200, { ok: true, post });
});

route('DELETE', '/api/posts/:id', async (req, res, { params, user }) => {
  const p = q.postById.get(params.id);
  if (!p) return err(res, 404, 'Нет поста');
  if (p.user_id !== user.id && !user.is_admin) return err(res, 403, 'Не твой пост');
  q.deletePost.run(p.id);
  broadcast({ type: 'post_delete', post_id: p.id, room_id: p.room_id });
  json(res, 200, { ok: true });
});

// ----- ИИ пишет пост -----
route('POST', '/api/rooms/:id/ai', async (req, res, { params, user }) => {
  const room = q.roomById.get(params.id);
  if (!room) return err(res, 404, 'Нет комнаты');
  const { ai_char_id, instruction } = await readBody(req);
  const aiChar = q.aiCharById.get(ai_char_id || 0);
  if (!aiChar || aiChar.deleted) return err(res, 400, 'Выбери ИИ-персонажа');
  if (genLocks.has(room.id)) return err(res, 409, 'В этой комнате уже генерится пост — подожди');
  genLocks.add(room.id);
  broadcast({ type: 'ai_typing', room_id: room.id, ai_char_id: aiChar.id, on: true });
  try {
    const text = await aiPost({ user, room, aiChar, instruction: instruction || '' });
    const r = q.insertPost.run(room.id, null, null, aiChar.id, text, 0, now());
    const post = publicPost(q.postById.get(Number(r.lastInsertRowid)));
    broadcast({ type: 'post', post });
    json(res, 200, { ok: true, post, spent_today: spentToday(user.id) });
  } finally {
    genLocks.delete(room.id);
    broadcast({ type: 'ai_typing', room_id: room.id, ai_char_id: aiChar.id, on: false });
  }
});

// ----- летописец -----
route('POST', '/api/rooms/:id/chronicle', async (req, res, { params, user }) => {
  const room = q.roomById.get(params.id);
  if (!room) return err(res, 404, 'Нет комнаты');
  const text = await chronicle({ user, room });
  q.setChronicle.run(text, now(), room.id);
  broadcast({ type: 'chronicle', room_id: room.id });
  json(res, 200, { ok: true, chronicle: text });
});

// ----- ИИ-персонажи (админ) -----
route('POST', '/api/ai-chars', async (req, res) => {
  const b = await readBody(req);
  if (!b.name || !b.model) return err(res, 400, 'Нужны имя и модель');
  const r = q.insertAiChar.run(b.name, b.emoji || '🤖', b.color || '#7c5cff', b.model,
    b.system_prompt || '', b.temperature ?? 0.9, b.max_tokens ?? 1200, b.context_posts ?? 40);
  broadcast({ type: 'ai_chars' });
  json(res, 200, { ok: true, id: Number(r.lastInsertRowid) });
}, { admin: true });

route('PATCH', '/api/ai-chars/:id', async (req, res, { params }) => {
  const c = q.aiCharById.get(params.id);
  if (!c) return err(res, 404, 'Нет такого');
  const b = await readBody(req);
  q.updateAiChar.run(b.name ?? c.name, b.emoji ?? c.emoji, b.color ?? c.color, b.model ?? c.model,
    b.system_prompt ?? c.system_prompt, b.temperature ?? c.temperature, b.max_tokens ?? c.max_tokens,
    b.context_posts ?? c.context_posts, b.deleted != null ? (b.deleted ? 1 : 0) : c.deleted, c.id);
  broadcast({ type: 'ai_chars' });
  json(res, 200, { ok: true });
}, { admin: true });

route('GET', '/api/ai-chars', async (req, res) => {
  json(res, 200, { ai_chars: q.aiChars.all() });
});

// ----- инвайты (админ) -----
route('POST', '/api/invites', async (req, res, { user }) => {
  const code = crypto.randomBytes(4).toString('hex');
  q.insertInvite.run(code, user.id, now());
  json(res, 200, { ok: true, code });
}, { admin: true });
route('GET', '/api/invites', async (req, res) => {
  json(res, 200, { invites: q.allInvites.all() });
}, { admin: true });

// ----- траты -----
route('GET', '/api/usage', async (req, res, { user }) => {
  const d = new Date(); d.setDate(1); d.setHours(0, 0, 0, 0); // с начала месяца
  const rows = q.usageByUserSince.all(d.getTime());
  json(res, 200, {
    since: d.getTime(),
    total: rows.reduce((s, r) => s + r.cost, 0),
    users: rows.map(r => ({ username: r.username, cost: r.cost, calls: r.calls, pt: r.pt, ct: r.ct })),
    my_spent_today: spentToday(user.id),
    my_daily_limit: user.is_admin ? null : dailyLimitFor(user),
  });
});

// ----- настройки (админ) -----
route('GET', '/api/settings', async (req, res) => {
  json(res, 200, {
    app_title: getSetting('app_title', 'Таверна'),
    world_prompt: getSetting('world_prompt', ''),
    default_daily_limit_usd: getSetting('default_daily_limit_usd', '1'),
    chronicle_model: getSetting('chronicle_model', 'anthropic/claude-haiku-5.5'),
    openrouter_key_set: !!(getSetting('openrouter_key', process.env.OPENROUTER_API_KEY || '')),
  });
}, { admin: true });

route('PATCH', '/api/settings', async (req, res) => {
  const b = await readBody(req);
  for (const k of ['app_title', 'world_prompt', 'default_daily_limit_usd', 'chronicle_model', 'openrouter_key']) {
    if (b[k] != null && String(b[k]).length) setSetting(k, String(b[k]));
  }
  json(res, 200, { ok: true });
}, { admin: true });

route('PATCH', '/api/users/:id/limit', async (req, res, { params }) => {
  const b = await readBody(req);
  q.setUserLimit.run(b.daily_limit_usd == null ? null : parseFloat(b.daily_limit_usd), params.id);
  json(res, 200, { ok: true });
}, { admin: true });

// ---------- static ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };
function serveStatic(req, res, pathname) {
  let file = pathname === '/' ? '/index.html' : pathname;
  const full = path.join(PUBLIC_DIR, path.normalize(file));
  if (!full.startsWith(PUBLIC_DIR)) return err(res, 403, 'нет');
  fs.readFile(full, (e, data) => {
    if (e) { // SPA-fallback
      fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (e2, d2) => {
        if (e2) return err(res, 404, 'нет файла');
        res.writeHead(200, { 'Content-Type': MIME['.html'] }); res.end(d2);
      });
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (pathname.startsWith('/api/')) handleApi(req, res, pathname).catch(e => err(res, 500, e.message));
  else serveStatic(req, res, pathname);
});

server.listen(PORT, () => {
  console.log(`Таверна слушает порт ${PORT}`);
  if (q.userCount.get().n === 0) console.log('Первый зарегистрировавшийся станет админом.');
});
