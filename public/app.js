'use strict';
/* Таверна — фронт без фреймворков */

const $app = document.getElementById('app');
let S = null;
let curRoom = null;
let curWorld = null;
let posts = [];
let composer = { persona_id: null, ooc: false, image: '' };
let sse = null;
let extLoaded = false;

// ---------- темы ----------
const THEMES = [
  ['candle', 'Свечная'], ['parchment', 'Пергамент'], ['midnight', 'Полночь'],
  ['grove', 'Роща'], ['noir', 'Нуар'],
];
function applyTheme(t) {
  document.body.dataset.theme = t;
  localStorage.setItem('tavern_theme', t);
}
applyTheme(localStorage.getItem('tavern_theme') || 'candle');

// ---------- utils ----------
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtBody = s => esc(s).replace(/\*([^*\n]{1,200}?)\*/g, '<em>$1</em>');
const fmtTime = ts => {
  if (!ts) return '';
  const d = new Date(ts), today = new Date();
  const hm = d.toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === today.toDateString()) return hm;
  return d.toLocaleDateString('ru', { day: 'numeric', month: 'short' }) + ' ' + hm;
};
const money = v => '$' + (v || 0).toFixed(v >= 1 ? 2 : 3);
const avaHtml = (a) => a.avatar
  ? `<div class="ava" style="border-color:${a.color};background-image:url('${esc(a.avatar)}')"></div>`
  : `<div class="ava" style="border-color:${a.color}">${a.emoji}</div>`;

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

// ---------- загрузка картинок (с сжатием на телефоне) ----------
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

// кнопка-поле «обложка» для форм
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

