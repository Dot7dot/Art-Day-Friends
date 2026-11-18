// Art Day · 藝術小日曆
// 每天隨手畫一張，只給今天的朋友看；所有的畫都留在自己的裝置裡。

import { SUPABASE_URL, SUPABASE_ANON_KEY, MAX_CLOUD_DRAWINGS_PER_DAY as CLOUD_MAX } from './config.js';
import * as archive from './archive.js';
import { processImage, cloudCopy, makeThumb, dataURLToBlob, makeAvatar } from './imaging.js';
import { icon } from './icons.js';
import { dayKey, addDays, endOfDay, dayParts, formatDayLong, timeLeftToday, formatTime } from './dates.js';
import { esc, toast, openModal, confirmDialog, avatar, uuid, debounce, copyText, downloadBlob, setBusy } from './ui.js';
import { openSketchPad } from './sketch.js';
import { ANIMALS, checkRecoveryInput, SCHOOL_MAX, MSG as RECOVERY_MSG } from './recovery.js';
import { openDrawingModal, commentHtml } from './drawing-modal.js';
import { cameraMode, openCameraModal } from './camera.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const app = document.getElementById('app');

const state = {
  backend: null,
  me: null,
  today: dayKey(),
  calMonth: null,
  selDay: null, // 日曆下方顯示哪一天；null = 今天
  incoming: 0,
  maintainedDay: null,
};

const isDemo = () => state.backend?.mode === 'local';
const inviteLink = (u) => `${location.origin}${location.pathname}#/add/${encodeURIComponent(u)}`;
const spinner = '<span class="spinner" aria-hidden="true"></span>';

// ════════════════════════════════════════════════════════════════
//  畫面生命週期：切換頁面時釋放圖片網址與計時器
// ════════════════════════════════════════════════════════════════

let ctx = null;
function newCtx() {
  ctx?.dispose();
  ctx = makeCtx();
  return ctx;
}

function makeCtx() {
  const urls = [];
  const timers = [];
  const cleanups = [];
  const c = {
    alive: true,
    url(blob) { const u = URL.createObjectURL(blob); urls.push(u); return u; },
    every(fn, ms) { timers.push(setInterval(fn, ms)); },
    onDispose(fn) { cleanups.push(fn); },
    dispose() {
      if (!c.alive) return;
      c.alive = false;
      cleanups.forEach((fn) => { try { fn(); } catch (e) { console.warn(e); } });
      timers.forEach(clearInterval);
      setTimeout(() => urls.forEach((u) => URL.revokeObjectURL(u)), 1000);
    },
  };
  return c;
}

/** 頁面裡可以單獨換掉的一塊（例如選了別天）：自己的網址與計時器，頁面離開時一起釋放 */
function subCtx(parent) {
  const k = makeCtx();
  parent.onDispose(() => k.dispose());
  return k;
}

// ════════════════════════════════════════════════════════════════
//  啟動
// ════════════════════════════════════════════════════════════════

async function loadBackend() {
  if (SUPABASE_URL && SUPABASE_ANON_KEY) {
    const m = await import('./backend-supabase.js');
    return m.createSupabaseBackend(SUPABASE_URL, SUPABASE_ANON_KEY);
  }
  const m = await import('./backend-local.js');
  return m.createLocalBackend();
}

async function boot() {
  app.innerHTML = `<div class="splash">${brandMark(56)}</div>`;
  try {
    state.backend = await loadBackend();
    state.me = await state.backend.init();
  } catch (e) {
    console.error(e);
    app.innerHTML = `
      <div class="fatal">
        ${brandMark(48)}
        <h1>暫時連不上 Art Day</h1>
        <p class="muted">${esc(e.message || e)}</p>
        <button class="btn btn-primary" onclick="location.reload()">${icon('refresh', 18)}<span>重新整理</span></button>
      </div>`;
    return;
  }
  state.backend.onAuthChange((me) => {
    state.me = me;
    render();
  });
  window.addEventListener('hashchange', render);
  setInterval(checkDayChange, 30_000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) checkDayChange(); });
  render();
}

function checkDayChange() {
  const t = dayKey();
  if (t === state.today) return;
  state.today = t;
  state.selDay = null;
  state.calMonth = null;
  if (!state.me) return;
  const name = parseRoute().name || 'friends';
  if (name === 'friends' || name === 'calendar') render();
  else dailyMaintenance();
}

/** 每天第一次打開：把以前的畫標成「只在本機」，並請雲端刪掉昨天以前的副本 */
async function dailyMaintenance() {
  const me = state.me;
  const today = state.today;
  if (!me || state.maintainedDay === `${me.id}:${today}`) return;
  state.maintainedDay = `${me.id}:${today}`;
  try {
    await archive.updateDrawings(me.id, (d) => d.day < today && d.cloud !== 'local', () => ({ cloud: 'local' }));
    await state.backend.purgeMyPast(today);
  } catch (e) {
    console.warn('daily maintenance failed', e);
    state.maintainedDay = null;
  }
}

// ════════════════════════════════════════════════════════════════
//  路由
// ════════════════════════════════════════════════════════════════

const VIEWS = { friends: viewFriends, calendar: viewCalendar, me: viewMe };
const HOME = 'friends'; // 首頁 = 好友動態

function parseRoute() {
  const [name = '', arg = ''] = location.hash.replace(/^#\/?/, '').split('/');
  let decoded = arg;
  try { decoded = decodeURIComponent(arg); } catch { /* 保持原樣 */ }
  return { name, arg: decoded };
}

let lastRoute = '';
async function render() {
  let route = parseRoute();
  if (route.name === 'today') {
    // 舊的「今天」網址：導到合併後的日曆頁，並選回今天
    state.selDay = null;
    state.calMonth = null;
    history.replaceState(null, '', `${location.pathname}${location.search}#/calendar`);
    route = parseRoute();
  }
  if (route.name === 'add' && route.arg) {
    sessionStorage.setItem('artday.invite', route.arg);
    location.replace('#/friends/list');
    return;
  }
  const c = newCtx();
  if (!state.me) { renderAuth(c); return; }

  const name = VIEWS[route.name] ? route.name : HOME;
  if (!VIEWS[route.name]) history.replaceState(null, '', `${location.pathname}${location.search}#/${HOME}`);
  const routeKey = `${name}/${route.arg}`;
  if (routeKey !== lastRoute) window.scrollTo(0, 0);
  lastRoute = routeKey;

  renderShell(name);
  dailyMaintenance();
  refreshBadge();
  const view = $('#view');
  try {
    await VIEWS[name](view, c, route.arg);
  } catch (e) {
    console.error(e);
    if (c.alive) view.innerHTML = errorBlock(e);
  }
}

function errorBlock(e) {
  return `<div class="empty">
    <div class="empty-art">${icon('cloudOff', 34)}</div>
    <h2>出了一點狀況</h2>
    <p class="muted">${esc(e?.message || e)}</p>
    <button class="btn" onclick="location.reload()">${icon('refresh', 18)}<span>重新整理</span></button>
  </div>`;
}

// ════════════════════════════════════════════════════════════════
//  外框：頂部列 + 導覽
// ════════════════════════════════════════════════════════════════

function brandMark(size = 30) {
  return `<svg class="brand-mark" width="${size}" height="${size}" viewBox="0 0 32 32" aria-hidden="true">
    <rect x="3" y="5.5" width="26" height="23.5" rx="8" fill="#fff" stroke="#F2994A" stroke-width="2"/>
    <path d="M3 12.5h26" stroke="#F2994A" stroke-width="2"/>
    <circle cx="16" cy="20.8" r="3.6" fill="#F2994A"/>
    <path d="M10.5 3v5M21.5 3v5" stroke="#2A2622" stroke-width="2" stroke-linecap="round"/>
  </svg>`;
}

function navItem(key, label, ico, active) {
  const on = key === active;
  return `<a class="nav-item ${on ? 'on' : ''}" href="#/${key}" ${on ? 'aria-current="page"' : ''}>
    <span class="nav-ico">${icon(ico)}${key === 'friends' ? '<span class="nav-badge" data-badge hidden></span>' : ''}</span>
    <span class="nav-label">${label}</span>
  </a>`;
}

function renderShell(active) {
  app.innerHTML = `
    <header class="topbar">
      <div class="topbar-inner">
        <a class="brand" href="#/friends">${brandMark()}<span class="brand-name">Art Day</span><span class="brand-sub">藝術小日曆</span></a>
        <nav class="nav" aria-label="主選單">
          ${navItem('friends', '好友', 'users', active)}
          ${navItem('calendar', '日曆', 'calendar', active)}
          ${navItem('me', '我的', 'user', active)}
        </nav>
      </div>
    </header>
    ${isDemo() ? `<div class="demo-bar"><div class="demo-inner">
      <span class="demo-dot"></span>
      <span><b>示範模式</b>　帳號與好友只存在這台裝置</span>
      <button class="link-btn" data-demo-help>如何連接雲端？</button>
    </div></div>` : ''}
    <main id="view" class="view"></main>`;
  $('[data-demo-help]')?.addEventListener('click', showCloudHelp);
  applyBadge();
}

function showCloudHelp() {
  openModal({
    title: '連接雲端，和朋友真正分享',
    content: `
      <p>目前是<b>本機示範模式</b>：可以完整體驗，但帳號、好友與「雲端」都只存在這個瀏覽器。</p>
      <ol class="steps">
        <li>到 <b>supabase.com</b> 建立免費專案。</li>
        <li>在 SQL Editor 執行專案裡的 <code>supabase/schema.sql</code>。</li>
        <li>把 Project URL 與 anon key 填進 <code>js/config.js</code>，推上 GitHub。</li>
      </ol>
      <p class="muted small">詳細步驟請看專案的 README。連接後，大家就能各自註冊、加好友，並看到彼此今天的畫。</p>
      <div class="modal-foot"><button class="btn btn-primary" data-close>知道了</button></div>`,
  });
}

let badgeAt = 0;
async function refreshBadge(force = false) {
  if (!state.me) return;
  if (force || Date.now() - badgeAt > 60_000) {
    badgeAt = Date.now();
    try { state.incoming = (await state.backend.listFriendships()).incoming.length; } catch { /* 忽略 */ }
  }
  applyBadge();
}

function applyBadge() {
  $$('[data-badge]').forEach((b) => {
    b.textContent = state.incoming > 9 ? '9+' : String(state.incoming);
    b.hidden = !state.incoming;
  });
}

// ════════════════════════════════════════════════════════════════
//  註冊／登入
// ════════════════════════════════════════════════════════════════

function renderAuth() {
  const cloud = !isDemo();
  let mode = localStorage.getItem('artday.hasAccount') ? 'login' : 'signup';

  app.innerHTML = `
    <div class="auth">
      <div class="auth-card">
        <div class="auth-brand">${brandMark(46)}<div><h1>Art Day</h1><p>藝術小日曆</p></div></div>
        <p class="auth-lead">每天隨手畫一張，<br>只給今天的朋友看。</p>
        <div class="segmented" role="tablist" aria-label="註冊或登入">
          <button type="button" role="tab" data-mode="signup">註冊</button>
          <button type="button" role="tab" data-mode="login">登入</button>
        </div>
        <form class="auth-form" novalidate></form>
      </div>
      <ul class="rules">
        <li><span class="rule-ico">${icon('users')}</span><div><b>加好友</b><span>就能看到對方今天畫的圖</span></div></li>
        <li><span class="rule-ico">${icon('hourglass')}</span><div><b>只有今天</b><span>過了今天，好友就看不到了</span></div></li>
        <li><span class="rule-ico">${icon('device')}</span><div><b>畫留在身邊</b><span>每一張都存在你的裝置，變成一本日曆</span></div></li>
      </ul>
      ${cloud ? '' : `<p class="auth-demo muted small"><span class="demo-dot"></span>示範模式：資料只存在這台裝置。<button class="link-btn" data-demo-help>如何連接雲端？</button></p>`}
    </div>`;

  $('[data-demo-help]')?.addEventListener('click', showCloudHelp);
  const form = $('.auth-form');

  const field = (name, label, attrs, hint = '') => `
    <label class="field">
      <span class="field-label">${label}</span>
      ${name === 'username'
        ? `<span class="input-adorn"><span>@</span><input name="${name}" ${attrs}></span>`
        : `<input name="${name}" ${attrs}>`}
      ${hint ? `<span class="field-hint">${hint}</span>` : ''}
    </label>`;

  function paint() {
    $$('[data-mode]').forEach((b) => {
      b.classList.toggle('on', b.dataset.mode === mode);
      b.setAttribute('aria-selected', String(b.dataset.mode === mode));
    });
    const userAttrs = 'autocomplete="username" autocapitalize="none" spellcheck="false" required placeholder="例如 momo_draws"';
    form.innerHTML = mode === 'signup'
      ? `${field('displayName', '暱稱', 'maxlength="30" required placeholder="朋友看到的名字" autocomplete="nickname"')}
         ${field('username', '使用者 ID', `${userAttrs} maxlength="20"`, '3–20 個英文小寫、數字或底線，朋友用它找到你，之後不能修改')}
         ${field('password', '密碼', 'type="password" autocomplete="new-password" minlength="6" required placeholder="至少 6 個字元"', '不需要信箱。下一步可以設定兩個問題，忘記密碼時用來重設（可跳過）')}
         <p class="form-error" role="alert" hidden></p>
         <button class="btn btn-primary btn-block" type="submit">建立帳號</button>`
      : `${field('username', '使用者 ID', userAttrs)}
         ${field('password', '密碼', 'type="password" autocomplete="current-password" required')}
         <p class="auth-aux"><button type="button" class="link-btn" data-forgot>忘記密碼？</button></p>
         <p class="form-error" role="alert" hidden></p>
         <button class="btn btn-primary btn-block" type="submit">登入</button>`;
  }
  paint();

  form.addEventListener('click', (e) => {
    if (e.target.closest('[data-forgot]')) openForgotPassword(form.elements.username?.value);
  });

  $('.segmented').addEventListener('click', (e) => {
    const b = e.target.closest('[data-mode]');
    if (b && b.dataset.mode !== mode) { mode = b.dataset.mode; paint(); }
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(form));
    const err = $('.form-error', form);
    const btn = $('button[type="submit"]', form);
    const fail = (msg) => { err.textContent = msg; err.hidden = false; };
    err.hidden = true;

    const username = (fd.username || '').trim().replace(/^@/, '').toLowerCase();
    const password = fd.password || '';
    try {
      if (mode === 'signup') {
        const displayName = (fd.displayName || '').trim();
        if (!displayName) return fail('請填寫暱稱');
        if (!/^[a-z0-9_]{3,20}$/.test(username)) return fail('使用者 ID 需為 3–20 個英文小寫、數字或底線');
        if (password.length < 6) return fail('密碼至少需要 6 個字元');
        setBusy(btn, true, '建立中…');
        if (!(await state.backend.usernameAvailable(username))) { setBusy(btn, false); return fail('這個使用者 ID 已經有人用了，換一個吧'); }
        const res = await state.backend.signUp({ password, username, displayName });
        localStorage.setItem('artday.hasAccount', '1');
        state.me = res.user;
        showRecoveryStep();
        return;
      } else {
        if (!username) return fail('請填寫使用者 ID');
        if (!password) return fail('請填寫密碼');
        setBusy(btn, true, '登入中…');
        state.me = await state.backend.signIn({ login: username, password });
        localStorage.setItem('artday.hasAccount', '1');
      }
      render();
    } catch (ex) {
      console.warn(ex);
      setBusy(btn, false);
      fail(ex.message || '發生錯誤，請再試一次');
    }
  });
}

