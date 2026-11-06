'use strict';
// server.js — Таверна-форум: приватная ролевая для своих + ИИ
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { q, now, getSetting, setSetting, DATA_DIR } = require('./db');
const { aiPost, chronicle, spentToday, dailyLimitFor, queueLifeChron, undoLifeChron, fillFromCard, draw, DEFAULT_ART } = require('./ai');
const life = require('./life');

const PORT = parseInt(process.env.PORT || '8080', 10);
const PUBLIC_DIR = path.join(__dirname, 'public');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');

// ---------- helpers ----------
const json = (res, code, obj) => {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
};
const err = (res, code, message) => json(res, code, { error: message });

function readBody(req, cap = 2e6) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > cap) { reject(new Error('Слишком большой запрос')); req.destroy(); } });
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

const publicUser = u => ({ id: u.id, username: u.username, is_admin: !!u.is_admin });
const publicPost = p => {
  const ch = life.json(p.chron, null);
  return {
    id: p.id, room_id: p.room_id, user_id: p.user_id, persona_id: p.persona_id,
    ai_char_id: p.ai_char_id, body: p.body, image: p.image || '', is_ooc: !!p.is_ooc,
    created_at: p.created_at, edited_at: p.edited_at,
    chron: ch ? { chips: ch.chips || [], at: ch.at } : null,
  };
};
const publicRoom = (r, lastTimes, previews) => ({
  id: r.id, world_id: r.world_id, title: r.title, kind: r.kind, category: r.category,
  description: r.description, cover: r.cover || '', auto_ai_char_id: r.auto_ai_char_id,
  map_x: r.map_x, map_y: r.map_y, chron_on: r.chron_on, scene: life.sceneOf(r),
  chronicle: r.chronicle, chronicle_at: r.chronicle_at,
  ai_ids: q.roomAi.all(r.id).map(x => x.ai_char_id),
  last_at: lastTimes?.[r.id]?.last_at || null, post_count: lastTimes?.[r.id]?.n || 0,
  preview: previews?.[r.id] || null,
});

// ---------- SSE ----------
const sseClients = new Set();
function broadcast(event) {
  const line = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of sseClients) { try { res.write(line); } catch { sseClients.delete(res); } }
}

const genLocks = new Set();

// Летописец после поста: по очереди в мире, траты — на того, кто запостил/позвал
function lifeAfter(post, user) {
  return queueLifeChron({ user, post })
    .then(r => { if (r) broadcast({ type: 'chron', room_id: r.room_id, world_id: r.world_id, post_id: r.post_id, chips: r.chips }); return r; })
    .catch(e => { broadcast({ type: 'chron_error', room_id: post.room_id, message: e.message }); return null; });
}

// ИИ пишет пост: взвод инициативы → генерация → отметка сыгранного → Летописец
async function makeAiPost({ user, room, aiChar, instruction }) {
  const seq = (q.lastPosts.get?.(room.id, 1)?.id) || Date.now();
  const text = await aiPost({ user, room, aiChar, instruction: instruction || '', postSeq: seq });
  const r = q.insertPost.run(room.id, null, null, aiChar.id, text, '', 0, now());
  const post = q.postById.get(Number(r.lastInsertRowid));
  life.afterAiPost(room, life.charInfo(life.keyOf('a', aiChar.id)), post.id);
  broadcast({ type: 'post', post: publicPost(post) });
  lifeAfter(post, user);
  return post;
}

// авто-ответ бота после поста игрока (сцены 1-на-1)
async function autoAiReply(room, user, chronDone) {
  const aiChar = q.aiCharById.get(room.auto_ai_char_id || 0);
  if (!aiChar || aiChar.deleted || genLocks.has(room.id)) return;
  genLocks.add(room.id);
  broadcast({ type: 'ai_typing', room_id: room.id, ai_char_id: aiChar.id, on: true });
  try {
    await chronDone; // сначала Летописец — бот видит свежее состояние
    await makeAiPost({ user, room: q.roomById.get(room.id), aiChar, instruction: '' });
  } catch (e) {
    broadcast({ type: 'ai_error', room_id: room.id, message: e.message });
  } finally {
    genLocks.delete(room.id);
    broadcast({ type: 'ai_typing', room_id: room.id, ai_char_id: aiChar.id, on: false });
  }
}

// ---------- роуты ----------
const routes = [];
function route(method, pattern, handler, { admin = false, open = false } = {}) {
  const keys = [];
  const rx = new RegExp('^' + pattern.replace(/([:@])(\w+)/g, (_, s, k) => { keys.push((s === '@' ? '@' : '') + k); return s === '@' ? '([pa])' : '(\\d+)'; }) + '$');
  routes.push({ method, rx, keys, handler, admin, open });
}