// ---------- авторы постов ----------
function author(p) {
  if (p.ai_char_id) {
    const c = S.ai_chars.find(c => c.id === p.ai_char_id);
    return { name: c ? c.name : 'ИИ', sub: 'ИИ', emoji: c?.emoji || '🤖', color: c?.color || '#9d7bff', avatar: c?.avatar || '', ai: true };
  }
  if (p.persona_id) {
    const pe = S.all_personas.find(x => x.id === p.persona_id);
    return pe
      ? { name: pe.name, sub: 'игрок: ' + pe.username, emoji: pe.emoji, color: pe.color, avatar: pe.avatar || '' }
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
      if (r) { r.last_at = ev.post.created_at; r.post_count++; }
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
  loadExtensions();
}

// ---------- роутинг ----------
window.addEventListener('hashchange', () => route());
async function route() {
  const h = location.hash || '#/';
  let m;
  curRoom = null; curWorld = null;
  if (S) {
    if ((m = h.match(/^#\/room\/(\d+)/))) {
      curRoom = S.rooms.find(r => r.id === +m[1]) || null;
      if (curRoom) {
        curWorld = S.worlds.find(w => w.id === curRoom.world_id) || null;
        posts = (await api(`/api/rooms/${curRoom.id}/posts?limit=50`)).posts;
      }
    } else if ((m = h.match(/^#\/world\/(\d+)/))) {
      curWorld = S.worlds.find(w => w.id === +m[1]) || null;
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
  if (curWorld) return renderWorld();
  renderHome();
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

// ----- главная: миры -----
function renderHome() {
  if (S.worlds.length === 1) { location.hash = `#/world/${S.worlds[0].id}`; return; }
  $app.innerHTML = `
  <div class="topbar">
    <h1>🕯️ ${esc(S.app_title)}</h1>
    <button class="iconbtn" id="b-theme" title="Тема">🎨</button>
    <button class="iconbtn" id="b-personas" title="Мои персонажи">🎭</button>
    <button class="iconbtn" onclick="location.hash='#/usage'" title="Траты">💰</button>
    ${S.me.is_admin ? `<button class="iconbtn" onclick="location.hash='#/admin'" title="Админка">⚙️</button>` : ''}
    <button class="iconbtn" id="b-logout" title="Выйти">🚪</button>
  </div>
  <div class="screen pad">
    ${S.worlds.map(w => worldCardHtml(w)).join('') ||
      `<div class="hint" style="margin-top:30vh;text-align:center">Миров пока нет.${S.me.is_admin ? '<br>Создай первый в ⚙️ админке.' : ''}</div>`}
  </div>`;
  bindHomeButtons();
}
function worldCardHtml(w) {
  const rooms = S.rooms.filter(r => r.world_id === w.id);
  return `
  <button class="world-card ${w.cover ? '' : 'nocover'}" ${w.cover ? `style="background-image:url('${esc(w.cover)}')"` : ''}
    onclick="location.hash='#/world/${w.id}'">
    <div class="wshade">
      <div class="wt">${w.emoji} ${esc(w.title)}</div>
      <div class="ws">${rooms.length} комнат</div>
    </div>
  </button>`;
}
function bindHomeButtons() {
  const t = document.getElementById('b-theme'); if (t) t.onclick = themeSheet;
  const p = document.getElementById('b-personas'); if (p) p.onclick = personasSheet;
  const l = document.getElementById('b-logout');
  if (l) l.onclick = async () => { await api('/api/logout', { method: 'POST' }); S = null; location.hash = ''; render(); };
}

// ----- мир: комнаты -----
function renderWorld() {
  const w = curWorld;
  const rooms = S.rooms.filter(r => r.world_id === w.id);
  const cats = {};
  for (const r of rooms) (cats[r.category] ||= []).push(r);
  const multi = S.worlds.length > 1;
  $app.innerHTML = `
  <div class="topbar">
    ${multi ? `<button class="back" onclick="location.hash='#/'">‹</button>` : ''}
    <h1>${w.emoji} ${esc(w.title)}</h1>
    <button class="iconbtn" id="b-theme" title="Тема">🎨</button>
    <button class="iconbtn" id="b-personas" title="Мои персонажи">🎭</button>
    <button class="iconbtn" onclick="location.hash='#/usage'" title="Траты">💰</button>
    ${S.me.is_admin ? `<button class="iconbtn" onclick="location.hash='#/admin'" title="Админка">⚙️</button>` : ''}
    ${multi ? '' : `<button class="iconbtn" id="b-logout" title="Выйти">🚪</button>`}
  </div>
  <div class="screen pad">
    ${Object.entries(cats).map(([cat, list]) => `
      <div class="cat-label">${esc(cat)}</div>
      ${list.map(r => `
        <button class="room-card ${r.cover ? 'covered' : ''}" ${r.cover ? `style="background-image:url('${esc(r.cover)}')"` : ''}
          onclick="location.hash='#/room/${r.id}'">
          <div class="ric">${r.kind === 'chat' ? '💬' : '📜'}</div>
          <div>
            <div class="rt">${esc(r.title)}</div>
            ${r.description ? `<div class="rd">${esc(r.description)}</div>` : ''}
          </div>
          <div class="rmeta">${r.post_count ? `${r.post_count}<br>${fmtTime(r.last_at)}` : '—'}</div>
        </button>`).join('')}
    `).join('') || `<div class="hint" style="margin-top:30vh;text-align:center">Комнат пока нет.${S.me.is_admin ? '<br>Создай первую в ⚙️ админке.' : ' Жди админа.'}</div>`}
  </div>`;
  bindHomeButtons();
}

// ----- комната -----
function renderRoom() {
  const r = curRoom;
  const myP = S.my_personas.find(p => p.id === composer.persona_id);
  $app.innerHTML = `
  <div class="topbar">
    <button class="back" onclick="location.hash='#/world/${r.world_id}'">‹</button>
    <h1>${r.kind === 'chat' ? '💬' : '📜'} ${esc(r.title)}</h1>
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
      <button class="chip" id="c-img">📎 фото</button>
    </div>
    ${composer.image ? `<div class="img-preview"><img src="${esc(composer.image)}"><button id="c-img-del">✕</button></div>` : ''}
    <div class="composer-row">
      <textarea id="c-text" rows="1" placeholder="${r.kind === 'chat' ? 'Сообщение…' : 'Твой пост… (*курсив* для действий)'}"></textarea>
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
    const btn = e.target.closest('.menu'); if (!btn) return;
    postMenu(+btn.dataset.id);
  });
  scrollFeedDown();
}

function postHtml(p) {
  const a = author(p);
  const mine = p.user_id === S.me.id;
  return `
  <div class="post ${a.ai ? 'ai' : ''} ${p.is_ooc ? 'ooc' : ''}" id="post-${p.id}">
    <div class="post-head">
      ${avaHtml(a)}
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
  ov.innerHTML = `<div class="sheet">${html}</div>`;
  ov.onclick = e => { if (e.target === ov) closeSheet(); };
  document.body.appendChild(ov);
  if (setup) setup(ov.querySelector('.sheet'));
}
function closeSheet() { document.querySelector('.overlay')?.remove(); }

function themeSheet() {
  const cur = localStorage.getItem('tavern_theme') || 'candle';
  sheet(`
    <h2>🎨 Тема</h2>
    ${THEMES.map(([id, name]) => `
      <button class="list-item" data-th="${id}" style="${cur === id ? 'border-color:var(--amber)' : ''}">
        <div class="grow"><div class="t">${name}</div></div>${cur === id ? '✓' : ''}
      </button>`).join('')}
    <div class="hint">Тема запоминается на этом устройстве.</div>
  `, s => {
    s.querySelectorAll('[data-th]').forEach(b => b.onclick = () => { applyTheme(b.dataset.th); closeSheet(); });
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
        <button class="iconbtn" data-edit="${p.id}">✏️</button>
        <button class="iconbtn" data-del="${p.id}">🗑</button>
      </div>`).join('') || '<div class="hint">Пока нет ни одного. Создай маску, за которую будешь играть.</div>'}
    <button class="btn" id="pe-new">＋ Новый персонаж</button>
  `, s => {
    s.querySelector('#pe-new').onclick = () => personaForm();
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
      <div><label>Цвет</label><input id="pf-color" type="color" value="${p?.color || '#c9a227'}" style="height:44px;padding:4px"></div>
    </div>
    <label>Аватарка</label>
    ${coverField('pf-avatar', p?.avatar)}
    <label>Кто это (видно всем)</label><textarea id="pf-bio" rows="3">${esc(p?.bio || '')}</textarea>
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
    <button class="back" onclick="history.back()">‹</button>
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
    <button class="back" onclick="location.hash='#/admin'">‹</button>
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
    <button class="back" onclick="location.hash='#/'">‹</button>
    <h1>⚙️ Админка</h1>
  </div>
  <div class="screen pad">

    <div class="sect"><h3>Миры</h3>
      ${S.worlds.map(w => `
        <div class="list-item">
          <div>${w.emoji}</div>
          <div class="grow"><div class="t">${esc(w.title)}</div></div>
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
            <div class="grow"><div class="t">${esc(r.title)}</div><div class="s">${esc(r.category)}${r.auto_ai_char_id ? ' · 🤖 авто' : ''}</div></div>
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
      <div class="hint" style="margin-top:6px">Промпт мира теперь у каждого мира свой — в ✏️ мира.</div>
    </div>
  </div>`;

  document.getElementById('a-newworld').onclick = () => worldForm();
  document.querySelectorAll('[data-wedit]').forEach(b => b.onclick = async () => {
    const { world } = await api(`/api/worlds/${b.dataset.wedit}`);
    worldForm(world);
  });
  document.getElementById('a-newroom').onclick = () => roomForm();
  document.querySelectorAll('[data-redit]').forEach(b => b.onclick = () => roomForm(S.rooms.find(r => r.id === +b.dataset.redit)));
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
    <label>Промпт мира (сеттинг, правила, тон — видят все ИИ этого мира)</label>
    <textarea id="wf-prompt" rows="6">${esc(w?.prompt || '')}</textarea>
    <button class="btn" id="wf-save">Сохранить</button>
    ${w ? `<button class="btn danger" id="wf-arch">📦 В архив</button>` : ''}
  `, s => {
    bindCoverField(s, 'wf-cover');
    s.querySelector('#wf-save').onclick = async () => {
      const body = {
        title: s.querySelector('#wf-title').value,
        emoji: s.querySelector('#wf-emoji').value || '🌍',
        cover: s.querySelector('#wf-cover').value,
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

function roomForm(r) {
  const bots = S.ai_chars;
  const attached = r?.ai_ids || [];
  sheet(`
    <h2>${r ? 'Комната' : 'Новая комната'}</h2>
    <label>Название</label><input id="rf-title" value="${esc(r?.title || '')}">
    <div class="row2">
      <div><label>Мир</label>
        <select id="rf-world">${S.worlds.map(w => `<option value="${w.id}" ${r?.world_id === w.id ? 'selected' : ''}>${w.emoji} ${esc(w.title)}</option>`).join('')}</select></div>
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
        await refreshState(); closeSheet(); renderAdmin();
      } catch (e) { toast(e.message, true); }
    };
    const a = s.querySelector('#rf-arch');
    if (a) a.onclick = async () => {
      if (!confirm('Убрать комнату в архив? Посты не удалятся.')) return;
      await api(`/api/rooms/${r.id}`, { method: 'PATCH', body: { archived: true } });
      await refreshState(); closeSheet(); renderAdmin();
    };
  });
}

function aiForm(c) {
  sheet(`
    <h2>${c ? 'ИИ-персонаж' : 'Новый ИИ-персонаж'}</h2>
    <label>Имя</label><input id="af-name" value="${esc(c?.name || '')}" placeholder="Гейммастер / Трактирщик / Наташа">
    <div class="row2">
      <div><label>Эмодзи</label><input id="af-emoji" value="${esc(c?.emoji || '🤖')}"></div>
      <div><label>Цвет</label><input id="af-color" type="color" value="${c?.color || '#7c5cff'}" style="height:44px;padding:4px"></div>
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