/** 註冊成功後的第二步：設定忘記密碼的兩個問題（可跳過），之後都會進到 App */
function showRecoveryStep() {
  const card = $('.auth-card');
  const done = () => { toast(`歡迎，${state.me.displayName}！`); render(); };
  card.innerHTML = `
    <div class="auth-brand">${brandMark(46)}<div><h1>帳號建好了</h1><p>${esc(state.me.displayName)} · @${esc(state.me.username)}</p></div></div>
    <h2 class="auth-step-title">設定忘記密碼的問題（可跳過）</h2>
    <p class="auth-note">因為沒有綁定信箱，萬一忘記密碼，要靠這兩個問題重設。<b>兩題都答對才能重設</b>，答案經過加密，連管理者也看不到。</p>
    <form class="auth-form" id="recovery-step" novalidate>
      ${recoveryFieldsHtml()}
      <p class="form-error" role="alert" hidden></p>
      <button class="btn btn-primary btn-block" type="submit">儲存</button>
      <button class="btn btn-ghost btn-block" type="button" data-skip>先跳過</button>
    </form>
    <p class="field-hint auth-foot">之後也可以到「我的」設定或修改。</p>`;
  const form = $('#recovery-step', card);
  $('[data-skip]', form).addEventListener('click', done);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('.form-error', form);
    const btn = $('button[type="submit"]', form);
    const { animal, school } = Object.fromEntries(new FormData(form));
    const bad = checkRecoveryInput(animal, school);
    err.hidden = !bad; err.textContent = bad;
    if (bad) return;
    setBusy(btn, true, '儲存中…');
    try {
      await state.backend.setRecoveryAnswers(animal, school);
      done();
    } catch (ex) {
      console.warn(ex);
      setBusy(btn, false);
      err.textContent = `${ex.message || '儲存失敗'}。也可以先跳過，之後到「我的」再設定。`;
      err.hidden = false;
    }
  });
}

/** 兩個問題的欄位（註冊第二步、設定、忘記密碼共用） */
function recoveryFieldsHtml() {
  return `
    <label class="field"><span class="field-label">最喜歡的動物</span>
      <select name="animal" required>
        <option value="">請選擇</option>
        ${ANIMALS.map((a) => `<option value="${a.key}">${esc(a.label)}</option>`).join('')}
      </select></label>
    <label class="field"><span class="field-label">你是什麼國小畢業的</span>
      <input name="school" maxlength="${SCHOOL_MAX}" autocomplete="off" autocapitalize="none" spellcheck="false" required placeholder="例如 大安國小">
      <span class="field-hint">重設密碼時要寫得一樣（「國小」可寫可不寫）</span></label>`;
}

const RESET_ERRORS = {
  wrong: '答案不太對，請再確認一下。連續答錯 5 次，這個帳號會暫時鎖住 24 小時',
  locked: '答錯的次數太多了，這個帳號暫時無法重設，請 24 小時後再試，或聯絡網站管理員',
  weak_password: '新密碼至少需要 6 個字元',
};

/** 登入畫面的「忘記密碼？」：先確認有沒有設定問題，再回答問題並設定新密碼 */
function openForgotPassword(prefill = '') {
  const m = openModal({ title: '忘記密碼', className: 'modal-small', content: '' });
  const body = m.body;
  const showError = (form, msg) => { const el = $('.form-error', form); el.textContent = msg; el.hidden = !msg; };

  function stepUser() {
    body.innerHTML = `<form class="stack" novalidate>
      <p class="muted small">輸入你的使用者 ID，我們會確認你有沒有設定過忘記密碼的問題。</p>
      <label class="field"><span class="field-label">使用者 ID</span>
        <span class="input-adorn"><span>@</span><input name="username" autocomplete="username" autocapitalize="none" spellcheck="false" required maxlength="20" autofocus></span></label>
      <p class="form-error" role="alert" hidden></p>
      <div class="modal-foot"><button type="button" class="btn" data-close>取消</button><button class="btn btn-primary" type="submit">下一步</button></div>
    </form>`;
    const form = $('form', body);
    form.elements.username.value = (prefill || '').trim();
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const username = form.elements.username.value.trim().replace(/^@/, '').toLowerCase();
      if (!username) return showError(form, '請填寫使用者 ID');
      const btn = $('button[type="submit"]', form);
      setBusy(btn, true, '確認中…');
      try {
        const ok = await state.backend.recoveryAvailable(username);
        if (ok) stepAnswers(username); else stepNone(username);
      } catch (ex) {
        console.warn(ex);
        setBusy(btn, false);
        showError(form, ex.message || RECOVERY_MSG.resetFailed);
      }
    });
  }

  function stepNone() {
    body.innerHTML = `<div class="stack">
      <p class="confirm-text">這個帳號沒有設定忘記密碼的問題，所以無法自己重設。請聯絡網站管理員，請他幫你重設密碼。</p>
      <div class="modal-foot"><button class="btn" data-back>換一個 ID</button><button class="btn btn-primary" data-close>知道了</button></div></div>`;
    $('[data-back]', body).addEventListener('click', stepUser);
  }

  function stepAnswers(username) {
    body.innerHTML = `<form class="stack" novalidate>
      <p class="muted small">@${esc(username)}，請回答你當初設定的兩個問題，再設定新密碼。</p>
      ${recoveryFieldsHtml()}
      <label class="field"><span class="field-label">新密碼</span>
        <input name="newPassword" type="password" autocomplete="new-password" minlength="6" required placeholder="至少 6 個字元"></label>
      <label class="field"><span class="field-label">再輸入一次新密碼</span>
        <input name="confirm" type="password" autocomplete="new-password" required></label>
      <p class="form-error" role="alert" hidden></p>
      <div class="modal-foot"><button type="button" class="btn" data-close>取消</button><button class="btn btn-primary" type="submit">重設密碼</button></div>
    </form>`;
    const form = $('form', body);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const { animal, school, newPassword, confirm } = Object.fromEntries(new FormData(form));
      const bad = checkRecoveryInput(animal, school)
        || (newPassword.length < 6 ? RESET_ERRORS.weak_password : '')
        || (newPassword !== confirm ? '兩次輸入的新密碼不一樣' : '');
      showError(form, bad);
      if (bad) return;
      const btn = $('button[type="submit"]', form);
      setBusy(btn, true, '重設中…');
      try {
        const status = await state.backend.resetPassword({ username, animal, school, newPassword });
        if (status !== 'ok') { setBusy(btn, false); return showError(form, RESET_ERRORS[status] || RECOVERY_MSG.resetFailed); }
      } catch (ex) {
        console.warn(ex);
        setBusy(btn, false);
        return showError(form, ex.message || RECOVERY_MSG.resetFailed);
      }
      try {
        state.me = await state.backend.signIn({ login: username, password: newPassword });
        localStorage.setItem('artday.hasAccount', '1');
        m.close(true);
        toast('密碼已重設，歡迎回來！');
        render();
      } catch (ex) {
        console.warn(ex);
        m.close(true);
        toast('密碼已重設，請用新密碼登入');
        const u = $('.auth-form input[name="username"]');
        if (u) u.value = username;
        $('.auth-form input[name="password"]')?.focus();
      }
    });
  }

  stepUser();
}

