'use strict';
/* Таверна — фронт без фреймворков */

const $app = document.getElementById('app');
let S = null;
let curRoom = null;
let posts = [];
let composer = { persona_id: null, ooc: false, image: '' };
let sse = null;
let extLoaded = false;
let tab = 'rooms';
let curWorldId = parseInt(localStorage.getItem('tavern_world') || '0', 10) || null;

// ---------- темы ----------
const THEMES = [
  ['wine', 'Графит и вино'], ['candle', 'Свечная'], ['parchment', 'Пергамент'],
  ['midnight', 'Полночь'], ['grove', 'Роща'],
];
function applyTheme(t) {
  document.body.dataset.theme = t;
  localStorage.setItem('tavern_theme', t);
}
applyTheme(localStorage.getItem('tavern_theme') || 'wine');

// ---------- utils ----------
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtBody = s => esc(s).replace(/\*([^*\n]{1,200}?)\*/g, '<em>$1</em>');
const fmtTime = ts => {
  if (!ts) return '';
  const d = new Date(ts), today = new Date();
  const hm = d.toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === today.toDateString()) return 'Сегодня, ' + hm;
  const yest = new Date(today.getTime() - 864e5);
  if (d.toDateString() === yest.toDateString()) return 'Вчера, ' + hm;
  return d.toLocaleDateString('ru', { day: 'numeric', month: 'short' }) + ', ' + hm;
};
const money = v => '$' + (v || 0).toFixed(v >= 1 ? 2 : 3);
const avaHtml = (a, cls = 'ava') => a.avatar
  ? `<div class="${cls}" style="border-color:${a.color};background-image:url('${esc(a.avatar)}')"></div>`
  : `<div class="${cls}" style="border-color:${a.color}">${a.emoji}</div>`;

function world() { return S.worlds.find(w => w.id === curWorldId) || S.worlds[0] || null; }

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function toast(text, bad = false) {
  const t = document.createElement('div');
  t.textContent = text;
  t.style.cssText = `position:fixed;left:50%;transform:translateX(-50%);bottom:90px;z-index:99;
    background:${bad ? 'var(--bad-bg)' : 'var(--panel2)'};color:${bad ? 'var(--bad-ink)' : 'var(--ink)'};
    padding:10px 16px;border-radius:12px;font-size:14px;max-width:86vw;border:1px solid var(--line);text-align:center`;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), bad ? 5000 : 2500);
}

// ---------- загрузка картинок ----------
function pickImage(cb) {
  const inp = document.createElement('input');
  inp.type = 'file'; inp.accept = 'image/*';
  inp.onchange = () => {
    const f = inp.files[0]; if (!f) return;
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = async () => {
        const MAX = 1600;
        const k = Math.min(1, MAX / Math.max(img.width, img.height));
        const cv = document.createElement('canvas');
        cv.width = Math.round(img.width * k); cv.height = Math.round(img.height * k);
        cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
        try {
          const r = await api('/api/upload', { method: 'POST', body: { data: cv.toDataURL('image/jpeg', 0.85) } });
          cb(r.url);
        } catch (e) { toast(e.message, true); }
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(f);
  };
  inp.click();
}

function coverField(id, current) {
  return `<div class="row2" style="align-items:center">
    <button type="button" class="btn ghost small" id="${id}-btn">🖼 ${current ? 'Сменить картинку' : 'Загрузить картинку'}</button>
    <button type="button" class="btn ghost small" id="${id}-clear" ${current ? '' : 'style="display:none"'}>✖ Убрать</button>
  </div>
  <input type="hidden" id="${id}" value="${esc(current || '')}">`;
}
function bindCoverField(s, id) {
  s.querySelector(`#${id}-btn`).onclick = () => pickImage(url => {
    s.querySelector(`#${id}`).value = url;
    s.querySelector(`#${id}-btn`).textContent = '🖼 Сменить картинку';
    s.querySelector(`#${id}-clear`).style.display = '';
    toast('Картинка загружена');
  });
  s.querySelector(`#${id}-clear`).onclick = () => {
    s.querySelector(`#${id}`).value = '';
    s.querySelector(`#${id}-clear`).style.display = 'none';
    s.querySelector(`#${id}-btn`).textContent = '🖼 Загрузить картинку';
  };
}

// ---------- расширения ----------
function loadExtensions() {
  if (extLoaded || !S) return;
  extLoaded = true;
  for (const x of S.extensions || []) {
    try {
      if (x.css) { const st = document.createElement('style'); st.textContent = x.css; document.head.appendChild(st); }
      if (x.js) new Function('Tavern', x.js)({ api, toast, sheet, closeSheet, state: () => S });
    } catch (e) { console.error('Расширение', x.name, e); }
  }
}

// ---------- авторы ----------
function author(p) {
  if (p.ai_char_id) {
    const c = S.ai_chars.find(c => c.id === p.ai_char_id);
    return { name: c ? c.name : 'ИИ', sub: 'ИИ', emoji: c?.emoji || '🤖', color: c?.color || '#c99ba8', avatar: c?.avatar || '', ai: true };
  }
  if (p.persona_id) {
    const pe = S.all_personas.find(x => x.id === p.persona_id);
    return pe
      ? { name: pe.name, sub: 'игрок: ' + pe.username, emoji: pe.emoji, color: pe.color, avatar: pe.avatar || '', pid: pe.id }
      : { name: '???', sub: '', emoji: '🎭', color: '#777', avatar: '' };
  }
  const u = S.users.find(u => u.id === p.user_id);
  return { name: u ? u.username : '???', sub: 'вне игры', emoji: '💬', color: '#8a8a8a', avatar: '' };
}

// ---------- SSE ----------
function connectSSE() {
  if (sse) sse.close();
  sse = new EventSource('/api/events');
  sse.onmessage = e => {
    const ev = JSON.parse(e.data);
    if (ev.type === 'post') {
      if (curRoom && ev.post.room_id === curRoom.id && !posts.find(p => p.id === ev.post.id)) {
        posts.push(ev.post); renderFeedAppend(ev.post);
      }
      const r = S?.rooms.find(r => r.id === ev.post.room_id);
      if (r) { r.last_at = ev.post.created_at; r.post_count++; r.preview = ev.post.body.slice(0, 90); }
      if (!curRoom) render();
    } else if (ev.type === 'post_edit' && curRoom && ev.post.room_id === curRoom.id) {
      const i = posts.findIndex(p => p.id === ev.post.id);
      if (i >= 0) { posts[i] = ev.post; render(); }
    } else if (ev.type === 'post_delete' && curRoom && ev.room_id === curRoom.id) {
      posts = posts.filter(p => p.id !== ev.post_id); render();
    } else if (ev.type === 'ai_typing' && curRoom && ev.room_id === curRoom.id) {
      const el = document.getElementById('typing');
      if (el) {
        const c = S.ai_chars.find(c => c.id === ev.ai_char_id);
        el.textContent = ev.on ? `${c?.emoji || '🤖'} ${c?.name || 'ИИ'} пишет…` : '';
      }
    } else if (ev.type === 'ai_error') {
      if (curRoom && ev.room_id === curRoom.id) toast('ИИ: ' + ev.message, true);
    } else if (['rooms', 'personas', 'ai_chars', 'chronicle', 'extensions'].includes(ev.type)) {
      refreshState().then(() => { if (!document.querySelector('.overlay')) render(); });
    }
  };
}

async function refreshState() {
  S = await api('/api/state');
  if (!composer.persona_id && S.my_personas[0]) composer.persona_id = S.my_personas[0].id;
  if (composer.persona_id && !S.my_personas.find(p => p.id === composer.persona_id)) composer.persona_id = null;
  if (!S.worlds.find(w => w.id === curWorldId)) curWorldId = S.worlds[0]?.id || null;
  loadExtensions();
}

// ---------- роутинг ----------
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
    }
  }
  render();
  if (curRoom) scrollFeedDown();
}

function scrollFeedDown() {
  requestAnimationFrame(() => {
    const sc = document.querySelector('.screen');
    if (sc) sc.scrollTop = sc.scrollHeight;
  });
}

