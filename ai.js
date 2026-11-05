'use strict';
// ai.js — вызовы OpenRouter: посты ИИ-персонажей, лорбуки, сводки летописца, лимиты и учёт трат
const { q, now, getSetting } = require('./db');
const { personaStateBlock } = require('./game');

const OR_URL = 'https://openrouter.ai/api/v1/chat/completions';
const LORE_CHAR_BUDGET = 9000; // максимум символов лора в контексте

function apiKey() {
  return getSetting('openrouter_key', process.env.OPENROUTER_API_KEY || '');
}

function dailyLimitFor(user) {
  if (user.is_admin) return Infinity;
  if (user.daily_limit_usd != null) return user.daily_limit_usd;
  const def = parseFloat(getSetting('default_daily_limit_usd', '1'));
  return Number.isFinite(def) ? def : 1;
}

function spentToday(userId) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return q.spentSince.get(userId, d.getTime()).s;
}

function checkLimit(user) {
  const limit = dailyLimitFor(user);
  const spent = spentToday(user.id);
  if (spent >= limit) {
    const e = new Error(`Дневной лимит исчерпан: потрачено $${spent.toFixed(3)} из $${limit}. Завтра обнулится.`);
    e.status = 429;
    throw e;
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

// Лорбуки: constant-записи + записи, чьи ключи встречаются в недавнем тексте
function loreFor(worldId, scanText) {
  const entries = q.activeEntriesByWorld.all(worldId);
  if (!entries.length) return '';
  const hay = scanText.toLowerCase();
  const picked = [];
  let budget = LORE_CHAR_BUDGET;
  for (const e of entries) {
    let hit = !!e.always_on;
    if (!hit && e.keys) {
      for (const k of e.keys.split(',')) {
        const key = k.trim().toLowerCase();
        if (key && hay.includes(key)) { hit = true; break; }
      }
    }
    if (hit && e.content.length <= budget) {
      picked.push(e.title ? `[${e.title}]\n${e.content}` : e.content);
      budget -= e.content.length;
    }
  }
  return picked.join('\n\n');
}

function buildContext(room, aiChar, instruction) {
  const names = nameMaps();
  const world = q.worldById.get(room.world_id);
  const posts = q.lastPosts.all(room.id, aiChar ? aiChar.context_posts : 60).reverse();
  const history = posts.map(p => renderPost(p, names)).join('\n\n');

  // лор сканируем по последним ~15 постам + описанию комнаты + указанию
  const scanText = [room.title, room.description, instruction || '',
    ...posts.slice(-15).map(p => p.body)].join('\n');
  const lore = world ? loreFor(world.id, scanText) : '';

  const parts = [];
  if (world && world.prompt) parts.push(`# Мир и правила игры: ${world.title}\n${world.prompt}`);
  parts.push(`# Локация: ${room.title}\n${room.description || '(без описания)'}`);
  if (room.chronicle) parts.push(`# Хроника событий этой локации (краткая сводка прошлого)\n${room.chronicle}`);
  if (lore) parts.push(`# Сведения о мире и персонажах (лорбук)\n${lore}`);
  const states = personaStateBlock(posts);
  if (states) parts.push(`# Текущее состояние персонажей игроков (одежда, транспорт, самочувствие, память)\n${states}`);
  if (aiChar) parts.push(`# Твоя роль\n${aiChar.system_prompt}`);
  parts.push(`# Формат\nЭто совместная ролевая игра живых игроков и ИИ. Ниже — последние посты сцены. Ответь ОДНИМ постом от своего лица, по-русски, в стиле сцены. Не пиши действия и реплики за персонажей живых игроков. Не добавляй подпись и заголовок — только текст поста.`);
  if (instruction) parts.push(`# Указание от игрока (вне игры, выполни его)\n${instruction}`);

  return { system: parts.join('\n\n'), history };
}

async function callOpenRouter({ model, system, userContent, temperature, max_tokens }) {
  const key = apiKey();
  if (!key) { const e = new Error('OpenRouter-ключ не задан (админка → Настройки).'); e.status = 400; throw e; }
  const res = await fetch(OR_URL, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: userContent },
      ],
      temperature,
      max_tokens,
      usage: { include: true },
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    const msg = data?.error?.message || `OpenRouter HTTP ${res.status}`;
    const e = new Error(msg); e.status = 502; throw e;
  }
  const text = data.choices?.[0]?.message?.content?.trim() || '';
  const usage = data.usage || {};
  return {
    text,
    prompt_tokens: usage.prompt_tokens || 0,
    completion_tokens: usage.completion_tokens || 0,
    cost_usd: typeof usage.cost === 'number' ? usage.cost : 0,
  };
}

function logUsage(user, aiCharId, roomId, model, r, kind) {
  q.insertUsage.run(user.id, aiCharId, roomId, model, r.prompt_tokens, r.completion_tokens, r.cost_usd, kind, now());
}

async function aiPost({ user, room, aiChar, instruction }) {
  checkLimit(user);
  const { system, history } = buildContext(room, aiChar, instruction);
  const r = await callOpenRouter({
    model: aiChar.model,
    system,
    userContent: history || '(сцена только начинается — открой её)',
    temperature: aiChar.temperature,
    max_tokens: aiChar.max_tokens,
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
  const r = await callOpenRouter({
    model,
    system,
    userContent: `${prev}# Посты\n${history || '(постов нет)'}`,
    temperature: 0.3,
    max_tokens: 1500,
  });
  logUsage(user, null, room.id, model, r, 'chronicle');
  return r.text;
}

module.exports = { aiPost, chronicle, spentToday, dailyLimitFor };