// ════════════════════════════════════════════════════════════════
//  今天（日曆頁下方的當天內容）
// ════════════════════════════════════════════════════════════════

async function addDrawing(blob, source) {
  const me = state.me;
  const day = dayKey();
  const p = await processImage(blob);
  const todays = await archive.drawingsOfDay(me.id, day);
  const cloudUsed = todays.filter((d) => d.cloud !== 'local').length;
  const rec = {
    id: uuid(), userId: me.id, day, blob: p.full, thumb: p.thumb, width: p.width, height: p.height,
    createdAt: Date.now(), source, cloud: cloudUsed < CLOUD_MAX ? 'pending' : 'local',
  };
  await archive.putDrawing(rec);
  return rec;
}

/** 把一張今天的畫上傳到雲端；失敗時保留為「待同步」 */
async function pushDrawing(rec) {
  if (rec.day !== dayKey()) {
    await archive.putDrawing({ ...rec, cloud: 'local' });
    return false;
  }
  try {
    const image = await cloudCopy(rec.blob);
    await state.backend.uploadDrawing({
      id: rec.id, day: rec.day, image, width: rec.width, height: rec.height,
      expiresAt: endOfDay(rec.day).toISOString(),
    });
    rec.cloud = 'synced';
    await archive.putDrawing(rec);
    return true;
  } catch (e) {
    rec.cloud = /上限/.test(e.message) ? 'local' : 'pending';
    await archive.putDrawing(rec);
    throw e;
  }
}

/**
 * 把圖片加進「今天」：存本機 → 同步到雲端（遵守每日雲端上限）→ 提示。
 * 「今天」頁與首頁的「＋」按鈕共用這一份。多次呼叫會排隊，不會同時計算雲端張數。
 *   onPending(n)  處理中的張數變化（開始時 +n，每張處理完 -1）
 *   onChange()    本機資料有變動，畫面可以重畫
 *   alive()       呼叫的畫面還在不在（不在就不顯示成功提示）
 *   link          成功提示附上「查看」連結，點了到「日曆」頁（今天）
 */
let addChain = Promise.resolve();
let addsInFlight = 0;
function addAndShareToday(blobs, source, opts = {}) {
  const run = () => addAndShareNow(blobs, source, opts);
  addsInFlight++;
  const p = addChain.then(run, run);
  addChain = p.catch(() => {});
  addChain.then(() => { addsInFlight--; });
  return p;
}

/**
 * 加圖片用的隱藏 <input>（放在畫面裡，點擊當下同步呼叫 .click()，手機瀏覽器才允許開啟）：
 *   pick() 上傳圖片：相簿或檔案，可多選（沒有 capture）
 *   take() 拍照：手機開系統相機（capture=environment，單張）；電腦開網頁內建的相機視窗
 * 選好的檔案交給 onFiles(files, source)；選完會清掉 value，同一張照片可以再拍／再選。
 */
function mountPhotoInputs(host, onFiles) {
  const mode = cameraMode();
  host.insertAdjacentHTML('beforeend', `
    <input type="file" accept="image/*" multiple hidden data-pick>
    ${mode ? '<input type="file" accept="image/*" capture="environment" hidden data-camera>' : ''}`);
  const pick = $(':scope > [data-pick]', host);
  const cam = $(':scope > [data-camera]', host);
  const wire = (input, source) => input?.addEventListener('change', () => {
    const files = [...input.files];
    input.value = '';
    if (files.length) onFiles(files, source);
  });
  wire(pick, 'upload');
  wire(cam, 'camera');
  return {
    canTake: !!mode,
    pick: () => pick.click(),
    take() {
      if (mode === 'native') cam.click();
      else if (mode === 'modal') {
        openCameraModal({ onFallback: () => pick.click() }).then((blob) => { if (blob) onFiles([blob], 'camera'); });
      }
    },
  };
}

async function addAndShareNow(blobs, source, { onPending, onChange, alive = () => true, link = false } = {}) {
  onPending?.(blobs.length);
  await onChange?.();
  let failed = 0;
  let added = 0;
  for (const b of blobs) {
    let rec = null;
    try {
      rec = await addDrawing(b, source);
      added++;
    } catch (e) {
      toast(e.message || '這張圖片無法加入', 'error');
    }
    onPending?.(-1);
    await onChange?.();
    if (rec?.cloud === 'pending') {
      try { await pushDrawing(rec); } catch (e) { failed++; console.warn(e); }
      await onChange?.();
    } else if (rec?.cloud === 'local') {
      toast(`今天雲端已滿 ${CLOUD_MAX} 張，這張先存在本機`);
    }
  }
  const action = link ? { action: { label: '查看', onClick: () => { location.hash = '#/today'; } } } : {};
  if (failed) toast(link ? '有圖片還沒同步到雲端，可到「日曆」點「重試」' : '有圖片還沒同步到雲端，稍後可點「重試」', 'error', action);
  else if (added && alive()) toast(source === 'sketch' ? '放進今天了！' : '已加入今天', '', action);
  return { added, failed };
}

async function removeDrawing(rec) {
  if (rec.day === dayKey() && rec.cloud === 'synced') {
    await state.backend.deleteDrawing(rec.id); // 先刪雲端（留言也會一起刪），失敗就整個取消
  }
  await archive.deleteDrawing(rec.id);
  archive.replaceComments(rec.userId, [rec.id], []).catch((e) => console.warn(e));
}

// ════════════════════════════════════════════════════════════════
//  留言
// ════════════════════════════════════════════════════════════════

/**
 * 讀取這些畫上的留言（陣列，依時間排序）。
 * mine = 這些是我自己的畫：成功就更新本機快取，失敗就改用快取（離線也看得到）。
 * 失敗又沒有快取時，回傳的陣列會帶 failed = true。
 */
async function loadComments(ids, { mine = false } = {}) {
  const me = state.me;
  if (!ids.length) return [];
  try {
    const list = await state.backend.fetchComments(ids);
    if (mine) archive.replaceComments(me.id, ids, list).catch((e) => console.warn(e));
    return list;
  } catch (e) {
    console.warn('comments unavailable', e);
    const cached = mine ? await archive.commentsOfDrawings(ids).catch(() => []) : [];
    return Object.assign(cached, { failed: !cached.length });
  }
}

const countBy = (list) => {
  const m = new Map();
  for (const c of list) m.set(c.drawingId, (m.get(c.drawingId) || 0) + 1);
  return m;
};

/** mine = 在自己的畫上（會同步本機快取） */
function commentActions(mine) {
  const me = state.me;
  return {
    load: (id) => loadComments([id], { mine }),
    async add(id, body) {
      const c = await state.backend.addComment(id, body);
      if (mine) archive.putComment(me.id, c).catch((e) => console.warn(e));
      return c;
    },
    async remove(c) {
      await state.backend.deleteComment(c.id);
      if (mine) archive.deleteComment(c.id).catch((e) => console.warn(e));
    },
  };
}

const cmtBadge = (id, n = 0, always = false) => `<span class="cmt-badge" data-cmt="${esc(id)}" ${n || always ? '' : 'hidden'}>${icon('chat', 14)}<span>${n || ''}</span></span>`;

function setCmtBadge(root, id, n, always = false) {
  const el = root.querySelector(`[data-cmt="${CSS.escape(id)}"]`);
  if (!el) return;
  el.hidden = !n && !always;
  el.lastElementChild.textContent = n || '';
}

/** 同步今天：重試未上傳的、把別台裝置今天上傳的抓回本機 */
async function syncToday() {
  const me = state.me;
  const day = dayKey();
  let changed = false;
  const local = await archive.drawingsOfDay(me.id, day);
  for (const d of local.filter((x) => x.cloud === 'pending')) {
    try { await pushDrawing(d); changed = true; } catch { /* 下次再試 */ }
  }
  const remote = await state.backend.fetchMyToday(day);
  const have = new Set(local.map((d) => d.id));
  for (const r of remote.drawings) {
    if (have.has(r.id)) continue;
    try {
      const blob = dataURLToBlob(await state.backend.fetchDrawingImage(r.id));
      await archive.putDrawing({
        id: r.id, userId: me.id, day, blob, thumb: await makeThumb(blob), width: r.width, height: r.height,
        createdAt: Date.parse(r.createdAt) || Date.now(), source: 'cloud', cloud: 'synced',
      });
      changed = true;
    } catch (e) { console.warn(e); }
  }
  let note = null;
  if (remote.note && !(await archive.getNote(me.id, day))) {
    await archive.putNote(me.id, day, remote.note);
    note = remote.note;
  }
  return { changed, note };
}

const STATUS = {
  synced: { cls: 'ok', ico: 'cloud', text: '已分享' },
  pending: { cls: 'warn', ico: 'refresh', text: '未同步・重試' },
  local: { cls: '', ico: 'device', text: '僅本機' },
};