// ---------- рендер ----------
function render() {
  const h = location.hash || '#/';
  if (!S) return renderLogin();
  if (curRoom) return renderRoom();
  if (h === '#/usage') return renderUsage();
  if (h === '#/admin') return renderAdmin();
  let m;
  if ((m = h.match(/^#\/lore\/(\d+)/))) return renderLore(+m[1]);
  renderTabs();
}

// ----- логин -----
function renderLogin(mode = 'login') {
  $app.innerHTML = `
  <div class="login-wrap">
    <div class="login-card">
      <div class="logo">🕯️</div>
      <h1>Таверна</h1>
      <div class="tabs">
        <button id="t-login" class="${mode === 'login' ? 'on' : ''}">Вход</button>
        <button id="t-reg" class="${mode === 'reg' ? 'on' : ''}">Регистрация</button>
      </div>
      ${mode === 'reg' ? `<input id="f-invite" placeholder="Инвайт-код" autocomplete="off">` : ''}
      <input id="f-user" placeholder="Ник" autocomplete="username">
      <input id="f-pass" type="password" placeholder="Пароль" autocomplete="current-password">
      <button class="btn" id="go">${mode === 'reg' ? 'Создать аккаунт' : 'Войти'}</button>
      <div class="msg-err" id="err"></div>
      ${mode === 'reg' ? `<div class="hint" style="text-align:center">Самый первый аккаунт становится админом — инвайт ему не нужен.</div>` : ''}
    </div>
  </div>`;
  document.getElementById('t-login').onclick = () => renderLogin('login');
  document.getElementById('t-reg').onclick = () => renderLogin('reg');
  document.getElementById('go').onclick = async () => {
    const body = {
      username: document.getElementById('f-user').value,
      password: document.getElementById('f-pass').value,
    };
    try {
      if (mode === 'reg') {
        body.invite = document.getElementById('f-invite')?.value || '';
        await api('/api/register', { method: 'POST', body });
      } else await api('/api/login', { method: 'POST', body });
      await boot();
    } catch (e) { document.getElementById('err').textContent = e.message; }
  };
}

// ----- каркас с табами -----
const TABS = [
  ['rooms', '💬', 'Комнаты'], ['chars', '👥', 'Персонажи'], ['map', '🗺', 'Мир'], ['settings', '⚙️', 'Настройки'],
];
function renderTabs() {
  const myAva = S.my_personas.find(p => p.avatar);
  let content = '';
  if (tab === 'rooms') content = roomsTabHtml();
  else if (tab === 'chars') content = charsTabHtml();
  else if (tab === 'map') content = mapTabHtml();
  else content = settingsTabHtml();
  $app.innerHTML = `
  <div class="topbar">
    <h1>🕯️ ${esc(S.app_title)}</h1>
    <div class="top-ava" ${myAva ? `style="background-image:url('${esc(myAva.avatar)}')"` : ''}>${myAva ? '' : '🎭'}</div>
  </div>
  <div class="screen" id="tabscreen">${content}</div>
  <div class="tabbar">
    ${TABS.map(([id, icon, label]) => `
      <button class="${tab === id ? 'on' : ''}" data-tab="${id}"><span class="ti">${icon}</span>${label}</button>`).join('')}
  </div>`;
  document.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => { tab = b.dataset.tab; renderTabs(); });
  bindTab();
}

function worldChipsHtml() {
  if (S.worlds.length <= 1) return '';
  return `<div class="world-chips">
    ${S.worlds.map(w => `<button class="chip ${w.id === curWorldId ? 'on' : ''}" data-world="${w.id}">${w.emoji} ${esc(w.title)}</button>`).join('')}
  </div>`;
}
function bindWorldChips() {
  document.querySelectorAll('[data-world]').forEach(b => b.onclick = () => {
    curWorldId = +b.dataset.world; localStorage.setItem('tavern_world', curWorldId); renderTabs();
  });
}

// ----- таб: комнаты -----
function roomsTabHtml() {
  const w = world();
  const rooms = w ? S.rooms.filter(r => r.world_id === w.id).slice().sort((a, b) => (b.last_at || 0) - (a.last_at || 0)) : [];
  return `<div class="pad">
    ${worldChipsHtml()}
    <div class="h-sect">
      <h2>Ваши истории</h2>
      ${S.me.is_admin ? `<button class="btn small" id="rt-newroom">＋ Комната</button>` : ''}
    </div>
    ${rooms.map(storyCardHtml).join('') ||
      `<div class="hint" style="margin-top:20vh;text-align:center">Комнат пока нет.${S.me.is_admin ? '<br>Жми «＋ Комната».' : ' Жди админа.'}</div>`}
  </div>`;
}
function storyCardHtml(r) {
  return `
  <button class="story-card" onclick="location.hash='#/room/${r.id}'">
    <div class="thumb" ${r.cover ? `style="background-image:url('${esc(r.cover)}')"` : ''}>${r.cover ? '' : (r.kind === 'chat' ? '💬' : '📜')}</div>
    <div class="sc-body">
      <div class="sc-top">
        <div class="sc-title">${esc(r.title)}</div>
        <div class="sc-time">${r.last_at ? fmtTime(r.last_at) : ''}</div>
      </div>
      <div class="sc-prev">${esc(r.preview || r.description || '…')}</div>
    </div>
  </button>`;
}

// ----- таб: персонажи -----
function charsTabHtml() {
  const w = world();
  const ai = S.ai_chars.filter(c => !c.world_id || !w || c.world_id === w.id);
  return `<div class="pad">
    ${worldChipsHtml()}
    <div class="h-sect">
      <h2>Персонажи</h2>
      <button class="btn small ghost" id="ct-mine">🎭 Мои</button>
    </div>
    <div class="char-grid">
      ${S.all_personas.map(p => `
        <button class="char-card" data-pp="${p.id}">
          <div class="cc-img" ${p.avatar ? `style="background-image:url('${esc(p.avatar)}')"` : ''}>${p.avatar ? '' : p.emoji}</div>
          <div class="cc-name">${esc(p.name)}</div>
          <div class="cc-sub">${esc(p.username)}</div>
        </button>`).join('')}
      ${ai.map(c => `
        <button class="char-card" data-ai-card="${c.id}">
          <div class="cc-img" ${c.avatar ? `style="background-image:url('${esc(c.avatar)}')"` : ''}>${c.avatar ? '' : c.emoji}</div>
          <div class="cc-name">${esc(c.name)}</div>
          <div class="cc-sub">ИИ</div>
        </button>`).join('')}
    </div>
  </div>`;
}

// ----- таб: карта -----
function mapTabHtml() {
  const w = world();
  if (!w) return `<div class="pad hint">Миров нет.</div>`;
  const rooms = S.rooms.filter(r => r.world_id === w.id);
  const pinned = rooms.filter(r => r.map_x != null && r.map_y != null);
  return `<div>
    <div class="pad" style="padding-bottom:0">
      ${worldChipsHtml()}
      <div class="h-sect"><h2>${w.emoji} ${esc(w.title)}</h2>
        ${S.me.is_admin ? `<button class="btn small ghost" id="mt-setup">📍 Метки</button>` : ''}
      </div>
    </div>
    ${w.map ? `
      <div class="map-wrap" id="mapwrap">
        <img src="${esc(w.map)}" draggable="false">
        ${pinned.map(r => `
          <button class="map-pin" data-pin="${r.id}" style="left:${r.map_x}%;top:${r.map_y}%">
            <span class="mp-dot">📍</span><span class="mp-label">${esc(r.title)}</span>
          </button>`).join('')}
      </div>
      ${pinned.length ? '' : `<div class="hint map-hint">Меток пока нет${S.me.is_admin ? ' — жми «📍 Метки» и расставь локации' : ''}.</div>`}
    ` : `<div class="pad hint">У этого мира ещё нет карты.${S.me.is_admin ? ' Загрузи её: ⚙️ Настройки → Админка → ✏️ мира → «Карта мира».' : ''}</div>`}
  </div>`;
}

function bindTab() {
  bindWorldChips();
  const nr = document.getElementById('rt-newroom'); if (nr) nr.onclick = () => roomForm();
  const cm = document.getElementById('ct-mine'); if (cm) cm.onclick = personasSheet;
  document.querySelectorAll('[data-pp]').forEach(b => b.onclick = () => personaProfile(+b.dataset.pp));
  document.querySelectorAll('[data-ai-card]').forEach(b => b.onclick = () => {
    const c = S.ai_chars.find(x => x.id === +b.dataset.aiCard);
    if (c) sheet(`<h2>${c.emoji} ${esc(c.name)}</h2><div class="hint">ИИ-персонаж · ${esc(c.model)}</div>
      ${c.avatar ? `<img src="${esc(c.avatar)}" style="width:100%;border-radius:12px">` : ''}`);
  });
  document.querySelectorAll('[data-pin]').forEach(b => b.onclick = () => { location.hash = `#/room/${b.dataset.pin}`; });
  const ms = document.getElementById('mt-setup'); if (ms) ms.onclick = mapSetupSheet;
  // настройки
  const st = document.getElementById('set-theme'); if (st) st.onclick = themeSheet;
  const sp = document.getElementById('set-personas'); if (sp) sp.onclick = personasSheet;
  const su = document.getElementById('set-usage'); if (su) su.onclick = () => location.hash = '#/usage';
  const sa = document.getElementById('set-admin'); if (sa) sa.onclick = () => location.hash = '#/admin';
  const so = document.getElementById('set-out'); if (so) so.onclick = async () => {
    await api('/api/logout', { method: 'POST' }); S = null; location.hash = ''; render();
  };
}

// админ: расстановка меток на карте
function mapSetupSheet() {
  const w = world();
  if (!w.map) return toast('Сначала загрузи карту мира (Админка → ✏️ мира)', true);
  const rooms = S.rooms.filter(r => r.world_id === w.id);
  sheet(`
    <h2>📍 Метки на карте</h2>
    <div class="hint">Выбери локацию — потом тапни точку на карте.</div>
    ${rooms.map(r => `
      <button class="list-item" data-place="${r.id}">
        <div>${r.map_x != null ? '📍' : '◻️'}</div>
        <div class="grow"><div class="t">${esc(r.title)}</div></div>
        ${r.map_x != null ? `<button class="iconbtn" data-unpin="${r.id}">✖</button>` : ''}
      </button>`).join('')}
  `, s => {
    s.querySelectorAll('[data-unpin]').forEach(b => b.onclick = async (e) => {
      e.stopPropagation();
      await api(`/api/rooms/${b.dataset.unpin}`, { method: 'PATCH', body: { map_x: null, map_y: null } });
      await refreshState(); closeSheet(); renderTabs(); toast('Метка убрана');
    });
    s.querySelectorAll('[data-place]').forEach(b => b.onclick = () => {
      const roomId = +b.dataset.place;
      closeSheet();
      toast('Тапни точку на карте');
      const wrap = document.getElementById('mapwrap');
      if (!wrap) return;
      const handler = async (e) => {
        const rect = wrap.getBoundingClientRect();
        const x = ((e.clientX - rect.left) / rect.width * 100).toFixed(1);
        const y = ((e.clientY - rect.top) / rect.height * 100).toFixed(1);
        wrap.removeEventListener('click', handler, true);
        await api(`/api/rooms/${roomId}`, { method: 'PATCH', body: { map_x: +x, map_y: +y } });
        await refreshState(); renderTabs(); toast('Метка поставлена');
      };
      wrap.addEventListener('click', handler, true);
    });
  });
}

// ----- таб: настройки -----
function settingsTabHtml() {
  return `<div class="pad">
    <div class="h-sect"><h2>Настройки</h2></div>
    <button class="list-item" id="set-personas" style="width:100%;text-align:left"><div>🎭</div><div class="grow"><div class="t">Мои персонажи</div></div>›</button>
    <button class="list-item" id="set-theme" style="width:100%;text-align:left"><div>🎨</div><div class="grow"><div class="t">Тема оформления</div></div>›</button>
    <button class="list-item" id="set-usage" style="width:100%;text-align:left"><div>💰</div><div class="grow"><div class="t">Траты за месяц</div></div>›</button>
    ${S.me.is_admin ? `<button class="list-item" id="set-admin" style="width:100%;text-align:left"><div>👑</div><div class="grow"><div class="t">Админка</div></div>›</button>` : ''}
    <button class="list-item" id="set-out" style="width:100%;text-align:left"><div>🚪</div><div class="grow"><div class="t">Выйти (${esc(S.me.username)})</div></div></button>
    <div class="hint" style="margin-top:10px">Сегодня потрачено: ${money(S.spent_today)}${S.daily_limit != null ? ` из ${money(S.daily_limit)}` : ''}</div>
  </div>`;
}

// ----- профиль персонажа: инвентарь, потребности, память -----
async function personaProfile(pid, kindTab = 'одежда') {
  let st;
  try { st = await api(`/api/personas/${pid}/state`); } catch (e) { return toast(e.message, true); }
  const p = st.persona;
  const kinds = ['одежда', 'транспорт', 'вещь'];
  const kindLabel = { 'одежда': '👗 Шмот', 'транспорт': '🚗 Транспорт', 'вещь': '🎒 Вещи' };
  const items = st.items.filter(i => i.kind === kindTab);
  sheet(`
    <div style="display:flex;gap:12px;align-items:center">
      ${avaHtml(p)}
      <div><h2 style="margin:0">${esc(p.name)}</h2><div class="hint">${esc(p.bio || '')}</div></div>
    </div>

    <div class="sect" style="margin-top:8px"><h3>Состояние</h3>
      ${st.need_labels.map(([k, label]) => `
        <div class="need-row" style="margin-bottom:7px">
          <div class="nr-label">${label}</div>
          <div class="need-bar ${st.needs[k] < 30 ? 'low' : ''}"><div style="width:${st.needs[k]}%"></div></div>
          <div class="nr-val">${st.needs[k]}</div>
        </div>`).join('')}
      ${st.mine ? `
        <div class="checkline" style="margin-top:6px"><input type="checkbox" id="pp-realism" ${p.realism ? 'checked' : ''}>
          <span>Реализм: потребности проседают со временем</span></div>
        <button class="btn ghost small" id="pp-needs" style="margin-top:8px">⚙️ Подправить состояние</button>` : ''}
    </div>

    <div class="sect"><h3>Инвентарь ${st.mine ? '' : '(что надето/при себе)'}</h3>
      <div class="seg">
        ${kinds.map(k => `<button data-ktab="${k}" class="${k === kindTab ? 'on' : ''}">${kindLabel[k]}</button>`).join('')}
      </div>
      <div style="margin-top:9px">
      ${items.map(i => `
        <div class="inv-item ${i.equipped ? 'on' : ''}">
          <div class="ii-img" ${i.image ? `style="background-image:url('${esc(i.image)}')"` : ''}>${i.image ? '' : (i.kind === 'одежда' ? '👕' : i.kind === 'транспорт' ? '🚗' : '📦')}</div>
          <div class="grow"><div class="t">${esc(i.name)}</div><div class="s">${i.equipped ? (i.kind === 'одежда' ? 'надето' : i.kind === 'транспорт' ? 'в разъездах' : 'при себе') : 'в шкафу'}${i.descr ? ' · ' + esc(i.descr) : ''}</div></div>
          ${st.mine ? `
            <button class="chip ${i.equipped ? 'on' : ''}" data-eq="${i.id}" data-eqv="${i.equipped}">${i.equipped ? 'снять' : 'надеть'}</button>
            <button class="iconbtn" data-iedit="${i.id}">✏️</button>` : ''}
        </div>`).join('') || `<div class="hint">Пусто.</div>`}
      </div>
      ${st.mine ? `<button class="btn ghost small" id="pp-additem">＋ Добавить</button>` : ''}
    </div>

    <div class="sect"><h3>Память персонажа</h3>
      ${st.memory.map((m, i) => `
        <div class="list-item" style="padding:8px 12px"><div class="grow"><div class="s" style="color:var(--ink)">${esc(m)}</div></div>
        ${st.mine ? `<button class="iconbtn" data-mdel="${i}">✖</button>` : ''}</div>`).join('') || '<div class="hint">Пока ничего не записано. Это факты, которые персонаж «помнит» — их видит ИИ.</div>'}
      ${st.mine ? `<div class="row2"><input id="pp-mem" placeholder="напр.: должна Тони услугу"><button class="btn small" id="pp-memadd" style="flex:0 0 auto">＋</button></div>` : ''}
    </div>
  `, s => {
    s.querySelectorAll('[data-ktab]').forEach(b => b.onclick = () => personaProfile(pid, b.dataset.ktab));
    if (!st.mine) return;
    s.querySelector('#pp-realism').onchange = async (e) => {
      await api(`/api/personas/${pid}/needs`, { method: 'PATCH', body: { realism: e.target.checked } });
      toast(e.target.checked ? 'Реализм включён' : 'Реализм выключен');
    };
    s.querySelector('#pp-needs').onclick = () => needsForm(pid, st);
    s.querySelector('#pp-additem').onclick = () => itemForm(pid, kindTab);
    s.querySelectorAll('[data-eq]').forEach(b => b.onclick = async () => {
      await api(`/api/items/${b.dataset.eq}`, { method: 'PATCH', body: { equipped: b.dataset.eqv !== '1' } });
      personaProfile(pid, kindTab);
    });
    s.querySelectorAll('[data-iedit]').forEach(b => b.onclick = () => {
      itemForm(pid, kindTab, st.items.find(i => i.id === +b.dataset.iedit));
    });
    s.querySelectorAll('[data-mdel]').forEach(b => b.onclick = async () => {
      const mem = st.memory.slice(); mem.splice(+b.dataset.mdel, 1);
      await api(`/api/personas/${pid}/memory`, { method: 'PATCH', body: { memory: mem } });
      personaProfile(pid, kindTab);
    });
    s.querySelector('#pp-memadd').onclick = async () => {
      const v = s.querySelector('#pp-mem').value.trim(); if (!v) return;
      await api(`/api/personas/${pid}/memory`, { method: 'PATCH', body: { memory: [...st.memory, v] } });
      personaProfile(pid, kindTab);
    };
  });
}

function needsForm(pid, st) {
  sheet(`
    <h2>⚙️ Состояние</h2>
    ${st.need_labels.map(([k, label]) => `
      <label>${label}: <span id="nv-${k}">${st.needs[k]}</span></label>
      <input type="range" min="5" max="100" value="${st.needs[k]}" data-need="${k}">`).join('')}
    <button class="btn" id="nf-save">Сохранить</button>
  `, s => {
    s.querySelectorAll('[data-need]').forEach(r => r.oninput = () => {
      s.querySelector(`#nv-${r.dataset.need}`).textContent = r.value;
    });
    s.querySelector('#nf-save').onclick = async () => {
      const needs = {};
      s.querySelectorAll('[data-need]').forEach(r => needs[r.dataset.need] = +r.value);
      await api(`/api/personas/${pid}/needs`, { method: 'PATCH', body: { needs } });
      personaProfile(pid);
    };
  });
}

function itemForm(pid, kindTab, it) {
  sheet(`
    <h2>${it ? 'Предмет' : 'Новый предмет'}</h2>
    <label>Что это</label>
    <div class="seg">
      ${['одежда', 'транспорт', 'вещь'].map(k => `<button data-ik="${k}" class="${(it?.kind || kindTab) === k ? 'on' : ''}">${k}</button>`).join('')}
    </div>
    <label>Название</label><input id="if-name" value="${esc(it?.name || '')}" placeholder="чёрное пальто / мотоцикл / фляга">
    <label>Описание (видит ИИ)</label><input id="if-descr" value="${esc(it?.descr || '')}">
    <label>Фото</label>
    ${coverField('if-img', it?.image)}
    <div class="checkline"><input type="checkbox" id="if-eq" ${it?.equipped ? 'checked' : ''}> <span>Сразу надеть / взять с собой</span></div>
    <button class="btn" id="if-save">Сохранить</button>
    ${it ? `<button class="btn danger" id="if-del">🗑 Удалить</button>` : ''}
  `, s => {
    bindCoverField(s, 'if-img');
    let kind = it?.kind || kindTab;
    s.querySelectorAll('[data-ik]').forEach(b => b.onclick = () => {
      kind = b.dataset.ik;
      s.querySelectorAll('[data-ik]').forEach(x => x.classList.toggle('on', x === b));
    });
    s.querySelector('#if-save').onclick = async () => {
      const body = {
        kind,
        name: s.querySelector('#if-name').value,
        descr: s.querySelector('#if-descr').value,
        image: s.querySelector('#if-img').value,
        equipped: s.querySelector('#if-eq').checked,
      };
      try {
        if (it) await api(`/api/items/${it.id}`, { method: 'PATCH', body });
        else await api(`/api/personas/${pid}/items`, { method: 'POST', body });
        personaProfile(pid, kind);
      } catch (e) { toast(e.message, true); }
    };
    const d = s.querySelector('#if-del');
    if (d) d.onclick = async () => {
      if (!confirm('Удалить предмет?')) return;
      await api(`/api/items/${it.id}`, { method: 'DELETE' });
      personaProfile(pid, kind);
    };
  });
}

// ----- комната -----
function renderRoom() {
  const r = curRoom;
  const myP = S.my_personas.find(p => p.id === composer.persona_id);
  $app.innerHTML = `
  <div class="topbar">
    <button class="back" onclick="location.hash='#/'">←</button>
    <h1>${esc(r.title)}</h1>
    <button class="iconbtn" id="b-chron" title="Хроника">📖</button>
  </div>
  <div class="screen ${r.kind === 'chat' ? 'chatmode' : ''}" id="scr">
    ${r.cover ? `<div class="room-cover" style="background-image:url('${esc(r.cover)}')">
      <div class="rc-shade"><h2>${esc(r.title)}</h2></div></div>` : ''}
    ${r.description ? `<div class="chronicle-box" style="margin-bottom:0"><div class="ch-title">Локация</div>${esc(r.description)}</div>` : ''}
    <div class="feed" id="feed">
      ${posts.length >= 50 ? `<button class="loadmore" id="b-more">↑ показать раньше</button>` : ''}
      ${posts.map(postHtml).join('')}
    </div>
    <div class="typing" id="typing"></div>
  </div>
  <div class="composer">
    <div class="composer-tools" id="ctools">
      <button class="chip ${myP ? 'on' : ''}" id="c-persona">${myP ? `${myP.emoji} ${esc(myP.name)}` : '💬 вне игры'}</button>
      <button class="chip ${composer.ooc ? 'on' : ''}" id="c-ooc">вне игры</button>
      <button class="chip ai-chip" id="c-ai">✨ позвать ИИ</button>
      <button class="chip" id="c-img">📎</button>
    </div>
    ${composer.image ? `<div class="img-preview"><img src="${esc(composer.image)}"><button id="c-img-del">✕</button></div>` : ''}
    <div class="composer-row">
      <textarea id="c-text" rows="1" placeholder="${r.kind === 'chat' ? 'Сообщение…' : 'Продолжить историю…'}"></textarea>
      <button class="send" id="c-send">➤</button>
    </div>
  </div>`;

  const ta = document.getElementById('c-text');
  ta.addEventListener('input', () => { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, innerHeight * .38) + 'px'; });

  document.getElementById('c-send').onclick = sendPost;
  document.getElementById('c-ooc').onclick = () => { composer.ooc = !composer.ooc; renderRoom(); };
  document.getElementById('c-persona').onclick = pickPersonaSheet;
  document.getElementById('c-ai').onclick = aiSheet;
  document.getElementById('c-img').onclick = () => pickImage(url => { composer.image = url; renderRoom(); });
  const del = document.getElementById('c-img-del');
  if (del) del.onclick = () => { composer.image = ''; renderRoom(); };
  document.getElementById('b-chron').onclick = chronicleSheet;
  const more = document.getElementById('b-more');
  if (more) more.onclick = loadMore;

  document.getElementById('feed').addEventListener('click', e => {
    const menuBtn = e.target.closest('.menu');
    if (menuBtn) return postMenu(+menuBtn.dataset.id);
    const avaBtn = e.target.closest('[data-prof]');
    if (avaBtn) return personaProfile(+avaBtn.dataset.prof);
  });
  scrollFeedDown();
}

function postHtml(p) {
  const a = author(p);
  const mine = p.user_id === S.me.id;
  return `
  <div class="post ${a.ai ? 'ai' : ''} ${p.is_ooc ? 'ooc' : ''}" id="post-${p.id}">
    <div class="post-head">
      ${a.pid ? `<button data-prof="${a.pid}" style="display:flex">${avaHtml(a)}</button>` : avaHtml(a)}
      <div>
        <div class="who" style="color:${a.color}">${esc(a.name)}</div>
        <div class="sub">${esc(a.sub)} · ${fmtTime(p.created_at)}${p.edited_at ? ' · ред.' : ''}</div>
      </div>
      ${(mine || S.me.is_admin) ? `<button class="menu" data-id="${p.id}">⋯</button>` : ''}
    </div>
    ${p.body ? `<div class="post-body">${fmtBody(p.body)}</div>` : ''}
    ${p.image ? `<img class="post-img" src="${esc(p.image)}" loading="lazy">` : ''}
  </div>`;
}

function renderFeedAppend(p) {
  const feed = document.getElementById('feed');
  if (!feed) return;
  feed.insertAdjacentHTML('beforeend', postHtml(p));
  scrollFeedDown();
}

async function loadMore() {
  const first = posts[0];
  if (!first) return;
  const older = (await api(`/api/rooms/${curRoom.id}/posts?before=${first.id}&limit=50`)).posts;
  posts = older.concat(posts);
  renderRoom();
}

async function sendPost() {
  const ta = document.getElementById('c-text');
  const body = ta.value.trim();
  if (!body && !composer.image) return;
  const btn = document.getElementById('c-send'); btn.disabled = true;
  try {
    await api(`/api/rooms/${curRoom.id}/posts`, { method: 'POST', body: {
      body, image: composer.image || '',
      persona_id: composer.ooc ? null : composer.persona_id, is_ooc: composer.ooc,
    }});
    ta.value = ''; ta.style.height = 'auto';
    if (composer.image) { composer.image = ''; renderRoom(); }
  } catch (e) { toast(e.message, true); }
  btn.disabled = false;
}

function postMenu(id) {
  const p = posts.find(x => x.id === id); if (!p) return;
  sheet(`
    <h2>Пост</h2>
    ${p.body ? `<button class="btn ghost" id="pm-edit">✏️ Редактировать</button>` : ''}
    <button class="btn danger" id="pm-del">🗑 Удалить</button>
  `, s => {
    const e = s.querySelector('#pm-edit');
    if (e) e.onclick = () => {
      closeSheet();
      sheet(`
        <h2>Редактирование</h2>
        <textarea id="pm-text" rows="8">${esc(p.body)}</textarea>
        <button class="btn" id="pm-save">Сохранить</button>
      `, s2 => {
        s2.querySelector('#pm-save').onclick = async () => {
          try { await api(`/api/posts/${id}`, { method: 'PATCH', body: { body: s2.querySelector('#pm-text').value } }); closeSheet(); }
          catch (e) { toast(e.message, true); }
        };
      });
    };
    s.querySelector('#pm-del').onclick = async () => {
      if (!confirm('Удалить пост?')) return;
      try { await api(`/api/posts/${id}`, { method: 'DELETE' }); closeSheet(); }
      catch (e) { toast(e.message, true); }
    };
  });
}

// ----- шторки -----
function sheet(html, setup) {
  closeSheet();
  const ov = document.createElement('div');
  ov.className = 'overlay';
  ov.innerHTML = `<div class="sheet"><button class="sheet-x" aria-label="Закрыть">✕</button>${html}</div>`;
  ov.onclick = e => { if (e.target === ov) closeSheet(); };
  ov.querySelector('.sheet-x').onclick = closeSheet;
  document.body.appendChild(ov);
  if (setup) setup(ov.querySelector('.sheet'));
}
function closeSheet() { document.querySelector('.overlay')?.remove(); }

function themeSheet() {
  const cur = localStorage.getItem('tavern_theme') || 'wine';
  sheet(`
    <h2>🎨 Тема</h2>
    ${THEMES.map(([id, name]) => `
      <button class="list-item" data-th="${id}" style="${cur === id ? 'border-color:var(--amber-soft)' : ''}">
        <div class="grow"><div class="t">${name}</div></div>${cur === id ? '✓' : ''}
      </button>`).join('')}
    <div class="hint">Тема запоминается на этом устройстве.</div>
  `, s => {
    s.querySelectorAll('[data-th]').forEach(b => b.onclick = () => { applyTheme(b.dataset.th); closeSheet(); render(); });
  });
}

function pickPersonaSheet() {
  sheet(`
    <h2>От чьего лица пишем?</h2>
    <button class="list-item" data-pid="">
      <div class="ava">💬</div><div class="grow"><div class="t">Вне игры (от себя)</div></div>
    </button>
    ${S.my_personas.map(p => `
      <button class="list-item" data-pid="${p.id}">
        ${avaHtml(p)}
        <div class="grow"><div class="t">${esc(p.name)}</div><div class="s">${esc(p.bio)}</div></div>
      </button>`).join('')}
    <button class="btn ghost" id="pp-manage">🎭 Мои персонажи…</button>
  `, s => {
    s.querySelectorAll('[data-pid]').forEach(b => b.onclick = () => {
      composer.persona_id = b.dataset.pid ? +b.dataset.pid : null;
      composer.ooc = !b.dataset.pid;
      closeSheet(); renderRoom();
    });
    s.querySelector('#pp-manage').onclick = () => { closeSheet(); personasSheet(); };
  });
}

function personasSheet() {
  sheet(`
    <h2>Мои персонажи</h2>
    ${S.my_personas.map(p => `
      <div class="list-item">
        ${avaHtml(p)}
        <div class="grow"><div class="t">${esc(p.name)}</div><div class="s">${esc(p.bio)}</div></div>
        <button class="iconbtn" data-prof2="${p.id}" title="Инвентарь">🎒</button>
        <button class="iconbtn" data-edit="${p.id}">✏️</button>
        <button class="iconbtn" data-del="${p.id}">🗑</button>
      </div>`).join('') || '<div class="hint">Пока нет ни одного. Создай маску, за которую будешь играть.</div>'}
    <button class="btn" id="pe-new">＋ Новый персонаж</button>
  `, s => {
    s.querySelector('#pe-new').onclick = () => personaForm();
    s.querySelectorAll('[data-prof2]').forEach(b => b.onclick = () => personaProfile(+b.dataset.prof2));
    s.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => personaForm(S.my_personas.find(p => p.id === +b.dataset.edit)));
    s.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
      if (!confirm('Удалить персонажа?')) return;
      await api(`/api/personas/${b.dataset.del}`, { method: 'DELETE' });
      await refreshState(); personasSheet();
    });
  });
}

