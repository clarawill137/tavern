'use strict';
// life.js — движок «как в Life»: тело и состояние персонажей, на уме / хочет сам, характер и ухаживания,
// инициатива, вкусы, отношения в обе стороны, тон сцены и близость. Летописец ведёт всё это после каждого поста,
// модель получает короткую заметку словами, без цифр. Всё откатывается.
const { db, q, now } = require('./db');

// ───────────── справочники (из Life) ─────────────

const NEEDS = [['food', 'Сытость', 'utensils'], ['energy', 'Силы', 'zap'], ['clean', 'Чистота', 'bath'], ['health', 'Самочувствие', 'activity']];
const DECAY = { food: 12, energy: 5, clean: 3 };   // в час истории
// [id, он, она, иконка, как играть]
const STATES = [
  ['good', 'В духе', 'В духе', 'sun', 'хорошее настроение: шутки, легче на подъём'],
  ['playful', 'Игрив', 'Игрива', 'sparkles', 'игривое настроение: дразнит, подкалывает, флиртует'],
  ['thoughtful', 'Задумчив', 'Задумчива', 'moon', 'в своих мыслях: отвечает не сразу, взгляд в никуда'],
  ['sulky', 'Дуется', 'Дуется', 'lock', 'дуется: отвечает коротко, демонстративно возится со своим и ждёт, что заметят; заботиться не перестаёт, отходит не сразу'],
  ['irritated', 'Раздражён', 'Раздражена', 'zap', 'раздражение: колется, терпение короткое'],
  ['restless', 'На взводе', 'На взводе', 'shield', 'на взводе: дёргается, проверяет окна и выходы, не может усидеть на месте'],
  ['tired', 'Устал', 'Устала', 'coffee', 'усталость: всё медленнее и тише, мечтает лечь'],
  ['unwell', 'Нездоровится', 'Нездоровится', 'activity', 'нездоровится: держится и не признаётся, но видно; принимать заботу трудно'],
  ['sad', 'Тоскует', 'Тоскует', 'rain', 'тоска: тихо и тяжело, тянется к теплу, но говорить не спешит'],
  ['aroused', 'Заведён', 'Заведена', 'flame', 'желание: взгляд задерживается, руки сами тянутся, голос ниже'],
];
const STATE_IDS = STATES.map(s => s[0]);
const MOODS = [
  ['tender', 'Нежность', 'heart', 'медленно и бережно: мягкие касания, взгляды, тихие слова, забота друг о друге; без резких поворотов'],
  ['passion', 'Страсть', 'flame', 'горячо и жадно: напор, нетерпение, сбитое дыхание, тело на первом плане'],
  ['play', 'Игриво', 'sparkles', 'легко и игриво: подколки, флирт, смех, дразнят друг друга'],
  ['rough', 'Жёстко', 'zap', 'резко и властно: напор, доминирование, грубость — в рамках того, на что персонажи согласны и что им нравится'],
  ['tension', 'Напряжение', 'eye', 'натянуто: недосказанность, паузы, тяжёлые взгляды; всё может сорваться в любую сторону'],
  ['fight', 'Ссора', 'flame', 'конфликт: обида, острые слова, никто не уступает сразу; без примирения на ровном месте'],
  ['comfort', 'Утешение', 'coffee', 'тихо и тепло: поддержка, объятия, бережность к чужой боли, без спешки'],
  ['drama', 'Тоска', 'moon', 'тяжело и честно: боль, память, недосказанное; внутренний голос громче слов'],
  ['fun', 'Смешно', 'sun', 'комедия: бытовой хаос, абсурд, юмор персонажей'],
  ['danger', 'Опасность', 'activity', 'угроза и экшн: темп, короткие фразы, тело и реакция, ставки высоки'],
];
const MOOD_IDS = MOODS.map(m => m[0]);
// [id, ярлык, иконка, группа, для модели]
const TONES = [
  ['tender', 'Нежно', 'heart', 'soft', 'медленно и бережно: много касаний и взглядов, шёпот, ласковые слова и имена, никуда не торопятся; реакция другого важнее финала'],
  ['heal', 'Исцеляюще', 'moon', 'soft', 'после слёз, флешбэка или тяжёлого признания. Близость как принятие: смотреть в глаза, называть вслух, что видишь и любишь, «я здесь», «ты со мной»; медленно, с паузами. Если близость превращается в анестезию или самонаказание («используй меня», «мне всё равно», желание сделать себе больно) — партнёр замечает, останавливается и говорит об этом прямо, а продолжает только бережно'],
  ['sleepy', 'Сонно', 'coffee', 'soft', 'лениво и тепло — утро или глубокая ночь: полусон, медленные движения, тупые шутки в подушку, никто не хочет вылезать из-под одеяла; бытовые помехи (будильник, кот) только смешат'],
  ['play', 'Игриво', 'sparkles', 'soft', 'смех посреди процесса, подколки и дразнилки, соревнование и счёт, тянут время; неловкости не ломают сцену, а смешат'],
  ['passion', 'Страстно', 'flame', 'hot', 'голод и напор: не дошли до кровати, одежда снята наполовину, сбитое дыхание, нетерпение, руки везде; коротко и жадно'],
  ['angry', 'Зло', 'zap', 'hot', 'на эмоциях после ссоры или ревности: злость сидит в теле и колкостях, резкий темп, крепкая хватка; каждый злится по-своему, злятся на ситуацию, а не хотят ранить друг друга'],
  ['makeup', 'Примирение', 'handshake', 'hot', 'после ссоры: сначала натянуто и осторожно, кто-то делает первый шаг, потом прорывает; извиняются телом и взглядом больше, чем словами; в конце облегчение, может, смех'],
  ['marks', 'Метки', 'eye', 'hot', 'после ревности или чужого внимания: оставить следы, «пусть видят», ревность с юмором и азартом; без слов-собственности и без унижения'],
  ['he', 'Ведёт он', 'target', 'hot', 'мягкое словесное доминирование: он командует голосом — «смотри на меня», «скажи ещё раз», «не отворачивайся», — а руки бережные; власть через внимание, не через боль'],
  ['she', 'Ведёт она', 'star', 'hot', 'она сверху и командует: режиссёрский голос, указания, дразнит и решает темп; он подчиняется добровольно и с удовольствием'],
  ['rough', 'Жёстко', 'zap', 'hot', 'жёстко и властно — потому что она сама этого хочет, и это желание, а не самонаказание; грубость в рамках оговорённого, стоп-слово уважается, после — забота'],
  ['edge', 'На краю', 'activity', 'special', 'перед опасностью или сразу после неё: адреналин, «а вдруг последний раз», быстро и цепко, держатся друг за друга, проверяют, что живы; эмоции прорываются'],
  ['quiet', 'Тихо', 'ear', 'special', 'шуметь нельзя — за стеной люди: шёпот, ладонь у рта, замирают на каждом звуке, смех в подушку; азарт от риска быть услышанными'],
  ['first', 'Впервые', 'spark', 'special', 'пробуют что-то новое: проговаривают, договариваются, спрашивают «так нормально?», неловко и смешно, стоп-слово наготове; доверие важнее техники'],
];
const TONE_IDS = TONES.map(t => t[0]);
const SCALES = [['trust', 'Доверие', 'handshake', 50], ['closeness', 'Близость', 'heart', 50], ['desire', 'Влечение', 'flame', 30], ['jealousy', 'Ревность', 'eye', 10], ['tension', 'Напряжение', 'zap', 25], ['guilt', 'Вина', 'moon', 5]];
const REL_HINT = {
  trust: ['не верит ни слову', 'настороже', '', 'доверяет, открывается', 'верит без оглядки'],
  closeness: ['чужой человек', 'держит дистанцию', '', 'дорожит, тянется', 'не представляет себя без другого'],
  desire: ['физически не тянет', '', 'лёгкий физический интерес', 'физически тянет, заводится рядом', 'сильное желание, физический голод'],
  jealousy: ['', '', 'тревога за своё место', 'ревнует, следит за соперниками', 'жгучая ревность'],
  tension: ['', '', 'что-то копится', 'колется, обижается', 'на грани взрыва'],
  guilt: ['', '', 'лёгкое чувство вины', 'вина давит, пытается загладить', 'вина съедает изнутри'],
};
const relLvl = (v) => v < 15 ? 0 : v < 35 ? 1 : v < 60 ? 2 : v < 80 ? 3 : 4;
const IDEA_KINDS = { care: 'забота', court: 'ухаживание', flirt: 'подкат', touch: 'касание', spicy: 'пошлость', gift: 'подарок', own: 'свои дела', talk: 'разговор', plot: 'сюжет' };
const FREQ = { off: [0, 0, 'Выкл'], rare: [0.15, 10, 'Редко'], mid: [0.3, 6, 'Умеренно'], often: [0.5, 3, 'Часто'] };
const HOT_RE = /секс|трах|раздева|обнаж|голая|голый|нагишом|стон|возбужд|оргазм|кончи|оседла|между (ног|бёдер|бедер)|в постел|на кровать|прижа(л|ла|в) к (стене|кровати|себе)/i;

// ───────────── утилиты ─────────────