async function mountToday(el, c, onData = () => {}) {
  const me = state.me;
  const day = state.today;
  const p = dayParts(day);
  let processing = 0;

  el.innerHTML = `
    <section class="day-head">
      <div class="day-head-text">
        <p class="eyebrow">${p.year} 年 ${p.month} 月 ${p.date} 日 · ${p.weekday}</p>
        <h2 id="today-title">今天畫了什麼？</h2>
      </div>
      <p class="chip" id="cloud-chip">${icon('clock', 16)}<span></span></p>
    </section>

    <section class="section drop-zone" id="drop-zone">
      <div class="section-head">
        <h3>今天的畫</h3>
        <span class="muted small" id="today-count"></span>
      </div>
      <div class="grid" id="today-grid"></div>
      <div class="drop-hint">${icon('upload', 28)}<span>放開就加入今天</span></div>
    </section>

    <section class="section">
      <div class="section-head">
        <h3>今日記錄</h3>
        <span class="muted small" id="note-state" aria-live="polite"></span>
      </div>
      <div class="note-card">
        <textarea id="note" class="lined" maxlength="1000" rows="5" aria-label="今日記錄"
          placeholder="今天想記下什麼？靈感、心情、用了哪些顏色……"></textarea>
      </div>
    </section>`;

  const grid = $('#today-grid', el);
  const noteEl = $('#note', el);
  const noteState = $('#note-state', el);
  const chipText = $('#cloud-chip span', el);

  const tickChip = () => {
    chipText.innerHTML = `<span>分享到今晚 24:00</span> · <span>還剩 ${timeLeftToday()}</span>`;
  };
  tickChip();
  c.every(tickChip, 30_000);

  let drawings = [];
  let counts = new Map();
  let lastSig = null;

  /** 好友留在我今天的畫上的留言數 */
  async function refreshCounts() {
    const ids = drawings.filter((d) => d.cloud === 'synced').map((d) => d.id);
    if (!ids.length || !c.alive) return;
    const list = await loadComments(ids, { mine: true });
    if (!c.alive) return;
    counts = countBy(list);
    for (const id of ids) setCmtBadge(grid, id, counts.get(id) || 0);
  }

  async function paintGrid() {
    drawings = await archive.drawingsOfDay(me.id, day);
    if (!c.alive) return;
    const sig = drawings.map((d) => d.id).join();
    if (lastSig !== null && sig !== lastSig) onData();
    lastSig = sig;
    const shared = drawings.filter((d) => d.cloud === 'synced').length;
    $('#today-title', el).textContent = drawings.length ? `今天畫了 ${drawings.length} 張` : '今天畫了什麼？';
    $('#today-count', el).textContent = drawings.length ? `已分享 ${shared} 張 · 雲端上限 ${CLOUD_MAX} 張` : '';
    grid.innerHTML = drawings.map((d) => {
      const s = STATUS[d.cloud] || STATUS.local;
      return `<figure class="tile">
        <button class="tile-img" data-view="${d.id}" aria-label="查看 ${formatTime(d.createdAt)} 的畫">
          <img src="${c.url(d.thumb || d.blob)}" alt="">
        </button>
        ${d.cloud === 'synced' ? cmtBadge(d.id, counts.get(d.id) || 0) : ''}
        ${d.cloud === 'pending'
          ? `<button class="badge ${s.cls}" data-retry="${d.id}">${icon(s.ico, 14)}<span>${s.text}</span></button>`
          : `<span class="badge ${s.cls}">${icon(s.ico, 14)}<span>${s.text}</span></span>`}
        <button class="tile-del" data-del="${d.id}" aria-label="刪除這張畫">${icon('trash', 17)}</button>
      </figure>`;
    }).join('')
      + Array.from({ length: processing }, () => `<div class="tile tile-loading">${spinner}<span>處理中</span></div>`).join('')
      + `${photo.canTake ? `<button class="tile add-tile" data-camera>${icon('camera', 26)}<span>拍照</span></button>` : ''}
         <button class="tile add-tile" data-upload>${icon('upload', 26)}<span>上傳圖片</span></button>
         <button class="tile add-tile" data-sketch>${icon('pen', 26)}<span>隨手畫</span></button>`;
  }

  const addAndShare = (blobs, source) => addAndShareToday(blobs, source, {
    onPending: (n) => { processing += n; },
    onChange: () => (c.alive ? paintGrid() : null),
    alive: () => c.alive,
  });

  const photo = mountPhotoInputs($('#drop-zone', el), addAndShare);

  grid.addEventListener('click', async (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    if (t.hasAttribute('data-camera')) photo.take();
    else if (t.hasAttribute('data-upload')) photo.pick();
    else if (t.hasAttribute('data-sketch')) {
      const blob = await openSketchPad();
      if (blob) addAndShare([blob], 'sketch');
    } else if (t.dataset.view) {
      const d = drawings.find((x) => x.id === t.dataset.view);
      if (!d) return;
      openDrawingModal({
        title: `今天 ${formatTime(d.createdAt)}`,
        src: c.url(d.blob),
        alt: '我今天的畫',
        drawingId: d.cloud === 'synced' ? d.id : null,
        me,
        isOwner: true,
        actions: commentActions(true),
        onCount: (n) => { counts.set(d.id, n); setCmtBadge(grid, d.id, n); },
        onDownload: () => downloadBlob(d.blob, `art-day-${d.day}-${formatTime(d.createdAt).replace(':', '')}.jpg`),
      });
    } else if (t.dataset.retry) {
      const d = drawings.find((x) => x.id === t.dataset.retry);
      if (!d) return;
      setBusy(t, true);
      try { await pushDrawing(d); toast('已同步到雲端'); } catch (err) { toast(err.message || '同步失敗', 'error'); }
      paintGrid();
    } else if (t.dataset.del) {
      const d = drawings.find((x) => x.id === t.dataset.del);
      if (!d || !(await confirmDialog('刪除這張畫？會同時從這台裝置與雲端移除。', { ok: '刪除', danger: true }))) return;
      try { await removeDrawing(d); toast('已刪除'); } catch (err) { toast(err.message || '刪除失敗', 'error'); }
      paintGrid();
    }
  });

  // 拖放上傳
  const zone = $('#drop-zone', el);
  let dragDepth = 0;
  zone.addEventListener('dragenter', (e) => { if ([...e.dataTransfer.types].includes('Files')) { dragDepth++; zone.classList.add('dragging'); } });
  zone.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) zone.classList.remove('dragging'); });
  zone.addEventListener('dragover', (e) => e.preventDefault());
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    zone.classList.remove('dragging');
    const files = [...e.dataTransfer.files].filter((f) => f.type.startsWith('image/'));
    if (files.length) addAndShare(files, 'upload');
  });

  // 今日記錄：自動儲存
  noteEl.value = await archive.getNote(me.id, day);
  const grow = () => { noteEl.style.height = 'auto'; noteEl.style.height = `${Math.max(160, noteEl.scrollHeight)}px`; };
  let dirty = false;
  const save = debounce(async () => {
    if (!dirty) return;
    dirty = false;
    const text = noteEl.value;
    await archive.putNote(me.id, day, text);
    if (c.alive) noteState.textContent = '已存在本機…';
    onData();
    try {
      if (day === dayKey()) await state.backend.saveNote({ day, note: text, expiresAt: endOfDay(day).toISOString() });
      if (c.alive) noteState.textContent = text.trim() ? '已儲存 · 好友今天看得到' : '已儲存';
    } catch (e) {
      console.warn(e);
      if (c.alive) noteState.textContent = '已存在本機 · 雲端同步失敗';
    }
  }, 800);
  noteEl.addEventListener('input', () => { dirty = true; noteState.textContent = '編輯中…'; grow(); save(); });
  noteEl.addEventListener('blur', () => save.flush());
  c.onDispose(() => save.flush());

  await paintGrid();
  grow();
  refreshCounts();
  c.every(refreshCounts, 30_000);

  // 背景同步
  syncToday().then(({ changed, note }) => {
    if (!c.alive) return;
    if (changed) paintGrid().then(refreshCounts);
    if (note && !noteEl.value && document.activeElement !== noteEl) { noteEl.value = note; grow(); }
  }).catch((e) => console.warn('sync failed', e));
}

// ════════════════════════════════════════════════════════════════
//  好友
// ════════════════════════════════════════════════════════════════

async function viewFriends(el, c, sub) {
  const tab = sub === 'list' ? 'list' : 'feed';
  el.innerHTML = `
    <p class="muted view-sub">只看得到好友「今天」的畫，過了今天就消失。</p>
    <div class="segmented seg-wide" role="tablist">
      <a href="#/friends" role="tab" class="${tab === 'feed' ? 'on' : ''}" aria-selected="${tab === 'feed'}">今日動態</a>
      <a href="#/friends/list" role="tab" class="${tab === 'list' ? 'on' : ''}" aria-selected="${tab === 'list'}">好友名單<span class="nav-badge inline" data-badge hidden></span></a>
    </div>
    ${tab === 'feed' ? '<div id="mine-slot"></div>' : ''}
    <div id="friends-body"><div class="loading">${spinner}<span>載入中…</span></div></div>`;
  applyBadge();
  const body = $('#friends-body', el);
  if (tab === 'feed') {
    const mine = mountMine($('#mine-slot', el), c);
    mine.photo = mountAddButton(el, c, mine);
    mine.repaint();
    // 沒有重新整理按鈕：每次進來都會載入；回到這個分頁（或切回 App）時，超過 1 分鐘就再更新一次
    let loadedAt = Date.now();
    let refreshing = false;
    const onVisible = () => {
      if (document.hidden || refreshing || !c.alive || Date.now() - loadedAt < 60_000) return;
      refreshing = true;
      mine.repaint();
      paintFeed(body, c)
        .then(() => { loadedAt = Date.now(); })
        .catch((e) => console.warn('feed refresh failed', e))
        .finally(() => { refreshing = false; });
    };
    document.addEventListener('visibilitychange', onVisible);
    c.onDispose(() => document.removeEventListener('visibilitychange', onVisible));
    // 在別台裝置畫的、或還沒上傳的，也順手同步進來（有新增在進行時先不做，避免重複處理）
    if (!addsInFlight) {
      syncToday().then(({ changed, note }) => { if (c.alive && (changed || note)) mine.repaint(); })
        .catch((e) => console.warn('sync failed', e));
    }
    await paintFeed(body, c);
    loadedAt = Date.now();
  } else {
    await paintFriendList(body, c);
  }
}

