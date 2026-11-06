'use strict';
// ai.js — вызовы OpenRouter: посты ИИ-персонажей, лорбуки, Летописец (Life), хроника, картинки; лимиты и учёт трат
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { q, now, getSetting, DATA_DIR } = require('./db');
const life = require('./life');

const OR_URL = 'https://openrouter.ai/api/v1/chat/completions';
const LORE_CHAR_BUDGET = 9000;
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const DEFAULT_ART = 'semi-realistic colored-pencil sketch on toned paper, moody cinematic light, graphite and deep wine palette';

function apiKey() { return getSetting('openrouter_key', process.env.OPENROUTER_API_KEY || ''); }
const lifeModel = () => getSetting('life_model', '') || getSetting('chronicle_model', 'anthropic/claude-haiku-5.5');
const imageModel = () => getSetting('image_model', 'google/gemini-2.5-flash-image');

function dailyLimitFor(user) {
  if (user.is_admin) return Infinity;
  if (user.daily_limit_usd != null) return user.daily_limit_usd;
  const def = parseFloat(getSetting('default_daily_limit_usd', '1'));
  return Number.isFinite(def) ? def : 1;
}
function spentToday(userId) {
  const d = new Date(); d.setHours(0, 0, 0, 0);
  return q.spentSince.get(userId, d.getTime()).s;
}
function checkLimit(user) {
  const limit = dailyLimitFor(user);
  const spent = spentToday(user.id);
  if (spent >= limit) {
    const e = new Error(`Дневной лимит исчерпан: потрачено $${spent.toFixed(3)} из $${limit}. Завтра обнулится.`);
    e.status = 429; throw e;
  }
}

function renderPost(p, names) {
  const who = p.ai_char_id
    ? (names.ai.get(p.ai_char_id) || 'ИИ')
    : p.persona_id
      ? `${names.personas.get(p.persona_id) || '???'} (игрок ${names.users.get(p.user_id) || '?'})`
      : `${names.users.get(p.user_id) || '???'} [вне игры]`;
  const ooc = p.is_ooc ? ' [вне игры]' : '';
  const img = p.image ? '\n[к посту приложена картинка]' : '';
  return `### ${who}${ooc}\n${p.body}${img}`;
}
function nameMaps() {
  const personas = new Map(), users = new Map(), ai = new Map();
  for (const p of q.allPersonas.all()) { personas.set(p.id, p.name); users.set(p.user_id, p.username); }
  for (const u of q.allUsers.all()) users.set(u.id, u.username);
  for (const c of q.aiChars.all()) ai.set(c.id, c.name);
  return { personas, users, ai };
}

function loreFor(worldId, scanText) {
  const entries = q.activeEntriesByWorld.all(worldId);
  if (!entries.length) return '';
  const hay = scanText.toLowerCase();
  const picked = [];
  let budget = LORE_CHAR_BUDGET;
  for (const e of entries) {
    let hit = !!e.always_on;
    if (!hit && e.keys) for (const k of e.keys.split(',')) { const key = k.trim().toLowerCase(); if (key && hay.includes(key)) { hit = true; break; } }
    if (hit && e.content.length <= budget) { picked.push(e.title ? `[${e.title}]\n${e.content}` : e.content); budget -= e.content.length; }
  }
  return picked.join('\n\n');
}

/** Карточки игроков в сцене — чтобы ИИ знал, кто перед ним. */
function playersBlock(room) {
  const out = [];
  for (const c of life.presentOf(room).filter(c => !c.ai)) {
    const p = life.prof(c.key);
    const bits = [c.bio, p.card.age && `возраст: ${p.card.age}`, p.card.look && `внешность: ${p.card.look}`, p.card.traits && `характер: ${p.card.traits}`].filter(Boolean);
    if (p.facts.length) bits.push(`важное: ${p.facts.slice(-8).join('; ')}`);
    if (bits.length) out.push(`## ${c.name}\n${life.cut(bits.join('. '), 900)}`);
  }
  return out.join('\n\n');
}

