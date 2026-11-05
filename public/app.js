'use strict';
/* Таверна — фронт без фреймворков */

const $app = document.getElementById('app');
let S = null;            // state с сервера
let curRoom = null;      // открытая комната
let posts = [];          // посты открытой комнаты
let composer = { persona_id: null, ooc: false };
let sse = null;

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
    background:${bad ? '#4a2a26' : '#2d241d'};color:${bad ? '#e8b1aa' : '#e8ddcb'};
    padding:10px 16px;border-radius:12px;font-size:14px;max-width:86vw;border:1px solid #3a2f25;text-align:center`;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), bad ? 5000 : 2500);
}

// ---------- авторы постов ----------
function author(p) {
  if (p.ai_char_id) {
    const c = S.ai_chars.find(c => c.id === p.ai_char_id);
    return { name: c ? c.name : 'ИИ', sub: 'ИИ', emoji: c?.emoji || '🤖', color: c?.color || '#9d7bff', ai: true };
  }
  if (p.persona_id) {
    const pe = S.all_personas.find(x => x.id === p.persona_id);
    return pe
      ? { name: pe.name, sub: 'игрок: ' + pe.username, emoji: pe.emoji, color: pe.color }
      : { name: '???', sub: '', emoji: '🎭', color: '#777' };
  }
  const u = S.users.find(u => u.id === p.user_id);
  return { name: u ? u.username : '???', sub: 'вне игры', emoji: '💬', color: '#8a8a8a' };
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
    } else if (['rooms', 'personas', 'ai_chars', 'chronicle'].includes(ev.type)) {
      refreshState().then(() => { if (!document.querySelector('.overlay')) render(); });
    }
  };
}

async function refreshState() {
  S = await api('/api/state');
  if (!composer.persona_id && S.my_personas[0]) composer.persona_id = S.my_personas[0].id;
  if (composer.persona_id && !S.my_personas.find(p => p.id === composer.persona_id)) composer.persona_id = null;
}