/** 首頁右下角的液態玻璃「＋」：新增今天的畫（拍照、上傳圖片或隨手畫），做法和日曆頁的「今天」完全一樣。回傳 photo 控制（給「我的」卡片的捷徑用） */
function mountAddButton(el, c, mine) {
  el.classList.add('has-fab');
  el.insertAdjacentHTML('beforeend', `
    <button class="fab" type="button" data-fab aria-label="新增今天的畫" aria-haspopup="dialog">${icon('plus', 28)}</button>`);
  const fab = $('[data-fab]', el);
  const add = (blobs, source) => addAndShareToday(blobs, source, {
    link: true,
    onPending: (n) => mine.pending(n),
    onChange: () => (c.alive ? mine.repaint() : null),
  });
  const photo = mountPhotoInputs(el, add);
  mine.sketch = async () => {
    const blob = await openSketchPad();
    if (blob) add([blob], 'sketch');
  };

  fab.addEventListener('click', () => {
    const m = openModal({
      title: '新增今天的畫',
      className: 'modal-small',
      content: `<div class="add-choices">
        ${photo.canTake ? `<button type="button" class="add-choice" data-choose="camera">
          <span class="add-choice-ico">${icon('camera', 24)}</span>
          <span><b>拍照</b><span class="muted small">用相機拍下手邊的畫</span></span>
        </button>` : ''}
        <button type="button" class="add-choice" data-choose="upload">
          <span class="add-choice-ico">${icon('upload', 24)}</span>
          <span><b>上傳圖片</b><span class="muted small">從相簿或檔案選一張或多張</span></span>
        </button>
        <button type="button" class="add-choice" data-choose="sketch">
          <span class="add-choice-ico">${icon('pen', 24)}</span>
          <span><b>隨手畫</b><span class="muted small">直接在畫板上畫一張</span></span>
        </button>
      </div>`,
    });
    m.body.addEventListener('click', (e) => {
      const b = e.target.closest('[data-choose]');
      if (!b) return;
      // 開啟相機／選檔視窗必須在點擊的當下同步呼叫，瀏覽器才允許
      if (b.dataset.choose === 'camera') photo.take();
      else if (b.dataset.choose === 'upload') photo.pick();
      m.close(true);
      if (b.dataset.choose === 'sketch') mine.sketch();
    });
  });
  return photo;
}

/**
 * 首頁最上面「我自己」的今天：本機的今天的畫（原圖）與今日記錄，好友留言數，點圖片可看大圖與留言。
 * 還沒畫時顯示一張精簡的提示卡。repaint() 會重畫（新增圖片時由 addAndShareToday 的 onChange 呼叫）。
 */
function mountMine(slot, c) {
  const me = state.me;
  let seq = 0;
  let kctx = null;
  let drawings = [];
  let counts = new Map();
  let processing = 0;
  const api = {
    photo: null,
    sketch: null,
    pending(n) { processing = Math.max(0, processing + n); },
    repaint,
  };

  async function refreshCounts() {
    const ids = drawings.filter((d) => d.cloud === 'synced').map((d) => d.id);
    if (!ids.length || !c.alive) return;
    const list = await loadComments(ids, { mine: true });
    if (!c.alive || list.failed) return;
    counts = countBy(list);
    for (const id of ids) setCmtBadge(slot, id, counts.get(id) || 0);
  }

  function html(list, note, k) {
    const n = list.length;
    if (!n && !note.trim() && !processing) {
      return `<article class="post post-mine mine-empty">
        <div class="mine-empty-head">
          ${avatar(me, 42)}
          <div class="post-who"><b>你今天還沒畫</b><span class="muted small">拍一張或畫一張，和朋友分享吧</span></div>
        </div>
        <div class="mine-empty-actions">
          ${api.photo?.canTake ? `<button type="button" class="btn btn-small" data-mine-take>${icon('camera', 18)}<span>拍照</span></button>` : ''}
          <button type="button" class="btn btn-small" data-mine-pick>${icon('upload', 18)}<span>上傳</span></button>
        </div>
      </article>`;
    }
    const last = Math.max(0, ...list.map((d) => d.createdAt || 0));
    const meta = [n ? `${n} 張畫` : '寫了一段話', last ? formatTime(last) : ''].filter(Boolean).join(' · ');
    const single = n === 1 && !processing ? list[0] : null;
    return `<article class="post post-mine">
      <header class="post-head">
        ${avatar(me, 42)}
        <div class="post-who"><b>${esc(me.displayName)}<span class="me-tag">我</span></b><span class="muted small">@${esc(me.username)} · ${meta}</span></div>
      </header>
      ${n || processing ? `<div class="post-grid ${single ? 'single' : ''}">
        ${list.map((d) => {
          const s = STATUS[d.cloud] || STATUS.local;
          return `<button class="post-img loaded" data-mine-view="${esc(d.id)}" aria-label="查看大圖與留言"
            ${single && d.width && d.height ? `style="aspect-ratio:${d.width}/${d.height}"` : ''}>
            <img src="${k.url(d.blob)}" alt="我今天的畫">
            ${d.cloud === 'synced' ? cmtBadge(d.id, counts.get(d.id) || 0) : `<span class="badge ${s.cls}">${icon(s.ico, 14)}<span>${d.cloud === 'pending' ? '未同步' : s.text}</span></span>`}
          </button>`;
        }).join('')}
        ${Array.from({ length: processing }, () => '<div class="post-img post-loading" role="status" aria-label="處理中"></div>').join('')}
      </div>` : ''}
      ${note.trim() ? `<p class="post-note">${esc(note)}</p>` : ''}
    </article>`;
  }

  async function repaint() {
    const mySeq = ++seq;
    const day = dayKey();
    let list = [];
    let note = '';
    try {
      [list, note] = await Promise.all([archive.drawingsOfDay(me.id, day), archive.getNote(me.id, day)]);
    } catch (e) { console.warn('own post unavailable', e); return; }
    if (!c.alive || mySeq !== seq) return; // 畫面已離開，或有更新的重畫
    const k = subCtx(c);
    drawings = list;
    slot.innerHTML = html(list, note || '', k);
    kctx?.dispose();
    kctx = k;
    refreshCounts();
  }

  slot.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.hasAttribute('data-mine-take')) api.photo?.take();
    else if (b.hasAttribute('data-mine-pick')) api.photo?.pick();
    else if (b.dataset.mineView) {
      const d = drawings.find((x) => x.id === b.dataset.mineView);
      if (!d) return;
      openDrawingModal({
        title: `${me.displayName} · 今天 ${formatTime(d.createdAt)}`,
        src: c.url(d.blob), // 用整個頁面的網址：重畫時不會被收掉
        alt: '我今天的畫',
        drawingId: d.cloud === 'synced' ? d.id : null,
        me,
        isOwner: true,
        actions: commentActions(true),
        onCount: (n) => { counts.set(d.id, n); setCmtBadge(slot, d.id, n); },
        onDownload: () => downloadBlob(d.blob, `art-day-${d.day}-${formatTime(d.createdAt).replace(':', '')}.jpg`),
      });
    }
  });

  return api;
}

async function paintFeed(body, c) {
  const posts = await state.backend.fetchFriendsToday();
  if (!c.alive) return;
  if (!posts.length) {
    body.innerHTML = `<div class="empty">
      <div class="empty-art">${icon('users', 34)}</div>
      <h2>還沒有好友</h2>
      <p class="muted">加好友之後，就能看到彼此今天畫了什麼。</p>
      <a class="btn btn-primary" href="#/friends/list">${icon('userPlus', 18)}<span>加好友</span></a>
    </div>
    <div id="suggest-slot"></div>`;
    body.onclick = onFeedSuggestClick;
    await fillFeedSuggestions($('#suggest-slot', body), c);
    return;
  }
  const active = posts.filter((p) => p.drawings.length || p.note)
    .sort((a, b) => (b.lastAt || '').localeCompare(a.lastAt || ''));
  const idle = posts.filter((p) => !p.drawings.length && !p.note);

  body.innerHTML = `
    ${active.length ? active.map(postCard).join('') : `<div class="empty compact">
      <div class="empty-art">${icon('pen', 30)}</div>
      <h2>好友們今天還沒動筆</h2>
      <p class="muted">晚點再來看看吧，或者你先畫一張？</p>
      <a class="btn" href="#/calendar">${icon('pen', 18)}<span>去畫今天的</span></a>
    </div>`}
    ${idle.length ? `<div class="idle">
      <h3>今天還沒動筆</h3>
      <div class="idle-list">${idle.map((p) => `<span class="idle-person">${avatar(p.profile, 30)}<span>${esc(p.profile.displayName)}</span></span>`).join('')}</div>
    </div>` : ''}
    <div id="suggest-slot"></div>`;
  fillFeedSuggestions($('#suggest-slot', body), c);

  const images = new Map();
  for (const p of active) for (const d of p.drawings) images.set(d.id, { ...d, who: p.profile.displayName });

  body.onclick = (e) => {
    if (onFeedSuggestClick(e)) return;
    const b = e.target.closest('[data-cloud-view]');
    if (!b) return;
    const img = $('img', b);
    if (!img?.src) return;
    const id = b.dataset.cloudView;
    const d = images.get(id);
    openDrawingModal({
      title: `${d?.who || ''} · 今天 ${d ? formatTime(d.createdAt) : ''}`,
      src: img.src,
      alt: `${d?.who || ''} 今天的畫`,
      drawingId: id,
      me: state.me,
      isOwner: false,
      actions: commentActions(false),
      onCount: (n) => setCmtBadge(body, id, n, true),
    });
  };

  // 各張畫的留言數（不擋住圖片載入；留言功能還沒設定好時就安靜略過）
  loadComments([...images.keys()]).then((list) => {
    if (!c.alive || list.failed) return;
    const counts = countBy(list);
    for (const id of images.keys()) setCmtBadge(body, id, counts.get(id) || 0, true);
  });

  // 逐張載入圖片（一次最多 3 張）
  const queue = $$('img[data-cloud-id]', body);
  const worker = async () => {
    while (queue.length && c.alive) {
      const img = queue.shift();
      const d = images.get(img.dataset.cloudId);
      try {
        img.src = d?.image || await state.backend.fetchDrawingImage(img.dataset.cloudId);
        img.addEventListener('load', () => img.closest('.post-img')?.classList.add('loaded'), { once: true });
      } catch (e) {
        img.closest('.post-img')?.classList.add('gone');
      }
    }
  };
  await Promise.all([worker(), worker(), worker()]);
}

function postCard(p) {
  const n = p.drawings.length;
  const meta = [n ? `${n} 張畫` : '寫了一段話', p.lastAt ? formatTime(p.lastAt) : ''].filter(Boolean).join(' · ');
  const single = n === 1 ? p.drawings[0] : null;
  return `<article class="post">
    <header class="post-head">
      ${avatar(p.profile, 42)}
      <div class="post-who"><b>${esc(p.profile.displayName)}</b><span class="muted small">@${esc(p.profile.username)} · ${meta}</span></div>
    </header>
    ${n ? `<div class="post-grid ${single ? 'single' : ''}">
      ${p.drawings.map((d) => `<button class="post-img" data-cloud-view="${esc(d.id)}" aria-label="查看大圖與留言"
          ${single && d.width && d.height ? `style="aspect-ratio:${d.width}/${d.height}"` : ''}>
          <img data-cloud-id="${esc(d.id)}" alt="${esc(p.profile.displayName)} 今天的畫">
          ${cmtBadge(d.id, 0, true)}
        </button>`).join('')}
    </div>` : ''}
    ${p.note ? `<p class="post-note">${esc(p.note)}</p>` : ''}
  </article>`;
}