function personaForm(p) {
  sheet(`
    <h2>${p ? 'Персонаж' : 'Новый персонаж'}</h2>
    <label>Имя</label><input id="pf-name" value="${esc(p?.name || '')}">
    <div class="row2">
      <div><label>Эмодзи</label><input id="pf-emoji" value="${esc(p?.emoji || '🎭')}"></div>
      <div><label>Цвет</label><input id="pf-color" type="color" value="${p?.color || '#9e4a58'}" style="height:44px;padding:4px"></div>
    </div>
    <label>Аватарка</label>
    ${coverField('pf-avatar', p?.avatar)}
    <label>Кто это (видно всем и ИИ)</label><textarea id="pf-bio" rows="3">${esc(p?.bio || '')}</textarea>
    <button class="btn" id="pf-save">Сохранить</button>
  `, s => {
    bindCoverField(s, 'pf-avatar');
    s.querySelector('#pf-save').onclick = async () => {
      const body = {
        name: s.querySelector('#pf-name').value,
        emoji: s.querySelector('#pf-emoji').value || '🎭',
        color: s.querySelector('#pf-color').value,
        avatar: s.querySelector('#pf-avatar').value,
        bio: s.querySelector('#pf-bio').value,
      };
      try {
        if (p) await api(`/api/personas/${p.id}`, { method: 'PATCH', body });
        else await api('/api/personas', { method: 'POST', body });
        await refreshState(); personasSheet();
      } catch (e) { toast(e.message, true); }
    };
  });
}