// ---------- роутинг ----------
window.addEventListener('hashchange', () => route());
async function route() {
  const h = location.hash || '#/';
  const m = h.match(/^#\/room\/(\d+)/);
  if (m && S) {
    curRoom = S.rooms.find(r => r.id === +m[1]) || null;
    if (curRoom) {
      posts = (await api(`/api/rooms/${curRoom.id}/posts?limit=50`)).posts;
    }
  } else curRoom = null;
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

// ----- главная -----
function renderHome() {
  const cats = {};
  for (const r of S.rooms) (cats[r.category] ||= []).push(r);
  $app.innerHTML = `
  <div class="topbar">
    <h1>🕯️ ${esc(S.app_title)}</h1>
    <button class="iconbtn" id="b-personas" title="Мои персонажи">🎭</button>
    <button class="iconbtn" onclick="location.hash='#/usage'" title="Траты">💰</button>
    ${S.me.is_admin ? `<button class="iconbtn" onclick="location.hash='#/admin'" title="Админка">⚙️</button>` : ''}
    <button class="iconbtn" id="b-logout" title="Выйти">🚪</button>
  </div>
  <div class="screen pad">
    ${Object.entries(cats).map(([cat, rooms]) => `
      <div class="cat-label">${esc(cat)}</div>
      ${rooms.map(r => `
        <button class="room-card" onclick="location.hash='#/room/${r.id}'">
          <div class="ric">${r.kind === 'chat' ? '💬' : '📜'}</div>
          <div>
            <div class="rt">${esc(r.title)}</div>
            ${r.description ? `<div class="rd">${esc(r.description)}</div>` : ''}
          </div>
          <div class="rmeta">${r.post_count ? `${r.post_count}<br>${fmtTime(r.last_at)}` : '—'}</div>
        </button>`).join('')}
    `).join('') || `<div class="hint" style="margin-top:30vh;text-align:center">Комнат пока нет.${S.me.is_admin ? '<br>Создай первую в ⚙️ админке.' : ' Жди админа.'}</div>`}
  </div>`;
  document.getElementById('b-personas').onclick = personasSheet;
  document.getElementById('b-logout').onclick = async () => { await api('/api/logout', { method: 'POST' }); S = null; location.hash = ''; render(); };
}

// ----- комната -----
function renderRoom() {
  const r = curRoom;
  const myP = S.my_personas.find(p => p.id === composer.persona_id);
  $app.innerHTML = `
  <div class="topbar">
    <button class="back" onclick="location.hash='#/'">‹</button>
    <h1>${r.kind === 'chat' ? '💬' : '📜'} ${esc(r.title)}</h1>
    <button class="iconbtn" id="b-chron" title="Хроника">📖</button>
  </div>
  <div class="screen ${r.kind === 'chat' ? 'chatmode' : ''}" id="scr">
    ${r.description ? `<div class="chronicle-box" style="margin-bottom:0"><div class="ch-title">Локация</div>${esc(r.description)}</div>` : ''}
    <div class="feed" id="feed">
      ${posts.length >= 50 ? `<button class="loadmore" id="b-more">↑ показать раньше</button>` : ''}
      ${posts.map(postHtml).join('')}
    </div>
    <div class="typing" id="typing"></div>
  </div>
  <div class="composer">
    <div class="composer-tools">
      <button class="chip ${myP ? 'on' : ''}" id="c-persona">${myP ? `${myP.emoji} ${esc(myP.name)}` : '💬 вне игры'}</button>
      <button class="chip ${composer.ooc ? 'on' : ''}" id="c-ooc">вне игры</button>
      <button class="chip ai-chip" id="c-ai">✨ позвать ИИ</button>
    </div>
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
      <div class="ava" style="border-color:${a.color}">${a.emoji}</div>
      <div>
        <div class="who" style="color:${a.color}">${esc(a.name)}</div>
        <div class="sub">${esc(a.sub)} · ${fmtTime(p.created_at)}${p.edited_at ? ' · ред.' : ''}</div>
      </div>
      ${(mine || S.me.is_admin) ? `<button class="menu" data-id="${p.id}">⋯</button>` : ''}
    </div>
    <div class="post-body">${fmtBody(p.body)}</div>
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
  if (!body) return;
  const btn = document.getElementById('c-send'); btn.disabled = true;
  try {
    await api(`/api/rooms/${curRoom.id}/posts`, { method: 'POST', body: {
      body, persona_id: composer.ooc ? null : composer.persona_id, is_ooc: composer.ooc,
    }});
    ta.value = ''; ta.style.height = 'auto';
  } catch (e) { toast(e.message, true); }
  btn.disabled = false;
}

function postMenu(id) {
  const p = posts.find(x => x.id === id); if (!p) return;
  sheet(`
    <h2>Пост</h2>
    <button class="btn ghost" id="pm-edit">✏️ Редактировать</button>
    <button class="btn danger" id="pm-del">🗑 Удалить</button>
  `, s => {
    s.querySelector('#pm-edit').onclick = () => {
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

function pickPersonaSheet() {
  sheet(`
    <h2>От чьего лица пишем?</h2>
    <button class="list-item" data-pid="">
      <div class="ava">💬</div><div class="grow"><div class="t">Вне игры (от себя)</div></div>
    </button>
    ${S.my_personas.map(p => `
      <button class="list-item" data-pid="${p.id}">
        <div class="ava" style="border-color:${p.color}">${p.emoji}</div>
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
        <div class="ava" style="border-color:${p.color}">${p.emoji}</div>
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
    <label>Кто это (видно всем)</label><textarea id="pf-bio" rows="3">${esc(p?.bio || '')}</textarea>
    <button class="btn" id="pf-save">Сохранить</button>
  `, s => {
    s.querySelector('#pf-save').onclick = async () => {
      const body = {
        name: s.querySelector('#pf-name').value,
        emoji: s.querySelector('#pf-emoji').value || '🎭',
        color: s.querySelector('#pf-color').value,
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
function aiSheet() {
  if (!S.ai_chars.length) return toast(S.me.is_admin ? 'Сначала создай ИИ-персонажей в админке' : 'Админ ещё не завёл ИИ-персонажей', true);
  sheet(`
    <h2>✨ Позвать ИИ</h2>
    ${S.ai_chars.map(c => `
      <button class="list-item" data-ai="${c.id}">
        <div class="ava" style="border-color:${c.color}">${c.emoji}</div>
        <div class="grow"><div class="t">${esc(c.name)}</div><div class="s">${esc(c.model)}</div></div>
      </button>`).join('')}
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
    <button class="back" onclick="location.hash='#/'">‹</button>
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

// ----- админка -----
async function renderAdmin() {
  const [settings, invites] = await Promise.all([api('/api/settings'), api('/api/invites')]);
  const aiFull = (await api('/api/ai-chars')).ai_chars;
  $app.innerHTML = `
  <div class="topbar">
    <button class="back" onclick="location.hash='#/'">‹</button>
    <h1>⚙️ Админка</h1>
  </div>
  <div class="screen pad">

    <div class="sect"><h3>Комнаты</h3>
      ${S.rooms.map(r => `
        <div class="list-item">
          <div>${r.kind === 'chat' ? '💬' : '📜'}</div>
          <div class="grow"><div class="t">${esc(r.title)}</div><div class="s">${esc(r.category)}</div></div>
          <button class="iconbtn" data-redit="${r.id}">✏️</button>
        </div>`).join('')}
      <button class="btn small" id="a-newroom">＋ Комната</button>
    </div>

    <div class="sect"><h3>ИИ-персонажи</h3>
      ${aiFull.map(c => `
        <div class="list-item">
          <div class="ava" style="border-color:${c.color}">${c.emoji}</div>
          <div class="grow"><div class="t">${esc(c.name)}</div><div class="s">${esc(c.model)}</div></div>
          <button class="iconbtn" data-aiedit="${c.id}">✏️</button>
        </div>`).join('')}
      <button class="btn small" id="a-newai">＋ ИИ-персонаж</button>
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
      <label>Промпт мира (видят все ИИ: сеттинг, правила, тон игры)</label>
      <textarea id="s-world" rows="5">${esc(settings.world_prompt)}</textarea>
      <label>Дневной лимит по умолчанию, $ на игрока</label><input id="s-limit" value="${esc(settings.default_daily_limit_usd)}">
      <label>Модель летописца</label><input id="s-chmodel" value="${esc(settings.chronicle_model)}">
      <label>OpenRouter API-ключ ${settings.openrouter_key_set ? '(задан — впиши новый, чтобы сменить)' : '⚠️ не задан'}</label>
      <input id="s-key" type="password" placeholder="sk-or-...">
      <button class="btn" id="s-save" style="margin-top:8px">Сохранить настройки</button>
    </div>
  </div>`;

  document.getElementById('a-newroom').onclick = () => roomForm();
  document.querySelectorAll('[data-redit]').forEach(b => b.onclick = () => roomForm(S.rooms.find(r => r.id === +b.dataset.redit)));
  document.getElementById('a-newai').onclick = () => aiForm();
  document.querySelectorAll('[data-aiedit]').forEach(b => b.onclick = () => aiForm(aiFull.find(c => c.id === +b.dataset.aiedit)));
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
      world_prompt: document.getElementById('s-world').value,
      default_daily_limit_usd: document.getElementById('s-limit').value,
      chronicle_model: document.getElementById('s-chmodel').value,
    };
    const key = document.getElementById('s-key').value.trim();
    if (key) body.openrouter_key = key;
    await api('/api/settings', { method: 'PATCH', body });
    await refreshState(); toast('Сохранено');
  };
}

function roomForm(r) {
  sheet(`
    <h2>${r ? 'Комната' : 'Новая комната'}</h2>
    <label>Название</label><input id="rf-title" value="${esc(r?.title || '')}">
    <div class="row2">
      <div><label>Тип</label>
        <select id="rf-kind">
          <option value="forum" ${r?.kind !== 'chat' ? 'selected' : ''}>📜 Форум (посты)</option>
          <option value="chat" ${r?.kind === 'chat' ? 'selected' : ''}>💬 Чат</option>
        </select></div>
      <div><label>Раздел</label><input id="rf-cat" value="${esc(r?.category || 'Локации')}" placeholder="Локации / Флуд / Служебное"></div>
    </div>
    <label>Описание локации (видят игроки и ИИ)</label>
    <textarea id="rf-desc" rows="4">${esc(r?.description || '')}</textarea>
    <button class="btn" id="rf-save">Сохранить</button>
    ${r ? `<button class="btn danger" id="rf-arch">📦 В архив</button>` : ''}
  `, s => {
    s.querySelector('#rf-save').onclick = async () => {
      const body = {
        title: s.querySelector('#rf-title').value,
        kind: s.querySelector('#rf-kind').value,
        category: s.querySelector('#rf-cat').value,
        description: s.querySelector('#rf-desc').value,
      };
      try {
        if (r) await api(`/api/rooms/${r.id}`, { method: 'PATCH', body });
        else await api('/api/rooms', { method: 'POST', body });
        await refreshState(); closeSheet(); renderAdmin();
      } catch (e) { toast(e.message, true); }
    };
    if (r) s.querySelector('#rf-arch').onclick = async () => {
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
    s.querySelector('#af-save').onclick = async () => {
      const body = {
        name: s.querySelector('#af-name').value,
        emoji: s.querySelector('#af-emoji').value,
        color: s.querySelector('#af-color').value,
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
    if (c) s.querySelector('#af-del').onclick = async () => {
      if (!confirm('Удалить ИИ-персонажа?')) return;
      await api(`/api/ai-chars/${c.id}`, { method: 'PATCH', body: { deleted: true } });
      await refreshState(); closeSheet(); renderAdmin();
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