// ── 推薦好友 ──
const SUGGEST_MAX_LIST = 8;
const SUGGEST_MAX_FEED = 4;
const dismissKey = () => `artday.suggest.dismissed.${state.me?.id}`;

function dismissedIds() {
  try { return new Set(JSON.parse(localStorage.getItem(dismissKey())) || []); } catch { return new Set(); }
}
function dismissSuggestion(id) {
  try {
    const ids = [...dismissedIds(), id].slice(-200);
    localStorage.setItem(dismissKey(), JSON.stringify(ids));
  } catch { /* 無痕模式等情況存不了，就只在這一次畫面上隱藏 */ }
}

/** 取得推薦好友；雲端資料庫還沒更新（沒有 suggest_friends）或出錯時回傳 null，畫面就不顯示這一區 */
async function loadSuggestions(limit) {
  const skip = dismissedIds();
  try {
    const list = await state.backend.suggestFriends(Math.min(20, limit + skip.size));
    return list.filter((p) => !skip.has(p.id)).slice(0, limit);
  } catch (e) {
    console.warn('suggestFriends unavailable', e);
    return null;
  }
}

const suggestReason = (p) => (p.mutualCount > 0 ? `${p.mutualCount} 位共同好友` : '新加入');

function suggestRow(p) {
  return personRow(p, `
    <button class="btn btn-small btn-primary" data-add="${p.id}">${icon('userPlus', 16)}<span>加好友</span></button>
    <button class="btn btn-small btn-ghost" data-skip="${p.id}" aria-label="略過 ${esc(p.displayName)}">略過</button>`,
  `<span class="suggest-reason">${esc(suggestReason(p))}</span>`);
}

function suggestCard(p) {
  return `<li class="suggest-card" data-suggest="${p.id}">
    ${avatar(p, 48)}
    <div class="suggest-who"><b>${esc(p.displayName)}</b><span class="muted small">@${esc(p.username)}</span></div>
    <span class="suggest-reason">${esc(suggestReason(p))}</span>
    <div class="suggest-actions">
      <button class="btn btn-small btn-primary" data-suggest-add="${p.id}">${icon('userPlus', 16)}<span>加好友</span></button>
      <button class="btn btn-small btn-ghost" data-skip="${p.id}" aria-label="略過 ${esc(p.displayName)}">略過</button>
    </div>
  </li>`;
}

/** 今日動態裡的精簡版：橫向捲動的小卡片 */
function suggestStrip(list) {
  return `<section class="section suggest-strip">
    <div class="section-head"><h2>你可能認識</h2><a class="link-btn" href="#/friends/list">查看更多</a></div>
    <ul class="suggest-scroll">${list.map(suggestCard).join('')}</ul>
  </section>`;
}

async function fillFeedSuggestions(slot, c) {
  const list = await loadSuggestions(SUGGEST_MAX_FEED);
  if (!c.alive || !list?.length) return;
  slot.innerHTML = suggestStrip(list);
}

/** 動態頁的推薦卡片：加好友／略過。有處理就回傳 true */
function onFeedSuggestClick(e) {
  const b = e.target.closest('button');
  if (!b) return false;
  const card = b.closest('.suggest-card');
  if (!card) return false;
  if (b.dataset.skip) {
    dismissSuggestion(b.dataset.skip);
    const strip = card.closest('.suggest-strip');
    card.remove();
    if (strip && !$('.suggest-card', strip)) strip.remove();
    return true;
  }
  if (b.dataset.suggestAdd) {
    setBusy(b, true);
    state.backend.sendFriendRequest(b.dataset.suggestAdd).then((r) => {
      const done = r === 'accepted' || r === 'already_friends';
      $('.suggest-actions', card).innerHTML = `<span class="tag">${done ? '已成為好友' : '已邀請'}</span>`;
      toast(done ? '你們成為好友了！重新整理就能看到對方今天的畫' : '邀請已送出，等對方接受');
      badgeAt = Date.now();
    }).catch((err) => {
      console.warn(err);
      setBusy(b, false);
      toast(err.message || '發生錯誤', 'error');
    });
    return true;
  }
  return false;
}

function personRow(p, actions, extra = '') {
  return `<li class="person">
    ${avatar(p, 40)}
    <div class="person-name"><b>${esc(p.displayName)}</b><span class="muted small">@${esc(p.username)}</span>${extra}</div>
    <div class="person-actions">${actions}</div>
  </li>`;
}

async function paintFriendList(body, c) {
  const me = state.me;
  const fs = await state.backend.listFriendships();
  if (!c.alive) return;
  state.incoming = fs.incoming.length;
  applyBadge();

  const relation = (id) => (fs.friends.some((p) => p.id === id) ? 'friend'
    : fs.incoming.some((p) => p.id === id) ? 'incoming'
      : fs.outgoing.some((p) => p.id === id) ? 'outgoing' : 'none');

  const actionFor = (p) => ({
    friend: '<span class="tag">已是好友</span>',
    incoming: `<button class="btn btn-small btn-primary" data-accept="${p.id}">${icon('check', 16)}<span>接受</span></button>`,
    outgoing: '<span class="tag">已邀請</span>',
    none: `<button class="btn btn-small btn-primary" data-add="${p.id}">${icon('userPlus', 16)}<span>加好友</span></button>`,
  }[relation(p.id)]);

  body.innerHTML = `
    <section class="card invite-card">
      <div>
        <p class="eyebrow">我的使用者 ID</p>
        <p class="my-id">@${esc(me.username)}</p>
      </div>
      <button class="btn btn-small" data-copy-invite>${icon('link', 17)}<span>複製邀請連結</span></button>
    </section>

    <section class="section">
      <h2>加好友</h2>
      <form class="search-row" id="search-form" role="search">
        <span class="input-adorn grow"><span>@</span><input name="q" placeholder="輸入對方的使用者 ID" autocomplete="off" autocapitalize="none" spellcheck="false" aria-label="使用者 ID"></span>
        <button class="btn btn-primary" type="submit">${icon('search', 18)}<span>搜尋</span></button>
      </form>
      ${isDemo() ? `<p class="muted small demo-hint">示範好友：${['momo_draws', 'ashu_sketch', 'lin_doodle', 'nana_paint', 'kai_ink'].map((u) => `<button class="link-btn" data-try="${u}">@${u}</button>`).join('、')}</p>` : ''}
      <ul class="people" id="search-results"></ul>
    </section>

    ${fs.incoming.length ? `<section class="section">
      <h2>好友邀請 <span class="count-pill">${fs.incoming.length}</span></h2>
      <ul class="people">${fs.incoming.map((p) => personRow(p, `
        <button class="btn btn-small btn-primary" data-accept="${p.id}">${icon('check', 16)}<span>接受</span></button>
        <button class="btn btn-small btn-ghost" data-decline="${p.id}">略過</button>`)).join('')}</ul>
    </section>` : ''}

    ${fs.outgoing.length ? `<section class="section">
      <h2>等待對方回覆</h2>
      <ul class="people">${fs.outgoing.map((p) => personRow(p, `<button class="btn btn-small btn-ghost" data-cancel="${p.id}">取消邀請</button>`)).join('')}</ul>
    </section>` : ''}

    <section class="section">
      <h2>我的好友 <span class="muted">${fs.friends.length}</span></h2>
      ${fs.friends.length
        ? `<ul class="people">${fs.friends.map((p) => personRow(p, `<button class="btn btn-small btn-ghost" data-remove="${p.id}" data-name="${esc(p.displayName)}">移除</button>`)).join('')}</ul>`
        : `<p class="muted empty-line">還沒有好友。搜尋對方的使用者 ID，或把邀請連結傳給朋友吧！</p>`}
    </section>

    <div id="suggest-slot"></div>`;

  loadSuggestions(SUGGEST_MAX_LIST).then((list) => {
    const slot = $('#suggest-slot', body);
    if (!c.alive || !slot || !list?.length) return;
    slot.innerHTML = `<section class="section" id="suggest-section">
      <h2>你可能認識</h2>
      <ul class="people">${list.map(suggestRow).join('')}</ul>
    </section>`;
  });

  const form = $('#search-form', body);
  const input = $('input', form);
  const results = $('#search-results', body);

  async function search(q) {
    q = q.trim().replace(/^@/, '').toLowerCase();
    if (!q) { results.innerHTML = ''; return; }
    results.innerHTML = `<li class="loading">${spinner}<span>搜尋中…</span></li>`;
    try {
      const found = await state.backend.searchUsers(q);
      if (!c.alive) return;
      found.sort((a, b) => (b.username === q) - (a.username === q));
      results.innerHTML = found.length
        ? found.map((p) => personRow(p, actionFor(p))).join('')
        : `<li class="muted empty-line">找不到 @${esc(q)}，確認一下拼字？</li>`;
    } catch (e) {
      results.innerHTML = `<li class="muted empty-line">${esc(e.message)}</li>`;
    }
  }

  form.addEventListener('submit', (e) => { e.preventDefault(); search(input.value); });

  body.onclick = async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    const d = b.dataset;
    try {
      if (b.hasAttribute('data-copy-invite')) {
        if (await copyText(inviteLink(me.username))) toast('邀請連結已複製，傳給朋友吧！');
        return;
      }
      if (d.try) { input.value = d.try; search(d.try); return; }
      if (d.skip) {
        dismissSuggestion(d.skip);
        const sec = b.closest('#suggest-section');
        b.closest('.person').remove();
        if (sec && !$('.person', sec)) sec.remove();
        return;
      }
      if (d.add) {
        setBusy(b, true);
        const r = await state.backend.sendFriendRequest(d.add);
        toast({
          requested: '邀請已送出，等對方接受', accepted: '你們成為好友了！',
          already_friends: '你們已經是好友了', already_requested: '已經邀請過了',
        }[r] || '完成');
      } else if (d.accept) {
        setBusy(b, true);
        await state.backend.acceptFriend(d.accept);
        toast('你們成為好友了！');
      } else if (d.decline || d.cancel) {
        setBusy(b, true);
        await state.backend.removeFriend(d.decline || d.cancel);
      } else if (d.remove) {
        if (!(await confirmDialog(`確定要移除「${d.name}」嗎？你們將看不到彼此今天的畫。`, { ok: '移除', danger: true }))) return;
        await state.backend.removeFriend(d.remove);
        toast('已移除');
      } else return;
      const q = input.value;
      await paintFriendList(body, c);
      if (q) { $('#search-form input', body).value = q; }
      badgeAt = Date.now();
    } catch (err) {
      console.warn(err);
      setBusy(b, false);
      toast(err.message || '發生錯誤', 'error');
    }
  };

  // 從邀請連結進來
  const invite = sessionStorage.getItem('artday.invite');
  if (invite) {
    sessionStorage.removeItem('artday.invite');
    if (invite.toLowerCase() !== me.username) {
      input.value = invite;
      await search(invite);
      toast(`這是 @${invite} 的邀請，加為好友吧！`);
    }
  }
}