// ----- вызов ИИ -----
function roomAiChars() {
  const attached = (curRoom.ai_ids || []).map(id => S.ai_chars.find(c => c.id === id)).filter(Boolean);
  const rest = S.ai_chars.filter(c => (!c.world_id || c.world_id === curRoom.world_id) && !attached.find(a => a.id === c.id));
  return { attached, rest };
}
function aiSheet() {
  const { attached, rest } = roomAiChars();
  if (!attached.length && !rest.length) return toast(S.me.is_admin ? 'Сначала создай ИИ-персонажей в админке' : 'Админ ещё не завёл ИИ-персонажей', true);
  const item = c => `
    <button class="list-item" data-ai="${c.id}">
      ${avaHtml(c)}
      <div class="grow"><div class="t">${esc(c.name)}</div><div class="s">${esc(c.model)}</div></div>
    </button>`;
  sheet(`
    <h2>✨ Позвать ИИ</h2>
    ${attached.length ? `<div class="hint">В этой комнате:</div>${attached.map(item).join('')}` : ''}
    ${rest.length ? `${attached.length ? '<div class="hint">Остальные:</div>' : ''}${rest.map(item).join('')}` : ''}
    <label>Указание (необязательно — «вне игры» просьба к ИИ)</label>
    <textarea id="ai-instr" rows="2" placeholder="напр.: пусть в таверну вбежит гонец с плохими вестями"></textarea>
    <div class="hint">Потрачено сегодня: ${money(S.spent_today)}${S.daily_limit != null ? ` из ${money(S.daily_limit)}` : ''}</div>
  `, s => {
    s.querySelectorAll('[data-ai]').forEach(b => b.onclick = async () => {
      const instruction = s.querySelector('#ai-instr').value;
      closeSheet();
      try {
        const r = await api(`/api/rooms/${curRoom.id}/ai`, { method: 'POST', body: { ai_char_id: +b.dataset.ai, instruction } });
        S.spent_today = r.spent_today;
      } catch (e) { toast(e.message, true); }
    });
  });
}

