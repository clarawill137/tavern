'use strict';
/* ✦ Таверна — интерфейс в стиле Life */
import { icon, CANDLE } from './icons.js';

const $app = document.getElementById('app');
let S = null, META = null;
const BRIEF = {};              // world_id → { clock, chars: { key: { room_id, at, outfit, state } } }
const WL = {};                 // world_id → следы, питомцы, треугольники, слухи, кат-сцены
const CUTBUSY = {};            // post_id → { step, of } — кат-сцена снимается
let curRoom = null, posts = [];
let composer = { persona_id: null, ooc: false, image: '' };
let tab = 'rooms';
let curWorldId = +localStorage.getItem('tavern_world') || null;
let openCard = null;           // { key, sub } — открытая карточка, чтобы обновлять вживую
let sse = null, extLoaded = false;
const prefs = { pal: localStorage.getItem('tavern_pal') || 'graphite', ava: localStorage.getItem('tavern_ava') || 'banner' };

function applyPal(p) { document.body.className = `pal-${p}`; prefs.pal = p; localStorage.setItem('tavern_pal', p); }
applyPal(prefs.pal);

// ───────────── утилиты ─────────────
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtBody = s => esc(s).replace(/\*([^*\n]{1,300}?)\*/g, '<em>$1</em>').replace(/«([^»\n]{1,300})»/g, '<q>«$1»</q>');
const cut = (t, n) => { t = String(t ?? ''); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
const money = v => '$' + (v || 0).toFixed(v >= 1 ? 2 : 3);
function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(ts), t = new Date();
  const hm = d.toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === t.toDateString()) return `Сегодня, ${hm}`;
  if (d.toDateString() === new Date(t - 864e5).toDateString()) return `Вчера, ${hm}`;
  return `${d.toLocaleDateString('ru', { day: 'numeric', month: 'short' })}, ${hm}`;
}
function ago(ts) {
  if (!ts) return '';
  const m = Math.round((Date.now() - ts) / 60000);
  if (m < 1) return 'только что'; if (m < 60) return `${m} мин назад`;
  const h = Math.round(m / 60); if (h < 24) return `${h} ч назад`;
  return `${Math.round(h / 24)} дн назад`;
}
function fit(url, cls = '', inner = '', attrs = '') {
  return url
    ? `<div class="lf-fit ${cls}" style="--img:url('${esc(url)}')" ${attrs}><i class="lf-fit-i"></i>${inner}</div>`
    : `<div class="${cls}" ${attrs}>${inner}</div>`;
}
function ava(c, cls = '') {
  if (!c) return `<span class="lf-ava ${cls}"><i>?</i></span>`;
  return c.avatar
    ? `<span class="lf-ava ${cls}"><img src="${esc(c.avatar)}" alt="" loading="lazy"></span>`
    : `<span class="lf-ava ${cls}"><i class="emoji">${esc(c.emoji || (c.name || '?')[0])}</i></span>`;
}
function api(path, opts = {}) {
  return fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts, body: opts.body ? JSON.stringify(opts.body) : undefined })
    .then(async res => { const d = await res.json().catch(() => ({})); if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`); return d; });
}
function toast(text, bad = false) {
  const t = document.createElement('div');
  t.className = `lf-toast${bad ? ' bad' : ''}`; t.textContent = text;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), bad ? 5000 : 2600);
}
// рябь на кнопках, как в Life
document.addEventListener('pointerdown', e => {
  const b = e.target.closest('.lf-btn, .lf-chip, .lf-seg button'); if (!b) return;
  const r = b.getBoundingClientRect(), s = Math.max(r.width, r.height) * 2.2;
  const i = document.createElement('i'); i.className = 'lf-ripple';
  i.style.cssText = `width:${s}px;height:${s}px;left:${e.clientX - r.left - s / 2}px;top:${e.clientY - r.top - s / 2}px`;
  b.appendChild(i); setTimeout(() => i.remove(), 650);
});
async function busy(btn, fn) {
  if (!btn) return fn();
  const html = btn.innerHTML; btn.classList.add('busy'); btn.innerHTML = `<span class="lf-spin"></span> ${btn.dataset.busy || ''}`;
  try { return await fn(); } finally { btn.classList.remove('busy'); btn.innerHTML = html; }
}

// ───────────── персонажи ─────────────
const world = () => S.worlds.find(w => w.id === curWorldId) || S.worlds[0] || null;
function chars() {
  const w = world();
  const out = [];
  for (const p of S.all_personas) out.push({ key: `p${p.id}`, t: 'p', id: p.id, name: p.name, avatar: p.avatar, emoji: p.emoji, ai: false, user_id: p.user_id, username: p.username });
  for (const c of S.ai_chars) if (!c.world_id || !w || c.world_id === w.id) out.push({ key: `a${c.id}`, t: 'a', id: c.id, name: c.name, avatar: c.avatar, emoji: c.emoji, ai: true });
  return out;
}
const charBy = key => chars().find(c => c.key === key) || null;
function postAuthor(p) {
  if (p.ai_char_id) { const c = S.ai_chars.find(x => x.id === p.ai_char_id); return { key: `a${p.ai_char_id}`, name: c?.name || 'ИИ', avatar: c?.avatar, emoji: c?.emoji || '✦', sub: 'ИИ', ai: true }; }
  if (p.persona_id) { const c = S.all_personas.find(x => x.id === p.persona_id); return { key: `p${p.persona_id}`, name: c?.name || '???', avatar: c?.avatar, emoji: c?.emoji || '🎭', sub: c?.username || '' }; }
  const u = S.users.find(u => u.id === p.user_id);
  return { key: null, name: u?.username || '???', emoji: '💬', sub: 'вне игры', ooc: true };
}
async function loadBrief(wid = curWorldId, force = false) {
  if (!wid) return null;
  if (!BRIEF[wid] || force) { try { BRIEF[wid] = await api(`/api/worlds/${wid}/brief`); } catch { BRIEF[wid] = { chars: {} }; } }
  return BRIEF[wid];
}
async function loadWL(wid = curWorldId, force = false) {
  if (!wid) return null;
  if (!WL[wid] || force) { try { WL[wid] = await api(`/api/worlds/${wid}/life`); } catch { WL[wid] = { traces: {}, pets: [], tris: [], rumors: null, push: {}, homes: {}, cuts: [], meta: { pet_kinds: {}, tri_kinds: [], tri_ends: [] } }; } }
  return WL[wid];
}
const wl = () => WL[curWorldId] || { traces: {}, pets: [], tris: [], rumors: null, push: {}, homes: {}, cuts: [], meta: { pet_kinds: {}, tri_kinds: [], tri_ends: [] } };
const cutOf = (postId) => wl().cuts.find(c => c.post_id === postId) || null;
const hereIn = (roomId) => Object.entries(BRIEF[curWorldId]?.chars || {}).filter(([, v]) => v.room_id === roomId).map(([k]) => charBy(k)).filter(Boolean);

// ───────────── картинки ─────────────
function pickImage(cb) {
  const inp = document.createElement('input'); inp.type = 'file'; inp.accept = 'image/*';
  inp.onchange = () => {
    const f = inp.files[0]; if (!f) return;
    const rd = new FileReader();
    rd.onload = () => {
      const img = new Image();
      img.onload = async () => {
        const k = Math.min(1, 1800 / Math.max(img.width, img.height));
        const cv = document.createElement('canvas'); cv.width = Math.round(img.width * k); cv.height = Math.round(img.height * k);
        cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
        try { cb((await api('/api/upload', { method: 'POST', body: { data: cv.toDataURL('image/jpeg', .87) } })).url); } catch (e) { toast(e.message, true); }
      };
      img.src = rd.result;
    };
    rd.readAsDataURL(f);
  };
  inp.click();
}
async function drawImage({ prompt, aspect = '1:1', refs = [] }) {
  const r = await api('/api/draw', { method: 'POST', body: { prompt, aspect, refs: refs.filter(Boolean), world_id: curWorldId } });
  if (S) S.spent_today = r.spent_today;
  return r.url;
}
/** Поле картинки: превью, загрузить, нарисовать (если есть draw), убрать. */
function imgField(id, cur, { draw = false, aspect = '3:4' } = {}) {
  return `<div class="lf-field" data-imgf="${id}">
    <div class="lf-row2" style="align-items:center">
      ${fit(cur, '', '', `id="${id}-pv" style="--img:url('${esc(cur || '')}');aspect-ratio:${aspect.replace(':', '/')};max-width:86px;border-radius:10px;border:1px solid var(--lf-line2);${cur ? '' : 'display:none'}"`)}
      <div style="display:flex;flex-direction:column;gap:6px;flex:2">
        <button type="button" class="lf-btn small" id="${id}-up">${icon('upload')} Загрузить</button>
        ${draw ? `<button type="button" class="lf-btn small" id="${id}-draw" data-busy="Рисую…">${icon('wand')} Нарисовать</button>` : ''}
        <button type="button" class="lf-btn small ghost" id="${id}-clr" ${cur ? '' : 'style="display:none"'}>${icon('x')} Убрать</button>
      </div>
    </div>
    <input type="hidden" id="${id}" value="${esc(cur || '')}">
  </div>`;
}
function bindImgField(s, id, drawFn) {
  const set = (url) => {
    s.querySelector(`#${id}`).value = url || '';
    const pv = s.querySelector(`#${id}-pv`);
    if (pv) { pv.style.setProperty('--img', `url('${url}')`); pv.className = url ? 'lf-fit' : ''; pv.style.display = url ? '' : 'none'; if (!pv.querySelector('.lf-fit-i')) pv.innerHTML = '<i class="lf-fit-i"></i>'; }
    s.querySelector(`#${id}-clr`).style.display = url ? '' : 'none';
  };
  s.querySelector(`#${id}-up`).onclick = () => pickImage(set);
  s.querySelector(`#${id}-clr`).onclick = () => set('');
  const d = s.querySelector(`#${id}-draw`);
  if (d && drawFn) d.onclick = () => busy(d, async () => { try { set(await drawImage(drawFn())); toast('Нарисовано'); } catch (e) { toast(e.message, true); } });
}

// ───────────── расширения ─────────────
function loadExtensions() {
  if (extLoaded || !S) return; extLoaded = true;
  for (const x of S.extensions || []) {
    try {
      if (x.css) { const st = document.createElement('style'); st.textContent = x.css; document.head.appendChild(st); }
      if (x.js) new Function('Tavern', x.js)({ api, toast, sheet, closeSheet, state: () => S, icon });
    } catch (e) { console.error('Расширение', x.name, e); }
  }
}

// ───────────── SSE ─────────────
function connectSSE() {
  if (sse) sse.close();
  sse = new EventSource('/api/events');
  sse.onmessage = e => {
    const ev = JSON.parse(e.data);
    if (ev.type === 'post') {
      if (curRoom && ev.post.room_id === curRoom.id && !posts.some(p => p.id === ev.post.id)) { posts.push(ev.post); appendPost(ev.post); }
      const r = S?.rooms.find(r => r.id === ev.post.room_id);
      if (r) { r.last_at = ev.post.created_at; r.post_count++; r.preview = cut(ev.post.body, 90); }
      if (!curRoom && !document.querySelector('.lf-overlay')) render();
    } else if (ev.type === 'post_edit' && curRoom?.id === ev.post.room_id) {
      const i = posts.findIndex(p => p.id === ev.post.id); if (i >= 0) { posts[i] = ev.post; replacePost(ev.post); }
    } else if (ev.type === 'post_delete' && curRoom?.id === ev.room_id) {
      posts = posts.filter(p => p.id !== ev.post_id); document.getElementById(`post-${ev.post_id}`)?.remove();
    } else if (ev.type === 'ai_typing' && curRoom?.id === ev.room_id) {
      const el = document.getElementById('typing');
      if (el) { const c = S.ai_chars.find(c => c.id === ev.ai_char_id); el.innerHTML = ev.on ? `${icon('feather')} ${esc(c?.name || 'ИИ')} пишет…` : ''; }
    } else if (ev.type === 'ai_error') {
      if (curRoom?.id === ev.room_id) toast('ИИ: ' + ev.message, true);
    } else if (ev.type === 'chron') {
      if (curRoom?.id === ev.room_id) { const p = posts.find(p => p.id === ev.post_id); if (p) { p.chron = ev.chips ? { chips: ev.chips } : null; replacePost(p); } }
      const wid = ev.world_id || S.rooms.find(r => r.id === ev.room_id)?.world_id;
      if (wid) { loadBrief(wid, true); loadWL(wid, true).then(() => { if (curRoom?.world_id === wid) updateRoomHere(); }); }
      if (openCard) refreshCard();
    } else if (ev.type === 'world_life') {
      loadWL(ev.world_id, true).then(() => {
        if (curRoom?.world_id === ev.world_id) { updateRoomHere(); if (ev.what === 'cuts') posts.forEach(p => { if (cutOf(p.id)) replacePost(p); }); }
        else if (!curRoom && !document.querySelector('.lf-overlay') && ev.world_id === curWorldId && ['map', 'chars'].includes(tab)) renderTabs();
        if (openCard) refreshCard();
        const ps = document.querySelector('.lf-sheet[data-pet]'); if (ps) petSheet(ps.dataset.pet);
      });
    } else if (ev.type === 'cut_progress') {
      if (ev.step < 0) delete CUTBUSY[ev.post_id]; else CUTBUSY[ev.post_id] = { step: ev.step, of: ev.of };
      const p = posts.find(p => p.id === ev.post_id); if (p) replacePost(p);
    } else if (ev.type === 'cut') {
      delete CUTBUSY[ev.post_id];
      const wid = S.rooms.find(r => r.id === ev.room_id)?.world_id;
      loadWL(wid, true).then(() => { const p = posts.find(p => p.id === ev.post_id); if (p) replacePost(p); });
    } else if (ev.type === 'chron_error') {
      if (curRoom?.id === ev.room_id && S.me.is_admin) toast('Летописец: ' + ev.message, true);
    } else if (ev.type === 'scene') {
      const r = S.rooms.find(r => r.id === ev.room_id); if (r) r.scene = ev.scene;
      if (curRoom?.id === ev.room_id) { curRoom.scene = ev.scene; updateRoomTop(); }
    } else if (ev.type === 'life') {
      if (openCard?.key === ev.key) refreshCard();
    } else if (['rooms', 'personas', 'ai_chars', 'chronicle', 'extensions'].includes(ev.type)) {
      refreshState().then(() => { if (!document.querySelector('.lf-overlay') && !curRoom) render(); });
    }
  };
}
async function refreshState() {
  S = await api('/api/state');
  if (!META) META = await api('/api/life/meta');
  if (!composer.persona_id && S.my_personas[0]) composer.persona_id = S.my_personas[0].id;
  if (composer.persona_id && !S.my_personas.some(p => p.id === composer.persona_id)) composer.persona_id = null;
  if (!S.worlds.some(w => w.id === curWorldId)) {
    const live = [...S.rooms].sort((a, b) => (b.last_at || 0) - (a.last_at || 0))[0];
    curWorldId = (live?.last_at && live.world_id) || S.worlds[0]?.id || null;
  }
  loadExtensions();
}