// ════════════════════════════════════════════════════════════════
//  日曆
// ════════════════════════════════════════════════════════════════

function streakOf(days, today) {
  let d = days.has(today) ? today : addDays(today, -1);
  let n = 0;
  while (days.has(d)) { n++; d = addDays(d, -1); }
  return n;
}

const monthKey = (dt) => `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}`;

/** 日曆頁：上面是壓扁的月曆，下面是選到那天的內容（預設今天，隨頁面往下捲） */
async function viewCalendar(el, c) {
  const me = state.me;
  const today = state.today;
  const thisMonth = today.slice(0, 7);
  if (state.selDay && state.selDay >= today) state.selDay = null;

  el.innerHTML = '<section id="cal-area" aria-label="月曆"></section><section id="day-pane" class="day-pane"></section>';
  const calArea = $('#cal-area', el);
  const pane = $('#day-pane', el);
  let calCtx = null;
  let dayCtx = null;
  let calSeq = 0;
  let daySeq = 0;

  async function paintCalendar() {
    const seq = ++calSeq;
    const month = state.calMonth && state.calMonth <= thisMonth ? state.calMonth : thisMonth;
    const [y, m] = month.split('-').map(Number);
    const daysIn = new Date(y, m, 0).getDate();
    const lead = new Date(y, m - 1, 1).getDay();
    const from = `${month}-01`;
    const to = `${month}-${String(daysIn).padStart(2, '0')}`;

    const [drawings, notes, act] = await Promise.all([
      archive.drawingsInRange(me.id, from, to),
      archive.notesInRange(me.id, from, to),
      archive.activity(me.id),
    ]);
    if (!c.alive || seq !== calSeq) return;
    calCtx?.dispose();
    calCtx = subCtx(c);

    const byDay = new Map();
    for (const d of drawings.sort((a, b) => a.createdAt - b.createdAt)) {
      if (!byDay.has(d.day)) byDay.set(d.day, []);
      byDay.get(d.day).push(d);
    }
    const noteDays = new Set(notes.map((n) => n.day));
    const streak = streakOf(act.drawingDays, today);
    const sel = state.selDay || today;

    let cells = '';
    for (let i = 0; i < lead; i++) cells += '<span class="cal-cell blank" aria-hidden="true"></span>';
    for (let d = 1; d <= daysIn; d++) {
      const key = `${month}-${String(d).padStart(2, '0')}`;
      const list = byDay.get(key) || [];
      const hasNote = noteDays.has(key);
      const isToday = key === today;
      const cls = ['cal-cell', list.length && 'has', isToday && 'today', key > today && 'future', !list.length && hasNote && 'note-only', key === sel && 'sel'].filter(Boolean).join(' ');
      const label = `${m} 月 ${d} 日${list.length ? `，${list.length} 張畫` : ''}${hasNote ? '，有文字記錄' : ''}${isToday ? '，今天' : ''}`;
      cells += (list.length || hasNote || isToday)
        ? `<button class="${cls}" data-day="${key}" aria-label="${label}" aria-pressed="${key === sel}">
            ${list.length ? `<img src="${calCtx.url(list[0].thumb || list[0].blob)}" alt="">` : ''}
            <span class="cal-n">${d}</span>
            ${list.length > 1 ? `<span class="cal-count">${list.length}</span>` : ''}
            ${!list.length && hasNote ? '<i class="cal-dot"></i>' : ''}
          </button>`
        : `<span class="${cls}" aria-label="${label}"><span class="cal-n">${d}</span></span>`;
    }

    calArea.innerHTML = `
      <div class="cal-head">
        <button class="icon-btn" data-month="-1" aria-label="上個月">${icon('left')}</button>
        <div class="cal-title">
          <h1>${y} 年 ${m} 月</h1>
          <p class="cal-sum muted small">本月 ${byDay.size} 天 · ${drawings.length} 張 · 連續 ${streak} 天${month !== thisMonth ? ' · <button class="link-btn" data-month="0">回到本月</button>' : ''}</p>
        </div>
        <button class="icon-btn" data-month="1" aria-label="下個月" ${month >= thisMonth ? 'disabled' : ''}>${icon('right')}</button>
      </div>
      <div class="calendar card">
        <div class="cal-weekdays">${['日', '一', '二', '三', '四', '五', '六'].map((w) => `<span>${w}</span>`).join('')}</div>
        <div class="cal-grid">${cells}</div>
      </div>`;
  }

  async function paintDay() {
    const seq = ++daySeq;
    dayCtx?.dispose();
    const k = subCtx(c);
    dayCtx = k;
    const day = state.selDay || today;
    if (day === today) {
      await mountToday(pane, k, () => paintCalendar());
    } else {
      const [list, note] = await Promise.all([archive.drawingsOfDay(me.id, day), archive.getNote(me.id, day)]);
      if (!c.alive || seq !== daySeq) return;
      if (!list.length && !note) { // 這天已經沒有內容了：回到今天
        state.selDay = null;
        paintCalendar();
        paintDay();
        return;
      }
      mountPastDay(pane, k, day, list, note, {
        onBack: () => { state.selDay = null; state.calMonth = null; paintCalendar(); paintDay(); window.scrollTo(0, 0); },
        onData: () => { paintCalendar(); paintDay(); },
      });
    }
  }

  calArea.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.month !== undefined) {
      const delta = Number(b.dataset.month);
      const cur = state.calMonth && state.calMonth <= thisMonth ? state.calMonth : thisMonth;
      const [cy, cm] = cur.split('-').map(Number);
      state.calMonth = delta === 0 ? thisMonth : monthKey(new Date(cy, cm - 1 + delta, 1));
      paintCalendar(); // 換月份不會改變選到的那天
    } else if (b.dataset.day) {
      const next = b.dataset.day === today ? null : b.dataset.day;
      if (next === state.selDay) return;
      state.selDay = next;
      for (const x of calArea.querySelectorAll('.cal-cell.sel')) { x.classList.remove('sel'); x.setAttribute('aria-pressed', 'false'); }
      b.classList.add('sel');
      b.setAttribute('aria-pressed', 'true');
      paintDay();
    }
  });

  await Promise.all([paintCalendar(), paintDay()]);
}

/** 以前的某一天：唯讀（可看大圖、下載、刪除），文字記錄當成文字顯示 */
function mountPastDay(el, c, day, list, note, { onBack, onData }) {
  const urls = list.map((d) => c.url(d.blob));
  const thumbs = list.map((d) => c.url(d.thumb || d.blob));
  const p = dayParts(day);

  el.innerHTML = `
    <section class="day-head">
      <div class="day-head-text">
        <p class="eyebrow">${p.year} 年 ${p.month} 月 ${p.date} 日 · ${p.weekday}</p>
        <h2>${list.length ? `這天畫了 ${list.length} 張` : '這天的文字記錄'}</h2>
      </div>
      <button class="btn btn-small" data-back>${icon('sun', 18)}<span>回到今天</span></button>
    </section>
    <p class="chip chip-quiet">${icon('device', 16)}<span>這天的畫只保存在這台裝置</span></p>
    ${list.length ? `<div class="sheet-grid">${list.map((d, i) => `
      <figure class="sheet-item">
        <button class="sheet-img" data-open="${i}" aria-label="查看大圖"><img src="${thumbs[i]}" alt="${formatTime(d.createdAt)} 的畫"></button>
        <figcaption>
          <span class="muted small">${formatTime(d.createdAt)}${d.source === 'sketch' ? ' · 隨手畫' : ''}</span>
          <span class="sheet-actions">
            <button class="icon-btn small" data-dl="${i}" aria-label="下載">${icon('download', 18)}</button>
            <button class="icon-btn small" data-rm="${i}" aria-label="刪除">${icon('trash', 18)}</button>
          </span>
        </figcaption>
        <ul class="comment-list compact sheet-comments" data-cmts="${esc(d.id)}" aria-label="好友的留言" hidden></ul>
      </figure>`).join('')}</div>` : ''}
    ${note ? `<div class="sheet-note"><p class="eyebrow">文字記錄</p><p>${esc(note)}</p></div>` : ''}`;

  // 好友在這些畫上留的字：先用本機快取，再向雲端更新（沒有留言就什麼都不顯示）
  const paintComments = (all) => {
    if (!c.alive) return;
    for (const ul of el.querySelectorAll('[data-cmts]')) {
      const mine = all.filter((x) => x.drawingId === ul.dataset.cmts);
      ul.innerHTML = mine.map((x) => commentHtml(x, { compact: true })).join('');
      ul.hidden = !mine.length;
    }
  };
  if (list.length) {
    const ids = list.map((d) => d.id);
    archive.commentsOfDrawings(ids).then(paintComments).catch(() => {});
    loadComments(ids, { mine: true }).then((all) => { if (!all.failed) paintComments(all); });
  }

  el.addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b || !c.alive) return;
    if (b.hasAttribute('data-back')) { onBack(); return; }
    const i = Number(b.dataset.open ?? b.dataset.dl ?? b.dataset.rm);
    const d = list[i];
    if (!d) return;
    const fname = `art-day-${day}-${i + 1}.jpg`;
    if (b.dataset.open !== undefined) {
      openDrawingModal({
        title: `${formatDayLong(day)} ${formatTime(d.createdAt)}`,
        src: urls[i],
        alt: '我的畫',
        drawingId: d.id,
        me: state.me,
        isOwner: true,
        readOnly: true,
        actions: commentActions(true),
        onDownload: () => downloadBlob(d.blob, fname),
      });
    } else if (b.dataset.dl !== undefined) {
      downloadBlob(d.blob, fname);
    } else if (b.dataset.rm !== undefined) {
      if (!(await confirmDialog('刪除這張畫？它只存在這台裝置，刪除後就找不回來了。', { ok: '刪除', danger: true }))) return;
      try {
        await removeDrawing(d);
        toast('已刪除');
        onData();
      } catch (err) { toast(err.message || '刪除失敗', 'error'); }
    }
  });
}

// ════════════════════════════════════════════════════════════════
//  我的
// ════════════════════════════════════════════════════════════════