function buildContext(room, aiChar, instruction) {
  const names = nameMaps();
  const world = q.worldById.get(room.world_id);
  const posts = q.lastPosts.all(room.id, aiChar ? aiChar.context_posts : 60).reverse();
  const history = posts.map(p => renderPost(p, names)).join('\n\n');
  const scanText = [room.title, room.description, instruction || '', ...posts.slice(-15).map(p => p.body)].join('\n');
  const lore = world ? loreFor(world.id, scanText) : '';
  const lastUser = [...posts].reverse().find(p => p.persona_id && !p.is_ooc)?.body || '';
  const speaker = aiChar ? life.charInfo(life.keyOf('a', aiChar.id)) : null;

  const parts = [];
  if (world && world.prompt) parts.push(`# Мир и правила игры: ${world.title}\n${world.prompt}`);
  parts.push(`# Локация: ${room.title}\n${room.description || '(без описания)'}`);
  if (room.chronicle) parts.push(`# Хроника событий этой локации (краткая сводка прошлого)\n${room.chronicle}`);
  if (lore) parts.push(`# Сведения о мире и персонажах (лорбук)\n${lore}`);
  const pl = playersBlock(room);
  if (pl) parts.push(`# Персонажи игроков в сцене\n${pl}`);
  if (aiChar) parts.push(`# Твоя роль\n${aiChar.system_prompt}`);
  parts.push(`# Формат\nЭто совместная ролевая игра живых игроков и ИИ. Ниже — последние посты сцены. Ответь ОДНИМ постом от своего лица, по-русски, в стиле сцены. Не пиши действия и реплики за персонажей живых игроков. Не добавляй подпись и заголовок — только текст поста.`);
  const ln = life.notes(room, speaker, { lastUserText: lastUser });
  if (ln) parts.push(`# Заметки к сцене (скрыты от игроков)\n${ln}`);
  if (instruction) parts.push(`# Указание от игрока (вне игры, выполни его)\n${instruction}`);
  return { system: parts.join('\n\n'), history };
}

async function callOpenRouter({ model, system, userContent, temperature, max_tokens, extra = {} }) {
  const key = apiKey();
  if (!key) { const e = new Error('OpenRouter-ключ не задан (админка → Настройки).'); e.status = 400; throw e; }
  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: userContent });
  const res = await fetch(process.env.OPENROUTER_URL || OR_URL, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json', 'X-Title': 'Tavern' },
    body: JSON.stringify({ model, messages, temperature, max_tokens, usage: { include: true }, ...extra }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    const msg = data?.error?.message || `OpenRouter HTTP ${res.status}`;
    const e = new Error(msg); e.status = 502; throw e;
  }
  const msg = data.choices?.[0]?.message || {};
  const text = typeof msg.content === 'string' ? msg.content.trim()
    : Array.isArray(msg.content) ? msg.content.filter(x => x.type === 'text').map(x => x.text).join('').trim() : '';
  const usage = data.usage || {};
  return { text, msg, prompt_tokens: usage.prompt_tokens || 0, completion_tokens: usage.completion_tokens || 0, cost_usd: typeof usage.cost === 'number' ? usage.cost : 0 };
}

function logUsage(user, aiCharId, roomId, model, r, kind) {
  q.insertUsage.run(user.id, aiCharId, roomId, model, r.prompt_tokens, r.completion_tokens, r.cost_usd, kind, now());
}

async function aiPost({ user, room, aiChar, instruction, postSeq }) {
  checkLimit(user);
  const speaker = life.charInfo(life.keyOf('a', aiChar.id));
  life.arm(room, speaker, postSeq || 0);
  const { system, history } = buildContext(room, aiChar, instruction);
  const r = await callOpenRouter({
    model: aiChar.model, system,
    userContent: history || '(сцена только начинается — открой её)',
    temperature: aiChar.temperature, max_tokens: aiChar.max_tokens,
  });
  logUsage(user, aiChar.id, room.id, aiChar.model, r, 'post');
  return r.text;
}

async function chronicle({ user, room }) {
  checkLimit(user);
  const model = getSetting('chronicle_model', 'anthropic/claude-haiku-5.5');
  const names = nameMaps();
  const posts = q.lastPosts.all(room.id, 120).reverse();
  const history = posts.map(p => renderPost(p, names)).join('\n\n');
  const prev = room.chronicle ? `# Прежняя хроника\n${room.chronicle}\n\n` : '';
  const system = `Ты — летописец ролевой игры. Веди хронику локации «${room.title}»: сжатая хронология событий по пунктам (кто, что, когда по внутриигровому времени, важные решения и состояния персонажей). Пиши по-русски, только факты из постов, без воды. Если дана прежняя хроника — обнови её: объедини с новыми событиями, не теряя старых ключевых фактов. Ответ — только текст хроники.`;
  const r = await callOpenRouter({ model, system, userContent: `${prev}# Посты\n${history || '(постов нет)'}`, temperature: 0.3, max_tokens: 1500 });
  logUsage(user, null, room.id, model, r, 'chronicle');
  return r.text;
}