// ───────────── роутинг ─────────────
window.addEventListener('hashchange', () => route());
async function route() {
  const h = location.hash || '#/';
  let m;
  curRoom = null;
  if (S && (m = h.match(/^#\/room\/(\d+)/))) {
    curRoom = S.rooms.find(r => r.id === +m[1]) || null;
    if (curRoom) {
      curWorldId = curRoom.world_id; localStorage.setItem('tavern_world', curWorldId);
      posts = (await api(`/api/rooms/${curRoom.id}/posts?limit=50`)).posts;
      loadBrief(); await loadWL();
    }
  }
  render();
}
function render() {
  const h = location.hash || '#/';
  if (!S) return renderLogin();
  if (curRoom) return renderRoom();
  if (h === '#/usage') return renderUsage();
  if (h === '#/admin') return renderAdmin();
  const m = h.match(/^#\/lore\/(\d+)/); if (m) return renderLore(+m[1]);
  renderTabs();
}
function topBar({ back = '', title = '', sub = '', right = '', candle = false, id = '' } = {}) {
  return `<div class="lf-top" ${id ? `id="${id}"` : ''}>
    <div class="lf-brand">
      ${back ? `<button class="lf-back" onclick="${back}">${icon('left')}</button>` : ''}
      ${candle ? CANDLE : ''}
      <div style="min-width:0"><div class="lf-brand-t">${title}</div>${sub ? `<div class="lf-brand-s">${sub}</div>` : ''}</div>
    </div>
    <div class="lf-top-r">${right}</div>
  </div>`;
}

// ───────────── вход ─────────────
function renderLogin(mode = 'login') {
  $app.innerHTML = `<div class="lf-login"><div class="lf-login-card">
    ${CANDLE}<h1>Таверна</h1><span class="lf-kicker">истории для своих</span>
    <div class="lf-seg"><button id="t-login" class="${mode === 'login' ? 'on' : ''}">Вход</button><button id="t-reg" class="${mode === 'reg' ? 'on' : ''}">Регистрация</button></div>
    ${mode === 'reg' ? `<input id="f-invite" placeholder="Инвайт-код" autocomplete="off">` : ''}
    <input id="f-user" placeholder="Ник" autocomplete="username">
    <input id="f-pass" type="password" placeholder="Пароль" autocomplete="current-password">
    <button class="lf-btn primary serif full" id="go">${mode === 'reg' ? 'Создать аккаунт' : 'Войти'}</button>
    <div class="lf-err" id="err"></div>
    ${mode === 'reg' ? `<div class="lf-hint" style="text-align:center">Самый первый аккаунт становится админом — инвайт ему не нужен.</div>` : ''}
  </div></div>`;
  document.getElementById('t-login').onclick = () => renderLogin('login');
  document.getElementById('t-reg').onclick = () => renderLogin('reg');
  document.getElementById('go').onclick = async () => {
    const body = { username: document.getElementById('f-user').value, password: document.getElementById('f-pass').value };
    try {
      if (mode === 'reg') { body.invite = document.getElementById('f-invite')?.value || ''; await api('/api/register', { method: 'POST', body }); }
      else await api('/api/login', { method: 'POST', body });
      await boot();
    } catch (e) { document.getElementById('err').textContent = e.message; }
  };
}

// ───────────── табы ─────────────
const TABS = [['rooms', 'scene', 'Истории'], ['chars', 'users', 'Персонажи'], ['map', 'map', 'Мир'], ['settings', 'settings', 'Настройки']];
async function renderTabs() {
  await Promise.all([loadBrief(), loadWL()]);
  const w = world();
  const me = S.my_personas.find(p => p.id === composer.persona_id) || S.my_personas[0];
  const body = tab === 'rooms' ? roomsTab() : tab === 'chars' ? charsTab() : tab === 'map' ? mapTab() : settingsTab();
  const ti = TABS.findIndex(t => t[0] === tab);
  $app.innerHTML = `
    ${topBar({ candle: true, title: `${esc(S.app_title)}`, sub: esc([w?.title, BRIEF[curWorldId]?.clock].filter(Boolean).join(' · ')), right: me ? `<button id="top-me">${ava({ ...me }, 'ring')}</button>` : '' })}
    <div class="lf-body anim" id="body">${body}</div>
    <nav class="lf-tabs">${TABS.map(([id, ic, l]) => `<button class="lf-tab ${tab === id ? 'on' : ''}" data-tab="${id}">${icon(ic)}${l}</button>`).join('')}
      <i class="lf-tab-ink" style="transform:translateX(${ti * 100}%)"></i></nav>`;
  document.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => { tab = b.dataset.tab; renderTabs(); });
  const tm = document.getElementById('top-me'); if (tm) tm.onclick = () => openCardSheet(`p${me.id}`);
  bindTab();
}
function worldChips() {
  if (S.worlds.length <= 1) return '';
  return `<div class="lf-chips">${S.worlds.map(w => `<button class="lf-chip ${w.id === curWorldId ? 'on' : ''}" data-world="${w.id}"><span class="emoji">${w.emoji}</span> ${esc(w.title)}</button>`).join('')}</div>`;
}
function roomCard(r) {
  const here = hereIn(r.id);
  return `<button class="lf-card lf-chcard" onclick="location.hash='#/room/${r.id}'">
    ${fit(r.cover, 'lf-chcard-img', r.cover ? '' : icon(r.kind === 'chat' ? 'message' : 'scene'))}
    <div class="lf-chcard-txt">
      <div class="lf-chcard-head"><b>${esc(r.title)}</b><small>${r.last_at ? fmtTime(r.last_at) : ''}</small></div>
      <div class="lf-chcard-prev">${esc(r.preview || r.description || 'Ещё ни слова…')}</div>
      ${here.length ? `<div class="lf-chcard-who">${here.slice(0, 5).map(c => ava(c, 'xs')).join('')}<span>сейчас здесь</span></div>` : ''}
    </div>
  </button>`;
}
function roomsTab() {
  const w = world();
  const rooms = w ? S.rooms.filter(r => r.world_id === w.id).sort((a, b) => (b.last_at || 0) - (a.last_at || 0)) : [];
  return `${worldChips()}
    <div class="lf-pagehead"><h1>Ваши истории</h1>${S.me.is_admin ? `<button class="lf-btn primary small" id="rt-new">${icon('plus')} Комната</button>` : ''}</div>
    <div class="lf-chlist">${rooms.map(roomCard).join('') || `<div class="lf-empty">${icon('scene')}Комнат пока нет.${S.me.is_admin ? '<br>Жми «Комната».' : ''}</div>`}</div>`;
}
function charsTab() {
  const br = BRIEF[curWorldId]?.chars || {};
  const list = chars();
  const card = c => {
    const b = br[c.key] || {};
    const room = S.rooms.find(r => r.id === b.room_id);
    return `<button class="lf-pcard" data-card="${c.key}">
      ${fit(c.avatar, 'lf-pcard-img', c.avatar ? '' : `<span class="emoji">${esc(c.emoji || '?')}</span>`)}
      <span class="lf-pcard-tag">${c.ai ? 'ИИ' : esc(c.username || '')}</span>
      <div class="lf-pcard-t"><b>${esc(c.name)}</b><small>${esc(b.state || (room ? room.title : '') || ' ')}</small></div>
    </button>`;
  };
  return `${worldChips()}
    <div class="lf-pagehead"><h1>Персонажи</h1><button class="lf-btn small" id="ct-mine">${icon('user')} Мои маски</button></div>
    ${list.length ? `<div class="lf-pgrid">${list.map(card).join('')}</div>` : `<div class="lf-empty">${icon('users')}Пока никого.</div>`}`;
}
const SLOTS = [[22, 26, 'top-left'], [50, 20, 'top-center'], [78, 26, 'top-right'], [22, 55, 'middle-left'], [50, 50, 'center'], [78, 55, 'middle-right'], [24, 84, 'bottom-left'], [50, 82, 'bottom-center'], [76, 84, 'bottom-right']];
function mapTab() {
  const w = world();
  if (!w) return `<div class="lf-empty">${icon('globe')}Миров нет.</div>`;
  const rooms = S.rooms.filter(r => r.world_id === w.id);
  const pinned = rooms.filter(r => r.map_x != null);
  const br = BRIEF[w.id] || {};
  const myKey = composer.persona_id ? `p${composer.persona_id}` : null;
  const myRoom = myKey ? br.chars?.[myKey]?.room_id : null;
  return `${worldChips()}
    <div class="lf-pagehead"><h1><span class="emoji">${w.emoji}</span> ${esc(w.title)}</h1></div>
    <div class="lf-clock"><b>${esc(br.clock || 'Время не отмечено')}</b><small>время истории — его ведёт Летописец</small></div>
    ${w.map ? `<div class="lf-map" id="map"><div class="lf-map-in" id="mapin"><img src="${esc(w.map)}" draggable="false" alt="">
      ${pinned.map(r => { const who = hereIn(r.id); return `<button class="lf-pin ${r.id === myRoom ? 'here' : ''}" data-pin="${r.id}" style="left:${r.map_x}%;top:${r.map_y}%">
        <span class="lf-pin-label">${icon(r.kind === 'chat' ? 'message' : 'pin')}${esc(r.title)}${who.length ? `<span class="lf-pin-who">${who.slice(0, 3).map(c => ava(c, 'xs')).join('')}</span>` : ''}</span><i class="lf-pin-stem"></i><i class="lf-pin-dot"></i></button>`; }).join('')}
      </div></div>`
    : `<div class="lf-mapempty">${icon('map')}<b>Карты пока нет</b><span>${S.me.is_admin ? 'Нарисуй её по местам этого мира или загрузи свою.' : 'Админ ещё не повесил карту.'}</span></div>`}
    ${S.me.is_admin ? `<div class="lf-actions">
      <button class="lf-btn" id="mt-draw" data-busy="Рисую карту…">${icon('wand')} ${w.map ? 'Перерисовать' : 'Нарисовать'}</button>
      <button class="lf-btn" id="mt-up">${icon('upload')} Своя карта</button>
      ${w.map ? `<button class="lf-btn" id="mt-pins">${icon('pin')} Метки</button>` : ''}</div>` : ''}
    <div class="lf-sec"><span>Места</span><i class="lf-sec-line"></i><small>${rooms.length}</small></div>
    <div class="lf-chlist">${rooms.map(roomCard).join('') || `<div class="lf-hint-i">Мест пока нет</div>`}</div>
    ${worldLifeHtml()}`;
}
function petCard(p) {
  const room = S.rooms.find(r => r.id === p.home);
  return `<button class="lf-petcard" data-pet="${p.id}">${p.img ? fit(p.img) : `<span class="ph">${icon('paw')}</span>`}
    ${p.urgent.length ? `<span class="need">${esc(p.needs.find(n => n.v < 30)?.word || 'просит')}</span>` : ''}
    <span class="lf-petcard-t"><b>${esc(p.name)}</b><small>${esc(p.kind_label)}${room ? ` · ${esc(room.title)}` : ''}</small></span></button>`;
}
function triFig(t) {
  const c = t.people.find(x => x.key === t.center) || t.people[0];
  const sides = t.people.filter(x => x !== c);
  return `<span class="lf-tri-fig"><svg viewBox="0 0 80 70" aria-hidden="true"><path d="M40 14 L13 56 L67 56 Z"/></svg>
    <span class="v c">${ava(c)}</span><span class="v l">${ava(sides[0])}</span><span class="v r">${ava(sides[1])}</span></span>`;
}
function triCard(t) {
  const M = wl().meta;
  const k = M.tri_kinds.find(x => x[0] === t.kind) || M.tri_kinds[0] || ['', '', 'eye'];
  const e = M.tri_ends.find(x => x[0] === t.end) || M.tri_ends[0] || ['', ''];
  const c = t.people.find(x => x.key === t.center) || t.people[0];
  const sides = t.people.filter(x => x !== c).map(x => x.name);
  return `<button class="lf-tri${t.on === false ? ' off' : ''}" data-tri="${t.id}">${triFig(t)}
    <span class="lf-tri-t"><b>${esc(sides[0] || '?')} — ${esc(c?.name || '?')} — ${esc(sides[1] || '?')}</b>
      <small>${icon(k[2])} ${esc(k[1])} · ${esc(e[1])}${t.on === false ? ' · выключен' : ''}</small>
      <span class="lf-tri-heat"><span>Накал</span><i class="lf-meter"><b style="width:${t.heat}%"></b></i><small>${t.heat}</small></span>
      ${t.note ? `<span class="lf-tri-note">${esc(cut(t.note, 120))}</span>` : ''}</span></button>`;
}
const TRUTH = { 'правда': 'yes', 'полуправда': 'half', 'враньё': 'no' };
function rumorsHtml(R) {
  if (!R) return `<div class="lf-hint-i">Слухов пока нет — они сами появятся в новый день истории, или собери их сейчас.</div>`;
  return `${R.news.map(n => `<div class="lf-news"><h3>${esc(n.title)}</h3><p>${esc(n.text)}</p></div>`).join('')}
    ${R.rumors.map((r, i) => `<div class="lf-rumor"><q>${esc(r.text)}</q><div class="lf-rumor-f"><small>${icon('ear')} ${esc(r.source)}</small>
      <button class="lf-truth ${TRUTH[r.truth] || 'half'}" data-truth>${esc(r.truth)}</button><button class="lf-iconbtn sm" data-push="${i}" title="Подкинуть в сцену">${icon('send')}</button></div></div>`).join('')}
    <div class="lf-hint">Собраны${R.clock ? ` · ${esc(R.clock)}` : ''}. Тап по «правда?» — подсмотреть. ${icon('send')} — подкинуть слух в сцену, ИИ его упомянет.</div>`;
}
function worldLifeHtml() {
  const d = wl();
  const tris = d.tris;
  const cuts = d.cuts.slice().reverse();
  return `
    <div class="lf-sec"><span>Питомцы</span><i class="lf-sec-line"></i><small>${d.pets.length || ''}</small></div>
    ${d.pets.length ? `<div class="lf-petgrid">${d.pets.map(petCard).join('')}</div>` : `<div class="lf-hint-i">Питомцев нет. Летописец заведёт сам, если в истории появится кот или пёс.</div>`}
    <button class="lf-btn ghost full" id="wl-pet" style="margin-top:8px">${icon('plus')} Питомец</button>
    <div class="lf-sec"><span>Треугольники</span><i class="lf-sec-line"></i><small>${tris.length || ''}</small></div>
    ${tris.map(triCard).join('') || `<div class="lf-hint-i">Трое, где чувства к одному влияют на другого. Когда все трое в сцене — ИИ держит эту ось.</div>`}
    <button class="lf-btn ghost full" id="wl-tri">${icon('plus')} Треугольник</button>
    <div class="lf-sec"><span>Новости и слухи</span><i class="lf-sec-line"></i></div>
    ${rumorsHtml(d.rumors)}
    <button class="lf-btn full" id="wl-rumors" data-busy="Собираю слухи…">${icon('ear')} ${d.rumors ? 'Свежие слухи' : 'Собрать слухи'}</button>
    ${cuts.length ? `<div class="lf-sec"><span>Кат-сцены</span><i class="lf-sec-line"></i><small>${cuts.length}</small></div>
      <div class="lf-strip">${cuts.map(c => `<button class="lf-cuttile" data-cutplay="${c.id}"><span class="lf-cuttile-img" style="background-image:url('${esc(c.frames[0]?.img || '')}')"></span><span class="lf-cuttile-play">${icon('play')}</span><small>${esc(cut(c.title, 26))}</small></button>`).join('')}</div>` : ''}`;
}
function settingsTab() {
  const row = (id, ic, t, s = '') => `<button class="lf-row" id="${id}">${icon(ic)}<span class="lf-grow"><b>${t}</b>${s ? `<small>${s}</small>` : ''}</span>${icon('right')}</button>`;
  return `<div class="lf-pagehead"><h1>Настройки</h1></div>
    ${row('st-personas', 'user', 'Мои маски', 'персонажи, за которых ты играешь')}
    <div class="lf-sec"><span>Вид</span><i class="lf-sec-line"></i></div>
    <div class="lf-field"><label>Палитра</label><div class="lf-seg">${[['graphite', 'Графит'], ['paper', 'Бумага'], ['moon', 'Луна']].map(([k, l]) => `<button data-pal="${k}" class="${prefs.pal === k ? 'on' : ''}">${l}</button>`).join('')}</div></div>
    <div class="lf-field"><label>Аватарки в постах</label><div class="lf-seg">${[['banner', 'Баннер'], ['portrait', 'Портрет'], ['small', 'Мелкие']].map(([k, l]) => `<button data-avm="${k}" class="${prefs.ava === k ? 'on' : ''}">${l}</button>`).join('')}</div></div>
    <div class="lf-sec"><span>Прочее</span><i class="lf-sec-line"></i></div>
    ${row('st-usage', 'wallet', 'Траты за месяц', `сегодня ${money(S.spent_today)}${S.daily_limit != null ? ` из ${money(S.daily_limit)}` : ''}`)}
    ${S.me.is_admin ? row('st-admin', 'key', 'Админка', 'миры, комнаты, ИИ, лорбуки, модели') : ''}
    ${row('st-out', 'enter', `Выйти`, esc(S.me.username))}`;
}
function bindTab() {
  document.querySelectorAll('[data-world]').forEach(b => b.onclick = async () => { curWorldId = +b.dataset.world; localStorage.setItem('tavern_world', curWorldId); renderTabs(); });
  const on = (id, fn) => { const el = document.getElementById(id); if (el) el.onclick = fn; };
  on('rt-new', () => roomForm(null, renderTabs));
  on('ct-mine', personasSheet);
  document.querySelectorAll('[data-card]').forEach(b => b.onclick = () => openCardSheet(b.dataset.card));
  document.querySelectorAll('[data-pin]').forEach(b => b.onclick = () => { location.hash = `#/room/${b.dataset.pin}`; });
  on('mt-pins', pinsSheet);
  on('wl-pet', () => petForm());
  on('wl-tri', () => triSheet());
  on('wl-rumors', () => busy(document.getElementById('wl-rumors'), async () => { try { const r = await api(`/api/worlds/${curWorldId}/rumors`, { method: 'POST' }); S.spent_today = r.spent_today; await loadWL(curWorldId, true); renderTabs(); } catch (e) { toast(e.message, true); } }));
  document.querySelectorAll('[data-pet]').forEach(b => b.onclick = () => petSheet(b.dataset.pet));
  document.querySelectorAll('[data-tri]').forEach(b => b.onclick = () => triSheet(wl().tris.find(t => t.id === b.dataset.tri)));
  document.querySelectorAll('[data-truth]').forEach(b => b.onclick = () => b.classList.toggle('show'));
  document.querySelectorAll('[data-cutplay]').forEach(b => b.onclick = () => playCut(wl().cuts.find(c => c.id === b.dataset.cutplay)));
  document.querySelectorAll('[data-push]').forEach(b => b.onclick = () => pushRumor(wl().rumors.rumors[+b.dataset.push]?.text));
  on('mt-up', () => pickImage(async url => { await api(`/api/worlds/${curWorldId}`, { method: 'PATCH', body: { map: url } }); await refreshState(); renderTabs(); }));
  on('mt-draw', () => busy(document.getElementById('mt-draw'), drawMap));
  document.querySelectorAll('[data-pal]').forEach(b => b.onclick = () => { applyPal(b.dataset.pal); renderTabs(); });
  document.querySelectorAll('[data-avm]').forEach(b => b.onclick = () => { prefs.ava = b.dataset.avm; localStorage.setItem('tavern_ava', prefs.ava); renderTabs(); });
  on('st-personas', personasSheet);
  on('st-usage', () => location.hash = '#/usage');
  on('st-admin', () => location.hash = '#/admin');
  on('st-out', async () => { await api('/api/logout', { method: 'POST' }); S = null; location.hash = ''; render(); });
}

// карта: нарисовать по местам, метки встают сами
async function drawMap() {
  const w = world();
  const rooms = S.rooms.filter(r => r.world_id === w.id && r.kind === 'forum').slice(0, SLOTS.length);
  const slotOf = (i) => SLOTS[[4, 0, 2, 6, 8, 1, 7, 3, 5][i]];
  const places = rooms.map((r, i) => `${r.title}${r.description ? ` (${cut(r.description, 80)})` : ''} — in the ${slotOf(i)[2]} area`).join('; ');
  const prompt = `An illustrated top-down city/area map for a story world "${w.title}". ${cut(S.worlds.find(x => x.id === w.id)?.prompt || '', 300)}. Draw small illustrated landmarks for these places, each in its own area: ${places}. Streets, districts, water, parks between them. No text, no labels, no letters.`;
  try {
    const url = await drawImage({ prompt, aspect: '3:4' });
    await api(`/api/worlds/${w.id}`, { method: 'PATCH', body: { map: url } });
    for (let i = 0; i < rooms.length; i++) if (rooms[i].map_x == null) { const [x, y] = slotOf(i); await api(`/api/rooms/${rooms[i].id}`, { method: 'PATCH', body: { map_x: x, map_y: y } }); }
    await refreshState(); renderTabs(); toast('Карта готова — метки встали сами, их можно передвинуть');
  } catch (e) { toast(e.message, true); }
}
function pinsSheet() {
  const w = world();
  const rooms = S.rooms.filter(r => r.world_id === w.id);
  sheet(`<h2>Метки на карте</h2><div class="lf-hint">Выбери место — потом тапни точку на карте.</div>
    ${rooms.map(r => `<div class="lf-row">${icon(r.map_x != null ? 'pin' : 'plus')}<button class="lf-grow" data-place="${r.id}" style="text-align:left"><b>${esc(r.title)}</b><small>${r.map_x != null ? 'стоит на карте' : 'без метки'}</small></button>
      ${r.map_x != null ? `<button class="lf-iconbtn sm" data-unpin="${r.id}">${icon('x')}</button>` : ''}</div>`).join('')}`, s => {
    s.querySelectorAll('[data-unpin]').forEach(b => b.onclick = async () => { await api(`/api/rooms/${b.dataset.unpin}`, { method: 'PATCH', body: { map_x: null, map_y: null } }); await refreshState(); closeSheet(); renderTabs(); });
    s.querySelectorAll('[data-place]').forEach(b => b.onclick = () => {
      const id = +b.dataset.place; closeSheet(); toast('Тапни точку на карте');
      const map = document.getElementById('map'), inn = document.getElementById('mapin'); if (!inn) return;
      map.classList.add('editing');
      const h = async (e) => {
        e.preventDefault(); e.stopPropagation();
        const r = inn.getBoundingClientRect();
        inn.removeEventListener('click', h, true); map.classList.remove('editing');
        await api(`/api/rooms/${id}`, { method: 'PATCH', body: { map_x: +((e.clientX - r.left) / r.width * 100).toFixed(1), map_y: +((e.clientY - r.top) / r.height * 100).toFixed(1) } });
        await refreshState(); renderTabs();
      };
      inn.addEventListener('click', h, true);
    });
  });
}

// ───────────── шторки ─────────────
function sheet(html, setup, { full = false } = {}) {
  closeSheet();
  const ov = document.createElement('div'); ov.className = 'lf-overlay';
  ov.innerHTML = `<div class="lf-sheet${full ? ' full' : ''}"><button class="lf-sheet-x" aria-label="Закрыть">${icon(full ? 'left' : 'x')}</button>${html}</div>`;
  ov.onclick = e => { if (e.target === ov) closeSheet(); };
  ov.querySelector('.lf-sheet-x').onclick = closeSheet;
  document.body.appendChild(ov);
  if (setup) setup(ov.querySelector('.lf-sheet'));
  return ov.querySelector('.lf-sheet');
}
function closeSheet() { document.querySelector('.lf-overlay')?.remove(); openCard = null; }

// ───────────── карточка персонажа ─────────────
const CARD_TABS = [['person', 'idcard', 'Личность'], ['life', 'heart', 'Жизнь'], ['wardrobe', 'shirt', 'Гардероб'], ['things', 'box', 'Вещи'], ['rel', 'handshake', 'Связи']];
const ROMANCE = [['off', 'Нет'], ['some', 'Иногда'], ['lots', 'Часто']];
async function openCardSheet(key, sub) {
  openCard = { key, sub: sub || openCard?.sub || 'person' };
  await refreshCard(true);
}
async function refreshCard(first = false) {
  if (!openCard) return;
  const k = openCard.key;
  let d;
  try { [d] = await Promise.all([api(`/api/life/${k[0]}/${k.slice(1)}?world=${curWorldId}`), loadWL()]); } catch (e) { return toast(e.message, true); }
  if (!openCard || openCard.key !== k) return;
  const keep = document.querySelector('.lf-sheet.full')?.scrollTop || 0;
  const c = d.char;
  const room = d.location ? S.rooms.find(r => r.id === d.location.room_id) : null;
  const sub = openCard.sub;
  const html = `
    <div class="lf-hero ${c.avatar ? '' : 'bare'}">${c.avatar ? fit(c.avatar, '', '', 'style="position:absolute;inset:0"') : `<div class="lf-hero-none" style="position:absolute;inset:0"><span class="emoji">${esc(c.emoji || '✦')}</span></div>`}
      ${d.can_edit ? `<div class="lf-hero-tools"><button class="lf-glass round" id="cd-up" title="Загрузить портрет">${icon('upload')}</button><button class="lf-glass" id="cd-draw" data-busy="Рисую…">${icon('wand')} Портрет</button></div>` : ''}
      <div class="lf-hero-cap"><span class="lf-kicker">${c.ai ? 'ИИ-персонаж' : `игрок · ${esc(S.users.find(u => u.id === c.user_id)?.username || '')}`}</span><h1>${esc(c.name)}</h1>
        <div class="lf-hero-pills">
          ${room ? `<span class="lf-pill">${icon('pin')} ${esc(room.title)} · ${ago(d.location.at)}</span>` : ''}
          ${d.state_label ? `<span class="lf-pill">${icon(META.states.find(s => s[1] === d.state_label || s[2] === d.state_label)?.[3] || 'sparkles')} ${esc(d.state_label)}</span>` : ''}
        </div></div>
    </div>
    <div class="lf-seg tabs5">${CARD_TABS.map(([id, ic, l]) => `<button data-ctab="${id}" class="${sub === id ? 'on' : ''}">${icon(ic)}${l}</button>`).join('')}</div>
    <div id="cd-body">${cardBody(d, sub)}</div>`;
  const s = document.querySelector('.lf-sheet.full');
  if (s && !first) { s.innerHTML = `<button class="lf-sheet-x">${icon('left')}</button>${html}`; s.querySelector('.lf-sheet-x').onclick = closeSheet; s.scrollTop = keep; bindCard(s, d); }
  else { const keepCard = openCard; const sh = sheet(html, null, { full: true }); openCard = keepCard; bindCard(sh, d); }
}
const lock = `<div class="lf-empty">${icon('lock')}Хозяин скрыл это от других</div>`;
function cardBody(d, sub) {
  const c = d.char, p = d.prof, E = d.can_edit;
  if (sub === 'person') {
    const kv = [['Возраст', p.card.age], ['Внешность', p.card.look], ['Характер', p.card.traits], ['История', p.card.story]].filter(x => x[1]);
    return `
      ${!c.ai && c.bio ? `<div class="lf-sec"><span>Кто это</span><i class="lf-sec-line"></i></div><div class="lf-text">${esc(c.bio)}</div>` : ''}
      <div class="lf-sec"><span>Личность</span><i class="lf-sec-line"></i>${E ? `<button class="lf-link" id="cd-edit">${icon('pencil')} изменить</button>` : ''}</div>
      ${kv.length ? `<dl class="lf-kv">${kv.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join('')}</dl>` : `<div class="lf-hint-i">Карточка пока пустая</div>`}
      ${homeHtml(d)}
      ${p.hobbies.length ? `<div class="lf-sec"><span>Увлечения</span><i class="lf-sec-line"></i></div><div class="lf-chips wrap">${p.hobbies.map(t => `<span class="lf-chip mini">${esc(t)}</span>`).join('')}</div>` : ''}
      ${p.likes.length || p.dislikes.length ? `<div class="lf-sec"><span>Вкусы</span><i class="lf-sec-line"></i><small>замечает Летописец</small></div>
        <div class="lf-chips wrap">${p.likes.map(t => `<span class="lf-chip mini">${icon('heart')} ${esc(t)}</span>`).join('')}${p.dislikes.map(t => `<span class="lf-chip mini" style="opacity:.7">${icon('x')} ${esc(t)}</span>`).join('')}</div>` : ''}
      ${p.facts.length || E ? `<div class="lf-sec"><span>Важное</span><i class="lf-sec-line"></i><small>это помнит ИИ</small></div>
        ${p.facts.map((f, i) => `<div class="lf-row">${icon('feather')}<span class="lf-grow">${esc(f)}</span>${E ? `<button class="lf-iconbtn sm" data-fdel="${i}">${icon('x')}</button>` : ''}</div>`).join('')}
        ${E ? `<div class="lf-row2" style="margin-top:6px"><input id="cd-fact" placeholder="напр.: должна Тони услугу"><button class="lf-btn icon" id="cd-factadd">${icon('plus')}</button></div>` : ''}` : ''}
      ${E ? `<div class="lf-actions"><button class="lf-btn" id="cd-fill" data-busy="Думаю…">${icon('sparkles')} ${c.ai ? 'Заполнить по карточке' : 'Разложить анкету'}</button></div>
        <div class="lf-hint">${c.ai ? 'ИИ додумает ему увлечения, вкусы, мысли и желания по карточке — проверь и поправь.' : 'Разложит по полям то, что ты написала в «Кто это». Ничего не придумывает — за твоего персонажа решаешь ты.'}</div>` : ''}
      ${E && !c.ai ? `<label class="lf-check"><input type="checkbox" id="cd-share" ${p.share ? 'checked' : ''}> Показывать другим игрокам «Жизнь» и «Связи»</label>` : ''}`;
  }
  if (sub === 'life') {
    if (!d.can_see) return lock;
    const st = d.state;
    return `
      <div class="lf-sec"><span>Тело</span><i class="lf-sec-line"></i><small>тает по времени истории</small></div>
      <div class="lf-bars">${d.body.map(n => `<button class="lf-bar-row ${n.v < 30 ? 'low' : ''}" data-need="${n.k}">${icon(n.ic)}<span>${n.label}</span><span class="lf-meter"><b style="width:${n.v}%"></b></span><small>${n.v}</small><em>${esc(n.word)}</em></button>`).join('')}</div>
      ${d.wounds.length || E ? `<div class="lf-chips wrap">${d.wounds.map(w => `<span class="lf-chip mini">${icon('activity')} ${esc(w.t)}${E ? ` <button class="x" data-wdel="${w.id}">✕</button>` : ''}</span>`).join('')}${E ? `<button class="lf-chip mini" id="cd-wadd">${icon('plus')} рана</button>` : ''}</div>` : ''}
      <div class="lf-sec"><span>Состояние</span><i class="lf-sec-line"></i><small>${st ? (st.manual ? 'задано руками' : 'видит Летописец') : 'ровно'}</small></div>
      <div class="lf-chips wrap">${META.states.map(([id, m, f, ic]) => `<button class="lf-chip ${st?.id === id ? 'on' : ''}" ${E ? `data-st="${id}"` : 'disabled'}>${icon(ic)} ${p.fem ? f : m}</button>`).join('')}</div>
      ${st?.why ? `<div class="lf-hint-i">${esc(st.why)}</div>` : ''}
      ${c.ai ? aiLifeHtml(d) : ''}`;
  }
  if (sub === 'wardrobe') {
    const looks = d.items.filter(i => i.kind === 'образ'), pieces = d.items.filter(i => i.kind === 'одежда');
    return `
      <div class="lf-sec"><span>Сейчас</span><i class="lf-sec-line"></i></div>
      <button class="lf-outfit" ${E ? 'id="cd-outfit"' : ''}><small>${p.fem ? 'на ней' : 'на нём'} · следит Летописец</small>${esc(d.outfit || looks.find(l => l.equipped)?.descr || 'не отмечено')}</button>
      <div class="lf-sec"><span>Образы</span><i class="lf-sec-line"></i><small>целиком</small></div>
      <div class="lf-looks">${looks.map(l => `<button class="lf-look ${l.equipped ? 'on' : ''}" data-item="${l.id}">${fit(l.image, 'lf-look-img', l.image ? '' : icon('shirt'))}${l.equipped ? `<span class="lf-look-badge">надето</span>` : ''}<div class="lf-look-t"><b>${esc(l.name)}</b><small>${esc(l.descr)}</small></div></button>`).join('')}
        ${E ? `<button class="lf-look" id="cd-lookadd"><div class="lf-look-img" style="display:grid;place-items:center">${icon('plus')}</div><div class="lf-look-t"><b>Новый образ</b><small>описать, нарисовать или загрузить</small></div></button>` : ''}</div>
      ${!looks.length && !E ? `<div class="lf-hint-i">Гардероб пуст</div>` : ''}
      ${pieces.length || E ? `<div class="lf-sec"><span>Отдельные вещи</span><i class="lf-sec-line"></i></div>${pieces.map(itemRow).join('')}${E ? `<button class="lf-btn ghost full" data-iadd="одежда">${icon('plus')} Вещь гардероба</button>` : ''}` : ''}`;
  }
  if (sub === 'things') {
    const things = d.items.filter(i => i.kind === 'вещь'), cars = d.items.filter(i => i.kind === 'транспорт');
    return `
      <div class="lf-sec"><span>Вещи</span><i class="lf-sec-line"></i><small>ведёт Летописец</small></div>
      ${things.map(itemRow).join('') || `<div class="lf-hint-i">Пусто</div>`}
      ${E ? `<button class="lf-btn ghost full" data-iadd="вещь">${icon('plus')} Вещь</button>` : ''}
      <div class="lf-sec"><span>Гараж</span><i class="lf-sec-line"></i></div>
      ${cars.map(itemRow).join('') || `<div class="lf-hint-i">Пешком</div>`}
      ${E ? `<button class="lf-btn ghost full" data-iadd="транспорт">${icon('plus')} Транспорт</button>` : ''}`;
  }
  if (sub === 'rel') {
    if (!d.can_see) return lock;
    const tris = wl().tris.filter(t => t.who.includes(c.key));
    return `${d.relations.length ? d.relations.map(r => relCard(d, r)).join('') : `<div class="lf-empty">${icon('handshake')}Связей пока нет — Летописец заведёт их сам, когда персонажи встретятся в сцене.</div>`}
      ${E ? `<button class="lf-btn ghost full" id="cd-reladd">${icon('plus')} Связь вручную</button>` : ''}
      <div class="lf-sec"><span>Треугольники</span><i class="lf-sec-line"></i><small>${tris.length || ''}</small></div>
      ${tris.map(triCard).join('') || `<div class="lf-hint-i">Треугольников с ${esc(c.name)} нет</div>`}
      ${E ? `<button class="lf-btn ghost full" id="cd-trinew">${icon('plus')} Треугольник</button>` : ''}`;
  }
  return '';
}
function homeHtml(d) {
  const rooms = S.rooms.filter(r => r.world_id === curWorldId);
  const home = rooms.find(r => r.id === d.home);
  if (!d.can_edit) return home ? `<div class="lf-sec"><span>Дом</span><i class="lf-sec-line"></i></div><div class="lf-row">${icon('home')}<span class="lf-grow"><b>${esc(home.title)}</b></span></div>` : '';
  return `<div class="lf-sec"><span>Дом</span><i class="lf-sec-line"></i><small>${d.char.ai ? 'туда он оставляет записки и подарки' : 'где живёт в этом мире'}</small></div>
    <div class="lf-field" style="margin-top:0"><select id="cd-home"><option value="">— не задан —</option>${rooms.map(r => `<option value="${r.id}" ${d.home === r.id ? 'selected' : ''}>${esc(r.title)}</option>`).join('')}</select></div>`;
}
function itemRow(i) {
  const ic = i.kind === 'транспорт' ? 'car' : i.kind === 'одежда' ? 'shirt' : 'box';
  const last = i.story?.[i.story.length - 1];
  return `<button class="lf-item" data-item="${i.id}">${fit(i.image, 'lf-item-img', i.image ? '' : icon(ic))}
    <span><b>${esc(i.name)}</b><small>${i.from_name ? `от ${esc(i.from_name)} · ` : ''}${esc(i.descr || (i.equipped ? 'при себе' : 'лежит'))}</small>${last ? `<div class="lf-story">${esc(last.t)}</div>` : ''}</span>${icon('right')}</button>`;
}
function aiLifeHtml(d) {
  const p = d.prof, E = d.can_edit, armed = d.armed || {};
  const dots = w => '●'.repeat(w || 1) + '○'.repeat(3 - (w || 1));
  const thought = t => `<div class="lf-row ${armed.id === t.id ? 'armed' : ''} ${t.status !== 'on' ? 'done' : ''}">${icon('brain')}<span class="lf-grow"><b style="font-size:14.5px;font-family:var(--lf-sans);font-weight:400">${esc(t.t)}</b><small class="lf-dots">${dots(t.w)}</small></span>
    ${E && t.status === 'on' ? `<button class="lf-iconbtn sm" data-arm="thought:${t.id}" title="в следующем ответе">${icon('zap')}</button><button class="lf-iconbtn sm" data-tdel="${t.id}">${icon('x')}</button>` : ''}</div>`;
  const want = t => `<div class="lf-row ${armed.id === t.id ? 'armed' : ''} ${t.status !== 'on' ? 'done' : ''}">${icon('target')}<span class="lf-grow"><b style="font-size:14.5px;font-family:var(--lf-sans);font-weight:400">${esc(t.t)}</b>${t.with ? `<small>с ${esc(t.with)}</small>` : ''}</span>
    ${E && t.status === 'on' ? `<button class="lf-iconbtn sm" data-arm="want:${t.id}">${icon('zap')}</button><button class="lf-iconbtn sm" data-wdone="${t.id}">${icon('check')}</button><button class="lf-iconbtn sm" data-wwdel="${t.id}">${icon('x')}</button>` : ''}</div>`;
  const ideas = d.ideas.filter(i => i.status === 'new' || i.status === 'armed').slice(-8);
  const done = d.ideas.filter(i => i.status === 'done').slice(-3);
  return `
    <div class="lf-sec"><span>На уме</span><i class="lf-sec-line"></i><small>⚡ — в следующем ответе</small></div>
    ${d.thoughts.filter(t => t.status === 'on').map(thought).join('') || `<div class="lf-hint-i">Ничего не тяготит</div>`}
    ${E ? `<div class="lf-row2"><input id="cd-th" placeholder="что его тяготит"><button class="lf-btn icon" id="cd-thadd">${icon('plus')}</button></div>` : ''}
    <div class="lf-sec"><span>Хочет сам</span><i class="lf-sec-line"></i><small>не про игроков</small></div>
    ${d.wants.filter(t => t.status === 'on').map(want).join('') || `<div class="lf-hint-i">Своих желаний пока нет</div>`}
    ${E ? `<div class="lf-row2"><input id="cd-wa" placeholder="напр.: хоккей с Сэмом в субботу"><button class="lf-btn icon" id="cd-waadd">${icon('plus')}</button></div>` : ''}
    <div class="lf-sec"><span>Характер</span><i class="lf-sec-line"></i></div>
    <div class="lf-field"><label>Что заводит</label><div class="lf-chips wrap">${p.turnons.map((t, i) => `<span class="lf-chip mini">${icon('flame')} ${esc(t)}${E ? ` <button class="x" data-todel="${i}">✕</button>` : ''}</span>`).join('')}${E ? `<button class="lf-chip mini" id="cd-toadd">${icon('plus')}</button>` : ''}</div></div>
    <div class="lf-field"><label>Ухаживает сам${p.romance.rel ? ` · ${esc(p.romance.rel)}` : ''}</label><div class="lf-seg" style="margin:4px 0 6px">${ROMANCE.map(([k, l]) => `<button ${E ? `data-rom="${k}"` : ''} class="${p.romance.level === k ? 'on' : ''}">${l}</button>`).join('')}</div>
      ${p.romance.style ? `<div class="lf-hint-i" style="text-align:left">${esc(p.romance.style)}</div>` : ''}${E ? `<button class="lf-link" id="cd-romedit">${icon('pencil')} как именно</button>` : ''}</div>
    <div class="lf-field"><label>Делится мыслями</label><div class="lf-seg" style="margin:4px 0">${Object.entries(META.freq).map(([k, l]) => `<button ${E ? `data-talk="${k}"` : ''} class="${p.talk === k ? 'on' : ''}">${l}</button>`).join('')}</div></div>
    <div class="lf-sec"><span>Инициатива</span><i class="lf-sec-line"></i><small>делает шаг сам</small></div>
    <div class="lf-seg" style="margin:4px 0 8px">${Object.entries(META.freq).map(([k, l]) => `<button ${E ? `data-ifreq="${k}"` : ''} class="${p.init.freq === k ? 'on' : ''}">${l}</button>`).join('')}</div>
    <div class="lf-chips wrap">${Object.entries(META.idea_kinds).map(([k, l]) => `<button class="lf-chip mini ${p.init.kinds.includes(k) ? 'on' : ''}" ${E ? `data-ikind="${k}"` : 'disabled'}>${l}</button>`).join('')}</div>
    ${ideas.map(i => `<div class="lf-row blur ${i.status === 'armed' ? 'armed' : ''}" data-reveal>${icon('gift')}<span class="lf-grow"><small>${esc(META.idea_kinds[i.kind] || '')}${i.status === 'armed' ? ' · в следующем ответе' : ''}</small><b style="font-size:14.5px;font-family:var(--lf-sans);font-weight:400">${esc(i.text)}</b></span>
      ${E ? `<button class="lf-iconbtn sm" data-arm="idea:${i.id}">${icon('zap')}</button><button class="lf-iconbtn sm" data-iskip="${i.id}">${icon('x')}</button>` : ''}</div>`).join('') || `<div class="lf-hint-i">Летописец подкинет задумки по ходу истории</div>`}
    ${done.length ? `<div class="lf-hint">Сбылось: ${done.map(i => esc(cut(i.text, 50))).join(' · ')}</div>` : ''}
    ${E ? `<div class="lf-row2" style="margin-top:6px"><input id="cd-idea" placeholder="своя задумка: что он сделает сам"><button class="lf-btn icon" id="cd-ideaadd">${icon('plus')}</button></div>` : ''}`;
}
function relCard(d, r) {
  const me = d.char.name;
  const rows = META.scales.map(([k, l, ic]) => {
    const a = r.out[k], b = r.back ? r.back[k] : null;
    const diff = b != null && Math.abs(a - b) >= 25;
    return `${icon(ic)}<span class="lab">${l}</span><span class="lf-meter ${diff ? 'diff' : ''}"><b style="width:${a}%"></b></span>${b != null ? `<span class="lf-meter ${diff ? 'diff' : ''}"><b style="width:${b}%"></b></span>` : '<span class="lf-hint" style="margin:0;text-align:center">скрыто</span>'}`;
  }).join('');
  return `<div class="lf-relcard"><div class="lf-relhead">${ava(r, 'md')}<b>${esc(r.name)}</b>${d.can_edit ? `<button class="lf-iconbtn sm" data-reledit="${r.key}">${icon('sliders')}</button>` : ''}</div>
    <div class="lf-relgrid"><span></span><span></span><span class="h">${esc(cut(me, 10))} →</span><span class="h">← ${esc(cut(r.name, 10))}</span>${rows}</div>
    ${r.moments.length ? `<div class="lf-moments">${r.moments.map(m => `<span>${esc(m.text)}</span>`).join('')}</div>` : ''}</div>`;
}
function bindCard(s, d) {
  const c = d.char, base = `/api/life/${c.key[0]}/${c.key.slice(1)}`, W = `?world=${curWorldId}`;
  const on = (sel, fn) => s.querySelectorAll(sel).forEach(b => b.onclick = (e) => fn(b, e));
  const patchState = async (body) => { try { await api(`${base}/state${W}`, { method: 'PATCH', body }); refreshCard(); } catch (e) { toast(e.message, true); } };
  const patchProf = async (body) => { try { await api(`${base}/prof`, { method: 'PATCH', body }); refreshCard(); } catch (e) { toast(e.message, true); } };
  on('[data-ctab]', b => { openCard.sub = b.dataset.ctab; refreshCard(); });
  on('#cd-up', () => pickImage(url => saveAvatar(c, url)));
  on('#cd-draw', b => busy(b, async () => {
    try { saveAvatar(c, await drawImage({ prompt: `Portrait of ${c.name}, head and shoulders, looking at the viewer. ${d.prof.card.look || ''}`, aspect: '3:4', refs: [c.avatar] })); } catch (e) { toast(e.message, true); }
  }));
  // личность
  on('#cd-edit', () => cardForm(d));
  on('#cd-fill', b => busy(b, async () => { try { await api(`${base}/fill${W}`, { method: 'POST' }); toast('Готово — проверь и поправь'); refreshCard(); } catch (e) { toast(e.message, true); } }));
  on('#cd-share', b => patchProf({ share: b.checked }));
  on('#cd-factadd', () => { const v = s.querySelector('#cd-fact').value.trim(); if (v) patchProf({ facts: [...d.prof.facts, v] }); });
  on('[data-fdel]', b => patchProf({ facts: d.prof.facts.filter((_, i) => i !== +b.dataset.fdel) }));
  // жизнь
  on('[data-need]', () => needsSheet(d, patchState));
  on('[data-st]', b => patchState({ state: d.state?.id === b.dataset.st ? null : b.dataset.st }));
  on('[data-wdel]', b => patchState({ wound_del: +b.dataset.wdel }));
  on('#cd-wadd', () => { const v = prompt('Что болит?'); if (v) patchState({ wound_add: v }); });
  on('#cd-thadd', () => { const v = s.querySelector('#cd-th').value.trim(); if (v) patchState({ thoughts_add: v }); });
  on('#cd-waadd', () => { const v = s.querySelector('#cd-wa').value.trim(); if (v) patchState({ wants_add: v }); });
  on('[data-tdel]', b => patchState({ thoughts_del: b.dataset.tdel }));
  on('[data-wwdel]', b => patchState({ wants_del: b.dataset.wwdel }));
  on('[data-wdone]', b => patchState({ wants_set: { id: b.dataset.wdone, status: 'done' } }));
  on('[data-arm]', (b, e) => { e.stopPropagation(); const [kind, id] = b.dataset.arm.split(':'); const same = d.armed?.id === id; patchState({ arm: same ? null : { kind, id } }); toast(same ? 'Снято' : `${c.name} сделает это в следующем ответе`); });
  on('[data-iskip]', (b, e) => { e.stopPropagation(); patchState({ idea_set: { id: b.dataset.iskip, status: 'skip' } }); });
  on('#cd-ideaadd', () => { const v = s.querySelector('#cd-idea').value.trim(); if (v) patchState({ idea_add: { text: v, kind: 'care' } }); });
  on('[data-reveal]', b => b.classList.toggle('open'));
  on('[data-rom]', b => patchProf({ romance: { level: b.dataset.rom } }));
  on('[data-talk]', b => patchProf({ talk: b.dataset.talk }));
  on('[data-ifreq]', b => patchProf({ init: { freq: b.dataset.ifreq } }));
  on('[data-ikind]', b => { const k = b.dataset.ikind; const ks = d.prof.init.kinds.includes(k) ? d.prof.init.kinds.filter(x => x !== k) : [...d.prof.init.kinds, k]; patchProf({ init: { kinds: ks } }); });
  on('#cd-toadd', () => { const v = prompt('Что его заводит?'); if (v) patchProf({ turnons: [...d.prof.turnons, v] }); });
  on('[data-todel]', b => patchProf({ turnons: d.prof.turnons.filter((_, i) => i !== +b.dataset.todel) }));
  on('#cd-romedit', () => sheet(`<h2>Ухаживания</h2>
    <div class="lf-field"><label>С кем и кто они друг другу</label><input id="ro-rel" value="${esc(d.prof.romance.rel)}" placeholder="Хеди, жена"></div>
    <div class="lf-field"><label>Как именно ухаживает</label><textarea id="ro-style" rows="3" placeholder="по-старомодному: цветы утром, открывает двери, касается мимоходом">${esc(d.prof.romance.style)}</textarea></div>
    <button class="lf-btn primary full" id="ro-save">Сохранить</button>`, x => {
      x.querySelector('#ro-save').onclick = async () => { const keep = openCard; await api(`${base}/prof`, { method: 'PATCH', body: { romance: { rel: x.querySelector('#ro-rel').value, style: x.querySelector('#ro-style').value } } }); openCard = keep; openCardSheet(c.key, 'life'); };
    }));
  // гардероб и вещи
  on('#cd-outfit', () => { const v = prompt('Что сейчас надето?', d.outfit || ''); if (v !== null) patchState({ outfit: v }); });
  on('#cd-lookadd', () => itemForm(d, { kind: 'образ' }));
  on('[data-iadd]', b => itemForm(d, { kind: b.dataset.iadd }));
  on('[data-item]', b => itemSheet(d, d.items.find(i => i.id === +b.dataset.item)));
  // связи
  on('[data-reledit]', b => relSheet(d, d.relations.find(r => r.key === b.dataset.reledit)));
  on('[data-tri]', b => triSheet(wl().tris.find(t => t.id === b.dataset.tri)));
  on('#cd-trinew', () => triSheet(null, c.key));
  const hm = s.querySelector('#cd-home'); if (hm) hm.onchange = () => patchState({ home: +hm.value || null });
  on('#cd-reladd', () => {
    const others = chars().filter(x => x.key !== c.key && !d.relations.some(r => r.key === x.key));
    sheet(`<h2>Связь с кем?</h2>${others.map(o => `<button class="lf-row" data-to="${o.key}">${ava(o)}<span class="lf-grow"><b>${esc(o.name)}</b></span></button>`).join('') || '<div class="lf-hint-i">Со всеми уже есть</div>'}`, x => {
      x.querySelectorAll('[data-to]').forEach(b => b.onclick = async () => { const keep = openCard; await api(`${base}/rel${W}`, { method: 'PATCH', body: { to: b.dataset.to } }); openCard = keep; openCardSheet(c.key, 'rel'); });
    });
  });
}
async function saveAvatar(c, url) {
  try {
    if (c.ai) await api(`/api/ai-chars/${c.id}`, { method: 'PATCH', body: { avatar: url } });
    else await api(`/api/personas/${c.id}`, { method: 'PATCH', body: { avatar: url } });
    await refreshState(); refreshCard();
  } catch (e) { toast(e.message, true); }
}
function cardForm(d) {
  const p = d.prof, c = d.char, keep = openCard;
  sheet(`<h2>Личность</h2>
    ${!c.ai ? `<div class="lf-field"><label>Кто это (видно всем и ИИ)</label><textarea id="cf-bio" rows="3">${esc(c.bio)}</textarea></div>` : ''}
    <div class="lf-row2"><div class="lf-field"><label>Возраст</label><input id="cf-age" value="${esc(p.card.age)}"></div>
      <div class="lf-field"><label>Пол</label><div class="lf-seg" style="margin:0"><button data-fem="0" class="${!p.fem ? 'on' : ''}">Он</button><button data-fem="1" class="${p.fem ? 'on' : ''}">Она</button></div></div></div>
    <div class="lf-field"><label>Внешность</label><textarea id="cf-look" rows="2">${esc(p.card.look)}</textarea></div>
    <div class="lf-field"><label>Характер</label><textarea id="cf-traits" rows="2">${esc(p.card.traits)}</textarea></div>
    <div class="lf-field"><label>История</label><textarea id="cf-story" rows="4">${esc(p.card.story)}</textarea></div>
    <div class="lf-field"><label>Увлечения (через запятую)</label><input id="cf-hob" value="${esc(p.hobbies.join(', '))}"></div>
    <div class="lf-field"><label>Любит (через запятую)</label><input id="cf-likes" value="${esc(p.likes.join(', '))}"></div>
    <div class="lf-field"><label>Не любит</label><input id="cf-dis" value="${esc(p.dislikes.join(', '))}"></div>
    ${c.ai ? `<div class="lf-field"><label>Метаболизм</label><div class="lf-seg" style="margin:0">${[[1, 'Обычный'], [1.5, 'Быстрый'], [2, 'Суперсолдат']].map(([v, l]) => `<button data-met="${v}" class="${p.metab === v ? 'on' : ''}">${l}</button>`).join('')}</div></div>` : ''}
    <button class="lf-btn primary full serif" id="cf-save">Сохранить</button>`, s => {
    let fem = p.fem, metab = p.metab ?? 1;
    s.querySelectorAll('[data-fem]').forEach(b => b.onclick = () => { fem = b.dataset.fem === '1'; s.querySelectorAll('[data-fem]').forEach(x => x.classList.toggle('on', x === b)); });
    s.querySelectorAll('[data-met]').forEach(b => b.onclick = () => { metab = +b.dataset.met; s.querySelectorAll('[data-met]').forEach(x => x.classList.toggle('on', x === b)); });
    const list = id => s.querySelector(id).value.split(',').map(x => x.trim()).filter(Boolean);
    s.querySelector('#cf-save').onclick = async () => {
      try {
        await api(`/api/life/${c.key[0]}/${c.key.slice(1)}/prof`, { method: 'PATCH', body: { fem, metab, card: { age: s.querySelector('#cf-age').value, look: s.querySelector('#cf-look').value, traits: s.querySelector('#cf-traits').value, story: s.querySelector('#cf-story').value }, hobbies: list('#cf-hob'), likes: list('#cf-likes'), dislikes: list('#cf-dis') } });
        if (!c.ai) await api(`/api/personas/${c.id}`, { method: 'PATCH', body: { bio: s.querySelector('#cf-bio').value } });
        await refreshState(); openCard = keep; openCardSheet(c.key, 'person');
      } catch (e) { toast(e.message, true); }
    };
  });
}
function needsSheet(d, patchState) {
  const keep = openCard;
  sheet(`<h2>Тело</h2>${d.body.map(n => `<div class="lf-field"><label>${n.label}: <b id="nv-${n.k}">${n.v}</b></label><input type="range" min="0" max="100" value="${n.v}" data-nk="${n.k}"></div>`).join('')}
    <button class="lf-btn primary full" id="nf-save">Сохранить</button>`, s => {
    s.querySelectorAll('[data-nk]').forEach(r => r.oninput = () => { s.querySelector(`#nv-${r.dataset.nk}`).textContent = r.value; });
    s.querySelector('#nf-save').onclick = async () => {
      const body = {}; s.querySelectorAll('[data-nk]').forEach(r => body[r.dataset.nk] = +r.value);
      await patchState({ body }); openCard = keep; openCardSheet(d.char.key, 'life');
    };
  });
}
function relSheet(d, r) {
  const keep = openCard;
  sheet(`<h2>${esc(d.char.name)} → ${esc(r.name)}</h2><div class="lf-hint">Что ${esc(d.char.name)} чувствует. Обратную сторону ведёт сам ${esc(r.name)}.</div>
    ${META.scales.map(([k, l]) => `<div class="lf-field"><label>${l}: <b id="rv-${k}">${r.out[k]}</b></label><input type="range" min="0" max="100" value="${r.out[k]}" data-rk="${k}"></div>`).join('')}
    <div class="lf-field"><label>Момент пары</label><input id="rv-mom" placeholder="напр.: Оставил ключ от квартиры"></div>
    <button class="lf-btn primary full" id="rv-save">Сохранить</button>`, s => {
    s.querySelectorAll('[data-rk]').forEach(x => x.oninput = () => { s.querySelector(`#rv-${x.dataset.rk}`).textContent = x.value; });
    s.querySelector('#rv-save').onclick = async () => {
      const body = { to: r.key, moment: s.querySelector('#rv-mom').value.trim() };
      s.querySelectorAll('[data-rk]').forEach(x => body[x.dataset.rk] = +x.value);
      await api(`/api/life/${d.char.key[0]}/${d.char.key.slice(1)}/rel?world=${curWorldId}`, { method: 'PATCH', body });
      openCard = keep; openCardSheet(d.char.key, 'rel');
    };
  });
}
function itemSheet(d, it) {
  if (!it) return;
  const keep = openCard, E = d.can_edit;
  const sub = it.kind === 'образ' || it.kind === 'одежда' ? 'wardrobe' : 'things';
  sheet(`${fit(it.image, '', it.image ? '' : `<div style="display:grid;place-items:center;height:100%;color:var(--lf-rose)">${icon(it.kind === 'транспорт' ? 'car' : it.kind === 'образ' ? 'shirt' : 'box', 'xl')}</div>`, `style="--img:url('${esc(it.image || '')}');margin:-18px -18px 12px;aspect-ratio:${it.kind === 'образ' ? '3/4' : '4/3'};max-height:62dvh"`)}
    <h2>${esc(it.name)}</h2>
    ${it.descr ? `<div class="lf-text">${esc(it.descr)}</div>` : ''}
    ${it.from_name ? `<div class="lf-hint">${icon('gift')} от ${esc(it.from_name)}</div>` : ''}
    ${it.story?.length ? `<div class="lf-sec"><span>История</span><i class="lf-sec-line"></i></div>${it.story.map(x => `<div class="lf-story" style="margin:6px 0">${esc(x.t)}</div>`).join('')}` : ''}
    ${E ? `<div class="lf-actions">
      ${it.kind === 'образ' ? `<button class="lf-btn primary" id="is-wear">${icon('shirt')} ${it.equipped ? 'Надето' : 'Надеть'}</button>` : `<button class="lf-btn" id="is-eq">${it.equipped ? 'Убрать' : 'Взять с собой'}</button>`}
      <button class="lf-btn" id="is-draw" data-busy="Рисую…">${icon('wand')} ${it.image ? 'Перерисовать' : 'Нарисовать'}</button>
      <button class="lf-btn" id="is-edit">${icon('pencil')}</button>
      <button class="lf-btn" id="is-give">${icon('gift')} Отдать</button>
      <button class="lf-btn danger icon" id="is-del">${icon('trash')}</button></div>` : ''}`, s => {
    const back = () => { openCard = keep; openCardSheet(d.char.key, sub); };
    const patch = async body => { try { await api(`/api/items/${it.id}?world=${curWorldId}`, { method: 'PATCH', body }); back(); } catch (e) { toast(e.message, true); } };
    const on = (id, fn) => { const el = s.querySelector(id); if (el) el.onclick = () => fn(el); };
    on('#is-wear', () => patch({ equipped: true }));
    on('#is-eq', () => patch({ equipped: !it.equipped }));
    on('#is-edit', () => itemForm(d, it));
    on('#is-del', async () => { if (!confirm('Удалить?')) return; await api(`/api/items/${it.id}`, { method: 'DELETE' }); back(); });
    on('#is-draw', b => busy(b, async () => { try { await patch({ image: await drawImage(itemDraw(d, it.kind, it.name, it.descr)) }); } catch (e) { toast(e.message, true); } }));
    on('#is-give', () => {
      const others = chars().filter(x => x.key !== d.char.key);
      sheet(`<h2>Кому отдать «${esc(it.name)}»?</h2>${others.map(o => `<button class="lf-row" data-to="${o.key}">${ava(o)}<span class="lf-grow"><b>${esc(o.name)}</b></span></button>`).join('')}`, x => {
        x.querySelectorAll('[data-to]').forEach(b => b.onclick = () => patch({ give_to: b.dataset.to }));
      });
    });
  });
}
function itemDraw(d, kind, name, descr) {
  const c = d.char;
  if (kind === 'образ') return { prompt: `Full-body fashion illustration of ${c.name} wearing: ${descr || name}. Whole figure visible from head to toe, standing, simple muted background. ${d.prof.card.look || ''}`, aspect: '3:4', refs: [c.avatar] };
  if (kind === 'транспорт') return { prompt: `A ${name}${descr ? `, ${descr}` : ''}, three-quarter view, parked, cinematic.`, aspect: '4:3' };
  return { prompt: `Still life of ${name}${descr ? `: ${descr}` : ''}, close-up on a surface, moody light.`, aspect: '1:1' };
}
function itemForm(d, it) {
  const keep = openCard, isNew = !it.id;
  const kind = it.kind || 'вещь';
  const label = { 'образ': 'образ', 'одежда': 'вещь гардероба', 'транспорт': 'транспорт', 'вещь': 'вещь' }[kind];
  sheet(`<h2>${isNew ? `Новый ${label}` : esc(it.name)}</h2>
    <div class="lf-field"><label>Название</label><input id="if-name" value="${esc(it.name || '')}" placeholder="${kind === 'образ' ? 'Вечер в баре' : kind === 'транспорт' ? 'Мотоцикл' : 'Зажигалка'}"></div>
    <div class="lf-field"><label>${kind === 'образ' ? 'Что надето целиком (это видит ИИ)' : 'Описание (видит ИИ)'}</label><textarea id="if-descr" rows="3">${esc(it.descr || '')}</textarea></div>
    ${imgField('if-img', it.image, { draw: true, aspect: kind === 'образ' ? '3:4' : '1:1' })}
    ${kind === 'образ' && isNew ? `<label class="lf-check"><input type="checkbox" id="if-eq"> Сразу надеть</label>` : ''}
    <button class="lf-btn primary full serif" id="if-save">Сохранить</button>`, s => {
    bindImgField(s, 'if-img', () => itemDraw(d, kind, s.querySelector('#if-name').value, s.querySelector('#if-descr').value));
    s.querySelector('#if-save').onclick = async () => {
      const body = { kind, name: s.querySelector('#if-name').value, descr: s.querySelector('#if-descr').value, image: s.querySelector('#if-img').value };
      try {
        if (isNew) await api(`/api/life/${d.char.key[0]}/${d.char.key.slice(1)}/items?world=${curWorldId}`, { method: 'POST', body: { ...body, equipped: kind === 'образ' ? !!s.querySelector('#if-eq')?.checked : true } });
        else await api(`/api/items/${it.id}?world=${curWorldId}`, { method: 'PATCH', body });
        openCard = keep; openCardSheet(d.char.key, kind === 'образ' || kind === 'одежда' ? 'wardrobe' : 'things');
      } catch (e) { toast(e.message, true); }
    };
  });
}

// ───────────── комната ─────────────
function sceneTag(r) {
  const sc = r.scene || {};
  const tone = META.tones.find(t => t[0] === sc.tone), mood = META.moods.find(m => m[0] === sc.set);
  if (sc.intim === 'on') return `<span class="lf-tonepill">${icon('flame')} ${tone ? tone[1] : 'Близость'}</span>`;
  if (mood) return `<span class="lf-tonepill">${icon(mood[2])} ${mood[1]}</span>`;
  return '';
}
function updateRoomTop() {
  const el = document.getElementById('room-top'); if (!el || !curRoom) return;
  el.outerHTML = roomTop();
  bindRoomTop();
}
function roomTop() {
  const w = world();
  return topBar({ id: 'room-top', back: "location.hash='#/'", title: esc(curRoom.title), sub: [esc(w?.title || ''), esc(BRIEF[curWorldId]?.clock || ''), sceneTag(curRoom)].filter(Boolean).join(' · '),
    right: `<button class="lf-iconbtn" id="b-scene" title="Сцена">${icon('sliders')}</button><button class="lf-iconbtn" id="b-chron" title="Хроника">${icon('book')}</button>` });
}
function bindRoomTop() {
  document.getElementById('b-scene').onclick = sceneSheet;
  document.getElementById('b-chron').onclick = chronicleSheet;
}
function renderRoom() {
  const r = curRoom;
  const myP = S.my_personas.find(p => p.id === composer.persona_id);
  $app.innerHTML = `${roomTop()}
  <div class="lf-body ${r.kind === 'chat' ? 'chatmode' : ''}" id="scr">
    ${r.cover ? `<div class="lf-frame"><div class="lf-frame-img" style="background-image:url('${esc(r.cover)}')"></div><div class="lf-frame-cap"><h2>${esc(r.title)}</h2><span>${esc(cut(r.description, 90))}</span></div></div>`
      : r.description ? `<div class="lf-locbox">${esc(r.description)}</div>` : ''}
    <div class="lf-here" id="room-here">${hereHtml()}</div>
    <div class="lf-feed" id="feed">
      ${posts.length >= 50 ? `<button class="lf-loadmore" id="b-more">↑ раньше</button>` : ''}
      ${posts.map(postHtml).join('') || `<div class="lf-empty">${icon('feather')}Начни историю</div>`}
    </div>
    <div class="lf-typing" id="typing"></div>
  </div>
  <div class="lf-composer">
    <div class="lf-chips" style="margin:0">
      <button class="lf-chip ${myP && !composer.ooc ? 'on' : ''}" id="c-persona">${myP ? `${ava(myP, 'xs')} ${esc(myP.name)}` : `${icon('message')} вне игры`}</button>
      <button class="lf-chip ${composer.ooc ? 'on' : ''}" id="c-ooc">${icon('message')} вне игры</button>
      <button class="lf-chip ai" id="c-ai">${icon('sparkles')} позвать ИИ</button>
    </div>
    ${composer.image ? `<div class="lf-preview"><img src="${esc(composer.image)}"><button id="c-img-del">${icon('x')}</button></div>` : ''}
    <div class="lf-composer-row">
      <button class="lf-plus" id="c-img" title="Картинка">${icon('plus')}</button>
      <textarea id="c-text" rows="1" placeholder="${r.kind === 'chat' ? 'Сообщение…' : 'Продолжить историю…'}"></textarea>
      <button class="lf-send" id="c-send">${icon('send')}</button>
    </div>
  </div>`;
  const ta = document.getElementById('c-text');
  ta.addEventListener('input', () => { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, innerHeight * .38) + 'px'; });
  bindRoomTop();
  document.getElementById('c-send').onclick = sendPost;
  document.getElementById('c-ooc').onclick = () => { composer.ooc = !composer.ooc; renderRoom(); };
  document.getElementById('c-persona').onclick = pickPersonaSheet;
  document.getElementById('c-ai').onclick = aiSheet;
  document.getElementById('c-img').onclick = () => pickImage(url => { composer.image = url; renderRoom(); });
  const del = document.getElementById('c-img-del'); if (del) del.onclick = () => { composer.image = ''; renderRoom(); };
  const more = document.getElementById('b-more'); if (more) more.onclick = loadMore;
  document.getElementById('feed').addEventListener('click', feedClick);
  document.getElementById('room-here').addEventListener('click', hereClick);
  scrollDown();
}
const TRACE_IC = { trace: 'sparkles', note: 'feather', food: 'utensils', gift: 'gift' };
const TRACE_L = { trace: 'след', note: 'записка', food: 'еда', gift: 'подарок' };
function petAva(p) { return p.img ? `<span class="lf-ava"><img src="${esc(p.img)}" alt=""></span>` : `<span class="lf-ava"><i>${icon('paw')}</i></span>`; }
function hereHtml() {
  if (!curRoom) return '';
  const d = wl();
  const tr = d.traces[curRoom.id] || [];
  const pets = d.pets.filter(p => p.on !== false && p.home === curRoom.id);
  const push = d.push[curRoom.id];
  if (!tr.length && !pets.length && !push) return '';
  return `${pets.length ? `<div class="lf-chips" style="margin:0 0 4px">${pets.map(p => `<button class="lf-petchip ${p.urgent.length ? 'need' : ''}" data-pet="${p.id}">${petAva(p)}${esc(p.name)}${p.urgent.length ? ` · ${esc(p.needs.find(n => n.v < 30)?.word || 'просит')}` : ''}</button>`).join('')}</div>` : ''}
    ${tr.map(t => `<div class="lf-trace k-${t.k}"><span class="lf-trace-ic">${icon(TRACE_IC[t.k] || 'sparkles')}</span><span class="lf-trace-t"><em>${TRACE_L[t.k] || 'след'}</em>${esc(t.t)}${t.by ? `<small>от ${esc(t.by)}</small>` : ''}</span><button class="x" data-trdel="${t.id}" title="Убрать">${icon('x')}</button></div>`).join('')}
    ${push ? `<div class="lf-rumor" style="margin:6px 0"><q>${esc(push)}</q><div class="lf-rumor-f"><small>${icon('ear')} слух в этой сцене — ИИ может его упомянуть</small><button class="lf-iconbtn sm" data-unpush="1">${icon('x')}</button></div></div>` : ''}`;
}
function updateRoomHere() {
  const el = document.getElementById('room-here'); if (!el) return;
  el.innerHTML = hereHtml();
}
async function hereClick(e) {
  const t = e.target.closest('[data-trdel],[data-pet],[data-unpush]'); if (!t) return;
  if (t.dataset.pet) return petSheet(t.dataset.pet);
  if (t.dataset.unpush) { await api(`/api/rooms/${curRoom.id}/rumor`, { method: 'POST', body: { text: '' } }); return; }
  if (t.dataset.trdel) { try { await api(`/api/worlds/${curRoom.world_id}/traces/${curRoom.id}/${t.dataset.trdel}`, { method: 'DELETE' }); } catch (er) { toast(er.message, true); } }
}
function traceForm(roomId = curRoom?.id) {
  sheet(`<h2>Оставить след</h2><div class="lf-hint">То, что переживёт сцену: записка, цветы на столе, разбитое зеркало. ИИ видит следы этого места.</div>
    <div class="lf-chips wrap">${Object.entries(TRACE_L).map(([k, l], i) => `<button class="lf-chip mini ${i === 0 ? 'on' : ''}" data-tk="${k}">${icon(TRACE_IC[k])} ${l}</button>`).join('')}</div>
    <div class="lf-field"><textarea id="tr-text" rows="3" placeholder="напр.: записка на холодильнике «Не жди, вернусь к утру»"></textarea></div>
    <button class="lf-btn primary full" id="tr-save">Оставить</button>`, s => {
    let k = 'trace';
    s.querySelectorAll('[data-tk]').forEach(b => b.onclick = () => { k = b.dataset.tk; s.querySelectorAll('[data-tk]').forEach(x => x.classList.toggle('on', x === b)); });
    s.querySelector('#tr-save').onclick = async () => {
      const text = s.querySelector('#tr-text').value.trim(); if (!text) return;
      try { await api(`/api/worlds/${curWorldId}/traces`, { method: 'POST', body: { room_id: roomId, text, kind: k } }); closeSheet(); } catch (e) { toast(e.message, true); }
    };
  });
}

// ── кат-сцены: на весь экран, кино-полосы, медленный наезд, подписи
let cutTimer = null;
function playCut(cut) {
  const frames = (cut?.frames || []).filter(f => f.img);
  if (!frames.length) return;
  stopCut();
  const el = document.createElement('div');
  el.id = 'lf-cut';
  el.innerHTML = `<div class="lf-cut-stage">${frames.map((f, i) => `<div class="lf-cut-f k${i % 4}" style="background-image:url('${esc(f.img)}')"><i class="bl"></i><i class="im"></i></div>`).join('')}</div>
    <i class="lf-cut-bar top"></i><i class="lf-cut-bar bot"></i>
    <div class="lf-cut-cap"><small></small><span></span></div>
    <div class="lf-cut-dots">${frames.map(() => '<b></b>').join('')}</div>
    <button class="lf-cut-x" aria-label="Закрыть">${icon('x')}</button>`;
  document.body.append(el);
  let i = -1;
  const show = (n) => {
    if (n >= frames.length) return stopCut();
    i = n;
    el.querySelectorAll('.lf-cut-f').forEach((f, k) => { f.classList.toggle('on', k === i); if (k === i) { f.style.animation = 'none'; void f.offsetWidth; f.style.animation = ''; } });
    el.querySelectorAll('.lf-cut-dots b').forEach((b, k) => b.classList.toggle('on', k <= i));
    const cap = el.querySelector('.lf-cut-cap');
    cap.classList.remove('on');
    cap.querySelector('small').textContent = frames[i].title || '';
    cap.querySelector('span').textContent = frames[i].caption || '';
    setTimeout(() => cap.classList.add('on'), 700);
    clearTimeout(cutTimer);
    cutTimer = setTimeout(() => show(i + 1), Math.max(5200, 2600 + String(frames[i].caption || '').length * 55));
  };
  el.addEventListener('click', (e) => { if (e.target.closest('.lf-cut-x')) return stopCut(); show(i + 1); });
  requestAnimationFrame(() => { el.classList.add('on'); setTimeout(() => show(0), 650); });
}
function stopCut() {
  clearTimeout(cutTimer);
  const el = document.getElementById('lf-cut'); if (!el) return;
  el.classList.remove('on'); setTimeout(() => el.remove(), 500);
}
async function makeCut(postId) {
  if (CUTBUSY[postId]) return;
  CUTBUSY[postId] = { step: 0, of: 3 };
  const p = posts.find(x => x.id === postId); if (p) replacePost(p);
  try {
    const r = await api(`/api/posts/${postId}/cut`, { method: 'POST' });
    if (S) S.spent_today = r.spent_today;
    delete CUTBUSY[postId];
    await loadWL(curWorldId, true);
    if (p) replacePost(p);
    playCut(r.cut);
  } catch (e) { delete CUTBUSY[postId]; if (p) replacePost(p); toast(e.message, true); }
}

function scrollDown() { requestAnimationFrame(() => { const sc = document.getElementById('scr'); if (sc) sc.scrollTop = sc.scrollHeight; }); }
function chronHtml(p) {
  const ch = p.chron;
  if (!ch?.chips?.length) return S.me.is_admin && !p.is_ooc && (p.persona_id || p.ai_char_id) ? `<div class="lf-chron"><button data-rechron="${p.id}" title="Прогнать Летописца">${icon('feather')}</button></div>` : '';
  const mine = p.user_id === S.me.id || S.me.is_admin || (p.ai_char_id && S.me.is_admin);
  return `<div class="lf-chron">${icon('feather')}${ch.chips.map(t => `<span>${esc(t)}</span>`).join('')}
    ${mine ? `<button data-unchron="${p.id}" title="Откатить">${icon('undo')}</button>` : ''}${S.me.is_admin ? `<button data-rechron="${p.id}" title="Перепрогнать">${icon('refresh')}</button>` : ''}</div>`;
}
function cutHtml(p) {
  const b = CUTBUSY[p.id];
  if (b) return `<div class="lf-cutbusy"><span class="lf-spin"></span> ${b.step ? `Снимаю кат-сцену · кадр ${b.step} из ${b.of}` : 'Раскадровка…'}</div>`;
  const c = cutOf(p.id);
  return c ? `<button class="lf-cutchip" data-cut="${c.id}">${icon('play')} ${esc(c.title)}</button>` : '';
}
function postHtml(p) {
  const a = postAuthor(p);
  const mine = p.user_id === S.me.id;
  const menu = p.body || mine || S.me.is_admin ? `<button class="lf-iconbtn sm lf-post-menu" data-menu="${p.id}">${icon('more')}</button>` : '';
  const mode = curRoom?.kind === 'chat' ? 'small' : prefs.ava;
  const time = fmtTime(p.created_at) + (p.edited_at ? ' · ред.' : '');
  let head;
  if (mode === 'banner' && a.avatar && !a.ooc) {
    head = `<div class="lf-banner" style="background-image:url('${esc(a.avatar)}')" ${a.key ? `data-card="${a.key}"` : ''}><div class="lf-banner-cap"><div class="who"><div class="lf-post-n">${esc(a.name)}</div><div class="lf-post-sub">${esc(a.sub)} · ${time}</div></div>${menu}</div></div>`;
  } else {
    head = `<div class="lf-post-head">${a.key ? `<button data-card="${a.key}">${ava(a, mode === 'small' ? '' : 'md')}</button>` : ava(a, mode === 'small' ? '' : 'md')}
      <div class="who"><div class="lf-post-n">${esc(a.name)}</div><div class="lf-post-sub">${esc(a.sub)} · ${time}</div></div>${menu}</div>`;
  }
  return `<article class="lf-post ${a.ai ? 'ai' : ''} ${p.is_ooc ? 'ooc' : ''}" id="post-${p.id}">${head}
    ${p.body ? `<div class="lf-post-body">${fmtBody(p.body)}</div>` : ''}
    ${p.image ? fit(p.image, 'lf-post-img', '', `data-full="${esc(p.image)}"`) : ''}
    ${chronHtml(p)}${cutHtml(p)}</article>`;
}
function appendPost(p) {
  const feed = document.getElementById('feed'); if (!feed) return;
  feed.querySelector('.lf-empty')?.remove();
  feed.insertAdjacentHTML('beforeend', postHtml(p));
  scrollDown();
}
function replacePost(p) { const el = document.getElementById(`post-${p.id}`); if (el) el.outerHTML = postHtml(p); }
async function feedClick(e) {
  const t = e.target.closest('[data-menu],[data-card],[data-unchron],[data-rechron],[data-full],[data-cut]'); if (!t) return;
  if (t.dataset.cut) return playCut(wl().cuts.find(c => c.id === t.dataset.cut));
  if (t.dataset.menu) return postMenu(+t.dataset.menu);
  if (t.dataset.card) return openCardSheet(t.dataset.card);
  if (t.dataset.full) return sheet(fit(t.dataset.full, '', '', `style="--img:url('${esc(t.dataset.full)}');margin:-18px;height:84dvh"`));
  if (t.dataset.unchron) { try { await api(`/api/posts/${t.dataset.unchron}/chron/undo`, { method: 'POST' }); toast('Откатила'); } catch (er) { toast(er.message, true); } return; }
  if (t.dataset.rechron) { t.innerHTML = '<span class="lf-spin"></span>'; try { await api(`/api/posts/${t.dataset.rechron}/chron`, { method: 'POST' }); } catch (er) { toast(er.message, true); } }
}
async function loadMore() {
  if (!posts[0]) return;
  posts = (await api(`/api/rooms/${curRoom.id}/posts?before=${posts[0].id}&limit=50`)).posts.concat(posts);
  renderRoom();
}
async function sendPost() {
  const ta = document.getElementById('c-text');
  const body = ta.value.trim();
  if (!body && !composer.image) return;
  const btn = document.getElementById('c-send'); btn.disabled = true;
  try {
    await api(`/api/rooms/${curRoom.id}/posts`, { method: 'POST', body: { body, image: composer.image || '', persona_id: composer.ooc ? null : composer.persona_id, is_ooc: composer.ooc } });
    ta.value = ''; ta.style.height = 'auto';
    if (composer.image) { composer.image = ''; renderRoom(); }
  } catch (e) { toast(e.message, true); }
  btn.disabled = false;
}
function postMenu(id) {
  const p = posts.find(x => x.id === id); if (!p) return;
  const own = p.user_id === S.me.id || S.me.is_admin;
  const c = cutOf(p.id);
  sheet(`<h2>Пост</h2>
    ${p.body && !p.is_ooc ? `<button class="lf-btn full" id="pm-cut" style="margin-bottom:8px">${icon('play')} ${c ? 'Переснять кат-сцену' : 'Снять кат-сцену'}</button>
      <div class="lf-hint" style="margin:-2px 0 10px">Три кадра по этому посту — общий план и два крупных, в стиле мира. Это 4 запроса: раскадровка и три картинки. ИИ кат-сцену не видит.</div>` : ''}
    ${c && (c.by === S.me.id || S.me.is_admin) ? `<button class="lf-btn full ghost" id="pm-cutdel" style="margin-bottom:8px">${icon('trash')} Удалить кат-сцену</button>` : ''}
    ${own && p.body ? `<button class="lf-btn full" id="pm-edit" style="margin-bottom:8px">${icon('pencil')} Редактировать</button>` : ''}
    ${own ? `<button class="lf-btn full danger" id="pm-del">${icon('trash')} Удалить</button>` : ''}`, s => {
    const pc = s.querySelector('#pm-cut'); if (pc) pc.onclick = () => { closeSheet(); makeCut(id); };
    const pd = s.querySelector('#pm-cutdel'); if (pd) pd.onclick = async () => { await api(`/api/worlds/${curRoom.world_id}/cuts/${c.id}`, { method: 'DELETE' }); closeSheet(); };
    const e = s.querySelector('#pm-edit');
    if (e) e.onclick = () => sheet(`<h2>Редактирование</h2><textarea id="pm-text" rows="10">${esc(p.body)}</textarea><button class="lf-btn primary full" id="pm-save" style="margin-top:10px">Сохранить</button>`, s2 => {
      s2.querySelector('#pm-save').onclick = async () => { try { await api(`/api/posts/${id}`, { method: 'PATCH', body: { body: s2.querySelector('#pm-text').value } }); closeSheet(); } catch (er) { toast(er.message, true); } };
    });
    const del = s.querySelector('#pm-del'); if (del) del.onclick = async () => { if (!confirm('Удалить пост?')) return; try { await api(`/api/posts/${id}`, { method: 'DELETE' }); closeSheet(); } catch (er) { toast(er.message, true); } };
  });
}

// сцена: кто здесь, тон, близость, Летописец
function sceneSheet() {
  const r = curRoom, sc = r.scene || {};
  const keys = []; for (const p of posts.slice(-10).reverse()) { const a = postAuthor(p); if (a.key && !keys.includes(a.key)) keys.push(a.key); }
  const here = keys.map(charBy).filter(Boolean);
  const last = [...posts].reverse().find(p => p.chron?.chips?.length);
  const auto = sc.auto || {};
  const autoMood = META.moods.find(m => m[0] === auto.mood);
  const groups = [['soft', 'Мягко'], ['hot', 'Горячо'], ['special', 'Особое']];
  sheet(`
    ${r.cover ? `<div class="lf-frame" style="margin:-18px -18px 8px"><div class="lf-frame-img" style="background-image:url('${esc(r.cover)}')"></div><div class="lf-frame-cap"><h2>${esc(r.title)}</h2><span>${esc(BRIEF[curWorldId]?.clock || '')}</span></div></div>` : `<h2>${esc(r.title)}</h2>`}
    <div class="lf-sec"><span>Кто здесь</span><i class="lf-sec-line"></i></div>
    <div style="display:flex;gap:14px;overflow-x:auto;padding:4px 2px">${here.map(c => `<button data-card="${c.key}" style="display:flex;flex-direction:column;align-items:center;gap:5px;width:70px">${ava(c, 'ring')}<span style="font-size:12px;color:var(--lf-text2);max-width:70px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(c.name)}</span></button>`).join('') || '<span class="lf-hint">Пока никого</span>'}</div>
    <div class="lf-sec"><span>Настроение</span><i class="lf-sec-line"></i><small>${autoMood && auto.mood !== 'calm' ? `Летописец видит: ${autoMood[1].toLowerCase()}` : 'авто'}</small></div>
    <div class="lf-chips wrap">${META.moods.map(([id, l, ic]) => `<button class="lf-chip ${sc.set === id ? 'on' : ''}" data-mood="${id}">${icon(ic)} ${l}</button>`).join('')}</div>
    <div class="lf-sec"><span>Близость</span><i class="lf-sec-line"></i><small>${auto.intim === 2 ? 'сейчас идёт' : auto.intim === 1 ? 'флирт' : ''}</small></div>
    <div class="lf-seg">${[['auto', 'Авто'], ['on', 'Включена'], ['off', 'Выключена']].map(([k, l]) => `<button data-intim="${k}" class="${(sc.intim || 'auto') === k ? 'on' : ''}">${l}</button>`).join('')}</div>
    <div class="lf-hint">В близости модель пишет сцену прямо, в характере и выбранном оттенке, без затемнений и обрывов.</div>
    ${groups.map(([g, gl]) => `<div class="lf-field"><label>${gl}</label><div class="lf-chips wrap" style="margin:0">${META.tones.filter(t => t[3] === g).map(([id, l, ic]) => `<button class="lf-chip mini ${sc.tone === id ? 'on' : ''}" data-tone="${id}">${icon(ic)} ${l}</button>`).join('')}</div></div>`).join('')}
    <label class="lf-check"><input type="checkbox" id="sc-preg" ${sc.preg ? 'checked' : ''}> Беременность — модель учитывает живот и грудь</label>
    <label class="lf-check"><input type="checkbox" id="sc-care" ${sc.care !== false ? 'checked' : ''}> Забота после — следующий ответ про «после»</label>
    <div class="lf-sec"><span>Это место</span><i class="lf-sec-line"></i></div>
    <div class="lf-actions" style="margin-top:0"><button class="lf-btn small" id="sc-trace">${icon('feather')} Оставить след</button><button class="lf-btn small" id="sc-pet">${icon('paw')} Питомец здесь</button></div>
    <div class="lf-sec"><span>Летописец</span><i class="lf-sec-line"></i><small>${r.chron_on === 0 ? 'выключен' : r.chron_on === 1 || r.kind === 'forum' ? 'после каждого поста' : 'выключен в чате'}</small></div>
    ${last ? `<div class="lf-chron" style="margin:0">${icon('feather')}${last.chron.chips.map(t => `<span>${esc(t)}</span>`).join('')}</div>` : '<div class="lf-hint-i">Пока ничего не отмечено</div>'}
  `, s => {
    const patch = async body => { try { const res = await api(`/api/rooms/${r.id}/scene`, { method: 'PATCH', body }); curRoom.scene = res.scene; sceneSheet(); updateRoomTop(); } catch (e) { toast(e.message, true); } };
    s.querySelectorAll('[data-mood]').forEach(b => b.onclick = () => patch({ set: sc.set === b.dataset.mood ? '' : b.dataset.mood }));
    s.querySelectorAll('[data-intim]').forEach(b => b.onclick = () => patch({ intim: b.dataset.intim }));
    s.querySelectorAll('[data-tone]').forEach(b => b.onclick = () => patch({ tone: sc.tone === b.dataset.tone ? '' : b.dataset.tone }));
    s.querySelector('#sc-preg').onchange = e => patch({ preg: e.target.checked });
    s.querySelector('#sc-care').onchange = e => patch({ care: e.target.checked });
    s.querySelectorAll('[data-card]').forEach(b => b.onclick = () => openCardSheet(b.dataset.card));
    s.querySelector('#sc-trace').onclick = () => traceForm(r.id);
    s.querySelector('#sc-pet').onclick = () => petForm(null, r.id);
  });
}
function chronicleSheet() {
  const r = curRoom;
  sheet(`<h2>Хроника</h2><div class="lf-locbox" style="font-style:normal;font-family:var(--lf-sans)">${r.chronicle ? esc(r.chronicle) : 'Летописец ещё не сводил хронику этого места.'}</div>
    ${r.chronicle_at ? `<div class="lf-hint">Обновлена: ${fmtTime(r.chronicle_at)}</div>` : ''}
    <button class="lf-btn primary full" id="ch-upd" data-busy="Пишу хронику…">${icon('feather')} Свести хронику</button>`, s => {
    const b = s.querySelector('#ch-upd');
    b.onclick = () => busy(b, async () => { try { const res = await api(`/api/rooms/${r.id}/chronicle`, { method: 'POST' }); r.chronicle = res.chronicle; r.chronicle_at = Date.now(); chronicleSheet(); } catch (e) { toast(e.message, true); } });
  });
}
function pickPersonaSheet() {
  sheet(`<h2>От чьего лица?</h2>
    <button class="lf-row" data-pid="">${icon('message')}<span class="lf-grow"><b>Вне игры</b><small>от себя</small></span></button>
    ${S.my_personas.map(p => `<button class="lf-row" data-pid="${p.id}">${ava(p, 'md')}<span class="lf-grow"><b>${esc(p.name)}</b><small>${esc(cut(p.bio, 60))}</small></span></button>`).join('')}
    <button class="lf-btn full" id="pp-manage" style="margin-top:8px">${icon('user')} Мои маски</button>`, s => {
    s.querySelectorAll('[data-pid]').forEach(b => b.onclick = () => { composer.persona_id = b.dataset.pid ? +b.dataset.pid : composer.persona_id; composer.ooc = !b.dataset.pid; closeSheet(); renderRoom(); });
    s.querySelector('#pp-manage').onclick = personasSheet;
  });
}
function personasSheet() {
  sheet(`<h2>Мои маски</h2>
    ${S.my_personas.map(p => `<div class="lf-row">${ava(p, 'md')}<button class="lf-grow" data-open="p${p.id}" style="text-align:left"><b>${esc(p.name)}</b><small>${esc(cut(p.bio, 60))}</small></button>
      <button class="lf-iconbtn sm" data-edit="${p.id}">${icon('pencil')}</button><button class="lf-iconbtn sm" data-del="${p.id}">${icon('trash')}</button></div>`).join('') || '<div class="lf-hint-i">Создай персонажа, за которого будешь играть</div>'}
    <button class="lf-btn primary full serif" id="pe-new" style="margin-top:10px">${icon('plus')} Новый персонаж</button>`, s => {
    s.querySelector('#pe-new').onclick = () => personaForm();
    s.querySelectorAll('[data-open]').forEach(b => b.onclick = () => openCardSheet(b.dataset.open));
    s.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => personaForm(S.my_personas.find(p => p.id === +b.dataset.edit)));
    s.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => { if (!confirm('Удалить персонажа?')) return; await api(`/api/personas/${b.dataset.del}`, { method: 'DELETE' }); await refreshState(); personasSheet(); });
  });
}
function personaForm(p) {
  sheet(`<h2>${p ? esc(p.name) : 'Новый персонаж'}</h2>
    <div class="lf-field"><label>Имя</label><input id="pf-name" value="${esc(p?.name || '')}"></div>
    <div class="lf-field"><label>Портрет</label>${imgField('pf-ava', p?.avatar, { draw: true })}</div>
    <div class="lf-field"><label>Кто это (видно всем и ИИ)</label><textarea id="pf-bio" rows="4">${esc(p?.bio || '')}</textarea></div>
    <div class="lf-row2"><div class="lf-field"><label>Эмодзи</label><input id="pf-emoji" value="${esc(p?.emoji || '🎭')}"></div><div class="lf-field"><label>Цвет</label><input id="pf-color" type="color" value="${p?.color || '#9e4a58'}" style="height:44px;padding:4px"></div></div>
    <button class="lf-btn primary full serif" id="pf-save">Сохранить</button>`, s => {
    bindImgField(s, 'pf-ava', () => ({ prompt: `Portrait of ${s.querySelector('#pf-name').value}, head and shoulders. ${s.querySelector('#pf-bio').value.slice(0, 400)}`, aspect: '3:4', refs: [s.querySelector('#pf-ava').value] }));
    s.querySelector('#pf-save').onclick = async () => {
      const body = { name: s.querySelector('#pf-name').value, avatar: s.querySelector('#pf-ava').value, bio: s.querySelector('#pf-bio').value, emoji: s.querySelector('#pf-emoji').value || '🎭', color: s.querySelector('#pf-color').value };
      try { if (p) await api(`/api/personas/${p.id}`, { method: 'PATCH', body }); else await api('/api/personas', { method: 'POST', body }); await refreshState(); personasSheet(); } catch (e) { toast(e.message, true); }
    };
  });
}
function aiSheet() {
  const attached = (curRoom.ai_ids || []).map(id => S.ai_chars.find(c => c.id === id)).filter(Boolean);
  const rest = S.ai_chars.filter(c => (!c.world_id || c.world_id === curRoom.world_id) && !attached.some(a => a.id === c.id));
  if (!attached.length && !rest.length) return toast(S.me.is_admin ? 'Сначала создай ИИ-персонажей в админке' : 'Админ ещё не завёл ИИ-персонажей', true);
  const item = c => `<button class="lf-row" data-ai="${c.id}">${ava(c, 'md')}<span class="lf-grow"><b>${esc(c.name)}</b><small>${esc(c.model)}</small></span>${icon('sparkles')}</button>`;
  sheet(`<h2>Позвать ИИ</h2>
    ${attached.length ? `<div class="lf-sec"><span>В этой комнате</span><i class="lf-sec-line"></i></div>${attached.map(item).join('')}` : ''}
    ${rest.length ? `<div class="lf-sec"><span>${attached.length ? 'Остальные' : 'Кто'}</span><i class="lf-sec-line"></i></div>${rest.map(item).join('')}` : ''}
    <div class="lf-field"><label>Указание (вне игры, необязательно)</label><textarea id="ai-instr" rows="2" placeholder="напр.: пусть в дверь постучат"></textarea></div>
    <div class="lf-hint">Сегодня потрачено: ${money(S.spent_today)}${S.daily_limit != null ? ` из ${money(S.daily_limit)}` : ''}</div>`, s => {
    s.querySelectorAll('[data-ai]').forEach(b => b.onclick = async () => {
      const instruction = s.querySelector('#ai-instr').value; closeSheet();
      try { const r = await api(`/api/rooms/${curRoom.id}/ai`, { method: 'POST', body: { ai_char_id: +b.dataset.ai, instruction } }); S.spent_today = r.spent_today; } catch (e) { toast(e.message, true); }
    });
  });
}

// ───────────── слухи в сцену ─────────────
function pushRumor(text) {
  if (!text) return;
  const rooms = S.rooms.filter(r => r.world_id === curWorldId);
  sheet(`<h2>В какую сцену?</h2><div class="lf-rumor" style="margin:4px 0 12px"><q>${esc(text)}</q></div>
    ${rooms.map(r => `<button class="lf-row" data-to="${r.id}">${icon(r.kind === 'chat' ? 'message' : 'scene')}<span class="lf-grow"><b>${esc(r.title)}</b>${wl().push[r.id] ? '<small>там уже ходит другой слух — заменю</small>' : ''}</span>${icon('send')}</button>`).join('')}`, s => {
    s.querySelectorAll('[data-to]').forEach(b => b.onclick = async () => { await api(`/api/rooms/${b.dataset.to}/rumor`, { method: 'POST', body: { text } }); closeSheet(); toast('Слух пошёл — ИИ упомянет его в ближайшем ответе там'); });
  });
}

// ───────────── питомцы ─────────────
function petSheet(id) {
  const p = wl().pets.find(x => x.id === id);
  if (!p) return closeSheet();
  const room = S.rooms.find(r => r.id === p.home);
  const sh = sheet(`
    <div class="lf-pethero">${p.img ? fit(p.img, '', '', 'style="position:absolute;inset:0"') : `<span class="lf-pethero-ic">${icon('paw')}</span>`}
      <button class="lf-glass" id="pt-draw" data-busy="Рисую…">${icon('wand')} ${p.img ? 'Перерисовать' : 'Портрет'}</button>
      <div class="lf-pethero-t"><h2>${esc(p.name)}</h2><span>${esc(p.kind_label)}${room ? ` · живёт: ${esc(room.title)}` : ''}${p.fav_name ? ` · больше всех любит ${esc(p.fav_name)}` : ''}</span></div></div>
    <div class="lf-petwords">${p.needs.filter(n => n.k !== 'health').map(n => `<span>${icon(n.ic)} ${esc(n.word)}</span>`).join('')}</div>
    <div class="lf-bars">${p.needs.map(n => `<div class="lf-bar-row ${n.v < 30 ? 'low' : ''}">${icon(n.ic)}<span>${n.label}</span><span class="lf-meter"><b style="width:${n.v}%"></b></span><small>${n.v}</small><em>${esc(n.word)}</em></div>`).join('')}</div>
    <div class="lf-actions"><button class="lf-btn" data-act="feed">${icon('utensils')} Покормить</button><button class="lf-btn" data-act="play">${icon('zap')} ${p.kind === 'dog' ? 'Выгулять' : 'Поиграть'}</button><button class="lf-btn" data-act="pet">${icon('heart')} Погладить</button>${p.hurt ? `<button class="lf-btn" id="pt-heal">${icon('activity')} Вылечить</button>` : ''}</div>
    <div class="lf-hint">Сытость, игра и ласка тают по времени истории. Летописец сам заметит, если в посте кота покормили или потискали.</div>
    ${p.look ? `<div class="lf-sec"><span>Какой</span><i class="lf-sec-line"></i></div><div class="lf-text">${esc(p.look)}</div>` : ''}
    ${p.traits?.length ? `<div class="lf-chips wrap">${p.traits.map(t => `<span class="lf-chip mini">${esc(t)}</span>`).join('')}</div>` : ''}
    ${p.moments?.length ? `<div class="lf-sec"><span>Моменты</span><i class="lf-sec-line"></i></div><div class="lf-moments">${p.moments.slice(-8).reverse().map(m => `<span>${m.bad ? '⚠ ' : ''}${esc(m.t)}</span>`).join('')}</div>` : ''}
    <div class="lf-actions"><button class="lf-btn" id="pt-edit">${icon('pencil')} Изменить</button><button class="lf-btn danger icon" id="pt-del">${icon('trash')}</button></div>`, s => {
    const W = curWorldId;
    const patch = async body => { try { await api(`/api/worlds/${W}/pets/${p.id}`, { method: 'PATCH', body }); } catch (e) { toast(e.message, true); } };
    s.querySelectorAll('[data-act]').forEach(b => b.onclick = () => patch({ act: b.dataset.act }));
    const heal = s.querySelector('#pt-heal'); if (heal) heal.onclick = () => patch({ healed: true });
    s.querySelector('#pt-edit').onclick = () => petForm(p);
    s.querySelector('#pt-del').onclick = async () => { if (!confirm(`Убрать ${p.name} из истории?`)) return; await api(`/api/worlds/${W}/pets/${p.id}`, { method: 'DELETE' }); closeSheet(); };
    const d = s.querySelector('#pt-draw');
    d.onclick = () => busy(d, async () => { try { await patch({ img: await drawImage({ prompt: `Portrait of a ${p.kind === 'dog' ? 'dog' : p.kind === 'cat' ? 'cat' : 'pet'} named ${p.name}: ${p.look || ''}. Cozy home interior, soft light, the animal looks at the viewer.`, aspect: '4:3', refs: [p.img] }) }); } catch (e) { toast(e.message, true); } });
  });
  sh.dataset.pet = id;
}
function petForm(p, homeRoom) {
  const kinds = wl().meta.pet_kinds;
  const rooms = S.rooms.filter(r => r.world_id === curWorldId);
  const home = p ? p.home : homeRoom ?? null;
  sheet(`<h2>${p ? esc(p.name) : 'Новый питомец'}</h2>
    <div class="lf-row2"><div class="lf-field" style="flex:2"><label>Кличка</label><input id="pf2-name" value="${esc(p?.name || '')}" placeholder="Альпин"></div>
      <div class="lf-field"><label>Кто</label><select id="pf2-kind">${Object.entries(kinds).map(([k, l]) => `<option value="${k}" ${(p?.kind || 'cat') === k ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></div></div>
    <div class="lf-field"><label>Как выглядит (видит ИИ и художник)</label><textarea id="pf2-look" rows="2" placeholder="рыжий толстый кот с порванным ухом">${esc(p?.look || '')}</textarea></div>
    <div class="lf-field"><label>Характер (через запятую)</label><input id="pf2-traits" value="${esc((p?.traits || []).join(', '))}" placeholder="наглый, ворует еду, любит коробки"></div>
    <div class="lf-field"><label>Живёт</label><select id="pf2-home"><option value="">— нигде —</option>${rooms.map(r => `<option value="${r.id}" ${home === r.id ? 'selected' : ''}>${esc(r.title)}</option>`).join('')}</select></div>
    ${p ? `<div class="lf-field"><label>Больше всех любит (пусто — сам решит по постам)</label><input id="pf2-fav" value="${esc(p.favName || '')}"></div>` : ''}
    <div class="lf-field"><label>Фото</label>${imgField('pf2-img', p?.img, { draw: true, aspect: '4:3' })}</div>
    <button class="lf-btn primary full serif" id="pf2-save">Сохранить</button>`, s => {
    bindImgField(s, 'pf2-img', () => ({ prompt: `Portrait of a ${s.querySelector('#pf2-kind').value === 'dog' ? 'dog' : s.querySelector('#pf2-kind').value === 'cat' ? 'cat' : 'pet'} named ${s.querySelector('#pf2-name').value}: ${s.querySelector('#pf2-look').value}. Cozy home interior, soft light.`, aspect: '4:3', refs: [s.querySelector('#pf2-img').value] }));
    s.querySelector('#pf2-save').onclick = async () => {
      const body = { name: s.querySelector('#pf2-name').value.trim(), kind: s.querySelector('#pf2-kind').value, look: s.querySelector('#pf2-look').value, img: s.querySelector('#pf2-img').value,
        traits: s.querySelector('#pf2-traits').value.split(',').map(x => x.trim()).filter(Boolean), home: +s.querySelector('#pf2-home').value || null };
      if (p) body.fav = s.querySelector('#pf2-fav').value.trim();
      if (!body.name) return toast('Кличка?', true);
      try {
        if (p) await api(`/api/worlds/${curWorldId}/pets/${p.id}`, { method: 'PATCH', body });
        else await api(`/api/worlds/${curWorldId}/pets`, { method: 'POST', body });
        await loadWL(curWorldId, true); closeSheet();
        if (!curRoom) renderTabs(); else updateRoomHere();
      } catch (e) { toast(e.message, true); }
    };
  });
}

// ───────────── треугольники ─────────────
function triSheet(t, preset) {
  const M = wl().meta;
  const pool = chars();
  const st = { who: t ? [...t.who] : preset ? [preset] : [], center: t?.center || preset || '', kind: t?.kind || 'jeal', end: t?.end || 'hold', on: t ? t.on !== false : true };
  const draw = () => {
    if (!st.who.includes(st.center)) st.center = st.who[0] || '';
    s.querySelector('#tr-who').innerHTML = pool.map(c => `<button class="lf-chip ${st.who.includes(c.key) ? 'on' : ''}" data-w="${c.key}">${ava(c, 'xs')} ${esc(c.name)}</button>`).join('');
    s.querySelector('#tr-center').innerHTML = st.who.length ? st.who.map(k => `<button data-c="${k}" class="${st.center === k ? 'on' : ''}">${esc(charBy(k)?.name || '?')}</button>`).join('') : '<button disabled>сначала выбери троих</button>';
    s.querySelectorAll('[data-k]').forEach(b => b.classList.toggle('on', b.dataset.k === st.kind));
    s.querySelectorAll('[data-e]').forEach(b => b.classList.toggle('on', b.dataset.e === st.end));
    s.querySelector('#tr-n').textContent = `${st.who.length} из 3`;
    s.querySelectorAll('[data-w]').forEach(b => b.onclick = () => { const k = b.dataset.w; if (st.who.includes(k)) st.who = st.who.filter(x => x !== k); else if (st.who.length < 3) st.who.push(k); else toast('Уже трое — сними кого-нибудь'); draw(); });
    s.querySelectorAll('[data-c]').forEach(b => b.onclick = () => { st.center = b.dataset.c; draw(); });
  };
  const s = sheet(`<h2>${t ? 'Треугольник' : 'Новый треугольник'}</h2>
    <div class="lf-hint">Трое, где чувства к одному влияют на другого. Когда все трое в сцене — ИИ держит эту ось в поведении. Когда двое, а третьего упомянули, — это отзовётся в реакции.</div>
    <div class="lf-field"><label>Кто <small id="tr-n"></small></label><div class="lf-chips wrap" id="tr-who"></div></div>
    <div class="lf-field"><label>В центре</label><div class="lf-seg" id="tr-center" style="margin:0"></div></div>
    <div class="lf-field"><label>Что между ними</label><div class="lf-chips wrap" style="margin:0">${M.tri_kinds.map(([k, l, ic]) => `<button class="lf-chip mini" data-k="${k}">${icon(ic)} ${esc(l)}</button>`).join('')}</div></div>
    <div class="lf-field"><label>Куда вести</label><div class="lf-seg" style="margin:0">${M.tri_ends.map(([k, l]) => `<button data-e="${k}">${esc(l)}</button>`).join('')}</div></div>
    <div class="lf-field"><label>Подробности (видит ИИ)</label><textarea id="tr-note" rows="2" placeholder="напр.: Макс не знает, что Баки ревнует">${esc(t?.note || '')}</textarea></div>
    ${t ? `<label class="lf-check"><input type="checkbox" id="tr-on" ${st.on ? 'checked' : ''}> Включён</label>` : ''}
    <div class="lf-actions"><button class="lf-btn primary serif" id="tr-save">Сохранить</button>${t?.can_edit ? `<button class="lf-btn danger icon" id="tr-del">${icon('trash')}</button>` : ''}</div>`, null);
  s.querySelectorAll('[data-k]').forEach(b => b.onclick = () => { st.kind = b.dataset.k; draw(); });
  s.querySelectorAll('[data-e]').forEach(b => b.onclick = () => { st.end = b.dataset.e; draw(); });
  draw();
  s.querySelector('#tr-save').onclick = async () => {
    if (st.who.length !== 3) return toast('Нужны ровно трое', true);
    const body = { who: st.who, center: st.center, kind: st.kind, end: st.end, note: s.querySelector('#tr-note').value };
    const on = s.querySelector('#tr-on'); if (on) body.on = on.checked;
    try {
      if (t) await api(`/api/worlds/${curWorldId}/tris/${t.id}`, { method: 'PATCH', body });
      else await api(`/api/worlds/${curWorldId}/tris`, { method: 'POST', body });
      await loadWL(curWorldId, true); closeSheet(); if (!curRoom) renderTabs();
    } catch (e) { toast(e.message, true); }
  };
  const del = s.querySelector('#tr-del'); if (del) del.onclick = async () => { if (!confirm('Удалить треугольник?')) return; await api(`/api/worlds/${curWorldId}/tris/${t.id}`, { method: 'DELETE' }); await loadWL(curWorldId, true); closeSheet(); if (!curRoom) renderTabs(); };
}

// ───────────── траты ─────────────
async function renderUsage() {
  const u = await api('/api/usage');
  const max = Math.max(...u.users.map(x => x.cost), 1e-4);
  $app.innerHTML = `${topBar({ back: "location.hash='#/'", title: 'Траты за месяц', sub: `с ${new Date(u.since).toLocaleDateString('ru')}` })}
    <div class="lf-body anim">
      <div class="lf-clock" style="align-items:flex-start"><small>всего</small><span class="lf-big">${money(u.total)}</span>${u.users.length > 1 ? `<small>поровну — ${money(u.total / u.users.length)} с каждого, по-честному — ниже</small>` : ''}</div>
      ${u.users.map(x => `<div class="lf-usage-row"><div><span>${esc(x.username)}</span><b>${money(x.cost)}</b></div><div class="lf-hint" style="margin:2px 0 6px">${x.calls} вызовов · ${x.pt + x.ct} токенов</div><span class="lf-meter"><b style="width:${(x.cost / max * 100).toFixed(1)}%"></b></span></div>`).join('')}
      <div class="lf-hint">Сегодня ты: ${money(u.my_spent_today)}${u.my_daily_limit != null ? ` из ${money(u.my_daily_limit)}` : ' (без лимита)'}. Летописец и картинки тоже считаются — на того, кто запостил или нажал.</div>
    </div>`;
}

// ───────────── лорбуки ─────────────
async function renderLore(worldId) {
  const w = S.worlds.find(x => x.id === worldId);
  const { lorebooks } = await api(`/api/worlds/${worldId}/lorebooks`);
  $app.innerHTML = `${topBar({ back: "location.hash='#/admin'", title: 'Лорбуки', sub: esc(w?.title || '') })}
  <div class="lf-body anim">
    ${lorebooks.map(b => `<div class="lf-sec"><span>${esc(b.name)}</span><i class="lf-sec-line"></i><small>${b.entries.length}</small></div>
      <div class="lf-actions" style="margin:0 0 6px"><button class="lf-chip ${b.enabled ? 'on' : ''}" data-btoggle="${b.id}">${b.enabled ? 'включён' : 'выключен'}</button><button class="lf-chip" data-bimport="${b.id}">${icon('upload')} импорт ST</button><button class="lf-chip" data-eadd="${b.id}">${icon('plus')} запись</button><button class="lf-chip" data-bdel="${b.id}">${icon('trash')}</button></div>
      ${b.entries.map(e => `<div class="lf-row ${e.enabled ? '' : 'done'}">${icon(e.always_on ? 'pin' : 'key')}<button class="lf-grow" data-eedit="${e.id}" data-ebook="${b.id}" style="text-align:left"><b style="font-size:14.5px">${esc(e.title || e.keys || '(без названия)')}</b><small>${esc(cut(e.keys, 80))}</small></button>
        <button class="lf-chip mini ${e.enabled ? 'on' : ''}" data-etoggle="${e.id}" data-eval="${e.enabled}">${e.enabled ? 'вкл' : 'выкл'}</button></div>`).join('')}`).join('') || `<div class="lf-empty">${icon('book')}Лорбуков нет. Создай и импортни свои из SillyTavern.</div>`}
    <button class="lf-btn primary full serif" id="lb-new" style="margin-top:16px">${icon('plus')} Новый лорбук</button>
    <div class="lf-hint">Импорт — тот же World Info JSON, что экспортируешь из таверны. Закреплённые записи подаются всегда, остальные — когда ключи мелькают в последних постах.</div>
  </div>`;
  const on = (sel, fn) => document.querySelectorAll(sel).forEach(b => b.onclick = () => fn(b));
  document.getElementById('lb-new').onclick = async () => { const name = prompt('Название лорбука:'); if (!name) return; await api(`/api/worlds/${worldId}/lorebooks`, { method: 'POST', body: { name } }); renderLore(worldId); };
  on('[data-btoggle]', async b => { const book = lorebooks.find(x => x.id === +b.dataset.btoggle); await api(`/api/lorebooks/${book.id}`, { method: 'PATCH', body: { enabled: !book.enabled } }); renderLore(worldId); });
  on('[data-bdel]', async b => { if (!confirm('Удалить лорбук со всеми записями?')) return; await api(`/api/lorebooks/${b.dataset.bdel}`, { method: 'DELETE' }); renderLore(worldId); });
  on('[data-bimport]', b => {
    const inp = document.createElement('input'); inp.type = 'file'; inp.accept = '.json,application/json';
    inp.onchange = () => { const f = inp.files[0]; if (!f) return; const rd = new FileReader(); rd.onload = async () => { try { const r = await api(`/api/lorebooks/${b.dataset.bimport}/import`, { method: 'POST', body: { json: rd.result, replace: confirm('Заменить записи? (Отмена — добавить к ним)') } }); toast(`Записей: ${r.imported}`); renderLore(worldId); } catch (e) { toast(e.message, true); } }; rd.readAsText(f); };
    inp.click();
  });
  on('[data-etoggle]', async b => { await api(`/api/lore-entries/${b.dataset.etoggle}`, { method: 'PATCH', body: { enabled: b.dataset.eval !== '1' } }); renderLore(worldId); });
  on('[data-eadd]', b => loreEntryForm(worldId, +b.dataset.eadd));
  on('[data-eedit]', b => { const book = lorebooks.find(x => x.id === +b.dataset.ebook); loreEntryForm(worldId, book.id, book.entries.find(e => e.id === +b.dataset.eedit)); });
}
function loreEntryForm(worldId, bookId, e) {
  sheet(`<h2>${e ? 'Запись' : 'Новая запись'}</h2>
    <div class="lf-field"><label>Название (для себя)</label><input id="le-title" value="${esc(e?.title || '')}"></div>
    <div class="lf-field"><label>Ключи через запятую</label><input id="le-keys" value="${esc(e?.keys || '')}" placeholder="Хеди, Барлоу, лаборатория"></div>
    <div class="lf-field"><label>Текст (идёт в контекст ИИ)</label><textarea id="le-content" rows="8">${esc(e?.content || '')}</textarea></div>
    <label class="lf-check"><input type="checkbox" id="le-always" ${e?.always_on ? 'checked' : ''}> Подавать всегда</label>
    <div class="lf-actions"><button class="lf-btn primary" id="le-save">Сохранить</button>${e ? `<button class="lf-btn danger icon" id="le-del">${icon('trash')}</button>` : ''}</div>`, s => {
    s.querySelector('#le-save').onclick = async () => {
      const body = { title: s.querySelector('#le-title').value, keys: s.querySelector('#le-keys').value, content: s.querySelector('#le-content').value, always_on: s.querySelector('#le-always').checked };
      try { if (e) await api(`/api/lore-entries/${e.id}`, { method: 'PATCH', body }); else await api(`/api/lorebooks/${bookId}/entries`, { method: 'POST', body }); closeSheet(); renderLore(worldId); } catch (er) { toast(er.message, true); }
    };
    const d = s.querySelector('#le-del'); if (d) d.onclick = async () => { if (!confirm('Удалить запись?')) return; await api(`/api/lore-entries/${e.id}`, { method: 'DELETE' }); closeSheet(); renderLore(worldId); };
  });
}

// ───────────── админка ─────────────
async function renderAdmin() {
  const [st, inv, ext, aiAll] = await Promise.all([api('/api/settings'), api('/api/invites'), api('/api/extensions'), api('/api/ai-chars')]);
  const aiFull = aiAll.ai_chars;
  const sec = (t, small = '') => `<div class="lf-sec"><span>${t}</span><i class="lf-sec-line"></i>${small ? `<small>${small}</small>` : ''}</div>`;
  $app.innerHTML = `${topBar({ back: "location.hash='#/'", title: 'Админка', sub: esc(S.app_title) })}
  <div class="lf-body anim">
    ${sec('Миры')}
    ${S.worlds.map(w => `<div class="lf-row"><span class="emoji" style="font-size:20px">${w.emoji}</span><span class="lf-grow"><b>${esc(w.title)}</b><small>${w.map ? 'есть карта' : 'без карты'}${w.clock ? ` · ${esc(w.clock)}` : ''}</small></span>
      <button class="lf-chip mini" onclick="location.hash='#/lore/${w.id}'">${icon('book')} лор</button><button class="lf-iconbtn sm" data-wedit="${w.id}">${icon('pencil')}</button></div>`).join('')}
    <button class="lf-btn ghost full" id="a-world">${icon('plus')} Мир</button>
    ${sec('Комнаты')}
    ${S.worlds.map(w => S.rooms.filter(r => r.world_id === w.id).map(r => `<div class="lf-row">${icon(r.kind === 'chat' ? 'message' : 'scene')}<span class="lf-grow"><b>${esc(r.title)}</b><small>${esc(w.title)} · ${esc(r.category)}${r.auto_ai_char_id ? ' · авто-бот' : ''}${r.chron_on === 0 || (r.chron_on === -1 && r.kind === 'chat') ? ' · без Летописца' : ''}</small></span><button class="lf-iconbtn sm" data-redit="${r.id}">${icon('pencil')}</button></div>`).join('')).join('')}
    <button class="lf-btn ghost full" id="a-room">${icon('plus')} Комната</button>
    ${sec('ИИ-персонажи')}
    ${aiFull.map(c => `<div class="lf-row">${ava(c, 'md')}<span class="lf-grow"><b>${esc(c.name)}</b><small>${esc(c.model)}${c.world_id ? ` · ${esc(S.worlds.find(w => w.id === c.world_id)?.title || '')}` : ' · все миры'}</small></span>
      <button class="lf-chip mini" data-life="a${c.id}">${icon('heart')} Life</button><button class="lf-iconbtn sm" data-aiedit="${c.id}">${icon('pencil')}</button></div>`).join('')}
    <button class="lf-btn ghost full" id="a-ai">${icon('plus')} ИИ-персонаж</button>
    ${sec('Расширения', 'CSS/JS только проверенные')}
    ${ext.extensions.map(x => `<div class="lf-row">${icon('puzzle')}<span class="lf-grow"><b>${esc(x.name)}</b></span><button class="lf-chip mini ${x.enabled ? 'on' : ''}" data-xt="${x.id}" data-xv="${x.enabled}">${x.enabled ? 'вкл' : 'выкл'}</button><button class="lf-iconbtn sm" data-xedit="${x.id}">${icon('pencil')}</button><button class="lf-iconbtn sm" data-xdel="${x.id}">${icon('trash')}</button></div>`).join('')}
    <button class="lf-btn ghost full" id="a-ext">${icon('plus')} Расширение</button>
    ${sec('Инвайты')}
    ${inv.invites.map(i => `<div class="lf-row">${icon('key')}<span class="lf-grow"><b style="font-family:monospace">${i.code}</b><small>${i.used_by_name ? `использовал ${esc(i.used_by_name)}` : 'свободен'}</small></span></div>`).join('')}
    <button class="lf-btn ghost full" id="a-inv">${icon('plus')} Инвайт</button>
    ${sec('Игроки и лимиты')}
    ${S.users.map(u => `<div class="lf-row">${icon('user')}<span class="lf-grow"><b>${esc(u.username)}${u.is_admin ? ' · админ' : ''}</b></span>${u.is_admin ? '' : `<button class="lf-chip mini" data-limit="${u.id}">лимит</button>`}</div>`).join('')}
    ${sec('Модели и ключ')}
    <div class="lf-field"><label>Название</label><input id="s-title" value="${esc(st.app_title)}"></div>
    <div class="lf-field"><label>Дневной лимит по умолчанию, $</label><input id="s-limit" value="${esc(st.default_daily_limit_usd)}"></div>
    <div class="lf-field"><label>Летописец Life (после каждого поста) — пусто = как модель хроники</label><input id="s-life" value="${esc(st.life_model)}" placeholder="${esc(st.chronicle_model)}"></div>
    <div class="lf-field"><label>Модель хроники</label><input id="s-chm" value="${esc(st.chronicle_model)}"></div>
    <div class="lf-field"><label>Модель картинок</label><input id="s-img" value="${esc(st.image_model)}"></div>
    <div class="lf-field"><label>Стиль картинок</label><textarea id="s-art" rows="2">${esc(st.art_style)}</textarea></div>
    <div class="lf-field"><label>OpenRouter API-ключ ${st.openrouter_key_set ? '(задан, наружу не отдаётся)' : '— не задан'}</label><input id="s-key" type="password" placeholder="sk-or-…"></div>
    <button class="lf-btn primary full serif" id="s-save">Сохранить</button>
  </div>`;
  const on = (sel, fn) => document.querySelectorAll(sel).forEach(b => b.onclick = () => fn(b));
  on('#a-world', () => worldForm());
  on('[data-wedit]', async b => worldForm((await api(`/api/worlds/${b.dataset.wedit}`)).world));
  on('#a-room', () => roomForm(null, renderAdmin));
  on('[data-redit]', b => roomForm(S.rooms.find(r => r.id === +b.dataset.redit), renderAdmin));
  on('#a-ai', () => aiForm());
  on('[data-aiedit]', b => aiForm(aiFull.find(c => c.id === +b.dataset.aiedit)));
  on('[data-life]', b => openCardSheet(b.dataset.life, 'life'));
  on('#a-ext', () => extForm());
  on('[data-xedit]', b => extForm(ext.extensions.find(x => x.id === +b.dataset.xedit)));
  on('[data-xt]', async b => { await api(`/api/extensions/${b.dataset.xt}`, { method: 'PATCH', body: { enabled: b.dataset.xv !== '1' } }); toast('Применится после перезагрузки'); renderAdmin(); });
  on('[data-xdel]', async b => { if (!confirm('Удалить расширение?')) return; await api(`/api/extensions/${b.dataset.xdel}`, { method: 'DELETE' }); renderAdmin(); });
  on('#a-inv', async () => { const r = await api('/api/invites', { method: 'POST' }); try { await navigator.clipboard.writeText(r.code); } catch {} toast(`Инвайт ${r.code} — скопирован`); renderAdmin(); });
  on('[data-limit]', async b => { const v = prompt('Дневной лимит $ (пусто — по умолчанию):'); if (v === null) return; await api(`/api/users/${b.dataset.limit}/limit`, { method: 'PATCH', body: { daily_limit_usd: v === '' ? null : parseFloat(v) } }); toast('Ок'); });
  on('#s-save', async () => {
    const body = { app_title: v('s-title'), default_daily_limit_usd: v('s-limit'), life_model: v('s-life'), chronicle_model: v('s-chm'), image_model: v('s-img'), art_style: v('s-art') };
    const key = v('s-key').trim(); if (key) body.openrouter_key = key;
    await api('/api/settings', { method: 'PATCH', body }); await refreshState(); toast('Сохранено');
  });
}
const v = id => document.getElementById(id).value;
function worldForm(w) {
  sheet(`<h2>${w ? esc(w.title) : 'Новый мир'}</h2>
    <div class="lf-row2"><div class="lf-field" style="flex:3"><label>Название</label><input id="wf-title" value="${esc(w?.title || '')}"></div><div class="lf-field"><label>Эмодзи</label><input id="wf-emoji" value="${esc(w?.emoji || '🌍')}"></div></div>
    <div class="lf-field"><label>Промпт мира (сеттинг, правила, тон — видят все ИИ мира)</label><textarea id="wf-prompt" rows="6">${esc(w?.prompt || '')}</textarea></div>
    <div class="lf-field"><label>Стиль картинок мира (пусто — общий)</label><input id="wf-art" value="${esc(w?.art_style || '')}"></div>
    <div class="lf-field"><label>Обложка</label>${imgField('wf-cover', w?.cover, { draw: true, aspect: '16:9' })}</div>
    <div class="lf-field"><label>Карта</label>${imgField('wf-map', w?.map, { aspect: '3:4' })}</div>
    <div class="lf-actions"><button class="lf-btn primary serif" id="wf-save">Сохранить</button>${w ? `<button class="lf-btn danger" id="wf-arch">${icon('box')} В архив</button>` : ''}</div>`, s => {
    bindImgField(s, 'wf-cover', () => ({ prompt: `Atmospheric establishing shot for a story world "${s.querySelector('#wf-title').value}". ${s.querySelector('#wf-prompt').value.slice(0, 500)}. No people in focus.`, aspect: '16:9' }));
    bindImgField(s, 'wf-map');
    s.querySelector('#wf-save').onclick = async () => {
      const body = { title: s.querySelector('#wf-title').value, emoji: s.querySelector('#wf-emoji').value || '🌍', prompt: s.querySelector('#wf-prompt').value, art_style: s.querySelector('#wf-art').value, cover: s.querySelector('#wf-cover').value, map: s.querySelector('#wf-map').value };
      try { if (w) await api(`/api/worlds/${w.id}`, { method: 'PATCH', body }); else await api('/api/worlds', { method: 'POST', body }); await refreshState(); closeSheet(); renderAdmin(); } catch (e) { toast(e.message, true); }
    };
    const a = s.querySelector('#wf-arch'); if (a) a.onclick = async () => { if (!confirm('Убрать мир в архив? Комнаты и посты останутся.')) return; await api(`/api/worlds/${w.id}`, { method: 'PATCH', body: { archived: true } }); await refreshState(); closeSheet(); renderAdmin(); };
  });
}
function roomForm(r, after) {
  const bots = S.ai_chars, att = r?.ai_ids || [];
  const ch = r ? (r.chron_on === -1 ? 'auto' : r.chron_on ? 'on' : 'off') : 'auto';
  sheet(`<h2>${r ? esc(r.title) : 'Новая комната'}</h2>
    <div class="lf-field"><label>Название</label><input id="rf-title" value="${esc(r?.title || '')}"></div>
    <div class="lf-row2"><div class="lf-field"><label>Мир</label><select id="rf-world">${S.worlds.map(w => `<option value="${w.id}" ${(r?.world_id ?? curWorldId) === w.id ? 'selected' : ''}>${esc(w.title)}</option>`).join('')}</select></div>
      <div class="lf-field"><label>Тип</label><select id="rf-kind"><option value="forum" ${r?.kind !== 'chat' ? 'selected' : ''}>История (посты)</option><option value="chat" ${r?.kind === 'chat' ? 'selected' : ''}>Чат</option></select></div></div>
    <div class="lf-field"><label>Раздел</label><input id="rf-cat" value="${esc(r?.category || 'Локации')}"></div>
    <div class="lf-field"><label>Описание места (видят игроки и ИИ)</label><textarea id="rf-desc" rows="4">${esc(r?.description || '')}</textarea></div>
    <div class="lf-field"><label>Кадр места</label>${imgField('rf-cover', r?.cover, { draw: true, aspect: '16:9' })}</div>
    <div class="lf-field"><label>Летописец после каждого поста</label><div class="lf-seg" style="margin:0">${[['auto', 'Авто'], ['on', 'Вкл'], ['off', 'Выкл']].map(([k, l]) => `<button data-ch="${k}" class="${ch === k ? 'on' : ''}">${l}</button>`).join('')}</div><div class="lf-hint">Авто — в историях да, в чатах нет.</div></div>
    <div class="lf-field"><label>Боты этой комнаты</label>${bots.map(c => `<label class="lf-check"><input type="checkbox" data-bot="${c.id}" ${att.includes(c.id) ? 'checked' : ''}> ${esc(c.name)}</label>`).join('') || '<div class="lf-hint">ИИ-персонажей пока нет</div>'}</div>
    <div class="lf-field"><label>Авто-ответ (бот сам отвечает на каждый пост в роли)</label><select id="rf-auto"><option value="">— выключен —</option>${bots.map(c => `<option value="${c.id}" ${r?.auto_ai_char_id === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></div>
    <div class="lf-actions"><button class="lf-btn primary serif" id="rf-save">Сохранить</button>${r ? `<button class="lf-btn danger" id="rf-arch">${icon('box')} В архив</button>` : ''}</div>`, s => {
    let chOn = ch;
    s.querySelectorAll('[data-ch]').forEach(b => b.onclick = () => { chOn = b.dataset.ch; s.querySelectorAll('[data-ch]').forEach(x => x.classList.toggle('on', x === b)); });
    bindImgField(s, 'rf-cover', () => ({ prompt: `${s.querySelector('#rf-title').value}: ${s.querySelector('#rf-desc').value.slice(0, 500)}. Establishing shot of the place, no people.`, aspect: '16:9' }));
    s.querySelector('#rf-save').onclick = async () => {
      const body = { title: s.querySelector('#rf-title').value, world_id: +s.querySelector('#rf-world').value, kind: s.querySelector('#rf-kind').value, category: s.querySelector('#rf-cat').value, description: s.querySelector('#rf-desc').value, cover: s.querySelector('#rf-cover').value,
        ai_ids: [...s.querySelectorAll('[data-bot]:checked')].map(x => +x.dataset.bot), auto_ai_char_id: +s.querySelector('#rf-auto').value || null, chron_on: chOn === 'auto' ? null : chOn === 'on' };
      try {
        if (r) await api(`/api/rooms/${r.id}`, { method: 'PATCH', body });
        else { const res = await api('/api/rooms', { method: 'POST', body }); await api(`/api/rooms/${res.id}`, { method: 'PATCH', body: { chron_on: body.chron_on } }); }
        await refreshState(); closeSheet(); (after || renderTabs)();
      } catch (e) { toast(e.message, true); }
    };
    const a = s.querySelector('#rf-arch'); if (a) a.onclick = async () => { if (!confirm('Убрать комнату в архив? Посты останутся.')) return; await api(`/api/rooms/${r.id}`, { method: 'PATCH', body: { archived: true } }); await refreshState(); closeSheet(); (after || renderTabs)(); };
  });
}
function aiForm(c) {
  sheet(`<h2>${c ? esc(c.name) : 'Новый ИИ-персонаж'}</h2>
    <div class="lf-field"><label>Имя</label><input id="af-name" value="${esc(c?.name || '')}" placeholder="Баки Барнс / Гейммастер"></div>
    <div class="lf-field"><label>Портрет</label>${imgField('af-ava', c?.avatar, { draw: true })}</div>
    <div class="lf-row2"><div class="lf-field"><label>Мир</label><select id="af-world"><option value="">Все миры</option>${S.worlds.map(w => `<option value="${w.id}" ${c?.world_id === w.id ? 'selected' : ''}>${esc(w.title)}</option>`).join('')}</select></div>
      <div class="lf-field"><label>Эмодзи</label><input id="af-emoji" value="${esc(c?.emoji || '✦')}"></div></div>
    <div class="lf-field"><label>Модель (слаг OpenRouter)</label><input id="af-model" value="${esc(c?.model || 'anthropic/claude-sonnet-5.5')}"></div>
    <div class="lf-field"><label>Карточка / системный промпт</label><textarea id="af-prompt" rows="8">${esc(c?.system_prompt || '')}</textarea></div>
    <div class="lf-row2"><div class="lf-field"><label>Температура</label><input id="af-temp" type="number" step="0.1" min="0" max="2" value="${c?.temperature ?? 0.9}"></div>
      <div class="lf-field"><label>Макс. токенов</label><input id="af-max" type="number" value="${c?.max_tokens ?? 1200}"></div>
      <div class="lf-field"><label>Постов в контекст</label><input id="af-ctx" type="number" value="${c?.context_posts ?? 40}"></div></div>
    <div class="lf-actions"><button class="lf-btn primary serif" id="af-save">Сохранить</button>${c ? `<button class="lf-btn danger icon" id="af-del">${icon('trash')}</button>` : ''}</div>`, s => {
    bindImgField(s, 'af-ava', () => ({ prompt: `Portrait of ${s.querySelector('#af-name').value}, head and shoulders, looking at the viewer.`, aspect: '3:4', refs: [s.querySelector('#af-ava').value] }));
    s.querySelector('#af-save').onclick = async () => {
      const body = { name: s.querySelector('#af-name').value, avatar: s.querySelector('#af-ava').value, emoji: s.querySelector('#af-emoji').value, world_id: +s.querySelector('#af-world').value || null, model: s.querySelector('#af-model').value, system_prompt: s.querySelector('#af-prompt').value,
        temperature: parseFloat(s.querySelector('#af-temp').value), max_tokens: parseInt(s.querySelector('#af-max').value, 10), context_posts: parseInt(s.querySelector('#af-ctx').value, 10) };
      try { if (c) await api(`/api/ai-chars/${c.id}`, { method: 'PATCH', body }); else await api('/api/ai-chars', { method: 'POST', body }); await refreshState(); closeSheet(); renderAdmin(); } catch (e) { toast(e.message, true); }
    };
    const d = s.querySelector('#af-del'); if (d) d.onclick = async () => { if (!confirm('Удалить ИИ-персонажа?')) return; await api(`/api/ai-chars/${c.id}`, { method: 'PATCH', body: { deleted: true } }); await refreshState(); closeSheet(); renderAdmin(); };
  });
}
function extForm(x) {
  sheet(`<h2>${x ? esc(x.name) : 'Новое расширение'}</h2>
    <div class="lf-field"><label>Название</label><input id="xf-name" value="${esc(x?.name || '')}"></div>
    <div class="lf-field"><label>CSS</label><textarea id="xf-css" rows="6" style="font-family:monospace;font-size:12.5px">${esc(x?.css || '')}</textarea></div>
    <div class="lf-field"><label>JS (объект Tavern: api, toast, sheet, state, icon)</label><textarea id="xf-js" rows="8" style="font-family:monospace;font-size:12.5px">${esc(x?.js || '')}</textarea></div>
    <div class="lf-note">${icon('shield')} Код выполняется у всех в браузере — ставь только свой или проверенный.</div>
    <button class="lf-btn primary full" id="xf-save">Сохранить</button>`, s => {
    s.querySelector('#xf-save').onclick = async () => {
      const body = { name: s.querySelector('#xf-name').value, css: s.querySelector('#xf-css').value, js: s.querySelector('#xf-js').value };
      try { if (x) await api(`/api/extensions/${x.id}`, { method: 'PATCH', body }); else await api('/api/extensions', { method: 'POST', body }); closeSheet(); toast('Применится после перезагрузки'); renderAdmin(); } catch (e) { toast(e.message, true); }
    };
  });
}

// ───────────── старт ─────────────
async function boot() {
  try { await refreshState(); connectSSE(); await route(); }
  catch { S = null; renderLogin(); }
}
boot();