// ----- хроника -----
function chronicleSheet() {
  const r = curRoom;
  sheet(`
    <h2>📖 Хроника: ${esc(r.title)}</h2>
    <div class="chronicle-box" style="margin:0">${r.chronicle ? esc(r.chronicle) : 'Летописец ещё ничего не записал.'}</div>
    ${r.chronicle_at ? `<div class="hint">Обновлена: ${fmtTime(r.chronicle_at)}</div>` : ''}
    <button class="btn" id="ch-upd">🪶 Обновить хронику (ИИ)</button>
  `, s => {
    s.querySelector('#ch-upd').onclick = async () => {
      s.querySelector('#ch-upd').disabled = true;
      s.querySelector('#ch-upd').textContent = '🪶 Летописец пишет…';
      try {
        const res = await api(`/api/rooms/${r.id}/chronicle`, { method: 'POST' });
        r.chronicle = res.chronicle; r.chronicle_at = Date.now();
        chronicleSheet();
      } catch (e) { toast(e.message, true); closeSheet(); }
    };
  });
}

// ----- траты -----
async function renderUsage() {
  const u = await api('/api/usage');
  const max = Math.max(...u.users.map(x => x.cost), 0.0001);
  $app.innerHTML = `
  <div class="topbar">
    <button class="back" onclick="location.hash='#/'">←</button>
    <h1>💰 Траты за месяц</h1>
  </div>
  <div class="screen pad">
    <div class="list-item" style="flex-direction:column;align-items:flex-start">
      <div class="s">Всего с ${new Date(u.since).toLocaleDateString('ru')}</div>
      <div class="big-num">${money(u.total)}</div>
      ${u.users.length > 1 ? `<div class="s">поровну: ${money(u.total / u.users.length)} с носа · по-честному — см. список ниже</div>` : ''}
    </div>
    ${u.users.map(x => `
      <div class="list-item" style="flex-direction:column;align-items:stretch">
        <div style="display:flex;justify-content:space-between">
          <div class="t">${esc(x.username)}</div><div class="t" style="color:var(--amber)">${money(x.cost)}</div>
        </div>
        <div class="s">${x.calls} вызовов · ${x.pt + x.ct} токенов</div>
        <div class="usage-bar"><div style="width:${(x.cost / max * 100).toFixed(1)}%"></div></div>
      </div>`).join('')}
    <div class="hint" style="margin-top:14px">Сегодня ты: ${money(u.my_spent_today)}${u.my_daily_limit != null ? ` из дневного лимита ${money(u.my_daily_limit)}` : ' (без лимита)'}.</div>
  </div>`;
}