// ───────────── Летописец Life: после каждого поста ─────────────

const queues = new Map(); // world_id → Promise — по очереди, чтобы не было гонок
function enqueue(worldId, fn) {
  const prev = queues.get(worldId) || Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  queues.set(worldId, next.catch(() => {}));
  return next;
}

function chronEnabled(room) {
  if (room.chron_on === 1) return true;
  if (room.chron_on === 0) return false;
  return room.kind === 'forum';
}

async function runLifeChron({ user, post }) {
  const room = q.roomById.get(post.room_id);
  if (!room) return null;
  checkLimit(user);
  const cast0 = life.castOf(room);
  life.numberLists(room.world_id, cast0);
  const { text, cast } = life.chronInput(room, post);
  const model = lifeModel();
  const r = await callOpenRouter({ model, system: life.CHRON_SYSTEM, userContent: text, temperature: 0.2, max_tokens: 1400 });
  logUsage(user, null, room.id, model, r, 'life');
  const j = life.parseJson(r.text);
  if (!j) throw new Error('Летописец вернул не JSON');
  const fresh = q.roomById.get(room.id);
  const snap = life.snapshot(fresh, cast);
  const res = life.apply(fresh, post, j, cast);
  const rec = { chips: res.chips, at: now(), cost: r.cost_usd, snap };
  q.setPostChron.run(JSON.stringify(rec), post.id);
  return { chips: res.chips, room_id: room.id, world_id: room.world_id, post_id: post.id, new_day: life.newDay(room.world_id) };
}

function queueLifeChron({ user, post, force = false }) {
  const room = q.roomById.get(post.room_id);
  if (!room || post.is_ooc || (!post.persona_id && !post.ai_char_id)) return Promise.resolve(null);
  if (!force && !chronEnabled(room)) return Promise.resolve(null);
  return enqueue(room.world_id, () => runLifeChron({ user, post: q.postById.get(post.id) || post }));
}

function undoLifeChron(post) {
  const room = q.roomById.get(post.room_id);
  const rec = life.json(post.chron, null);
  if (!room || !rec?.snap) { const e = new Error('Нечего откатывать'); e.status = 400; throw e; }
  const last = q.latestChronInWorld.get(room.world_id);
  if (last && last.id !== post.id) { const e = new Error('Откатить можно только последнюю запись Летописца в этом мире'); e.status = 409; throw e; }
  life.restore(room, rec.snap);
  q.setPostChron.run('', post.id);
}

// ───────────── «Заполнить по карточке» ─────────────

const FILL_SYSTEM = `Ты помогаешь оживить персонажа ролевой истории на русском: чтобы у него была своя жизнь, а не только реакции на игрока.
По карточке ответь только JSON:
{"fem":false,"metab":1,"hobbies":[],"turnons":[],"likes":[],"dislikes":[],"romance":{"level":"off|some|lots","rel":"с кем и кто они друг другу, коротко","style":"как именно он ухаживает, 8–20 слов"},"thoughts":[{"t":"что его тяготит, 6–14 слов","w":1}],"wants":[{"t":"его собственное желание не про игроков, 6–14 слов","with":""}],"card":{"age":"","look":"внешность коротко","traits":"характер коротко"}}
fem — женщина ли; metab — 1 обычный, 1.5 быстрый, 2 суперсолдат. hobbies — 3–6 увлечений; turnons — 3–6 вещей, что его заводит; likes/dislikes — по 3–6 вкусов (еда, музыка, привычки). w — вес мысли 1–3. Только то, что следует из карточки, без выдумок про сюжет.`;

// Для игроков — только разложить по полочкам то, что они сами написали. Ничего не придумывать.
const FILL_PLAYER = `Ты раскладываешь анкету персонажа живого игрока по полям. Ничего не придумывай и не додумывай: только то, что прямо написано.
Ответь только JSON:
{"fem":false,"hobbies":[],"likes":[],"dislikes":[],"facts":[],"card":{"age":"","look":"","traits":"","story":""}}
fem — женщина ли (по тексту). hobbies, likes, dislikes — только названные в тексте. facts — до 6 важных фактов о нём из текста, 4–14 слов каждый. card — возраст, внешность, характер, история коротко своими словами из текста. Чего нет в тексте — пусто.`;