async function handleApi(req, res, pathname) {
  for (const r of routes) {
    if (r.method !== req.method) continue;
    const m = pathname.match(r.rx);
    if (!m) continue;
    const params = {};
    r.keys.forEach((k, i) => { if (k[0] === '@') params[k.slice(1)] = m[i + 1]; else params[k] = parseInt(m[i + 1], 10); });
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
  const previews = {};
  for (const p of q.lastPostPreviews.all()) {
    let who = '';
    if (p.ai_char_id) who = q.aiCharById.get(p.ai_char_id)?.name || '';
    else if (p.persona_id) who = q.personaById.get(p.persona_id)?.name || '';
    previews[p.room_id] = (who ? who + ': ' : '') + p.body.slice(0, 90);
  }
  json(res, 200, {
    me: publicUser(user),
    app_title: getSetting('app_title', 'Таверна'),
    worlds: q.allWorlds.all().map(w => ({ id: w.id, title: w.title, emoji: w.emoji, cover: w.cover, accent: w.accent, map: w.map || '', clock: w.clock || '' })),
    rooms: q.allRooms.all().map(r => publicRoom(r, lastTimes, previews)),
    my_personas: q.personasByUser.all(user.id),
    all_personas: q.allPersonas.all().map(p => ({ id: p.id, name: p.name, emoji: p.emoji, color: p.color, avatar: p.avatar || '', username: p.username, user_id: p.user_id })),
    ai_chars: q.aiChars.all().map(c => ({ id: c.id, world_id: c.world_id, name: c.name, emoji: c.emoji, color: c.color, avatar: c.avatar || '', model: c.model })),
    users: q.allUsers.all().map(u => ({ id: u.id, username: u.username, is_admin: !!u.is_admin })),
    extensions: q.enabledExtensions.all().map(x => ({ id: x.id, name: x.name, css: x.css, js: x.js })),
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

// ----- загрузка картинок (base64 data URL) -----
route('POST', '/api/upload', async (req, res) => {
  const { data } = await readBody(req, 9e6);
  const m = /^data:image\/(png|jpe?g|webp|gif);base64,(.+)$/.exec(String(data || ''));
  if (!m) return err(res, 400, 'Нужна картинка (png/jpg/webp/gif)');
  const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > 6e6) return err(res, 400, 'Картинка больше 6 МБ — сожми');
  const name = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${ext}`;
  fs.writeFileSync(path.join(UPLOADS_DIR, name), buf);
  json(res, 200, { ok: true, url: `/uploads/${name}` });
});

// ----- personas -----
route('POST', '/api/personas', async (req, res, { user }) => {
  const { name, emoji, color, bio, avatar } = await readBody(req);
  if (!name || !String(name).trim()) return err(res, 400, 'Имя персонажа обязательно');
  const r = q.insertPersona.run(user.id, String(name).trim(), emoji || '🎭', color || '#c9a227', bio || '', avatar || '');
  broadcast({ type: 'personas' });
  json(res, 200, { ok: true, id: Number(r.lastInsertRowid) });
});
route('PATCH', '/api/personas/:id', async (req, res, { params, user }) => {
  const b = await readBody(req);
  const p = q.personaById.get(params.id);
  if (!p || p.user_id !== user.id) return err(res, 404, 'Не твой персонаж');
  q.updatePersona.run(b.name ?? p.name, b.emoji ?? p.emoji, b.color ?? p.color, b.bio ?? p.bio, b.avatar ?? p.avatar, p.id, user.id);
  broadcast({ type: 'personas' });
  json(res, 200, { ok: true });
});
route('DELETE', '/api/personas/:id', async (req, res, { params, user }) => {
  q.deletePersona.run(params.id, user.id);
  broadcast({ type: 'personas' });
  json(res, 200, { ok: true });
});

// ----- Life: карточки персонажей, жизнь, гардероб, вещи, связи -----
// Ключ персонажа: /api/life/p/12 — маска игрока, /api/life/a/3 — ИИ-персонаж
function lifeKey(t, id) { return life.keyOf(t, id); }
function canEdit(user, c) { return !!c && (user.is_admin || (!c.ai && c.user_id === user.id)); }
function canSeeInner(user, c) { return !!c && (c.ai || user.is_admin || c.user_id === user.id || life.prof(c.key).share); }
function worldFrom(req) {
  const w = parseInt(new URL(req.url, 'http://x').searchParams.get('world') || '0', 10);
  return q.worldById.get(w) ? w : (q.allWorlds.all()[0]?.id || 1);
}
function lifeView(user, c, W) {
  const p = life.prof(c.key), x = life.state(W, c.key);
  const seeInner = canSeeInner(user, c);
  const k = life.parseKey(c.key);
  const loc = q.lastPostOfAuthorInWorld.get(W, k.t, k.id, k.t, k.id);
  const items = q.itemsByOwner.all(c.key).map(i => ({ ...i, story: life.json(i.story, []), from_name: i.from_key ? life.charInfo(i.from_key)?.name || '' : '' }));
  const out = {
    char: { key: c.key, t: c.t, id: c.id, name: c.name, ai: c.ai, user_id: c.user_id, avatar: c.avatar, emoji: c.emoji, color: c.color, bio: c.ai ? '' : c.bio },
    can_edit: canEdit(user, c), can_see: seeInner, world_id: W,
    prof: { card: p.card, likes: p.likes, dislikes: p.dislikes, hobbies: p.hobbies, facts: p.facts, fem: p.fem, share: p.share },
    outfit: x.outfit, state_label: life.stateLabel(x, p),
    location: loc ? { room_id: loc.room_id, at: loc.created_at } : null,
    items: seeInner || canEdit(user, c) ? items : items.filter(i => i.kind === 'образ' || i.equipped),
  };
  if (seeInner) {
    const b = life.bodyView(W, c.key, x, p);
    out.prof = { ...out.prof, turnons: p.turnons, romance: p.romance, init: p.init, talk: p.talk, metab: p.metab, inner: p.inner };
    out.body = b.needs; out.urgent = b.urgent; out.wounds = b.wounds;
    out.state = x.state; out.thoughts = x.thoughts; out.wants = x.wants; out.ideas = x.ideas; out.armed = x.armed;
    const rels = q.relsOf.all(W, c.key, c.key);
    const others = new Set(rels.map(r => r.from_key === c.key ? r.to_key : r.from_key));
    out.relations = [...others].map(o => {
      const oc = life.charInfo(o); if (!oc) return null;
      const ab = life.rel(W, c.key, o), ba = life.rel(W, o, c.key);
      const backHidden = !oc.ai && !canSeeInner(user, oc);
      return { key: o, name: oc.name, avatar: oc.avatar, emoji: oc.emoji, ai: oc.ai, out: ab, back: backHidden ? null : ba, moments: [...ab.moments, ...ba.moments].slice(-6) };
    }).filter(Boolean);
  }
  return out;
}

route('GET', '/api/life/meta', async (req, res) => {
  json(res, 200, {
    needs: life.NEEDS, states: life.STATES.map(s => [s[0], s[1], s[2], s[3]]), moods: life.MOODS.map(m => [m[0], m[1], m[2]]),
    tones: life.TONES.map(t => [t[0], t[1], t[2], t[3]]), scales: life.SCALES, idea_kinds: life.IDEA_KINDS,
    freq: Object.fromEntries(Object.entries(life.FREQ).map(([k, v]) => [k, v[2]])),
  });
});

route('GET', '/api/life/@t/:id', async (req, res, { params, user }) => {
  const c = life.charInfo(lifeKey(params.t, params.id));
  if (!c) return err(res, 404, 'Нет персонажа');
  json(res, 200, lifeView(user, c, worldFrom(req)));
});

// профиль: карточка личности, вкусы, характер, ухаживания, инициатива, видимость
route('PATCH', '/api/life/@t/:id/prof', async (req, res, { params, user }) => {
  const c = life.charInfo(lifeKey(params.t, params.id));
  if (!canEdit(user, c)) return err(res, 403, 'Нельзя');
  const b = await readBody(req);
  const p = life.prof(c.key);
  if (b.card && typeof b.card === 'object') for (const f of ['age', 'look', 'traits', 'story']) if (b.card[f] != null) p.card[f] = life.cut(b.card[f], 2000);
  for (const f of ['likes', 'dislikes', 'hobbies', 'turnons', 'facts']) if (Array.isArray(b[f])) p[f] = b[f].map(s => life.cut(s, 200)).filter(Boolean).slice(0, 60);
  if (typeof b.fem === 'boolean') p.fem = b.fem;
  if ([1, 1.5, 2].includes(b.metab)) p.metab = b.metab;
  if (typeof b.share === 'boolean') p.share = b.share;
  if (typeof b.inner === 'boolean') p.inner = b.inner;
  if (b.talk && life.FREQ[b.talk]) p.talk = b.talk;
  if (b.romance && typeof b.romance === 'object') p.romance = { ...p.romance, ...b.romance };
  if (b.init && typeof b.init === 'object') {
    if (life.FREQ[b.init.freq]) p.init.freq = b.init.freq;
    if (Array.isArray(b.init.kinds)) p.init.kinds = b.init.kinds.filter(k => life.IDEA_KINDS[k]);
  }
  life.saveProf(c.key, p);
  broadcast({ type: 'life', key: c.key });
  json(res, 200, { ok: true });
});

// состояние в мире: тело, состояние, мысли, желания, идеи, одежда, взвести
route('PATCH', '/api/life/@t/:id/state', async (req, res, { params, user }) => {
  const c = life.charInfo(lifeKey(params.t, params.id));
  if (!canEdit(user, c)) return err(res, 403, 'Нельзя');
  const W = worldFrom(req);
  const b = await readBody(req);
  const x = life.state(W, c.key), h = life.worldHours(W);
  if (b.body && typeof b.body === 'object') for (const [k] of life.NEEDS) if (typeof b.body[k] === 'number') life.setNeed(x, k, b.body[k], h);
  if (b.state !== undefined) x.state = b.state && life.STATES.some(s => s[0] === b.state) ? { id: b.state, why: life.cut(b.why || '', 60), manual: true } : null;
  if (typeof b.outfit === 'string') x.outfit = life.cut(b.outfit, 300);
  if (b.wound_del != null) x.wounds = x.wounds.filter(w => w.id !== b.wound_del);
  if (b.wound_add) x.wounds.push({ id: ++x.seq, t: life.cut(b.wound_add, 50), at: h });
  for (const f of ['thoughts', 'wants']) {
    if (b[`${f}_add`]) x[f].push({ id: life.uid(), t: life.cut(b[`${f}_add`], 120), w: 1, status: 'on', by: 'hand', with: life.cut(b.with || '', 40) });
    if (b[`${f}_set`] && typeof b[`${f}_set`] === 'object') { const y = x[f].find(i => i.id === b[`${f}_set`].id); if (y) Object.assign(y, { status: b[`${f}_set`].status ?? y.status, w: b[`${f}_set`].w ?? y.w }); }
    if (b[`${f}_del`]) x[f] = x[f].filter(i => i.id !== b[`${f}_del`]);
  }
  if (b.idea_add && b.idea_add.text) x.ideas.push({ id: life.uid(), kind: life.IDEA_KINDS[b.idea_add.kind] ? b.idea_add.kind : 'care', text: life.cut(b.idea_add.text, 160), when: 'scene', status: 'new', by: 'hand' });
  if (b.idea_set) { const y = x.ideas.find(i => i.id === b.idea_set.id); if (y && ['new', 'skip', 'done'].includes(b.idea_set.status)) y.status = b.idea_set.status; }
  if (b.arm !== undefined) {
    if (!b.arm) x.armed = null;
    else if (['idea', 'thought', 'want'].includes(b.arm.kind)) { x.armed = { kind: b.arm.kind, id: b.arm.id, at: 0, manual: true }; if (b.arm.kind === 'idea') { const y = x.ideas.find(i => i.id === b.arm.id); if (y) y.status = 'armed'; } }
  }
  life.saveState(W, c.key, x);
  broadcast({ type: 'life', key: c.key });
  json(res, 200, { ok: true });
});

// шкалы отношений руками: from → to
route('PATCH', '/api/life/@t/:id/rel', async (req, res, { params, user }) => {
  const c = life.charInfo(lifeKey(params.t, params.id));
  if (!canEdit(user, c)) return err(res, 403, 'Нельзя');
  const W = worldFrom(req);
  const b = await readBody(req);
  const o = life.charInfo(b.to); if (!o || o.key === c.key) return err(res, 400, 'К кому?');
  const r = life.rel(W, c.key, o.key);
  for (const [f] of life.SCALES) if (typeof b[f] === 'number') r[f] = Math.max(0, Math.min(100, Math.round(b[f])));
  if (b.moment) r.moments.push({ text: life.cut(b.moment, 60), by: 'hand' });
  life.saveRel(W, c.key, o.key, r);
  broadcast({ type: 'life', key: c.key });
  json(res, 200, { ok: true });
});

route('POST', '/api/life/@t/:id/fill', async (req, res, { params, user }) => {
  const c = life.charInfo(lifeKey(params.t, params.id));
  if (!canEdit(user, c)) return err(res, 403, 'Нельзя');
  await fillFromCard({ user, key: c.key, worldId: worldFrom(req) });
  broadcast({ type: 'life', key: c.key });
  json(res, 200, { ok: true, spent_today: spentToday(user.id) });
});

// вещи, гардероб, гараж
route('POST', '/api/life/@t/:id/items', async (req, res, { params, user }) => {
  const c = life.charInfo(lifeKey(params.t, params.id));
  if (!canEdit(user, c)) return err(res, 403, 'Нельзя');
  const b = await readBody(req);
  if (!b.name) return err(res, 400, 'Название обязательно');
  const kind = ['образ', 'одежда', 'транспорт', 'вещь'].includes(b.kind) ? b.kind : 'вещь';
  if (kind === 'образ' && b.equipped) q.unequipLooks.run(c.key);
  const r = q.insertItem.run(c.t === 'p' ? c.id : 0, c.key, kind, life.cut(b.name, 80), life.cut(b.descr || '', 600), b.image || '', b.equipped ? 1 : 0, '[]', '', now());
  if (kind === 'образ' && b.equipped) { const W = worldFrom(req); const x = life.state(W, c.key); x.outfit = life.cut(b.descr || b.name, 300); life.saveState(W, c.key, x); }
  broadcast({ type: 'life', key: c.key });
  json(res, 200, { ok: true, id: Number(r.lastInsertRowid) });
});

route('PATCH', '/api/items/:id', async (req, res, { params, user }) => {
  const it = q.itemById.get(params.id);
  if (!it) return err(res, 404, 'Нет предмета');
  const c = life.charInfo(it.owner_key);
  if (!canEdit(user, c)) return err(res, 403, 'Не твой предмет');
  const b = await readBody(req);
  const equipped = b.equipped != null ? (b.equipped ? 1 : 0) : it.equipped;
  if (it.kind === 'образ' && equipped && !it.equipped) {
    q.unequipLooks.run(c.key);
    const W = worldFrom(req); const x = life.state(W, c.key); x.outfit = life.cut(b.descr ?? it.descr ?? it.name, 300); life.saveState(W, c.key, x);
  }
  let owner = it.owner_key;
  if (b.give_to) { const to = life.charInfo(b.give_to); if (to) owner = to.key; }
  q.updateItem.run(b.kind ?? it.kind, b.name ?? it.name, b.descr ?? it.descr, b.image ?? it.image, equipped, it.story, owner !== it.owner_key ? it.owner_key : it.from_key, owner, it.id);
  broadcast({ type: 'life', key: c.key });
  json(res, 200, { ok: true });
});

route('DELETE', '/api/items/:id', async (req, res, { params, user }) => {
  const it = q.itemById.get(params.id);
  if (!it) return err(res, 404, 'Нет предмета');
  const c = life.charInfo(it.owner_key);
  if (!canEdit(user, c)) return err(res, 403, 'Не твой предмет');
  q.deleteItem.run(it.id);
  broadcast({ type: 'life', key: c.key });
  json(res, 200, { ok: true });
});

// кто где в мире + время истории (для карты и сетки персонажей)
route('GET', '/api/worlds/:id/brief', async (req, res, { params, user }) => {
  const w = q.worldById.get(params.id);
  if (!w) return err(res, 404, 'Нет мира');
  const keys = [...q.allPersonas.all().map(p => life.keyOf('p', p.id)), ...q.aiChars.all().filter(c => !c.world_id || c.world_id === w.id).map(c => life.keyOf('a', c.id))];
  const chars = {};
  for (const k of keys) {
    const c = life.charInfo(k); if (!c) continue;
    const pk = life.parseKey(k);
    const loc = q.lastPostOfAuthorInWorld.get(w.id, pk.t, pk.id, pk.t, pk.id);
    const x = life.state(w.id, k), p = life.prof(k);
    chars[k] = { room_id: loc?.room_id || null, at: loc?.created_at || null, outfit: x.outfit, state: canSeeInner(user, c) ? life.stateLabel(x, p) : '' };
  }
  json(res, 200, { clock: w.clock, hours: w.hours, chars });
});

// сцена: тон, близость, беременность, «забота после»
route('PATCH', '/api/rooms/:id/scene', async (req, res, { params }) => {
  const room = q.roomById.get(params.id);
  if (!room) return err(res, 404, 'Нет комнаты');
  const b = await readBody(req);
  const sc = life.sceneOf(room);
  if (b.set !== undefined) sc.set = life.MOODS.some(m => m[0] === b.set) ? b.set : '';
  if (b.intim !== undefined) sc.intim = ['auto', 'on', 'off'].includes(b.intim) ? b.intim : 'auto';
  if (b.tone !== undefined) sc.tone = life.TONES.some(t => t[0] === b.tone) ? b.tone : '';
  if (typeof b.preg === 'boolean') sc.preg = b.preg;
  if (typeof b.care === 'boolean') sc.care = b.care;
  q.setRoomScene.run(JSON.stringify(sc), room.id);
  broadcast({ type: 'scene', room_id: room.id, scene: sc });
  json(res, 200, { ok: true, scene: sc });
});

// Летописец: перепрогнать / откатить
route('POST', '/api/posts/:id/chron', async (req, res, { params, user }) => {
  const p = q.postById.get(params.id);
  if (!p || p.deleted) return err(res, 404, 'Нет поста');
  const r = await queueLifeChron({ user, post: p, force: true });
  if (r) broadcast({ type: 'chron', room_id: r.room_id, world_id: r.world_id, post_id: r.post_id, chips: r.chips });
  json(res, 200, { ok: true, chips: r?.chips || [] });
});
route('POST', '/api/posts/:id/chron/undo', async (req, res, { params, user }) => {
  const p = q.postById.get(params.id);
  if (!p) return err(res, 404, 'Нет поста');
  if (p.user_id !== user.id && !user.is_admin) return err(res, 403, 'Откатить может автор поста или админ');
  undoLifeChron(p);
  broadcast({ type: 'chron', room_id: p.room_id, post_id: p.id, chips: null });
  json(res, 200, { ok: true });
});

// картинки: портреты, образы, вещи, обложки мест, карты
route('POST', '/api/draw', async (req, res, { user }) => {
  const b = await readBody(req);
  if (!b.prompt) return err(res, 400, 'Что рисуем?');
  const aspect = ['1:1', '3:4', '4:3', '16:9', '9:16', '2:3', '3:2'].includes(b.aspect) ? b.aspect : '1:1';
  const refs = Array.isArray(b.refs) ? b.refs.filter(u => typeof u === 'string' && u.startsWith('/uploads/')) : [];
  const url = await draw({ user, prompt: life.cut(b.prompt, 3000), aspect, refs, worldId: b.world_id || null });
  json(res, 200, { ok: true, url, spent_today: spentToday(user.id) });
});

// ----- миры -----
route('POST', '/api/worlds', async (req, res) => {
  const b = await readBody(req);
  if (!b.title) return err(res, 400, 'Название обязательно');
  const r = q.insertWorld.run(b.title, b.emoji || '🌍', b.cover || '', b.prompt || '', b.accent || '', b.position ?? 0);
  broadcast({ type: 'rooms' });
  json(res, 200, { ok: true, id: Number(r.lastInsertRowid) });
}, { admin: true });

route('GET', '/api/worlds/:id', async (req, res, { params }) => {
  const w = q.worldById.get(params.id);
  if (!w) return err(res, 404, 'Нет мира');
  json(res, 200, { world: w });
}, { admin: true });

route('PATCH', '/api/worlds/:id', async (req, res, { params }) => {
  const w = q.worldById.get(params.id);
  if (!w) return err(res, 404, 'Нет мира');
  const b = await readBody(req);
  q.updateWorld.run(b.title ?? w.title, b.emoji ?? w.emoji, b.cover ?? w.cover, b.prompt ?? w.prompt,
    b.accent ?? w.accent, b.position ?? w.position, b.archived != null ? (b.archived ? 1 : 0) : w.archived,
    b.map ?? w.map ?? '', b.art_style ?? w.art_style ?? '', w.id);
  broadcast({ type: 'rooms' });
  json(res, 200, { ok: true });
}, { admin: true });

// ----- rooms -----
route('POST', '/api/rooms', async (req, res) => {
  const b = await readBody(req);
  if (!b.title) return err(res, 400, 'Название обязательно');
  const worldId = b.world_id || 1;
  if (!q.worldById.get(worldId)) return err(res, 400, 'Нет такого мира');
  const r = q.insertRoom.run(worldId, String(b.title), b.kind === 'chat' ? 'chat' : 'forum',
    b.category || 'Локации', b.description || '', b.cover || '', 0);
  const roomId = Number(r.lastInsertRowid);
  if (Array.isArray(b.ai_ids)) for (const id of b.ai_ids) q.addRoomAi.run(roomId, id);
  broadcast({ type: 'rooms' });
  json(res, 200, { ok: true, id: roomId });
}, { admin: true });

route('PATCH', '/api/rooms/:id', async (req, res, { params }) => {
  const room = q.roomById.get(params.id);
  if (!room) return err(res, 404, 'Нет комнаты');
  const b = await readBody(req);
  q.updateRoom.run(b.title ?? room.title, b.kind ?? room.kind, b.category ?? room.category,
    b.description ?? room.description, b.cover ?? room.cover,
    b.auto_ai_char_id !== undefined ? (b.auto_ai_char_id || null) : room.auto_ai_char_id,
    b.position ?? room.position,
    b.archived != null ? (b.archived ? 1 : 0) : room.archived,
    b.map_x !== undefined ? b.map_x : room.map_x,
    b.map_y !== undefined ? b.map_y : room.map_y,
    b.chron_on !== undefined ? (b.chron_on === null ? -1 : b.chron_on ? 1 : 0) : room.chron_on, room.id);
  if (Array.isArray(b.ai_ids)) {
    q.clearRoomAi.run(room.id);
    for (const id of b.ai_ids) q.addRoomAi.run(room.id, id);
  }
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
  const { persona_id, body, image, is_ooc } = await readBody(req);
  if ((!body || !String(body).trim()) && !image) return err(res, 400, 'Пустой пост');
  let pid = null;
  if (persona_id) {
    const p = q.personaById.get(persona_id);
    if (!p || p.user_id !== user.id) return err(res, 400, 'Не твой персонаж');
    pid = p.id;
  }
  const img = image && String(image).startsWith('/uploads/') ? String(image) : '';
  const r = q.insertPost.run(room.id, user.id, pid, null, String(body || ''), img, is_ooc ? 1 : 0, now());
  const raw = q.postById.get(Number(r.lastInsertRowid));
  const post = publicPost(raw);
  broadcast({ type: 'post', post });
  json(res, 200, { ok: true, post });
  // Летописец, потом авто-ответ бота (только на пост «в роли»)
  const chronDone = pid && !is_ooc ? lifeAfter(raw, user) : Promise.resolve(null);
  if (pid && !is_ooc && room.auto_ai_char_id) autoAiReply(room, user, chronDone);
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
    const post = await makeAiPost({ user, room, aiChar, instruction });
    json(res, 200, { ok: true, post: publicPost(post), spent_today: spentToday(user.id) });
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
  const r = q.insertAiChar.run(b.world_id || null, b.name, b.emoji || '🤖', b.color || '#7c5cff', b.avatar || '',
    b.model, b.system_prompt || '', b.temperature ?? 0.9, b.max_tokens ?? 1200, b.context_posts ?? 40);
  broadcast({ type: 'ai_chars' });
  json(res, 200, { ok: true, id: Number(r.lastInsertRowid) });
}, { admin: true });

route('PATCH', '/api/ai-chars/:id', async (req, res, { params }) => {
  const c = q.aiCharById.get(params.id);
  if (!c) return err(res, 404, 'Нет такого');
  const b = await readBody(req);
  q.updateAiChar.run(b.world_id !== undefined ? (b.world_id || null) : c.world_id,
    b.name ?? c.name, b.emoji ?? c.emoji, b.color ?? c.color, b.avatar ?? c.avatar, b.model ?? c.model,
    b.system_prompt ?? c.system_prompt, b.temperature ?? c.temperature, b.max_tokens ?? c.max_tokens,
    b.context_posts ?? c.context_posts, b.deleted != null ? (b.deleted ? 1 : 0) : c.deleted, c.id);
  broadcast({ type: 'ai_chars' });
  json(res, 200, { ok: true });
}, { admin: true });

route('GET', '/api/ai-chars', async (req, res) => {
  json(res, 200, { ai_chars: q.aiChars.all() });
});

// ----- лорбуки -----
route('GET', '/api/worlds/:id/lorebooks', async (req, res, { params }) => {
  const books = q.booksByWorld.all(params.id).map(b => ({ ...b, entries: q.entriesByBook.all(b.id) }));
  json(res, 200, { lorebooks: books });
}, { admin: true });

route('POST', '/api/worlds/:id/lorebooks', async (req, res, { params }) => {
  const b = await readBody(req);
  if (!b.name) return err(res, 400, 'Название обязательно');
  const r = q.insertBook.run(params.id, b.name);
  json(res, 200, { ok: true, id: Number(r.lastInsertRowid) });
}, { admin: true });

route('PATCH', '/api/lorebooks/:id', async (req, res, { params }) => {
  const b = q.bookById.get(params.id);
  if (!b) return err(res, 404, 'Нет лорбука');
  const body = await readBody(req);
  q.updateBook.run(body.name ?? b.name, body.enabled != null ? (body.enabled ? 1 : 0) : b.enabled, b.id);
  json(res, 200, { ok: true });
}, { admin: true });

route('DELETE', '/api/lorebooks/:id', async (req, res, { params }) => {
  q.deleteBookEntries.run(params.id);
  q.deleteBook.run(params.id);
  json(res, 200, { ok: true });
}, { admin: true });

// импорт ST World Info JSON (формат SillyTavern: {entries: {uid: {key:[], content, constant, disable}}})
route('POST', '/api/lorebooks/:id/import', async (req, res, { params }) => {
  const book = q.bookById.get(params.id);
  if (!book) return err(res, 404, 'Нет лорбука');
  const { json: raw, replace } = await readBody(req, 8e6);
  let data;
  try { data = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return err(res, 400, 'Это не JSON'); }
  let entries = data?.entries ?? data;
  if (entries && !Array.isArray(entries) && typeof entries === 'object') entries = Object.values(entries);
  if (!Array.isArray(entries) || !entries.length) return err(res, 400, 'В файле нет записей (ожидаю ST World Info)');
  if (replace) q.deleteBookEntries.run(book.id);
  let n = 0;
  for (const e of entries) {
    if (!e || typeof e !== 'object') continue;
    const keys = Array.isArray(e.key) ? e.key : Array.isArray(e.keys) ? e.keys : (e.key ? [e.key] : []);
    const content = String(e.content || '').trim();
    if (!content) continue;
    const title = String(e.comment || e.title || '').slice(0, 120);
    const alwaysOn = e.constant ? 1 : 0;
    const enabled = (e.disable || e.enabled === false) ? 0 : 1;
    q.insertEntry.run(book.id, title, keys.map(String).join(', '), content, alwaysOn, enabled, n);
    n++;
  }
  json(res, 200, { ok: true, imported: n });
}, { admin: true });

route('POST', '/api/lorebooks/:id/entries', async (req, res, { params }) => {
  const b = await readBody(req);
  const r = q.insertEntry.run(params.id, b.title || '', b.keys || '', b.content || '',
    b.always_on ? 1 : 0, b.enabled === false ? 0 : 1, b.position ?? 0);
  json(res, 200, { ok: true, id: Number(r.lastInsertRowid) });
}, { admin: true });

route('PATCH', '/api/lore-entries/:id', async (req, res, { params }) => {
  const e = q.entryById.get(params.id);
  if (!e) return err(res, 404, 'Нет записи');
  const b = await readBody(req);
  q.updateEntry.run(b.title ?? e.title, b.keys ?? e.keys, b.content ?? e.content,
    b.always_on != null ? (b.always_on ? 1 : 0) : e.always_on,
    b.enabled != null ? (b.enabled ? 1 : 0) : e.enabled, b.position ?? e.position, e.id);
  json(res, 200, { ok: true });
}, { admin: true });

route('DELETE', '/api/lore-entries/:id', async (req, res, { params }) => {
  q.deleteEntry.run(params.id);
  json(res, 200, { ok: true });
}, { admin: true });

// ----- расширения -----
route('GET', '/api/extensions', async (req, res) => {
  json(res, 200, { extensions: q.allExtensions.all() });
}, { admin: true });

route('POST', '/api/extensions', async (req, res) => {
  const b = await readBody(req, 4e6);
  if (!b.name) return err(res, 400, 'Название обязательно');
  const r = q.insertExtension.run(b.name, b.css || '', b.js || '');
  broadcast({ type: 'extensions' });
  json(res, 200, { ok: true, id: Number(r.lastInsertRowid) });
}, { admin: true });

route('PATCH', '/api/extensions/:id', async (req, res, { params }) => {
  const x = q.extensionById.get(params.id);
  if (!x) return err(res, 404, 'Нет расширения');
  const b = await readBody(req, 4e6);
  q.updateExtension.run(b.name ?? x.name, b.css ?? x.css, b.js ?? x.js,
    b.enabled != null ? (b.enabled ? 1 : 0) : x.enabled, x.id);
  broadcast({ type: 'extensions' });
  json(res, 200, { ok: true });
}, { admin: true });

route('DELETE', '/api/extensions/:id', async (req, res, { params }) => {
  q.deleteExtension.run(params.id);
  broadcast({ type: 'extensions' });
  json(res, 200, { ok: true });
}, { admin: true });

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
  const d = new Date(); d.setDate(1); d.setHours(0, 0, 0, 0);
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
    default_daily_limit_usd: getSetting('default_daily_limit_usd', '1'),
    chronicle_model: getSetting('chronicle_model', 'anthropic/claude-haiku-5.5'),
    life_model: getSetting('life_model', ''),
    image_model: getSetting('image_model', 'google/gemini-2.5-flash-image'),
    art_style: getSetting('art_style', DEFAULT_ART),
    openrouter_key_set: !!(getSetting('openrouter_key', process.env.OPENROUTER_API_KEY || '')),
  });
}, { admin: true });

route('PATCH', '/api/settings', async (req, res) => {
  const b = await readBody(req);
  for (const k of ['app_title', 'default_daily_limit_usd', 'chronicle_model', 'openrouter_key', 'life_model', 'image_model', 'art_style']) {
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
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };

function serveFile(res, full, cache) {
  fs.readFile(full, (e, data) => {
    if (e) return err(res, 404, 'нет файла');
    const headers = { 'Content-Type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream' };
    if (cache) headers['Cache-Control'] = 'public, max-age=31536000, immutable';
    res.writeHead(200, headers);
    res.end(data);
  });
}

function serveStatic(req, res, pathname) {
  if (pathname.startsWith('/uploads/')) {
    if (!auth(req)) return err(res, 401, 'Не авторизован'); // картинки только для своих
    const full = path.join(UPLOADS_DIR, path.normalize(pathname.slice(9)));
    if (!full.startsWith(UPLOADS_DIR)) return err(res, 403, 'нет');
    return serveFile(res, full, true);
  }
  let file = pathname === '/' ? '/index.html' : pathname;
  const full = path.join(PUBLIC_DIR, path.normalize(file));
  if (!full.startsWith(PUBLIC_DIR)) return err(res, 403, 'нет');
  fs.readFile(full, (e, data) => {
    if (e) {
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