function formatBytes(n) {
  if (!Number.isFinite(n)) return '—';
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

async function viewMe(el, c) {
  const me = state.me;
  const [act, est, persisted, recovery] = await Promise.all([
    archive.activity(me.id),
    navigator.storage?.estimate?.().catch(() => null),
    navigator.storage?.persisted?.().catch(() => false),
    state.backend.recoveryStatus().catch((e) => { console.warn(e); return { supported: false }; }),
  ]);
  if (!c.alive) return;
  const streak = streakOf(act.drawingDays, state.today);
  const link = inviteLink(me.username);

  el.innerHTML = `
    <section class="card profile-card">
      <button class="avatar-edit" data-avatar aria-label="更換大頭貼">
        ${avatar(me, 72)}
        <span class="avatar-edit-badge" aria-hidden="true">${icon('image', 14)}</span>
      </button>
      <div class="profile-main">
        <h1>${esc(me.displayName)}</h1>
        <p class="muted">@${esc(me.username)}</p>
      </div>
      <div class="profile-actions">
        <button class="btn btn-small" data-avatar>${icon('image', 16)}<span>更換大頭貼</span></button>
        <button class="btn btn-small" data-edit-name>${icon('pen', 16)}<span>修改暱稱</span></button>
        ${me.avatar ? `<button class="btn btn-small btn-ghost" data-avatar-remove>移除大頭貼</button>` : ''}
      </div>
      <input type="file" id="avatar-input" accept="image/*" hidden>
    </section>

    <div class="stats">
      <div class="stat"><b>${act.drawingDays.size}</b><span>畫畫的日子</span></div>
      <div class="stat"><b>${act.drawingCount}</b><span>張作品</span></div>
      <div class="stat"><b>${streak}</b><span>連續天數</span></div>
    </div>

    <section class="section">
      <h2>邀請朋友</h2>
      <div class="card link-card">
        <code class="link-text">${esc(link)}</code>
        <button class="btn btn-small" data-copy>${icon('copy', 16)}<span>複製</span></button>
      </div>
    </section>

    ${recovery.supported ? `<section class="section" data-recovery>
      <h2>忘記密碼的問題</h2>
      <div class="card stack">
        <p>沒有綁定信箱，所以忘記密碼時要靠「最喜歡的動物」和「畢業的國小」兩個問題重設。兩題都答對才行，答案已加密，不會顯示給任何人。</p>
        <div class="kv"><span>目前狀態</span>
          ${recovery.hasAnswers ? `<b class="ok-text">${icon('shield', 16)} 已設定</b>` : '<b class="muted">尚未設定</b>'}</div>
        ${recovery.hasAnswers && recovery.updatedAt ? `<div class="kv"><span>上次更新</span><b>${esc(new Date(recovery.updatedAt).toLocaleDateString('zh-TW', { year: 'numeric', month: 'numeric', day: 'numeric' }))}</b></div>` : ''}
        <div class="btn-row">
          <button class="btn ${recovery.hasAnswers ? '' : 'btn-primary'}" data-recovery-set>${recovery.hasAnswers ? '修改' : '設定'}</button>
          ${recovery.hasAnswers ? '<button class="btn" data-recovery-clear>移除</button>' : ''}
        </div>
      </div>
    </section>` : ''}

    <section class="section">
      <h2>本機保存</h2>
      <div class="card stack">
        <p>你所有的畫都保存在<b>這台裝置的瀏覽器</b>裡。清除瀏覽器資料或換手機前，記得先匯出備份。</p>
        <div class="kv"><span>目前使用空間</span><b>${est ? formatBytes(est.usage) : '—'}</b></div>
        <div class="kv"><span>防止瀏覽器自動清除</span>
          ${persisted ? `<b class="ok-text">${icon('shield', 16)} 已開啟</b>` : `<button class="btn btn-small" data-persist>${icon('shield', 16)}<span>開啟保護</span></button>`}
        </div>
        <div class="btn-row">
          <button class="btn" data-export>${icon('download', 18)}<span>匯出備份</span></button>
          <button class="btn" data-import>${icon('upload', 18)}<span>匯入備份</span></button>
          <input type="file" id="import-input" accept=".json,application/json" hidden>
        </div>
      </div>
    </section>

    <section class="section">
      <h2>Art Day 的規則</h2>
      <ul class="rules compact">
        <li><span class="rule-ico">${icon('users')}</span><div><b>加好友</b><span>互相成為好友，就能看到對方今天畫的圖和文字。</span></div></li>
        <li><span class="rule-ico">${icon('hourglass')}</span><div><b>只有今天</b><span>好友只看得到今天的，過了午夜就看不到了。</span></div></li>
        <li><span class="rule-ico">${icon('cloud')}</span><div><b>雲端只放今天</b><span>今天的畫會上傳一份到雲端，隔天自動刪除，節省空間。</span></div></li>
        <li><span class="rule-ico">${icon('device')}</span><div><b>畫留在身邊</b><span>每一張都永久存在你的裝置，在「日曆」裡隨時翻看。</span></div></li>
      </ul>
    </section>

    <button class="btn btn-ghost btn-block logout" data-logout>${icon('logout', 18)}<span>登出</span></button>
    <p class="foot muted small">${isDemo() ? '示範模式 · 資料只存在這台裝置' : '雲端模式 · Supabase'} · Art Day</p>`;

  const importInput = $('#import-input', el);
  const avatarInput = $('#avatar-input', el);

  avatarInput.addEventListener('change', async () => {
    const file = avatarInput.files[0];
    avatarInput.value = '';
    if (!file) return;
    try {
      const url = await makeAvatar(file);
      state.me = await state.backend.updateProfile({ avatar: url });
      toast('已更新大頭貼');
      render();
    } catch (err) { avatarError(err); }
  });

  el.addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.hasAttribute('data-avatar')) {
      avatarInput.click();
    } else if (b.hasAttribute('data-avatar-remove')) {
      setBusy(b, true);
      try {
        state.me = await state.backend.updateProfile({ avatar: null });
        toast('已移除大頭貼');
        render();
      } catch (err) { setBusy(b, false); avatarError(err); }
    } else if (b.hasAttribute('data-copy')) {
      if (await copyText(link)) toast('邀請連結已複製');
    } else if (b.hasAttribute('data-edit-name')) {
      editName();
    } else if (b.hasAttribute('data-recovery-set')) {
      editRecovery(recovery.hasAnswers);
    } else if (b.hasAttribute('data-recovery-clear')) {
      if (!(await confirmDialog('移除後，忘記密碼就無法自己重設，只能請網站管理員幫忙。確定要移除嗎？', { title: '移除忘記密碼的問題', ok: '移除', danger: true }))) return;
      try {
        await state.backend.clearRecoveryAnswers();
        toast('已移除');
        render();
      } catch (err) { toast(err.message || '移除失敗', 'error'); }
    } else if (b.hasAttribute('data-persist')) {
      const ok = await navigator.storage?.persist?.().catch(() => false);
      toast(ok ? '已開啟保護，瀏覽器不會自動清除你的畫' : '瀏覽器沒有同意。把網站加到主畫面，或常常使用，通常就會允許', ok ? '' : 'error');
      if (ok) render();
    } else if (b.hasAttribute('data-export')) {
      setBusy(b, true, '準備中…');
      try {
        const data = await archive.exportArchive(me);
        downloadBlob(new Blob([JSON.stringify(data)], { type: 'application/json' }), `art-day-${me.username}-${state.today}.json`);
        toast(`已匯出 ${data.drawings.length} 張畫`);
      } catch (err) { toast(err.message || '匯出失敗', 'error'); }
      setBusy(b, false);
    } else if (b.hasAttribute('data-import')) {
      importInput.click();
    } else if (b.hasAttribute('data-logout')) {
      await state.backend.signOut();
      state.me = null;
      state.maintainedDay = null;
      state.incoming = 0;
      badgeAt = 0;
      location.hash = '';
      render();
    }
  });

  importInput.addEventListener('change', async () => {
    const file = importInput.files[0];
    importInput.value = '';
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      const added = await archive.importArchive(me.id, data, { makeThumb, dataURLToBlob });
      toast(added ? `已匯入 ${added} 張畫` : '沒有新的畫需要匯入');
      render();
    } catch (err) {
      toast(err instanceof SyntaxError ? '檔案格式不正確' : (err.message || '匯入失敗'), 'error');
    }
  });
}

function avatarError(err) {
  console.warn(err);
  if (err?.code === 'AVATAR_UNSUPPORTED') {
    openModal({
      title: '大頭貼功能還沒開啟',
      className: 'modal-small',
      content: `<p class="confirm-text">雲端資料庫還沒有大頭貼的欄位。請網站管理員到 Supabase 的 SQL Editor，把最新的 <code>supabase/schema.sql</code> 整份再執行一次（可重複執行，不會刪掉資料），就能使用了。</p>
        <div class="modal-foot"><button class="btn btn-primary" data-close>知道了</button></div>`,
    });
  } else {
    toast(err?.message || '大頭貼更新失敗', 'error');
  }
}

function editRecovery(isSet) {
  const m = openModal({
    title: isSet ? '修改忘記密碼的問題' : '設定忘記密碼的問題',
    className: 'modal-small',
    content: `<form class="stack" id="recovery-form" novalidate>
      <p class="muted small">${isSet ? '修改時要重新選擇兩個答案。' : ''}忘記密碼時，兩題都答對才能重設。答案經過加密，不會顯示給任何人。</p>
      ${recoveryFieldsHtml()}
      <p class="form-error" role="alert" hidden></p>
      <div class="modal-foot"><button type="button" class="btn" data-close>取消</button><button class="btn btn-primary" type="submit">儲存</button></div>
    </form>`,
  });
  const form = $('#recovery-form', m.body);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('.form-error', form);
    const { animal, school } = Object.fromEntries(new FormData(form));
    const bad = checkRecoveryInput(animal, school);
    err.hidden = !bad; err.textContent = bad;
    if (bad) return;
    const btn = $('button[type="submit"]', form);
    setBusy(btn, true, '儲存中…');
    try {
      await state.backend.setRecoveryAnswers(animal, school);
      m.close(true);
      toast('已儲存忘記密碼的問題');
      render();
    } catch (ex) {
      setBusy(btn, false);
      err.textContent = ex.message || '儲存失敗';
      err.hidden = false;
    }
  });
}

function editName() {
  const m = openModal({
    title: '修改暱稱',
    className: 'modal-small',
    content: `<form class="stack" id="name-form">
      <label class="field"><span class="field-label">暱稱</span>
        <input name="displayName" maxlength="30" required value="${esc(state.me.displayName)}" autofocus></label>
      <div class="modal-foot"><button type="button" class="btn" data-close>取消</button><button class="btn btn-primary" type="submit">儲存</button></div>
    </form>`,
  });
  $('#name-form', m.body).addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = e.target.elements.displayName.value.trim();
    if (!name) return;
    const btn = $('button[type="submit"]', e.target);
    setBusy(btn, true, '儲存中…');
    try {
      state.me = await state.backend.updateProfile({ displayName: name });
      m.close(true);
      toast('已更新暱稱');
      render();
    } catch (err) {
      setBusy(btn, false);
      toast(err.message || '更新失敗', 'error');
    }
  });
}

boot();