async function fillFromCard({ user, key, worldId }) {
  checkLimit(user);
  const c = life.charInfo(key);
  if (!c) { const e = new Error('Нет персонажа'); e.status = 404; throw e; }
  const src = c.ai ? (q.aiCharById.get(c.id)?.system_prompt || '') : c.bio;
  if (!c.ai) return fillPlayer({ user, c });
  const r = await callOpenRouter({ model: lifeModel(), system: FILL_SYSTEM, userContent: `Персонаж: ${c.name}\n\n${life.cut(src, 12000)}`, temperature: 0.4, max_tokens: 1200 });
  logUsage(user, c.ai ? c.id : null, null, lifeModel(), r, 'life');
  const j = life.parseJson(r.text);
  if (!j) { const e = new Error('Модель вернула не JSON'); e.status = 502; throw e; }
  const p = life.prof(key);
  if (typeof j.fem === 'boolean') p.fem = j.fem;
  if ([1, 1.5, 2].includes(Number(j.metab))) p.metab = Number(j.metab);
  for (const f of ['hobbies', 'turnons', 'likes', 'dislikes']) if (Array.isArray(j[f]) && j[f].length) p[f] = [...new Set([...p[f], ...j[f].map(s => life.cut(s, 40))])].slice(-20);
  if (j.romance && typeof j.romance === 'object') p.romance = { level: ['off', 'some', 'lots'].includes(j.romance.level) ? j.romance.level : p.romance.level, rel: life.cut(j.romance.rel || p.romance.rel, 80), style: life.cut(j.romance.style || p.romance.style, 200) };
  if (j.card && typeof j.card === 'object') for (const f of ['age', 'look', 'traits']) if (j.card[f] && !p.card[f]) p.card[f] = life.cut(j.card[f], 300);
  life.saveProf(key, p);
  if (worldId) {
    const x = life.state(worldId, key);
    for (const t of Array.isArray(j.thoughts) ? j.thoughts : []) if (t?.t) x.thoughts.push({ id: life.uid(), t: life.cut(t.t, 120), w: Math.max(1, Math.min(3, Number(t.w) || 1)), status: 'on', by: 'fill' });
    for (const t of Array.isArray(j.wants) ? j.wants : []) if (t?.t) x.wants.push({ id: life.uid(), t: life.cut(t.t, 120), with: life.cut(t.with || '', 40), status: 'on', by: 'fill' });
    life.saveState(worldId, key, x);
  }
  return p;
}

async function fillPlayer({ user, c }) {
  if (!String(c.bio || '').trim()) { const e = new Error('Сначала напиши «Кто это» — заполняю только по твоему тексту'); e.status = 400; throw e; }
  const r = await callOpenRouter({ model: lifeModel(), system: FILL_PLAYER, userContent: `Персонаж: ${c.name}\n\n${life.cut(c.bio, 12000)}`, temperature: 0.2, max_tokens: 900 });
  logUsage(user, null, null, lifeModel(), r, 'life');
  const j = life.parseJson(r.text);
  if (!j) { const e = new Error('Модель вернула не JSON'); e.status = 502; throw e; }
  const p = life.prof(c.key);
  if (typeof j.fem === 'boolean') p.fem = j.fem;
  for (const f of ['hobbies', 'likes', 'dislikes', 'facts']) if (Array.isArray(j[f]) && j[f].length) p[f] = [...new Set([...p[f], ...j[f].map(s => life.cut(s, f === 'facts' ? 120 : 40))])].slice(-20);
  if (j.card && typeof j.card === 'object') for (const f of ['age', 'look', 'traits', 'story']) if (j.card[f] && !p.card[f]) p.card[f] = life.cut(j.card[f], f === 'story' ? 1200 : 300);
  life.saveProf(c.key, p);
  return p;
}

// ───────────── картинки (Nano Banana через OpenRouter) ─────────────

function refToDataUrl(url) {
  const m = /^\/uploads\/([\w.-]+)$/.exec(String(url || ''));
  if (!m) return null;
  const full = path.join(UPLOADS_DIR, m[1]);
  if (!fs.existsSync(full)) return null;
  const ext = path.extname(full).slice(1).toLowerCase();
  const mime = ext === 'jpg' ? 'jpeg' : ext;
  return `data:image/${mime};base64,${fs.readFileSync(full).toString('base64')}`;
}

function extractImage(msg) {
  const imgs = msg?.images || [];
  for (const im of imgs) { const u = im?.image_url?.url || im?.url; if (u) return u; }
  if (Array.isArray(msg?.content)) for (const part of msg.content) { const u = part?.image_url?.url; if (u) return u; }
  const m = /data:image\/[a-z]+;base64,[A-Za-z0-9+/=]+/.exec(typeof msg?.content === 'string' ? msg.content : '');
  return m ? m[0] : null;
}