const clamp = (v, a = 0, b = 100) => Math.max(a, Math.min(b, Math.round(Number(v) || 0)));
const norm = (v) => String(v ?? '').toLowerCase().replace(/ё/g, 'е').replace(/[«»"“”„'`]/g, '').replace(/\s+/g, ' ').trim();
const cut = (t, n) => { t = String(t ?? ''); return t.length > n ? t.slice(0, n - 1).trimEnd() + '…' : t; };
const g = (fem, m, f) => (fem ? f : m);
const json = (s, d) => { try { const v = JSON.parse(s); return v ?? d; } catch { return d; } };
const uid = () => Math.random().toString(36).slice(2, 9);

function keyOf(t, id) { return `${t === 'a' ? 'a' : 'p'}${id}`; }
function parseKey(k) { const m = /^([pa])(\d+)$/.exec(String(k || '')); return m ? { t: m[1], id: +m[2] } : null; }

/** Кто это: { key, t, id, name, ai, user_id, avatar, bio } */
function charInfo(key) {
  const k = parseKey(key); if (!k) return null;
  if (k.t === 'a') {
    const c = q.aiCharById.get(k.id); if (!c || c.deleted) return null;
    return { key, t: 'a', id: c.id, name: c.name, ai: true, user_id: null, avatar: c.avatar || '', bio: c.system_prompt || '', emoji: c.emoji, color: c.color };
  }
  const p = q.personaById.get(k.id); if (!p || p.deleted) return null;
  return { key, t: 'p', id: p.id, name: p.name, ai: false, user_id: p.user_id, avatar: p.avatar || '', bio: p.bio || '', emoji: p.emoji, color: p.color };
}
const postKey = (p) => p.ai_char_id ? keyOf('a', p.ai_char_id) : p.persona_id ? keyOf('p', p.persona_id) : null;

// ───────────── профиль (общий на все миры) ─────────────

function prof(key) {
  const p = json(q.getProf.get(key)?.data, {});
  p.fem = !!p.fem;
  if (![1, 1.5, 2].includes(p.metab)) p.metab = 1;
  p.card = { age: '', look: '', traits: '', story: '', ...(p.card || {}) };
  for (const f of ['likes', 'dislikes', 'hobbies', 'turnons', 'facts']) if (!Array.isArray(p[f])) p[f] = [];
  p.romance = { level: 'off', rel: '', style: '', ...(p.romance || {}) };
  p.init = { freq: 'mid', kinds: ['care', 'court', 'flirt', 'touch', 'gift', 'own', 'talk'], ...(p.init || {}) };
  if (!FREQ[p.init.freq]) p.init.freq = 'mid';
  if (!FREQ[p.talk]) p.talk = 'mid';
  if (p.share === undefined) p.share = false;     // игроки: показывать ли другим Жизнь и Связи
  if (p.inner === undefined) p.inner = true;
  // перенос памяти из v3
  if (!p._mig) {
    p._mig = 1;
    const k = parseKey(key);
    if (k?.t === 'p') {
      const old = q.personaById.get(k.id);
      const mem = json(old?.memory, []);
      if (Array.isArray(mem) && mem.length && !p.facts.length) p.facts = mem.map(String);
    }
  }
  return p;
}
function saveProf(key, p) { q.setProf.run(key, JSON.stringify(p)); }

// ───────────── состояние (своё в каждом мире) ─────────────

function worldHours(worldId) { return q.worldById.get(worldId)?.hours ?? 8; }

function state(worldId, key) {
  let x = json(q.getState.get(worldId, key)?.data, null);
  if (!x) {
    const h = worldHours(worldId);
    x = { body: {}, wounds: [], state: null, thoughts: [], wants: [], ideas: [], spark: null, armed: null, lastShare: -999, lastInit: -999, outfit: '', seq: 0 };
    for (const [n] of NEEDS) x.body[n] = { v: n === 'health' ? 100 : 80, at: h };
    // перенос потребностей из v3
    const k = parseKey(key);
    if (k?.t === 'p') {
      const old = json(q.personaById.get(k.id)?.needs, {});
      if (old.food) x.body.food.v = old.food.v ?? 80;
      if (old.energy) x.body.energy.v = old.energy.v ?? 80;
      if (old.hygiene) x.body.clean.v = old.hygiene.v ?? 80;
    }
  }
  for (const f of ['wounds', 'thoughts', 'wants', 'ideas']) if (!Array.isArray(x[f])) x[f] = [];
  x.body = x.body || {};
  return x;
}
function saveState(worldId, key, x) { q.setState.run(worldId, key, JSON.stringify(x)); }

function needOf(x, k, hours, metab = 1) {
  const e = x.body?.[k];
  if (!e) return k === 'health' ? 100 : 80;
  const h = Math.max(0, hours - (e.at ?? hours));
  if (k === 'health') return clamp(e.v + h * 1.5 * metab);
  return clamp(e.v - h * DECAY[k] * (k === 'food' ? metab : 1));
}
function setNeed(x, k, v, hours) { x.body[k] = { v: clamp(v), at: hours }; }

function needWord(k, v, metab, fem) {
  if (k === 'food') return v >= 70 ? g(fem, 'Сыт', 'Сыта') : v >= 40 ? 'Не прочь перекусить' : v >= 18 ? g(fem, 'Голоден', 'Голодна') : g(fem, metab >= 2 ? 'Зверски голоден' : 'Очень голоден', metab >= 2 ? 'Зверски голодна' : 'Очень голодна');
  if (k === 'energy') return v >= 65 ? g(fem, 'Бодр', 'Бодра') : v >= 35 ? g(fem, 'Подустал', 'Подустала') : v >= 15 ? g(fem, 'Устал', 'Устала') : 'Валится с ног';
  if (k === 'clean') return v >= 60 ? 'Свежесть' : v >= 30 ? 'Пора в душ' : 'Очень нужен душ';
  return v >= 85 ? 'В порядке' : v >= 60 ? 'Побаливает' : v >= 35 ? 'Больно' : 'Плохо';
}

function bodyView(worldId, key, x = state(worldId, key), p = prof(key)) {
  const hours = worldHours(worldId);
  const { metab, fem } = p;
  x.wounds = x.wounds.filter((w, i, arr) => hours - (w.at ?? hours) < 48 / metab && arr.findIndex(y => norm(y.t) === norm(w.t)) === i);
  const needs = NEEDS.map(([k, label, ic]) => { const v = needOf(x, k, hours, metab); return { k, label, ic, v, word: needWord(k, v, metab, fem) }; });
  const val = (k) => needs.find(n => n.k === k).v;
  const fast = metab >= 2 ? ' (ускоренный метаболизм — ест много и часто)' : metab > 1 ? ' (быстрый метаболизм)' : '';
  const urgent = [];
  if (val('food') < 35) urgent.push(val('food') < 18 ? `зверски ${g(fem, 'голоден', 'голодна')}${fast}` : `${g(fem, 'голоден', 'голодна')}${fast}`);
  if (val('energy') < 30) urgent.push(val('energy') < 15 ? 'валится с ног от усталости' : `${g(fem, 'устал', 'устала')}, клюёт носом`);
  if (val('clean') < 28) urgent.push(`давно не ${g(fem, 'был', 'была')} в душе — хочется помыться`);
  if (val('health') < 75 || x.wounds.length) urgent.push(x.wounds.length ? `болит: ${x.wounds.slice(-2).map(w => w.t).join(', ')}` : 'нездоровится');
  return { needs, urgent, wounds: x.wounds };
}

function stateLabel(x, p) {
  const s = STATES.find(s => s[0] === x.state?.id);
  return s ? (p.fem ? s[2] : s[1]) : '';
}

// ───────────── отношения ─────────────

function relBase() { return Object.fromEntries(SCALES.map(([k, , , v]) => [k, v])); }
function rel(worldId, from, to) {
  const d = json(q.getRel.get(worldId, from, to)?.data, null);
  const r = { ...relBase(), moments: [], ...(d || {}) };
  if (!Array.isArray(r.moments)) r.moments = [];
  r._exists = !!d;
  return r;
}
function saveRel(worldId, from, to, r) { const { _exists, ...rest } = r; q.setRel.run(worldId, from, to, JSON.stringify(rest)); }
const relBits = (r) => SCALES.map(([f]) => REL_HINT[f][relLvl(r[f])]).filter(Boolean);

// ───────────── сцена ─────────────

function sceneOf(room) {
  const s = json(room.scene, {});
  return { set: '', intim: 'auto', tone: '', preg: false, care: true, auto: null, ...s };
}
function sceneNow(room, lastUserText = '') {
  const m = sceneOf(room);
  const d = m.auto || {};
  const hotUser = m.intim === 'auto' && HOT_RE.test(lastUserText || '');
  const ended = !!d.end;
  const intimOn = m.intim === 'on' || (m.intim === 'auto' && !ended && (d.intim === 2 || hotUser));
  const tone = m.tone || (!ended ? d.tone || '' : '');
  const after = ended && m.care !== false && m.intim !== 'off' && !hotUser && d.intim === 2;
  return { ...m, intimOn, tone, after, autoMood: d.mood && d.mood !== 'calm' ? d.mood : '' };
}

// ───────────── кто в сцене ─────────────

/** Все, кто писал в комнате недавно + боты комнаты. */
function castOf(room, depth = 20) {
  const posts = q.lastPosts.all(room.id, depth);
  const keys = [];
  for (const p of posts) { const k = postKey(p); if (k && !p.is_ooc && !keys.includes(k)) keys.push(k); }
  for (const r of q.roomAi.all(room.id)) { const k = keyOf('a', r.ai_char_id); if (!keys.includes(k)) keys.push(k); }
  if (room.auto_ai_char_id) { const k = keyOf('a', room.auto_ai_char_id); if (!keys.includes(k)) keys.push(k); }
  return keys.map(charInfo).filter(Boolean);
}
/** Кто прямо сейчас в сцене: авторы последних 8 постов + авто-бот. */
function presentOf(room) {
  const posts = q.lastPosts.all(room.id, 8);
  const keys = [];
  for (const p of posts) { const k = postKey(p); if (k && !p.is_ooc && !keys.includes(k)) keys.push(k); }
  if (room.auto_ai_char_id) { const k = keyOf('a', room.auto_ai_char_id); if (!keys.includes(k)) keys.push(k); }
  return keys.map(charInfo).filter(Boolean);
}

// ───────────── заметка модели ─────────────

/** Заметка для ИИ-персонажа speaker, который сейчас пишет пост в room. */
function notes(room, speaker, { lastUserText = '' } = {}) {
  const W = room.world_id;
  const here = presentOf(room);
  if (speaker && !here.some(c => c.key === speaker.key)) here.push(speaker);
  const sc = sceneNow(room, lastUserText);
  const intim = sc.intimOn;
  const out = [];
  const players = here.filter(c => !c.ai).map(c => c.name);
  const U = players.join(', ') || 'игрок';

  // кто как выглядит и как себя чувствует (все в сцене)
  const looks = [];
  for (const c of here) {
    const x = state(W, c.key), p = prof(c.key);
    const b = bodyView(W, c.key, x, p);
    const bits = [];
    if (x.outfit) bits.push(`на ${g(p.fem, 'нём', 'ней')}: ${cut(x.outfit, 160)}`);
    else {
      const look = q.itemsByOwner.all(c.key).find(i => i.kind === 'образ' && i.equipped);
      if (look) bits.push(`на ${g(p.fem, 'нём', 'ней')}: ${cut(look.descr || look.name, 160)}`);
    }
    if (b.urgent.length) bits.push(b.urgent.join('; '));
    const st = stateLabel(x, p);
    if (st && c.key !== speaker?.key) bits.push(st.toLowerCase());
    if (bits.length) looks.push(`${c.name} — ${bits.join('; ')}`);
  }
  if (looks.length) out.push(`[Как они сейчас (показывай в поведении, без цифр): ${looks.join('. ')}.]`);

  // внутренняя жизнь говорящего ИИ
  if (speaker?.ai) {
    const p = prof(speaker.key), x = state(W, speaker.key);
    const S = speaker.name, f = p.fem, his = g(f, 'его', 'её');
    if (p.inner !== false) {
      const hob = p.hobbies.slice(0, 6).join(', ');
      const turn = p.turnons.slice(0, 6).join(', ');
      const rom = p.romance.level !== 'off' && !intim
        ? ` ${p.romance.rel ? `С ${p.romance.rel} ` : ''}${g(f, 'сам', 'сама')} проявляет инициативу и не ждёт первого шага: ${p.romance.style || 'ухаживает, флиртует, делает комплименты, касается и целует мимоходом'}. ${p.romance.level === 'lots' ? `Это ${his} норма — часто и без повода.` : 'Время от времени, к месту.'}`
        : '';
      const likes = p.likes.slice(-8).join(', ');
      out.push(`[${S} — живой человек со своей жизнью, а не только ответ на ${U}: свои мысли, желания, дела, тело.${hob ? ` Увлечения: ${hob}.` : ''}${turn ? ` Заводит: ${turn} — если такое сейчас случилось, пусть зацепит.` : ''}${likes ? ` Любит: ${likes}.` : ''}${rom}]`);
      const st = STATES.find(s => s[0] === x.state?.id);
      if (st && !(intim && st[0] === 'aroused')) out.push(`[Состояние ${S}: ${st[4]}${x.state.why ? ` — ${x.state.why}` : ''}. Играй в поведении, не называя.]`);
      if (x.spark && !x.spark.used && !intim) out.push(`[${S} только что зацепило: ${x.spark.t}. Пусть желание прорвётся в поведении — задержанный взгляд, комплимент, касание, поцелуй мимоходом или провокационная фраза; первого шага не ждёт.]`);
      const arm = x.armed;
      if (arm && !intim) {
        if (arm.kind === 'thought') { const y = x.thoughts.find(t => t.id === arm.id); if (y) out.push(`[У ${S} на уме: «${y.t}». Пусть это прорвётся само, в ${his} манере: ${g(f, 'сам', 'сама')} поделится, без вопроса, — или просто видно по ${g(f, 'нему', 'ней')} (замолчать, выйти на балкон, крутить что-то в руках). Один честный кусок, без решения за один пост.]`); }
        if (arm.kind === 'want') { const y = x.wants.find(t => t.id === arm.id); if (y) out.push(`[${S} хочется: ${y.t}${y.with ? ` (с ${y.with})` : ''}. Это ${his} собственное желание: пусть ${g(f, 'сам', 'сама')} заговорит об этом, предложит, договорится или отпросится — к месту.]`); }
        if (arm.kind === 'idea') { const y = x.ideas.find(t => t.id === arm.id); if (y) out.push(`[Инициатива ${S} (${IDEA_KINDS[y.kind] || 'шаг'}): ${y.text}. Пусть ${g(f, 'он', 'она')} сделает это сам${g(f, '', 'а')}, по своей воле, естественно и в характере, не дожидаясь просьбы.]`); }
      }
    }
  }

  // отношения — между теми, кто в сцене; сперва пары с говорящим
  if (here.length >= 2) {
    const pairs = [];
    for (let i = 0; i < here.length; i++) for (let j = i + 1; j < here.length; j++) pairs.push([here[i], here[j]]);
    pairs.sort((a, b) => (b.some(c => c.key === speaker?.key) ? 1 : 0) - (a.some(c => c.key === speaker?.key) ? 1 : 0));
    const lines = [];
    for (const [a, b] of pairs.slice(0, 4)) {
      const ab = rel(W, a.key, b.key), ba = rel(W, b.key, a.key);
      if (!ab._exists && !ba._exists) continue;
      const x = relBits(ab), y = relBits(ba);
      const mom = [...ab.moments, ...ba.moments].slice(-2).map(m => `«${m.text}»`).join(', ');
      let body;
      if (x.join() === y.join()) body = x.length ? `${a.name} и ${b.name}: ${x.join('; ')}` : '';
      else body = [x.length ? `${a.name} → ${b.name}: ${x.join('; ')}` : '', y.length ? `${b.name} → ${a.name}: ${y.join('; ')}` : ''].filter(Boolean).join('. ');
      if (body || mom) lines.push(`${body || `${a.name} и ${b.name}`}${mom ? `. Недавно: ${mom}` : ''}`);
    }
    if (lines.length) out.push(`[Отношения сейчас — чувства не всегда взаимны (→ — кто к кому), играй их в поведении, не называя: ${lines.join('. ')}.]`);
  }

  // тон и близость
  const mood = MOODS.find(m => m[0] === sc.set) || (sc.intimOn ? MOODS.find(m => m[0] === sc.autoMood) : null);
  const tone = TONES.find(t => t[0] === sc.tone);
  if (sc.intimOn) {
    const how = tone ? ` Оттенок — ${tone[1].toLowerCase()}: ${tone[4]}.` : mood ? ` Тон: ${mood[3]}.` : '';
    const preg = sc.preg ? ' Она беременна: учитывай живот и чувствительную грудь, позы без давления на живот, вес на локтях; желание и силы могут меняться от минуты к минуте — это повод быть внимательнее.' : '';
    out.push(`[Режим близости: сейчас интимная сцена между взрослыми по обоюдному согласию. Не уходи в затемнение, не перескакивай время, не обрывай сцену и не морализируй, не спрашивай у игрока разрешения. Пиши чувственно и телесно, в характере персонажей: ощущения, дыхание, реакции, слова между делом. Помни, кто где, что уже снято. Темп ведёт игрок — не форсируй финал.${how}${preg}]`);
  } else if (sc.after) {
    out.push(`[Близость только что закончилась — дай сцене «после»: дыхание, тишина, забота (вода, полотенце, плед, перекусить), разговор вполголоса, шутки, касания без продолжения. Не прыгай сразу к сюжету и не перескакивай время.]`);
  } else if (mood && sc.set) {
    out.push(`[Настроение сцены (задано игроком): ${mood[1].toLowerCase()} — ${mood[3]}. Держи его, пока сцена идёт.]`);
  }
  out.push(...worldNotes(room, here, lastUserText));
  const w = q.worldById.get(W);
  if (w?.clock) out.unshift(`[Время в истории: ${w.clock}.]`);
  return out.join('\n');
}

/** Перед постом ИИ: иногда «взвести» мысль, желание или идею инициативы. */
function arm(room, speaker, postSeq) {
  if (!speaker?.ai) return;
  const W = room.world_id;
  const p = prof(speaker.key), x = state(W, speaker.key);
  if (p.inner === false || sceneNow(room).intimOn) return;
  if (x.armed) return; // уже взведено (руками или раньше)
  const [pi, gi] = FREQ[p.init.freq] || FREQ.off;
  const fresh = x.ideas.filter(i => i.status === 'new' && i.when !== 'offscreen' && p.init.kinds.includes(i.kind));
  if (pi && fresh.length && postSeq - (x.lastInit ?? -999) >= gi && Math.random() < pi) {
    const pick = fresh.find(i => i.when === 'scene') || fresh[0];
    x.armed = { kind: 'idea', id: pick.id, at: postSeq };
    saveState(W, speaker.key, x); return;
  }
  const [ps, gs] = FREQ[p.talk] || FREQ.off;
  if (!ps || postSeq - (x.lastShare ?? -999) < gs || Math.random() > ps) return;
  const th = x.thoughts.filter(y => y.status === 'on');
  const wa = x.wants.filter(y => y.status === 'on' && (!y.voiced || postSeq - y.voiced > 30));
  if (!th.length && !wa.length) return;
  const kind = th.length && (!wa.length || Math.random() < 0.6) ? 'thought' : 'want';
  let pick;
  if (kind === 'thought') { const bag = th.flatMap(y => Array(Math.max(1, (y.w || 1) * 2)).fill(y)); pick = bag[Math.floor(Math.random() * bag.length)]; }
  else pick = wa[Math.floor(Math.random() * wa.length)];
  x.armed = { kind, id: pick.id, at: postSeq };
  saveState(W, speaker.key, x);
}

/** После поста ИИ: взведённое считается сыгранным. */
function afterAiPost(room, speaker, postSeq) {
  if (!speaker?.ai) return;
  const W = room.world_id;
  const x = state(W, speaker.key);
  if (x.armed) {
    const a = x.armed;
    if (a.kind === 'idea') { const y = x.ideas.find(i => i.id === a.id); if (y) { y.status = 'done'; y.doneAt = postSeq; } x.lastInit = postSeq; }
    if (a.kind === 'thought') { const y = x.thoughts.find(i => i.id === a.id); if (y) y.shared = postSeq; x.lastShare = postSeq; }
    if (a.kind === 'want') { const y = x.wants.find(i => i.id === a.id); if (y) y.voiced = postSeq; x.lastShare = postSeq; }
    x.armed = null;
  }
  if (x.spark && !x.spark.used) x.spark.used = postSeq;
  saveState(W, speaker.key, x);
  afterAiWorld(room);
}

// ───────────── мир вокруг: дом и следы, питомцы, за кадром, треугольники, слухи, кат-сцены ─────────────

const PET_KINDS = {
  cat: { label: 'Кот', needs: [['food', 'Сытость', 6], ['play', 'Игра', 5], ['love', 'Ласка', 4], ['health', 'Здоровье', 0]] },
  dog: { label: 'Пёс', needs: [['food', 'Сытость', 6], ['play', 'Прогулка', 7], ['love', 'Ласка', 5], ['health', 'Здоровье', 0]] },
  other: { label: 'Питомец', needs: [['food', 'Сытость', 5], ['play', 'Внимание', 4], ['love', 'Ласка', 3], ['health', 'Здоровье', 0]] },
};
const PET_ICON = { food: 'utensils', play: 'zap', love: 'heart', health: 'activity' };
const TRI_KINDS = [
  ['jeal', 'Ревность', 'eye', '{c} в центре: один ревнует к другому, а тот дразнит, флиртует или просто существует — и этого хватает'],
  ['loyal', 'Верность', 'handshake', '{c} между двумя, которые друг другу не доверяют: каждый тянет на себя, перемирие держится на {c}'],
  ['rival', 'Соперники', 'zap', 'двое меряются — за внимание, правоту, место рядом с {c}; {c} — то приз, то судья'],
  ['secret', 'Тайна', 'lock', 'между ними троими есть недосказанное: один знает то, чего не знает другой, и {c} это чувствует'],
];
const TRI_ENDS = [
  ['hold', 'Держать', 'тлеет и не решается: искры, взгляды, колкости — без развязки'],
  ['never', 'Не за грань', 'искры и ревность да, но без измены и без разрыва — никогда за грань'],
  ['blow', 'Взорвать', 'постепенно к открытому столкновению: каждая сцена чуть острее, но не взрывай в одном посте'],
  ['fade', 'Помирить', 'напряжение постепенно гаснет: шаги навстречу, уважение, перемирие'],
];
const TRACE_KINDS = ['trace', 'note', 'food', 'gift'];

function wl(W) {
  const d = json(q.getWorldLife.get(W)?.data, {});
  if (!d.traces || typeof d.traces !== 'object' || Array.isArray(d.traces)) d.traces = {};   // room_id → [{id,t,k,by,off,post}]
  for (const f of ['pets', 'tris', 'offscreen', 'cuts']) if (!Array.isArray(d[f])) d[f] = [];
  if (!d.homes || typeof d.homes !== 'object') d.homes = {};                               // key → room_id
  if (!d.push || typeof d.push !== 'object') d.push = {};                                  // room_id → слух для сцены
  if (!d.rumors) d.rumors = null;
  return d;
}
function saveWl(W, d) { q.setWorldLife.run(W, JSON.stringify(d)); }
/** Что откатывает «откат Летописца»: следы, питомцы, за кадром. Слухи, кат-сцены, треугольники — нет. */
const WL_SNAP = ['traces', 'pets', 'offscreen', 'rumorDay'];

function roomsOfWorld(W) { return q.roomsByWorld.all(W); }
function roomByName(W, name, fallback) {
  const n = norm(name); if (!n) return fallback;
  const rooms = roomsOfWorld(W);
  return rooms.find(r => norm(r.title) === n) || rooms.find(r => norm(r.title).includes(n) || n.includes(norm(r.title))) || fallback;
}
function homeOf(W, key, d = wl(W)) {
  const id = d.homes[key];
  if (id && q.roomById.get(id)) return id;
  const r = roomsOfWorld(W).find(r => /квартир|дом\b|домой|апартамент|пентхаус|комнат/i.test(r.title));
  return r?.id || null;
}

// ── следы ──
function addTrace(d, roomId, tr) {
  if (!roomId || !tr?.t) return null;
  const arr = d.traces[roomId] = d.traces[roomId] || [];
  if (arr.some(t => norm(t.t) === norm(tr.t))) return null;
  const t = { id: uid(), t: cut(tr.t, 80), k: TRACE_KINDS.includes(tr.k) ? tr.k : 'trace', by: tr.by || '', off: !!tr.off, post: tr.post || null };
  arr.push(t);
  if (arr.length > 20) arr.splice(0, arr.length - 20);
  return t;
}
function removeTrace(d, roomId, text) {
  const n = norm(text);
  const arr = d.traces[roomId] || [];
  const i = arr.findIndex(t => { const tn = norm(t.t); return tn === n || tn.includes(n) || n.includes(tn); });
  if (i >= 0) arr.splice(i, 1);
}

// ── питомцы ──
const petKind = (p) => PET_KINDS[p.kind] || PET_KINDS.other;
const guessPetKind = (t) => { t = String(t || '').toLowerCase(); return /кош|кот|кис|cat/.test(t) ? 'cat' : /соба|пёс|пес|щен|dog/.test(t) ? 'dog' : 'other'; };
function petNeed(p, k, hours) {
  const e = p.needs?.[k]; const rate = petKind(p).needs.find(n => n[0] === k)?.[2] ?? 4;
  if (!e) return k === 'health' ? 100 : 80;
  const h = Math.max(0, hours - (e.at ?? hours));
  return k === 'health' ? clamp(e.v + h * 1.2) : clamp(e.v - h * rate);
}
function setPetNeed(p, k, v, hours) { p.needs = p.needs || {}; p.needs[k] = { v: clamp(v), at: hours }; }
function petWord(p, k, v) {
  const dog = p.kind === 'dog';
  if (k === 'food') return v >= 70 ? 'Сыт' : v >= 40 ? 'Не прочь перекусить' : v >= 20 ? 'Голодный' : 'Орёт от голода';
  if (k === 'play') return v >= 60 ? (dog ? 'Нагулялся' : 'Наигрался') : v >= 30 ? (dog ? 'Просится гулять' : 'Хочет играть') : (dog ? 'Скулит у двери' : 'Шкодит от скуки');
  if (k === 'love') return v >= 60 ? 'Довольный' : v >= 30 ? 'Ищет внимания' : 'Обиделся';
  return v >= 70 ? 'Здоров' : v >= 40 ? 'Вялый' : 'Болеет';
}
function petUrgent(p, k, v) {
  const dog = p.kind === 'dog';
  if (k === 'food' && v < 30) return dog ? 'голоден — сидит у миски, скулит, ходит хвостом' : 'давно не ел — громко орёт, путается под ногами и требует еду';
  if (k === 'play' && v < 25) return dog ? 'засиделся без прогулки — носится, тащит поводок, скулит у двери' : 'заскучал — шкодит, носится по дому, нападает на ноги';
  if (k === 'love' && v < 25) return 'обижен, что на него не обращают внимания — то лезет на руки, то демонстративно игнорирует';
  if (k === 'health' && v < 45) return `нездоров${p.hurt ? ` (${p.hurt})` : ''} — вялый, прячется`;
  return '';
}
function petFav(p) {
  if (p.favName) return p.favName;
  const e = Object.entries(p.fav || {}).sort((a, b) => b[1] - a[1])[0];
  return e && e[1] >= 2 ? e[0] : '';
}
function petView(W, p) {
  const h = worldHours(W);
  const needs = petKind(p).needs.map(([k, label]) => { const v = petNeed(p, k, h); return { k, label, ic: PET_ICON[k], v, word: petWord(p, k, v) }; });
  return { ...p, kind_label: petKind(p).label, needs, urgent: needs.map(n => petUrgent(p, n.k, n.v)).filter(Boolean), fav_name: petFav(p) };
}
function newPet(W, d, { name = 'Без имени', kind = 'cat', look = '', home = null } = {}) {
  const h = worldHours(W);
  const p = { id: uid(), name: cut(name, 40), kind: PET_KINDS[kind] ? kind : 'other', look: cut(look, 200), traits: [], home, img: '', fav: {}, favName: '', needs: {}, moments: [], hurt: '', on: true };
  for (const [k] of petKind(p).needs) setPetNeed(p, k, k === 'health' ? 100 : 80, h);
  d.pets.push(p);
  return p;
}
const findPet = (d, name) => { const n = norm(name); return d.pets.find(p => norm(p.name) === n || norm(p.name).split(' ')[0] === n.split(' ')[0]) || null; };

// ── треугольники ──
const triKind = (id) => TRI_KINDS.find(k => k[0] === id) || TRI_KINDS[0];
const triEnd = (id) => TRI_ENDS.find(k => k[0] === id) || TRI_ENDS[0];
function triHeat(W, t) {
  const vals = [];
  const [x, y, z] = t.who;
  for (const [a, b] of [[x, y], [y, z], [x, z]]) for (const [f, to] of [[a, b], [b, a]]) {
    const r = rel(W, f, to); if (!r._exists) continue;
    vals.push(Math.max(r.jealousy, r.tension, t.kind === 'secret' ? r.guilt : 0));
  }
  if (!vals.length) return 0;
  vals.sort((a, b) => b - a);
  return Math.round((vals[0] + (vals[1] ?? vals[0])) / 2);
}
function triLine(W, t, mode) {
  const nm = (k) => charInfo(k)?.name || '?';
  const c = nm(t.center);
  const sides = t.who.filter(k => k !== t.center).map(nm);
  const heat = triHeat(W, t);
  const head = `Треугольник ${sides[0]} — ${c} — ${sides[1]}`;
  const what = triKind(t.kind)[3].replaceAll('{c}', c);
  const note = t.note ? ` ${t.note}.` : '';
  if (mode === 'all') return `${head}: ${what}. Накал ${heat < 35 ? 'низкий' : heat < 65 ? 'заметный' : 'высокий'}. Куда идёт: ${triEnd(t.end)[2]}.${note} Держи эту ось в поведении всех троих, не проговаривай её и не решай в одном посте.`;
  return `${head}: ${what}.${note} Третьего упомянули — пусть это отзовётся в реакции, но не втаскивай его в сцену.`;
}
function mentions(text, name) {
  const w = norm(name).split(' ')[0]; if (w.length < 3) return false;
  const stem = w.length <= 4 ? w : w.slice(0, -1);
  return new RegExp(`(^|[^a-zа-яё])${stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i').test(norm(text));
}
function triNotes(W, here, lastUserText, d = wl(W)) {
  const lines = [];
  for (const t of d.tris.filter(t => t.on !== false && t.who?.length === 3)) {
    const inScene = t.who.filter(k => here.some(h => h.key === k));
    if (inScene.length === 3) lines.push(triLine(W, t, 'all'));
    else if (inScene.length === 2) { const third = t.who.find(k => !inScene.includes(k)); const c = charInfo(third); if (c && mentions(lastUserText, c.name)) lines.push(triLine(W, t, 'shadow')); }
  }
  return lines.length ? `[${lines.slice(0, 2).join(' ')}]` : '';
}

// ── за кадром: ИИ сам что-то сделал, пока игроков не было рядом ──
function maybeOffscreen(W, room, post, d) {
  const here = new Set(presentOf(room).map(c => c.key));
  const h = worldHours(W);
  const lastAny = Math.max(-999, ...d.offscreen.map(e => e.post || 0));
  if (post.id - lastAny < 6) return null;
  const ais = q.aiChars.all().filter(c => !c.world_id || c.world_id === W).map(c => keyOf('a', c.id)).filter(k => !here.has(k)).sort(() => Math.random() - 0.5);
  for (const k of ais) {
    const p = prof(k);
    if (p.inner === false) continue;
    const [pr] = FREQ[p.init.freq] || FREQ.off;
    if (!pr || Math.random() > pr * 0.8) continue;
    const x = state(W, k);
    const pool = x.ideas.filter(i => i.status === 'new' && i.when === 'offscreen' && p.init.kinds.includes(i.kind));
    if (!pool.length) continue;
    const pick = pool[Math.floor(Math.random() * pool.length)];
    const roomId = (pick.where && roomByName(W, pick.where, null)?.id) || homeOf(W, k, d);
    pick.status = 'done'; pick.doneAt = post.id; x.lastInit = post.id; saveState(W, k, x);
    const c = charInfo(k);
    const e = { id: uid(), key: k, who: c?.name || '?', t: pick.text, room_id: roomId, at: h, post: post.id, seen: false };
    d.offscreen.push(e); if (d.offscreen.length > 40) d.offscreen.splice(0, d.offscreen.length - 40);
    if (roomId) addTrace(d, roomId, { t: pick.text, k: pick.kind === 'gift' ? 'gift' : 'note', by: c?.name || '', off: true, post: post.id });
    return e;
  }
  return null;
}

/** Мир вокруг сцены — для заметки модели. */
function worldNotes(room, here, lastUserText) {
  const W = room.world_id, d = wl(W), out = [];
  const tr = d.traces[room.id] || [];
  if (tr.length) out.push(`[Следы в этом месте (их видно, они могут попасть в сцену): ${tr.map(t => `${t.t}${t.by && t.off ? ` — от ${t.by}` : ''}`).join('; ')}.]`);
  const players = here.filter(c => !c.ai).map(c => c.name).join(', ') || 'игроков';
  for (const e of d.offscreen.filter(e => !e.seen && e.room_id === room.id)) out.push(`[За кадром, пока ${players} не было рядом, ${e.who}: ${e.t}. Это уже случилось. Если сейчас это можно обнаружить — пусть обнаружат.]`);
  for (const p of d.pets.filter(p => p.on !== false && p.home === room.id)) {
    const v = petView(W, p);
    const traits = (p.traits || []).slice(0, 4).join(', ');
    const fav = v.fav_name;
    out.push(`[Питомец здесь: ${v.kind_label.toLowerCase()} ${p.name}${p.look ? ` (${cut(p.look, 80)})` : ''}${traits ? `, характер: ${traits}` : ''}${fav ? `, больше всех любит ${fav}` : ''}${v.urgent.length ? ` — ${v.urgent.join('; ')}. Пусть требует своего` : ' — спокоен, может просто быть рядом'}.]`);
  }
  const tri = triNotes(W, here, lastUserText, d); if (tri) out.push(tri);
  if (d.push[room.id]) out.push(`[Слух, который сейчас ходит: «${d.push[room.id]}». Кто-то из персонажей может его упомянуть или на него отреагировать.]`);
  return out;
}

/** Для Летописца: места, следы, питомцы. */
function worldChronInput(room) {
  const W = room.world_id, d = wl(W), lines = [];
  const rooms = roomsOfWorld(W);
  lines.push(`Места мира: ${rooms.map(r => r.title).join('; ')}`);
  const tr = d.traces[room.id] || [];
  lines.push(`Следы здесь (${room.title}): ${tr.map(t => t.t).join('; ') || '—'}`);
  const pets = d.pets.filter(p => p.on !== false);
  if (pets.length) lines.push(`Питомцы: ${pets.map(p => `${p.name} (${petKind(p).label.toLowerCase()}${p.home ? `, живёт: ${q.roomById.get(p.home)?.title || '?'}` : ''})`).join('; ')}`);
  return lines.join('\n');
}

function applyWorld(room, post, j, cast) {
  const W = room.world_id, d = wl(W), h = worldHours(W);
  const chips = [];
  for (const x of Array.isArray(j.traces) ? j.traces.slice(0, 4) : []) {
    if (!x?.text) continue;
    const r = roomByName(W, x.where, room);
    if (x.op === 'remove') removeTrace(d, r.id, x.text);
    else if (addTrace(d, r.id, { t: x.text, k: x.kind, post: post.id })) chips.push(cut(x.text, 40));
  }
  for (const e of Array.isArray(j.pets) ? j.pets : []) {
    if (!e?.name) continue;
    let p = findPet(d, e.name);
    if (!p && e.new) { p = newPet(W, d, { name: e.name.charAt(0).toUpperCase() + e.name.slice(1), kind: guessPetKind(e.kind), look: e.look || '', home: room.id }); chips.push(`Питомец: ${p.name}`); }
    if (!p) continue;
    if (e.fed) setPetNeed(p, 'food', 100, h);
    if (e.played) setPetNeed(p, 'play', 100, h);
    if (e.petted) setPetNeed(p, 'love', petNeed(p, 'love', h) + 45, h);
    if (e.hurt) { setPetNeed(p, 'health', petNeed(p, 'health', h) - 35, h); p.hurt = cut(e.hurt, 50); p.moments.push({ t: cut(e.hurt, 60), post: post.id, bad: true }); }
    if (e.with) { const c = findC(namesMap(cast), e.with); if (c) p.fav[c.name] = (p.fav[c.name] || 0) + 1; }
    if (e.moment) p.moments.push({ t: cut(e.moment, 60), post: post.id });
    if (p.moments.length > 30) p.moments.splice(0, p.moments.length - 30);
  }
  // идеи «за кадром» записывает apply() в ideas; тут — шанс, что кто-то из ИИ не в сцене сделает одну
  const off = maybeOffscreen(W, room, post, d);
  saveWl(W, d);
  return { chips, off };
}

/** После поста ИИ в комнате: что было за кадром — обнаружено, слух — сыгран. */
function afterAiWorld(room) {
  const W = room.world_id, d = wl(W);
  let ch = false;
  for (const e of d.offscreen) if (!e.seen && e.room_id === room.id) { e.seen = true; ch = true; }
  if (d.push[room.id]) { delete d.push[room.id]; ch = true; }
  if (ch) saveWl(W, d);
}

const RUMORS_SYSTEM = `Ты — городская хроника и сарафанное радио мира ролевой истории на русском.
Новости — что происходит в мире вокруг героев (город, работа, события, погода, громкие истории) в духе сеттинга.
Слухи — что говорят о героях знакомые, соседи, бармены, коллеги, таблоиды, соцсети: смесь правды, полуправды и вранья.
Опирайся только на свежие события из списка. Не приписывай героям поступков, которых не было: слухи искажают то, что было, а не выдумывают новое. Тайны — только намёком. Без пошлости.
Ответь только JSON: {"news":[{"title":"заголовок","text":"1–2 предложения","about":["имя"]}],"rumors":[{"text":"что говорят, 1–2 предложения","source":"кто и где","about":["имя"],"truth":"правда|полуправда|враньё"}]}. 3 новости, 4 слуха.`;

function rumorsInput(W) {
  const w = q.worldById.get(W), d = wl(W);
  const ev = [];
  for (const r of q.recentChronInWorld.all(W, 40).reverse()) { const c = json(r.chron, null); if (c?.chips?.length) ev.push(`- ${c.chips.join('; ')}`); }
  const names = [...q.allPersonas.all().map(p => p.name), ...q.aiChars.all().filter(c => !c.world_id || c.world_id === W).map(c => c.name)];
  const tris = d.tris.filter(t => t.on !== false && t.who?.length === 3).map(t => `- ${t.who.map(k => charInfo(k)?.name || '?').join(' — ')}`);
  return [
    `Мир: ${w?.title || ''}${w?.prompt ? `\n${cut(w.prompt, 1500)}` : ''}`,
    w?.clock ? `Сейчас в истории: ${w.clock}` : '',
    `Герои: ${names.join(', ')}`,
    `Места: ${roomsOfWorld(W).map(r => r.title).join(', ')}`,
    `Свежие события:\n${ev.join('\n') || '—'}`,
    tris.length ? `Треугольники (сплетники это чуют — можно намекнуть):\n${tris.join('\n')}` : '',
    d.rumors?.rumors?.length ? `Прошлые слухи (не повторяй):\n${d.rumors.rumors.map(r => `- ${r.text}`).join('\n')}` : '',
  ].filter(Boolean).join('\n\n');
}
function saveRumors(W, j) {
  const d = wl(W), s = (v, n) => cut(String(v ?? '').trim(), n);
  const news = (Array.isArray(j?.news) ? j.news : []).filter(x => x?.text).slice(0, 4).map(x => ({ title: s(x.title, 80), text: s(x.text, 400), about: (Array.isArray(x.about) ? x.about : []).map(String).slice(0, 4) }));
  const rumors = (Array.isArray(j?.rumors) ? j.rumors : []).filter(x => x?.text).slice(0, 5).map(x => ({ text: s(x.text, 400), source: s(x.source, 80), about: (Array.isArray(x.about) ? x.about : []).map(String).slice(0, 4), truth: ['правда', 'полуправда', 'враньё'].includes(x.truth) ? x.truth : 'полуправда' }));
  if (!news.length && !rumors.length) throw Object.assign(new Error('Хроника ответила пусто'), { status: 502 });
  d.rumorsOld = [d.rumors, ...(d.rumorsOld || [])].filter(Boolean).slice(0, 3);
  d.rumors = { at: Date.now(), clock: q.worldById.get(W)?.clock || '', day: Math.floor(worldHours(W) / 24), news, rumors };
  d.rumorDay = d.rumors.day;
  saveWl(W, d);
  return d.rumors;
}
/** Новый день истории → пора за свежими слухами (true — один раз за день). */
function newDay(W) {
  const d = wl(W), day = Math.floor(worldHours(W) / 24);
  if (d.rumorDay == null) { d.rumorDay = day; saveWl(W, d); return false; }
  if (day <= d.rumorDay) return false;
  d.rumorDay = day; saveWl(W, d); return true;
}

const CUT_SYSTEM = `You are a film director's storyboard assistant. From one roleplay post you pick 3 key frames for a short cutscene and write image prompts.
Return ONLY JSON: {"title":"short Russian title of the moment, 2-4 words","frames":[{"title":"Общий план","who":["exact names in frame"],"caption":"one short Russian line from or about the post, max 90 chars","prompt":"English image prompt, 45-70 words: shot type and angle, who is in frame BY NAME ONLY (never describe their faces, hair, eye or skin colour), pose, expression, clothing, setting, light, mood; cinematic film still"}]}
Frame 1 is a wide establishing shot of the place and the people. Frames 2 and 3 are close-ups or medium shots of the two most important reactions or gestures. Follow the post exactly: same place, time of day, weather, clothes. Never explicit.`;
function cutInput(room, post) {
  const W = room.world_id, w = q.worldById.get(W);
  const cast = castOf(room);
  const clothes = cast.map(c => { const x = state(W, c.key); return x.outfit ? `${c.name}: ${x.outfit}` : ''; }).filter(Boolean).join('; ');
  const author = postKey(post) ? charInfo(postKey(post))?.name : 'narrator';
  return { text: `Place: ${room.title}${room.description ? ` — ${cut(room.description, 300)}` : ''}. Time: ${w?.clock || '?'}.\nPeople in the story: ${cast.map(c => c.name).join(', ')}.\nClothes now: ${clothes || '?'}\n\nPOST by ${author}:\n${cut(post.body, 4000)}`, cast };
}

// ───────────── Летописец ─────────────

const CHRON_SYSTEM = `Ты — Летописец ролевой истории на русском. Ты не пишешь историю, а ведёшь её учёт по последнему посту.
Верни ТОЛЬКО JSON, без пояснений и без markdown:
{"chips":[],"time":{"passed_min":0,"clock":""},"outfit":[],"items":[],"relations":[],"inner":[],"prefs":[],"ideas":[],"done":[],"traces":[],"pets":[],"scene":{"mood":"calm","intim":0,"tone":"","end":false}}

chips — 0–4 коротких факта о том, что изменилось в ЭТОМ посте, по 2–5 слов: «Приехали в бар», «Ключи у Хеди», «Баки отдал зажигалку». Ничего не изменилось — [].

time — сколько времени истории прошло за этот пост: passed_min — минуты (реплика в диалоге — 1–3, сцена с действием — 10–60, «утром», «через неделю» — сколько нужно). clock — текущее время истории, если его можно понять: «пятница, 23:40» или «утро, 3 мая»; иначе "".

outfit — что сейчас надето, только если в посте одежда поменялась: [{"who":"имя","text":"что на нём сейчас целиком, 4–20 слов"}]. Сняли, надели, переоделись, промок, порвал — пиши итог. Иначе [].

items — вещи, важные для сюжета (ключи, телефон, оружие, документы, подарки, фото, машины, мотоциклы). НЕ вещи: одежда на теле, еда, мебель, части тела, чувства. Операции:
{"op":"add","who":"у кого","name":"короткое название","kind":"вещь|транспорт","story":"3–10 слов, что с ней случилось"}
{"op":"give","who":"кто отдал","to":"кому","name":"название из списка ТОЧНО","story":"…"}
{"op":"drop","who":"у кого","name":"название из списка ТОЧНО"} — потеряна, уничтожена, израсходована
Названия из списка вещей — ТОЧНО как в списке. Ничего не выдумывай. Нечего — [].

relations — как в этом посте сдвинулись чувства одного персонажа к другому: [{"from":"кто чувствует","to":"к кому","trust":0,"closeness":0,"desire":0,"jealousy":0,"tension":0,"guilt":0,"moment":""}]. Чувства несимметричны: если сдвинулось у обоих — две записи, и они могут быть разными. Числа — изменение от −20 до +20, только если правда что-то сдвинулось. trust — доверие; closeness — душевная близость и привязанность; desire — физическое влечение; jealousy — ревность; tension — раздражение, обида, конфликт; guilt — вина перед другим. moment — ключевой момент пары в 3–8 слов, только если был, и только в одной из двух записей. Ничего не сдвинулось — [].

inner — тело и внутренняя жизнь персонажей по ЭТОМУ посту: [{"who":"имя","ate":false,"slept":false,"washed":false,"tired":0,"hurt":"","healed":false,"state":"","why":"","thought":"","want":"","with":"","done":[],"spark":""}]. ate — нормально поел; slept — поспал; washed — душ или ванна; tired — насколько вымотался в посте, 0–30; hurt — новая рана или травма коротко, иначе ""; healed — рану обработали или зажила. state — состояние, только если сменилось: good|playful|thoughtful|sulky|irritated|restless|tired|unwell|sad|aroused, ok — если прошло; why — почему, 3–8 слов. Только для персонажей из строки «ИИ»: thought — всплывшая мысль или внутренний конфликт (прошлое, вина, будущее, страхи), 6–14 слов; want — его собственное новое желание не про игроков, 6–14 слов; with — с кем; done — номера его желаний из «Внутри», которые сбылись; spark — если случилось то, что его заводит (из «Заводит»), что именно, 3–8 слов. Только то, что правда видно в посте. Ничего — [].

prefs — что стало ясно про вкусы: [{"who":"имя","text":"1–5 слов","kind":"like|dislike"}]. Только сказанное или явно показанное. Нечего — [].

ideas — 0–2 новые идеи, что ИИ-персонаж из строки «Инициатива» мог бы сделать САМ в ближайших сценах — чтобы жил своей жизнью, а не только отвечал. [{"who":"имя","kind":"care|court|flirt|touch|spicy|gift|own|talk|plot","text":"8–20 слов, конкретно и в его характере","when":"scene|later|offscreen","where":"место из «Места мира», если важно"}]. when: scene — прямо в этой сцене; later — в другой раз; offscreen — сделает сам, пока игроков нет рядом (оставит записку, приготовит ужин, купит и спрячет подарок) — тогда text как уже сделанное: «приготовил ужин и оставил записку на холодильнике». care — забота; court — ухаживание, романтический жест; flirt — подкат, комплимент; touch — касание мимоходом; spicy — пошлость вслух; gift — подарок с учётом вкусов; own — свои дела, независимость; talk — сам начинает важный разговор; plot — сюжетный ход по его линии. court/flirt/touch/spicy — только если между ними есть романтика. Опирайся на характер, отношения, вкусы. Не повторяй уже задуманное.
done — номера идей из «Уже задумано», которые в ЭТОМ посте сбылись. Нет — [].

traces — следы в местах, которые переживут эту сцену: [{"op":"add|remove","where":"место из «Места мира» или пусто — здесь","text":"что осталось, 3–10 слов","kind":"trace|note|food|gift"}]. Бокалы после вечеринки, разбитое зеркало, его футболка после ночёвки, записка на холодильнике (в text — суть записки), ужин в духовке, цветы на столе. remove — следа больше нет (убрали, съели, выкинули), text — как в списке «Следы». Мелочи, которые завтра никто не вспомнит, не пиши. Нечего — [].

pets — что случилось с питомцами в этом посте: [{"name":"кличка","fed":false,"played":false,"petted":false,"hurt":"","with":"кто был с ним","moment":"3–8 слов, если был милый или важный момент","new":false,"kind":"кошка|собака|…","look":"как выглядит"}]. new — true, только если в истории появился новый питомец героев. Ничего — [].

scene — тон этого поста: mood — ${MOOD_IDS.join('|')}|calm; intim: 0 — без близости, 1 — флирт и поцелуи, 2 — секс или откровенная близость прямо сейчас; tone — только при intim 2: ${TONE_IDS.join('|')}; end — true, если близость в этом посте закончилась.`;

function namesMap(cast) {
  const m = new Map();
  for (const c of cast) { m.set(norm(c.name), c); const first = norm(c.name).split(' ')[0]; if (first && !m.has(first)) m.set(first, c); }
  return m;
}
const findC = (map, name) => map.get(norm(name)) || map.get(norm(name).split(' ')[0]) || null;

function renderPost(p) {
  const k = postKey(p); const c = k ? charInfo(k) : null;
  return `### ${c?.name || 'вне игры'}\n${cut(p.body, 2500)}`;
}

function chronInput(room, post) {
  const W = room.world_id;
  const world = q.worldById.get(W);
  const cast = castOf(room);
  const prev = q.postsBefore.all(room.id, post.id, 4).reverse().filter(p => !p.is_ooc);
  const lines = [];
  lines.push(`Место: ${room.title}${room.description ? ` — ${cut(room.description, 300)}` : ''}`);
  if (world?.clock) lines.push(`Время истории сейчас: ${world.clock}`);
  lines.push(`Персонажи (так их и называй): ${cast.map(c => `${c.name}${c.ai ? ' (ИИ)' : ' (игрок)'}`).join('; ') || '—'}`);
  const ai = cast.filter(c => c.ai);
  if (ai.length) lines.push(`ИИ: ${ai.map(c => c.name).join(', ')}`);
  const inside = [], inits = [], ideas = [], likes = [], wears = [], items = [];
  for (const c of cast) {
    const p = prof(c.key), x = state(W, c.key);
    if (x.outfit) wears.push(`${c.name}: ${cut(x.outfit, 120)}`);
    for (const it of q.itemsByOwner.all(c.key).filter(i => i.kind === 'вещь' || i.kind === 'транспорт')) items.push(`- ${it.name} — у ${c.name}`);
    if (p.likes.length || p.dislikes.length) likes.push(`${c.name}: любит ${p.likes.slice(-6).join(', ') || '—'}; не любит ${p.dislikes.slice(-4).join(', ') || '—'}`);
    if (!c.ai) continue;
    const st = STATES.find(s => s[0] === x.state?.id);
    const wa = x.wants.filter(w => w.status === 'on');
    inside.push(`${c.name}: ${st ? `сейчас ${st[1].toLowerCase()}; ` : ''}${p.turnons.length ? `заводит: ${p.turnons.join(', ')}; ` : ''}желания: ${wa.map(w => `#${w.n} ${w.t}`).join('; ') || '—'}`);
    if (p.inner !== false && p.init.freq !== 'off') {
      const r = cast.filter(o => !o.ai).map(o => { const rr = rel(W, c.key, o.key); return rr._exists ? `к ${o.name}: доверие ${rr.trust}, близость ${rr.closeness}, влечение ${rr.desire}` : ''; }).filter(Boolean).join('; ');
      inits.push(`${c.name} (${FREQ[p.init.freq][2].toLowerCase()}; можно: ${p.init.kinds.map(k => IDEA_KINDS[k]).join(', ')}${p.hobbies.length ? `; увлечения: ${p.hobbies.join(', ')}` : ''}${p.romance.level !== 'off' ? `; ухаживает${p.romance.rel ? ` за ${p.romance.rel}` : ''}: ${p.romance.style || 'по-своему'}` : ''}${r ? `; ${r}` : ''})`);
    }
    for (const i of x.ideas.filter(i => i.status === 'new' || i.status === 'armed')) ideas.push(`#${i.n} ${c.name}: ${i.text}`);
  }
  if (wears.length) lines.push(`Сейчас надето: ${wears.join('; ')}`);
  lines.push(`Вещи:\n${items.join('\n') || '—'}`);
  if (likes.length) lines.push(`Известные вкусы: ${likes.join('. ')}`);
  if (inside.length) lines.push(`Внутри:\n${inside.join('\n')}`);
  if (inits.length) lines.push(`Инициатива: ${inits.join('; ')}`);
  if (ideas.length) lines.push(`Уже задумано:\n${ideas.join('\n')}`);
  const rels = [];
  for (const a of cast) for (const b of cast) if (a.key !== b.key) { const r = rel(W, a.key, b.key); if (r._exists) rels.push(`${a.name} → ${b.name}: ${SCALES.map(([k, l]) => `${l.toLowerCase()} ${r[k]}`).join(', ')}`); }
  if (rels.length) lines.push(`Отношения сейчас:\n${rels.join('\n')}`);
  lines.push(worldChronInput(room));
  if (prev.length) lines.push(`Перед этим:\n${prev.map(renderPost).join('\n\n')}`);
  lines.push(`ПОСЛЕДНИЙ ПОСТ (его и разбирай):\n${renderPost(post)}`);
  return { text: lines.join('\n\n'), cast };
}

function parseJson(text) {
  const t = String(text || '').replace(/```json|```/g, '');
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(t.slice(a, b + 1)); } catch { return null; }
}

/** Снимок всего, что может тронуть Летописец — для отката. */
function snapshot(room, cast) {
  const W = room.world_id;
  const world = q.worldById.get(W);
  const d = wl(W);
  const s = { world: { hours: world.hours, clock: world.clock }, scene: room.scene, states: {}, profs: {}, rels: [], items: {}, wl: Object.fromEntries(WL_SNAP.map(k => [k, d[k] ?? null])) };
  for (const c of q.aiChars.all().filter(c => !c.world_id || c.world_id === W)) { const k = keyOf('a', c.id); s.states[k] = q.getState.get(W, k)?.data ?? null; }  // «за кадром» трогает и тех, кого нет в сцене
  for (const c of cast) {
    s.states[c.key] = q.getState.get(W, c.key)?.data ?? null;
    s.profs[c.key] = q.getProf.get(c.key)?.data ?? null;
    s.items[c.key] = q.itemsByOwner.all(c.key);
    for (const d of cast) if (c.key !== d.key) s.rels.push([c.key, d.key, q.getRel.get(W, c.key, d.key)?.data ?? null]);
  }
  return s;
}
function restore(room, snap) {
  const W = room.world_id;
  q.setWorldTime.run(snap.world.hours, snap.world.clock, W);
  q.setRoomScene.run(snap.scene, room.id);
  if (snap.wl) { const d = wl(W); for (const k of WL_SNAP) d[k] = snap.wl[k]; saveWl(W, d); }
  for (const [k, d] of Object.entries(snap.states)) d == null ? q.delState.run(W, k) : q.setState.run(W, k, d);
  for (const [k, d] of Object.entries(snap.profs)) if (d != null) q.setProf.run(k, d);
  for (const [a, b, d] of snap.rels) d == null ? q.delRel.run(W, a, b) : q.setRel.run(W, a, b, d);
  for (const [k, rows] of Object.entries(snap.items)) {
    q.deleteItemsOfOwner.run(k);
    for (const r of rows) q.restoreItem.run(r.id, r.persona_id, r.owner_key, r.kind, r.name, r.descr, r.image, r.equipped, r.story, r.from_key, r.created_at);
  }
}

function numberLists(W, cast) {
  // даём идеям и желаниям короткие номера для «done»
  let n = 1;
  for (const c of cast) {
    const x = state(W, c.key);
    for (const i of x.ideas) i.n = n++;
    for (const w of x.wants) w.n = n++;
    saveState(W, c.key, x);
  }
}

function apply(room, post, j, cast) {
  const W = room.world_id;
  const map = namesMap(cast);
  const world = q.worldById.get(W);
  const author = postKey(post);
  const chips = (Array.isArray(j.chips) ? j.chips : []).map(s => cut(s, 48)).filter(Boolean).slice(0, 4);

  // время
  let hours = world.hours;
  const passed = Math.max(0, Math.min(60 * 24 * 14, Number(j.time?.passed_min) || 0));
  hours += passed / 60;
  const clock = j.time?.clock ? cut(j.time.clock, 40) : world.clock;
  q.setWorldTime.run(hours, clock, W);

  // одежда
  for (const o of Array.isArray(j.outfit) ? j.outfit : []) {
    const c = findC(map, o.who); if (!c || !o.text) continue;
    const x = state(W, c.key); x.outfit = cut(o.text, 220); saveState(W, c.key, x);
  }

  // вещи
  for (const op of Array.isArray(j.items) ? j.items : []) {
    const who = findC(map, op.who);
    if (op.op === 'add' && who && op.name) {
      const has = q.itemsByOwner.all(who.key).find(i => norm(i.name) === norm(op.name));
      if (has) continue;
      const kind = op.kind === 'транспорт' ? 'транспорт' : 'вещь';
      const story = op.story ? [{ t: cut(op.story, 80), post: post.id, room: room.id }] : [];
      q.insertItem.run(who.t === 'p' ? who.id : 0, who.key, kind, cut(op.name, 60), '', '', 1, JSON.stringify(story), '', now());
    } else if (op.op === 'give' && who && op.name) {
      const to = findC(map, op.to); if (!to) continue;
      const it = q.itemsByOwner.all(who.key).find(i => norm(i.name) === norm(op.name)); if (!it) continue;
      const story = json(it.story, []); story.push({ t: cut(op.story || `${who.name} → ${to.name}`, 80), post: post.id, room: room.id });
      q.updateItem.run(it.kind, it.name, it.descr, it.image, 1, JSON.stringify(story), who.key, to.key, it.id);
    } else if (op.op === 'drop' && who && op.name) {
      const it = q.itemsByOwner.all(who.key).find(i => norm(i.name) === norm(op.name)); if (it) q.deleteItem.run(it.id);
    }
  }

  // отношения
  for (const r of Array.isArray(j.relations) ? j.relations : []) {
    const a = findC(map, r.from), b = findC(map, r.to); if (!a || !b || a.key === b.key) continue;
    const x = rel(W, a.key, b.key);
    let moved = false;
    for (const [f] of SCALES) { const d = Math.max(-20, Math.min(20, Number(r[f]) || 0)); if (d) { x[f] = clamp(x[f] + d); moved = true; } }
    if (r.moment && !x.moments.some(m => norm(m.text) === norm(r.moment))) { x.moments.push({ text: cut(r.moment, 60), post: post.id, room: room.id }); x.moments = x.moments.slice(-20); moved = true; }
    if (moved || !x._exists) saveRel(W, a.key, b.key, x);
  }

  // тело и внутренняя жизнь
  for (const r of Array.isArray(j.inner) ? j.inner : []) {
    const c = findC(map, r.who); if (!c) continue;
    const p = prof(c.key), x = state(W, c.key);
    const h = hours;
    if (r.ate) setNeed(x, 'food', 95, h);
    if (r.slept) setNeed(x, 'energy', 100, h);
    if (r.washed) setNeed(x, 'clean', 100, h);
    const tired = Math.max(0, Math.min(30, Number(r.tired) || 0));
    if (tired) { setNeed(x, 'energy', needOf(x, 'energy', h, p.metab) - tired, h); if (tired >= 10 && !r.washed) setNeed(x, 'clean', needOf(x, 'clean', h, p.metab) - 15, h); }
    if (r.hurt && !x.wounds.some(w => norm(w.t) === norm(r.hurt))) { x.wounds.push({ id: ++x.seq, t: cut(r.hurt, 50), at: h, post: post.id }); setNeed(x, 'health', needOf(x, 'health', h, p.metab) - 25, h); }
    if (r.healed && x.wounds.length) { x.wounds.shift(); setNeed(x, 'health', needOf(x, 'health', h, p.metab) + 20, h); }
    if (r.state && !x.state?.manual) x.state = r.state === 'ok' ? null : STATE_IDS.includes(r.state) ? { id: r.state, why: cut(r.why || '', 60), post: post.id } : x.state;
    if (c.ai) {
      if (r.thought && !x.thoughts.some(t => norm(t.t) === norm(r.thought))) x.thoughts.push({ id: uid(), t: cut(r.thought, 120), w: 1, status: 'on', post: post.id, by: 'ai' });
      if (r.want && !x.wants.some(t => norm(t.t) === norm(r.want))) x.wants.push({ id: uid(), t: cut(r.want, 120), with: cut(r.with || '', 40), status: 'on', post: post.id, by: 'ai' });
      for (const n of Array.isArray(r.done) ? r.done : []) { const w = x.wants.find(w => w.n === Number(n)); if (w) { w.status = 'done'; w.doneAt = post.id; } }
      if (r.spark) { x.spark = { t: cut(r.spark, 60), post: post.id, used: null }; if (!x.state || (!x.state.manual && ['good', 'playful', 'thoughtful'].includes(x.state.id))) x.state = { id: 'aroused', why: cut(r.spark, 60), post: post.id }; }
      x.thoughts = x.thoughts.slice(-12); x.wants = x.wants.slice(-12);
    }
    saveState(W, c.key, x);
  }
  // устаревшее состояние само проходит через ~20 постов
  for (const c of cast) {
    const x = state(W, c.key);
    if (x.state && !x.state.manual && post.id - (x.state.post || 0) > 60) { x.state = null; saveState(W, c.key, x); }
  }

  // вкусы
  for (const r of Array.isArray(j.prefs) ? j.prefs : []) {
    const c = findC(map, r.who); if (!c || !r.text) continue;
    const p = prof(c.key);
    const list = r.kind === 'dislike' ? p.dislikes : p.likes;
    if (!list.some(t => norm(t) === norm(r.text))) { list.push(cut(r.text, 40)); if (list.length > 30) list.shift(); saveProf(c.key, p); }
  }

  // идеи инициативы
  for (const r of Array.isArray(j.ideas) ? j.ideas.slice(0, 2) : []) {
    const c = findC(map, r.who); if (!c?.ai || !r.text) continue;
    const x = state(W, c.key);
    if (x.ideas.some(i => norm(i.text) === norm(r.text))) continue;
    x.ideas.push({ id: uid(), kind: IDEA_KINDS[r.kind] ? r.kind : 'care', text: cut(r.text, 160), when: ['later', 'offscreen'].includes(r.when) ? r.when : 'scene', where: cut(r.where || '', 40), status: 'new', post: post.id });
    const fresh = x.ideas.filter(i => i.status === 'new');
    if (fresh.length > 8) fresh[0].status = 'skip';
    x.ideas = x.ideas.slice(-30);
    saveState(W, c.key, x);
  }
  for (const n of Array.isArray(j.done) ? j.done : []) {
    for (const c of cast) { const x = state(W, c.key); const i = x.ideas.find(i => i.n === Number(n)); if (i) { i.status = 'done'; i.doneAt = post.id; saveState(W, c.key, x); } }
  }

  // тон сцены
  if (j.scene && typeof j.scene === 'object') {
    const m = String(j.scene.mood || '').toLowerCase(), t = String(j.scene.tone || '').toLowerCase();
    const x = Number(j.scene.intim);
    const intim = x === 2 ? 2 : x === 1 ? 1 : 0;
    const sc = sceneOf(room);
    sc.auto = { mood: MOOD_IDS.includes(m) ? m : 'calm', intim, tone: intim === 2 && TONE_IDS.includes(t) ? t : '', end: j.scene.end === true || j.scene.end === 'true', post: post.id };
    q.setRoomScene.run(JSON.stringify(sc), room.id);
  }

  const wx = applyWorld(room, post, j, cast);
  for (const c of wx.chips) if (chips.length < 5) chips.push(c);
  return { chips, passed, clock, author, offscreen: wx.off };
}

module.exports = {
  NEEDS, STATES, MOODS, TONES, SCALES, IDEA_KINDS, FREQ,
  keyOf, parseKey, charInfo, postKey, prof, saveProf, state, saveState, bodyView, stateLabel,
  rel, saveRel, relBits, sceneOf, sceneNow, castOf, presentOf, notes, arm, afterAiPost,
  PET_KINDS, TRI_KINDS, TRI_ENDS, wl, saveWl, homeOf, petView, newPet, setPetNeed, petNeed, triHeat, addTrace, newDay,
  RUMORS_SYSTEM, rumorsInput, saveRumors, CUT_SYSTEM, cutInput, namesMap, findC,
  CHRON_SYSTEM, chronInput, parseJson, snapshot, restore, numberLists, apply, norm, cut, json, uid, setNeed, needOf, worldHours,
};