// ----- лорбуки -----
async function renderLore(worldId) {
  const w = S.worlds.find(x => x.id === worldId);
  const { lorebooks } = await api(`/api/worlds/${worldId}/lorebooks`);
  $app.innerHTML = `
  <div class="topbar">
    <button class="back" onclick="location.hash='#/admin'">←</button>
    <h1>📚 Лорбуки: ${esc(w?.title || '')}</h1>
  </div>
  <div class="screen pad">
    ${lorebooks.map(b => `
      <div class="sect">
        <div class="list-item">
          <div class="grow"><div class="t">${esc(b.name)}</div><div class="s">${b.entries.length} записей</div></div>
          <button class="chip ${b.enabled ? 'on' : ''}" data-btoggle="${b.id}">${b.enabled ? 'вкл' : 'выкл'}</button>
          <button class="iconbtn" data-bimport="${b.id}" title="Импорт ST JSON">📥</button>
          <button class="iconbtn" data-bdel="${b.id}">🗑</button>
        </div>
        ${b.entries.map(e => `
          <div class="list-item" style="margin-left:12px">
            <div class="grow">
              <div class="t" style="font-size:14px">${esc(e.title || e.keys || '(без названия)')} ${e.always_on ? '📌' : ''}</div>
              <div class="s">${esc(e.keys)}</div>
            </div>
            <button class="chip ${e.enabled ? 'on' : ''}" data-etoggle="${e.id}" data-eval="${e.enabled}">${e.enabled ? 'вкл' : 'выкл'}</button>
            <button class="iconbtn" data-eedit="${e.id}" data-ebook="${b.id}">✏️</button>
          </div>`).join('')}
        <button class="btn ghost small" data-eadd="${b.id}">＋ Запись</button>
      </div>`).join('') || '<div class="hint" style="margin-top:20px">Лорбуков нет. Создай и импортни свои из SillyTavern (World Info JSON).</div>'}
    <div class="sect">
      <button class="btn" id="lb-new">＋ Новый лорбук</button>
      <div class="hint" style="margin-top:8px">📥 — импорт файла World Info из ST (тот же JSON, что экспортируешь из таверны). 📌 — запись подаётся всегда, остальные — когда ключи мелькают в последних постах.</div>
    </div>
  </div>`;

  document.getElementById('lb-new').onclick = async () => {
    const name = prompt('Название лорбука:'); if (!name) return;
    await api(`/api/worlds/${worldId}/lorebooks`, { method: 'POST', body: { name } });
    renderLore(worldId);
  };
  document.querySelectorAll('[data-btoggle]').forEach(b => b.onclick = async () => {
    const book = lorebooks.find(x => x.id === +b.dataset.btoggle);
    await api(`/api/lorebooks/${book.id}`, { method: 'PATCH', body: { enabled: !book.enabled } });
    renderLore(worldId);
  });
  document.querySelectorAll('[data-bdel]').forEach(b => b.onclick = async () => {
    if (!confirm('Удалить лорбук со всеми записями?')) return;
    await api(`/api/lorebooks/${b.dataset.bdel}`, { method: 'DELETE' });
    renderLore(worldId);
  });
  document.querySelectorAll('[data-bimport]').forEach(b => b.onclick = () => {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = '.json,application/json';
    inp.onchange = () => {
      const f = inp.files[0]; if (!f) return;
      const reader = new FileReader();
      reader.onload = async () => {
        try {
          const r = await api(`/api/lorebooks/${b.dataset.bimport}/import`, { method: 'POST', body: { json: reader.result, replace: confirm('Заменить существующие записи? (Отмена = добавить к ним)') } });
          toast(`Импортировано записей: ${r.imported}`);
          renderLore(worldId);
        } catch (e) { toast(e.message, true); }
      };
      reader.readAsText(f);
    };
    inp.click();
  });
  document.querySelectorAll('[data-etoggle]').forEach(b => b.onclick = async () => {
    await api(`/api/lore-entries/${b.dataset.etoggle}`, { method: 'PATCH', body: { enabled: b.dataset.eval !== '1' } });
    renderLore(worldId);
  });
  document.querySelectorAll('[data-eadd]').forEach(b => b.onclick = () => loreEntryForm(worldId, +b.dataset.eadd));
  document.querySelectorAll('[data-eedit]').forEach(b => {
    b.onclick = () => {
      const book = lorebooks.find(x => x.id === +b.dataset.ebook);
      loreEntryForm(worldId, book.id, book.entries.find(e => e.id === +b.dataset.eedit));
    };
  });
}

function loreEntryForm(worldId, bookId, e) {
  sheet(`
    <h2>${e ? 'Запись' : 'Новая запись'}</h2>
    <label>Название (для себя)</label><input id="le-title" value="${esc(e?.title || '')}">
    <label>Ключи через запятую (при каких словах подавать)</label><input id="le-keys" value="${esc(e?.keys || '')}" placeholder="Хеди, Барлоу, лаборатория">
    <label>Текст (попадает в контекст ИИ)</label><textarea id="le-content" rows="7">${esc(e?.content || '')}</textarea>
    <div class="checkline"><input type="checkbox" id="le-always" ${e?.always_on ? 'checked' : ''}> <span>📌 Подавать всегда (constant)</span></div>
    <button class="btn" id="le-save">Сохранить</button>
    ${e ? `<button class="btn danger" id="le-del">🗑 Удалить</button>` : ''}
  `, s => {
    s.querySelector('#le-save').onclick = async () => {
      const body = {
        title: s.querySelector('#le-title').value,
        keys: s.querySelector('#le-keys').value,
        content: s.querySelector('#le-content').value,
        always_on: s.querySelector('#le-always').checked,
      };
      try {
        if (e) await api(`/api/lore-entries/${e.id}`, { method: 'PATCH', body });
        else await api(`/api/lorebooks/${bookId}/entries`, { method: 'POST', body });
        closeSheet(); renderLore(worldId);
      } catch (er) { toast(er.message, true); }
    };
    const d = s.querySelector('#le-del');
    if (d) d.onclick = async () => {
      if (!confirm('Удалить запись?')) return;
      await api(`/api/lore-entries/${e.id}`, { method: 'DELETE' });
      closeSheet(); renderLore(worldId);
    };
  });
}