async function draw({ user, prompt, aspect = '1:1', refs = [], worldId = null }) {
  checkLimit(user);
  const style = (worldId && q.worldById.get(worldId)?.art_style) || getSetting('art_style', DEFAULT_ART);
  const content = [{ type: 'text', text: `${prompt}\n\nStyle: ${style}. Aspect ratio ${aspect}. No text, no watermark, no captions.${refs.length ? ' Keep the faces and looks of the people exactly as in the reference images.' : ''}` }];
  for (const u of refs.slice(0, 4)) { const d = refToDataUrl(u); if (d) content.push({ type: 'image_url', image_url: { url: d } }); }
  const model = imageModel();
  const r = await callOpenRouter({ model, userContent: content, extra: { modalities: ['image', 'text'], image_config: { aspect_ratio: aspect } } });
  logUsage(user, null, null, model, r, 'image');
  const dataUrl = extractImage(r.msg);
  if (!dataUrl) { const e = new Error(r.text ? `Картинки нет, модель ответила: ${life.cut(r.text, 160)}` : 'Модель не вернула картинку'); e.status = 502; throw e; }
  const m = /^data:image\/(png|jpe?g|webp);base64,(.+)$/.exec(dataUrl);
  let buf, ext;
  if (m) { buf = Buffer.from(m[2], 'base64'); ext = m[1] === 'jpeg' ? 'jpg' : m[1]; }
  else {
    const res = await fetch(dataUrl); buf = Buffer.from(await res.arrayBuffer());
    ext = (res.headers.get('content-type') || '').includes('png') ? 'png' : 'jpg';
  }
  const name = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${ext}`;
  fs.writeFileSync(path.join(UPLOADS_DIR, name), buf);
  return `/uploads/${name}`;
}

// ───────────── новости и слухи мира ─────────────

const rumorBusy = new Set();
async function makeRumors({ user, worldId }) {
  if (rumorBusy.has(worldId)) { const e = new Error('Слухи уже собираются'); e.status = 409; throw e; }
  checkLimit(user);
  rumorBusy.add(worldId);
  try {
    const model = lifeModel();
    const r = await callOpenRouter({ model, system: life.RUMORS_SYSTEM, userContent: life.rumorsInput(worldId), temperature: 0.8, max_tokens: 1600 });
    logUsage(user, null, null, model, r, 'life');
    return life.saveRumors(worldId, life.parseJson(r.text));
  } finally { rumorBusy.delete(worldId); }
}

// ───────────── кат-сцена: 3 кадра по посту ─────────────

async function makeCut({ user, post, onStep }) {
  const room = q.roomById.get(post.room_id);
  if (!room) { const e = new Error('Нет комнаты'); e.status = 404; throw e; }
  checkLimit(user);
  const { text, cast } = life.cutInput(room, post);
  const model = lifeModel();
  const r = await callOpenRouter({ model, system: life.CUT_SYSTEM, userContent: text, temperature: 0.5, max_tokens: 1600 });
  logUsage(user, null, room.id, model, r, 'life');
  const j = life.parseJson(r.text);
  const frames = (j?.frames || []).filter(f => f?.prompt).slice(0, 3);
  if (!frames.length) { const e = new Error('Раскадровка не вышла'); e.status = 502; throw e; }
  const map = life.namesMap(cast);
  const cutObj = { id: life.uid(), post_id: post.id, room_id: room.id, title: life.cut(j.title || 'Кат-сцена', 40), at: now(), by: user.id, frames: [] };
  for (let k = 0; k < frames.length; k++) {
    onStep?.(k + 1, frames.length);
    const f = frames[k];
    const refs = (Array.isArray(f.who) ? f.who : []).map(n => life.findC(map, n)?.avatar).filter(u => u && u.startsWith('/uploads/')).slice(0, 2);
    const img = await draw({ user, prompt: `${f.prompt}\nCinematic 16:9 film still, shallow depth of field, no letterbox.`, aspect: '16:9', refs, worldId: room.world_id });
    cutObj.frames.push({ title: life.cut(f.title || '', 30), caption: life.cut(f.caption || '', 120), img });
  }
  const d = life.wl(room.world_id);
  d.cuts = [...d.cuts.filter(c => c.post_id !== post.id), cutObj].slice(-60);
  life.saveWl(room.world_id, d);
  return cutObj;
}

module.exports = {
  aiPost, chronicle, spentToday, dailyLimitFor, checkLimit,
  queueLifeChron, undoLifeChron, chronEnabled, fillFromCard, draw, DEFAULT_ART, makeRumors, makeCut,
};