// ----- админка -----
async function renderAdmin() {
  const [settings, invites, extAll] = await Promise.all([
    api('/api/settings'), api('/api/invites'), api('/api/extensions'),
  ]);
  const aiFull = (await api('/api/ai-chars')).ai_chars;
  $app.innerHTML = `
  <div class="topbar">
    <button class="back" onclick="location.hash='#/'">←</button>
    <h1>👑 Админка</h1>
  </div>
  <div class="screen pad">

    <div class="sect"><h3>Миры</h3>
      ${S.worlds.map(w => `
        <div class="list-item">
          <div>${w.emoji}</div>
          <div class="grow"><div class="t">${esc(w.title)}</div><div class="s">${w.map ? '🗺 карта есть' : 'без карты'}</div></div>
          <button class="btn small ghost" onclick="location.hash='#/lore/${w.id}'">📚 лор</button>
          <button class="iconbtn" data-wedit="${w.id}">✏️</button>
        </div>`).join('')}
      <button class="btn small" id="a-newworld">＋ Мир</button>
    </div>

    <div class="sect"><h3>Комнаты</h3>
      ${S.worlds.map(w => `
        <div class="hint" style="margin:6px 0 4px">${w.emoji} ${esc(w.title)}</div>
        ${S.rooms.filter(r => r.world_id === w.id).map(r => `
          <div class="list-item">
            <div>${r.kind === 'chat' ? '💬' : '📜'}</div>
            <div class="grow"><div class="t">${esc(r.title)}</div><div class="s">${esc(r.category)}${r.auto_ai_char_id ? ' · 🤖 авто' : ''}${r.map_x != null ? ' · 📍' : ''}</div></div>
            <button class="iconbtn" data-redit="${r.id}">✏️</button>
          </div>`).join('')}
      `).join('')}
      <button class="btn small" id="a-newroom">＋ Комната</button>
    </div>

    <div class="sect"><h3>ИИ-персонажи</h3>
      ${aiFull.map(c => `
        <div class="list-item">
          ${avaHtml(c)}
          <div class="grow"><div class="t">${esc(c.name)}</div><div class="s">${esc(c.model)}${c.world_id ? ' · ' + esc(S.worlds.find(w => w.id === c.world_id)?.title || '') : ' · все миры'}</div></div>
          <button class="iconbtn" data-aiedit="${c.id}">✏️</button>
        </div>`).join('')}
      <button class="btn small" id="a-newai">＋ ИИ-персонаж</button>
    </div>

    <div class="sect"><h3>Расширения</h3>
      ${extAll.extensions.map(x => `
        <div class="list-item">
          <div class="grow"><div class="t">${esc(x.name)}</div></div>
          <button class="chip ${x.enabled ? 'on' : ''}" data-xtoggle="${x.id}" data-xval="${x.enabled}">${x.enabled ? 'вкл' : 'выкл'}</button>
          <button class="iconbtn" data-xedit="${x.id}">✏️</button>
          <button class="iconbtn" data-xdel="${x.id}">🗑</button>
        </div>`).join('') || '<div class="hint">Нет расширений. Это свои CSS/JS-допилы интерфейса — ставь только то, чему доверяешь.</div>'}
      <button class="btn small" id="a-newext">＋ Расширение</button>
    </div>

    <div class="sect"><h3>Инвайты</h3>
      ${invites.invites.map(i => `
        <div class="list-item"><div class="grow">
          <div class="t" style="font-family:monospace">${i.code}</div>
          <div class="s">${i.used_by_name ? '✅ ' + esc(i.used_by_name) : '🕐 не использован'}</div>
        </div></div>`).join('')}
      <button class="btn small" id="a-invite">＋ Инвайт</button>
    </div>

    <div class="sect"><h3>Игроки и лимиты</h3>
      ${S.users.map(u => `
        <div class="list-item">
          <div class="grow"><div class="t">${esc(u.username)} ${u.is_admin ? '👑' : ''}</div></div>
          ${u.is_admin ? '' : `<button class="btn small ghost" data-limit="${u.id}">лимит</button>`}
        </div>`).join('')}
    </div>

    <div class="sect"><h3>Настройки</h3>
      <label>Название таверны</label><input id="s-title" value="${esc(settings.app_title)}">
      <label>Дневной лимит по умолчанию, $ на игрока</label><input id="s-limit" value="${esc(settings.default_daily_limit_usd)}">
      <label>Модель летописца</label><input id="s-chmodel" value="${esc(settings.chronicle_model)}">
      <label>OpenRouter API-ключ ${settings.openrouter_key_set ? '(задан — впиши новый, чтобы сменить)' : '⚠️ не задан'}</label>
      <input id="s-key" type="password" placeholder="sk-or-...">
      <button class="btn" id="s-save" style="margin-top:8px">Сохранить настройки</button>
    </div>
  </div>`;

  document.getElementById('a-newworld').onclick = () => worldForm();
  document.querySelectorAll('[data-wedit]').forEach(b => b.onclick = async () => {
    const { world } = await api(`/api/worlds/${b.dataset.wedit}`);
    worldForm(world);
  });
  document.getElementById('a-newroom').onclick = () => roomForm(null, () => renderAdmin());
  document.querySelectorAll('[data-redit]').forEach(b => b.onclick = () => roomForm(S.rooms.find(r => r.id === +b.dataset.redit), () => renderAdmin()));
  document.getElementById('a-newai').onclick = () => aiForm();
  document.querySelectorAll('[data-aiedit]').forEach(b => b.onclick = () => aiForm(aiFull.find(c => c.id === +b.dataset.aiedit)));
  document.getElementById('a-newext').onclick = () => extForm();
  document.querySelectorAll('[data-xedit]').forEach(b => b.onclick = () => extForm(extAll.extensions.find(x => x.id === +b.dataset.xedit)));
  document.querySelectorAll('[data-xtoggle]').forEach(b => b.onclick = async () => {
    await api(`/api/extensions/${b.dataset.xtoggle}`, { method: 'PATCH', body: { enabled: b.dataset.xval !== '1' } });
    toast('Обновится после перезагрузки страницы'); renderAdmin();
  });
  document.querySelectorAll('[data-xdel]').forEach(b => b.onclick = async () => {
    if (!confirm('Удалить расширение?')) return;
    await api(`/api/extensions/${b.dataset.xdel}`, { method: 'DELETE' }); renderAdmin();
  });
  document.getElementById('a-invite').onclick = async () => {
    const r = await api('/api/invites', { method: 'POST' });
    try { await navigator.clipboard.writeText(r.code); } catch {}
    toast(`Инвайт: ${r.code} (скопирован)`);
    renderAdmin();
  };
  document.querySelectorAll('[data-limit]').forEach(b => b.onclick = async () => {
    const v = prompt('Дневной лимит $ (пусто = дефолт):');
    if (v === null) return;
    await api(`/api/users/${b.dataset.limit}/limit`, { method: 'PATCH', body: { daily_limit_usd: v === '' ? null : parseFloat(v) } });
    toast('Ок');
  });
  document.getElementById('s-save').onclick = async () => {
    const body = {
      app_title: document.getElementById('s-title').value,
      default_daily_limit_usd: document.getElementById('s-limit').value,
      chronicle_model: document.getElementById('s-chmodel').value,
    };
    const key = document.getElementById('s-key').value.trim();
    if (key) body.openrouter_key = key;
    await api('/api/settings', { method: 'PATCH', body });
    await refreshState(); toast('Сохранено');
  };
}

function worldForm(w) {
  sheet(`
    <h2>${w ? 'Мир' : 'Новый мир'}</h2>
    <label>Название</label><input id="wf-title" value="${esc(w?.title || '')}">
    <label>Эмодзи</label><input id="wf-emoji" value="${esc(w?.emoji || '🌍')}">
    <label>Обложка</label>
    ${coverField('wf-cover', w?.cover)}
    <label>Карта мира (по ней перемещаются между локациями)</label>
    ${coverField('wf-map', w?.map)}
    <label>Промпт мира (сеттинг, правила, тон — видят все ИИ этого мира)</label>
    <textarea id="wf-prompt" rows="6">${esc(w?.prompt || '')}</textarea>
    <button class="btn" id="wf-save">Сохранить</button>
    ${w ? `<button class="btn danger" id="wf-arch">📦 В архив</button>` : ''}
  `, s => {
    bindCoverField(s, 'wf-cover');
    bindCoverField(s, 'wf-map');
    s.querySelector('#wf-save').onclick = async () => {
      const body = {
        title: s.querySelector('#wf-title').value,
        emoji: s.querySelector('#wf-emoji').value || '🌍',
        cover: s.querySelector('#wf-cover').value,
        map: s.querySelector('#wf-map').value,
        prompt: s.querySelector('#wf-prompt').value,
      };
      try {
        if (w) await api(`/api/worlds/${w.id}`, { method: 'PATCH', body });
        else await api('/api/worlds', { method: 'POST', body });
        await refreshState(); closeSheet(); renderAdmin();
      } catch (e) { toast(e.message, true); }
    };
    const a = s.querySelector('#wf-arch');
    if (a) a.onclick = async () => {
      if (!confirm('Убрать мир в архив? Комнаты и посты не удалятся.')) return;
      await api(`/api/worlds/${w.id}`, { method: 'PATCH', body: { archived: true } });
      await refreshState(); closeSheet(); renderAdmin();
    };
  });
}

function roomForm(r, after) {
  const bots = S.ai_chars;
  const attached = r?.ai_ids || [];
  sheet(`
    <h2>${r ? 'Комната' : 'Новая комната'}</h2>
    <label>Название</label><input id="rf-title" value="${esc(r?.title || '')}">
    <div class="row2">
      <div><label>Мир</label>
        <select id="rf-world">${S.worlds.map(w => `<option value="${w.id}" ${(r?.world_id ?? curWorldId) === w.id ? 'selected' : ''}>${w.emoji} ${esc(w.title)}</option>`).join('')}</select></div>
      <div><label>Тип</label>
        <select id="rf-kind">
          <option value="forum" ${r?.kind !== 'chat' ? 'selected' : ''}>📜 Форум (посты)</option>
          <option value="chat" ${r?.kind === 'chat' ? 'selected' : ''}>💬 Чат</option>
        </select></div>
    </div>
    <label>Раздел</label><input id="rf-cat" value="${esc(r?.category || 'Локации')}" placeholder="Локации / Флуд / Служебное">
    <label>Обложка локации</label>
    ${coverField('rf-cover', r?.cover)}
    <label>Описание локации (видят игроки и ИИ)</label>
    <textarea id="rf-desc" rows="4">${esc(r?.description || '')}</textarea>
    <label>Боты этой комнаты</label>
    ${bots.map(c => `<div class="checkline"><input type="checkbox" data-bot="${c.id}" ${attached.includes(c.id) ? 'checked' : ''}> <span>${c.emoji} ${esc(c.name)}</span></div>`).join('') || '<div class="hint">ИИ-персонажей пока нет</div>'}
    <label>Авто-ответ (бот сам отвечает на каждый пост в роли — для сцен 1-на-1)</label>
    <select id="rf-auto">
      <option value="">— выключен —</option>
      ${bots.map(c => `<option value="${c.id}" ${r?.auto_ai_char_id === c.id ? 'selected' : ''}>${c.emoji} ${esc(c.name)}</option>`).join('')}
    </select>
    <button class="btn" id="rf-save">Сохранить</button>
    ${r ? `<button class="btn danger" id="rf-arch">📦 В архив</button>` : ''}
  `, s => {
    bindCoverField(s, 'rf-cover');
    s.querySelector('#rf-save').onclick = async () => {
      const body = {
        title: s.querySelector('#rf-title').value,
        world_id: +s.querySelector('#rf-world').value,
        kind: s.querySelector('#rf-kind').value,
        category: s.querySelector('#rf-cat').value,
        cover: s.querySelector('#rf-cover').value,
        description: s.querySelector('#rf-desc').value,
        ai_ids: [...s.querySelectorAll('[data-bot]:checked')].map(x => +x.dataset.bot),
        auto_ai_char_id: +s.querySelector('#rf-auto').value || null,
      };
      try {
        if (r) await api(`/api/rooms/${r.id}`, { method: 'PATCH', body });
        else await api('/api/rooms', { method: 'POST', body });
        await refreshState(); closeSheet();
        after ? after() : renderTabs();
      } catch (e) { toast(e.message, true); }
    };
    const a = s.querySelector('#rf-arch');
    if (a) a.onclick = async () => {
      if (!confirm('Убрать комнату в архив? Посты не удалятся.')) return;
      await api(`/api/rooms/${r.id}`, { method: 'PATCH', body: { archived: true } });
      await refreshState(); closeSheet(); after ? after() : renderTabs();
    };
  });
}

function aiForm(c) {
  sheet(`
    <h2>${c ? 'ИИ-персонаж' : 'Новый ИИ-персонаж'}</h2>
    <label>Имя</label><input id="af-name" value="${esc(c?.name || '')}" placeholder="Гейммастер / Трактирщик / Наташа">
    <div class="row2">
      <div><label>Эмодзи</label><input id="af-emoji" value="${esc(c?.emoji || '🤖')}"></div>
      <div><label>Цвет</label><input id="af-color" type="color" value="${c?.color || '#9e4a58'}" style="height:44px;padding:4px"></div>
    </div>
    <label>Аватарка</label>
    ${coverField('af-avatar', c?.avatar)}
    <label>Мир</label>
    <select id="af-world">
      <option value="">🌐 Все миры</option>
      ${S.worlds.map(w => `<option value="${w.id}" ${c?.world_id === w.id ? 'selected' : ''}>${w.emoji} ${esc(w.title)}</option>`).join('')}
    </select>
    <label>Модель (слаг OpenRouter)</label>
    <input id="af-model" value="${esc(c?.model || 'anthropic/claude-sonnet-5.5')}" placeholder="anthropic/claude-opus-5.5">
    <label>Системный промпт (кто он, как пишет, чего не делает)</label>
    <textarea id="af-prompt" rows="7">${esc(c?.system_prompt || '')}</textarea>
    <div class="row2">
      <div><label>Температура</label><input id="af-temp" type="number" step="0.1" min="0" max="2" value="${c?.temperature ?? 0.9}"></div>
      <div><label>Макс. токенов</label><input id="af-max" type="number" value="${c?.max_tokens ?? 1200}"></div>
    </div>
    <label>Постов в контекст</label><input id="af-ctx" type="number" value="${c?.context_posts ?? 40}">
    <button class="btn" id="af-save">Сохранить</button>
    ${c ? `<button class="btn danger" id="af-del">🗑 Удалить</button>` : ''}
  `, s => {
    bindCoverField(s, 'af-avatar');
    s.querySelector('#af-save').onclick = async () => {
      const body = {
        name: s.querySelector('#af-name').value,
        emoji: s.querySelector('#af-emoji').value,
        color: s.querySelector('#af-color').value,
        avatar: s.querySelector('#af-avatar').value,
        world_id: +s.querySelector('#af-world').value || null,
        model: s.querySelector('#af-model').value,
        system_prompt: s.querySelector('#af-prompt').value,
        temperature: parseFloat(s.querySelector('#af-temp').value),
        max_tokens: parseInt(s.querySelector('#af-max').value, 10),
        context_posts: parseInt(s.querySelector('#af-ctx').value, 10),
      };
      try {
        if (c) await api(`/api/ai-chars/${c.id}`, { method: 'PATCH', body });
        else await api('/api/ai-chars', { method: 'POST', body });
        await refreshState(); closeSheet(); renderAdmin();
      } catch (e) { toast(e.message, true); }
    };
    const d = s.querySelector('#af-del');
    if (d) d.onclick = async () => {
      if (!confirm('Удалить ИИ-персонажа?')) return;
      await api(`/api/ai-chars/${c.id}`, { method: 'PATCH', body: { deleted: true } });
      await refreshState(); closeSheet(); renderAdmin();
    };
  });
}

function extForm(x) {
  sheet(`
    <h2>${x ? 'Расширение' : 'Новое расширение'}</h2>
    <label>Название</label><input id="xf-name" value="${esc(x?.name || '')}">
    <label>CSS (вставляется на страницу)</label>
    <textarea id="xf-css" rows="5" style="font-family:monospace;font-size:13px">${esc(x?.css || '')}</textarea>
    <label>JS (выполняется при загрузке; доступен объект Tavern: api, toast, sheet, state)</label>
    <textarea id="xf-js" rows="7" style="font-family:monospace;font-size:13px">${esc(x?.js || '')}</textarea>
    <div class="hint">⚠️ Код выполняется у всех в браузере. Ставь только свой или проверенный.</div>
    <button class="btn" id="xf-save">Сохранить</button>
  `, s => {
    s.querySelector('#xf-save').onclick = async () => {
      const body = {
        name: s.querySelector('#xf-name').value,
        css: s.querySelector('#xf-css').value,
        js: s.querySelector('#xf-js').value,
      };
      try {
        if (x) await api(`/api/extensions/${x.id}`, { method: 'PATCH', body });
        else await api('/api/extensions', { method: 'POST', body });
        closeSheet(); toast('Сохранено — обновится после перезагрузки страницы'); renderAdmin();
      } catch (e) { toast(e.message, true); }
    };
  });
}

// ---------- старт ----------
async function boot() {
  try {
    await refreshState();
    connectSSE();
    await route();
  } catch {
    S = null;
    renderLogin();
  }
}
boot();
