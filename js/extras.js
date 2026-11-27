// 愛心、外框與「新功能介紹」的畫面與流程。
// 資料規則都在後端（supabase/schema.sql／backend-local.js）；這裡只負責畫面。

import { icon } from './icons.js';
import { dayKey } from './dates.js';
import { esc, toast, openModal, confirmDialog, avatar, setBusy } from './ui.js';
import { FRAMES, ACHIEVEMENT_FRAMES, getFrame } from './frames.js';

let S = null;          // app 的 state（state.me、state.backend…）
let rerender = () => {};
export function initExtras(state, onRerender) { S = state; rerender = onRerender; }

const unsupported = (e) => e?.code === 'FEATURE_UNSUPPORTED';
const reduceMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

// ════════════════════════════════════════════════════════════════
//  愛心
// ════════════════════════════════════════════════════════════════

const H = { liked: new Set(), busy: new Set() };
const sel = (id) => `[data-heart="${CSS.escape(id)}"]`;
export const heartsOn = () => S?.heartsOk !== false;

const heartLabel = (on) => (on ? '收回愛心' : '給愛心');

/** 愛心按鈕（別人的畫才放；資料庫還沒更新時不顯示） */
export function heartBtn(id, cls = '', label = '') {
  if (!heartsOn()) return '';
  const on = H.liked.has(id);
  return `<button type="button" class="heart-btn ${cls}${on ? ' on' : ''}" data-heart="${esc(id)}" aria-pressed="${on}" aria-label="${heartLabel(on)}">${icon('heart', 20)}${label ? `<span>${esc(label)}</span>` : ''}</button>`;
}

export function heartIsOn(id) { return H.liked.has(id); }

export function paintHearts(root = document) {
  for (const b of root.querySelectorAll('[data-heart]')) {
    const on = H.liked.has(b.dataset.heart);
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', String(on));
    b.setAttribute('aria-label', heartLabel(on));
  }
}

function hideHearts() {
  S.heartsOk = false;
  document.querySelectorAll('.heart-btn, .heart-count').forEach((x) => x.remove());
}

/** 查這些畫我按過哪些（畫面畫好後呼叫）；資料庫還沒更新就把愛心按鈕藏起來 */
export async function loadLiked(ids) {
  if (!heartsOn() || !ids.length) return;
  try {
    const set = await S.backend.likedIds(ids);
    for (const id of ids) H.liked.delete(id);
    for (const id of set) H.liked.add(id);
    paintHearts();
  } catch (e) {
    if (unsupported(e)) hideHearts(); else console.warn(e);
  }
}

/** 按一下愛心／再按一下收回。回傳最後的狀態 */
export async function toggleHeart(id) {
  if (H.busy.has(id)) return H.liked.has(id);
  const want = !H.liked.has(id);
  H.busy.add(id);
  if (want) H.liked.add(id); else H.liked.delete(id);
  paintHearts();
  if (want) for (const b of document.querySelectorAll(sel(id))) { b.classList.remove('pop'); void b.offsetWidth; b.classList.add('pop'); }
  try {
    await S.backend.setHeart(id, want);
  } catch (e) {
    if (want) H.liked.delete(id); else H.liked.add(id);
    paintHearts();
    if (unsupported(e)) { hideHearts(); toast('愛心還沒開啟：請網站管理員重新執行最新的 supabase/schema.sql', 'error'); } else toast(e.message || '愛心沒有送出', 'error');
  } finally { H.busy.delete(id); }
  return H.liked.has(id);
}

/** 「❤ 收到 N 顆愛心 · 可用 M 顆」（只有自己看得到）；回傳 null = 還沒開啟 */
export async function loadMyHearts() {
  if (!heartsOn()) return null;
  try { return await S.backend.myHearts(); } catch (e) {
    if (unsupported(e)) S.heartsOk = false; else console.warn(e);
    return null;
  }
}

export const heartsLineHtml = (h) => `<span class="hearts-line-ico">${icon('heart', 18)}</span><span>收到 <b>${h.received}</b> 顆愛心 · 可用 <b>${h.available}</b> 顆</span>`;

// ════════════════════════════════════════════════════════════════
//  解鎖外框：領取成就、慶祝、問要不要換上
// ════════════════════════════════════════════════════════════════

let queue = Promise.resolve();
const enqueue = (fn) => { queue = queue.then(fn).catch((e) => console.warn(e)); return queue; };

const CONFETTI = ['#F29A4C', '#FF9EBB', '#FFE07A', '#7CCB7B', '#5BB5E9', '#B880E2', '#F2686C'];
function confettiHtml() {
  if (reduceMotion()) return '';
  return Array.from({ length: 14 }, (_, i) => {
    const a = (i / 14) * 360 + (i % 3) * 9;
    const d = 62 + (i % 4) * 12;
    const size = 7 + (i % 3) * 3;
    return `<i class="confetti" style="--dx:${Math.round(Math.cos((a * Math.PI) / 180) * d)}px;--dy:${Math.round(Math.sin((a * Math.PI) / 180) * d)}px;--s:${size}px;background:${CONFETTI[i % CONFETTI.length]};animation-delay:${(i % 5) * 40}ms"></i>`;
  }).join('');
}

function showUnlock(id) {
  const f = getFrame(id);
  if (!f || !S.me) return Promise.resolve();
  return new Promise((resolve) => {
    const m = openModal({
      title: '解鎖新外框',
      className: 'modal-small unlock-modal',
      onClose: resolve,
      content: `<div class="unlock">
        <div class="unlock-stage">${confettiHtml()}<span class="unlock-avatar">${avatar({ ...S.me, frame: id }, 120)}</span></div>
        <p class="unlock-text">解鎖新外框：<b>${esc(f.name)}</b>！要現在換上嗎？</p>
        <div class="modal-foot">
          <button class="btn" data-close>之後再說</button>
          <button class="btn btn-primary" data-wear autofocus>換上</button>
        </div></div>`,
    });
    m.body.querySelector('[data-wear]').addEventListener('click', async (e) => {
      setBusy(e.currentTarget, true, '換上中…');
      try {
        S.me = await S.backend.updateProfile({ frame: id });
        toast(`已換上「${f.name}」`);
        m.close(true);
        rerender();
      } catch (err) {
        setBusy(e.currentTarget, false);
        toast(err.message || '換上失敗', 'error');
      }
    });
  });
}

/** 領取成就外框（記錄今天有使用、檢查條件）。回傳新解鎖的 id；queueIt = false 時由呼叫的人自己處理 */
let claiming = null;
let claimAgain = false;
async function claimRaw() {
  if (!S?.me || S.framesOk === false) return [];
  try {
    return await S.backend.claimFrameAchievements(dayKey());
  } catch (e) {
    if (unsupported(e)) S.framesOk = false; else console.warn('claim frames failed', e);
    return [];
  }
}

export function queueUnlocks(ids) { for (const id of ids) enqueue(() => showUnlock(id)); }

/** 做完會有成就的事之後呼叫（上傳、留言、設定忘記密碼的問題…）；同時多次呼叫會合併 */
export function claimFrames() {
  if (claiming) { claimAgain = true; return claiming; }
  claiming = (async () => {
    const ids = await claimRaw();
    queueUnlocks(ids);
  })().finally(() => {
    claiming = null;
    if (claimAgain) { claimAgain = false; claimFrames(); }
  });
  return claiming;
}

/** 打開 App（或登入、註冊）後：先領成就，再（第一次時）顯示新功能介紹，最後依序問要不要換上新外框 */
export async function startupExtras() {
  const ids = await claimRaw();
  if (S.framesOk !== false && S.heartsOk !== false) await enqueue(showWhatsNew);
  queueUnlocks(ids);
}

// ════════════════════════════════════════════════════════════════
//  更換外框
// ════════════════════════════════════════════════════════════════

export const framesOn = () => S?.framesOk !== false && !!S?.me && 'frame' in S.me;

export async function openFramePicker() {
  const m = openModal({
    title: '更換外框',
    className: 'modal-frames',
    content: `<div class="loading"><span class="spinner" aria-hidden="true"></span><span>載入中…</span></div>`,
  });
  let owned;
  let hearts = { received: 0, spent: 0, available: 0 };
  try {
    owned = await S.backend.frameStatus();
    hearts = (await S.backend.myHearts().catch((e) => { if (!unsupported(e)) console.warn(e); return hearts; }));
  } catch (e) {
    if (unsupported(e)) S.framesOk = false;
    m.body.innerHTML = `<p class="confirm-text">${esc(unsupported(e) ? '外框還沒開啟：請網站管理員到 Supabase SQL Editor 重新執行最新的 supabase/schema.sql。' : (e.message || '讀取失敗'))}</p>
      <div class="modal-foot"><button class="btn btn-primary" data-close>知道了</button></div>`;
    return m;
  }
  let pick = S.me.frame || null;

  const stateOf = (f) => (S.me.frame === f.id ? 'eq' : owned[f.id] ? 'own' : 'lock');
  const lockText = (f) => (f.group === 'shop' ? `❤ ${f.price}` : f.short);

  function paint() {
    const f = getFrame(pick);
    const st = f ? stateOf(f) : null;
    const desc = !f ? (S.me.frame ? '' : '點下面的外框，就能預覽戴在你頭像上的樣子')
      : st === 'eq' ? '使用中'
        : st === 'own' ? '已擁有'
          : f.group === 'shop' ? `❤ ${f.price} 顆愛心可以買下` : `解鎖條件：${f.cond}`;
    let actions = '';
    if (f && st === 'own') actions += '<button class="btn btn-primary" data-use>使用</button>';
    else if (f && st === 'lock' && f.group === 'shop') actions += `<button class="btn btn-primary" data-buy>購買並使用 · ❤ ${f.price}</button>`;
    else if (f && st === 'lock') actions += '<button class="btn" disabled>還沒解鎖</button>';
    if (S.me.frame) actions += '<button class="btn btn-ghost" data-none>取消外框</button>';
    m.body.innerHTML = `
      <div class="fp-top">
        <div class="fp-preview" data-preview>${avatar({ ...S.me, frame: pick }, 120)}</div>
        <div class="fp-info">
          <b class="fp-name">${f ? esc(f.name) : '沒有外框'}</b>
          <span class="muted small fp-desc">${esc(desc)}</span>
          <span class="fp-hearts">${heartsLineHtml(hearts)}</span>
        </div>
      </div>
      <div class="fp-actions">${actions || '<span class="muted small">點選外框預覽，喜歡再購買或使用</span>'}</div>
      <ul class="fp-grid" role="list">
        ${FRAMES.map((x) => {
    const s = stateOf(x);
    return `<li><button type="button" class="fp-tile ${s}${x.id === pick ? ' sel' : ''}" data-pick="${x.id}" aria-pressed="${x.id === pick}" aria-label="預覽 ${esc(x.name)}：${s === 'eq' ? '使用中' : s === 'own' ? '已擁有' : `未解鎖，${esc(lockText(x))}`}">
          ${avatar({ ...S.me, frame: x.id }, 60)}
          <span class="fp-tile-name">${esc(x.name)}</span>
          <span class="fp-tile-sub">${s === 'eq' ? '使用中' : s === 'own' ? '已擁有' : `${icon('lock', 12)}<span>${esc(lockText(x))}</span>`}</span>
        </button></li>`;
  }).join('')}
      </ul>`;
  }
  paint();

  async function equip(id, msg) {
    S.me = await S.backend.updateProfile({ frame: id });
    toast(msg);
    rerender();
  }

  m.body.addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b || b.disabled) return;
    try {
      if (b.dataset.pick) { pick = b.dataset.pick; paint(); m.body.querySelector(`[data-pick="${b.dataset.pick}"]`)?.focus(); return; }
      const f = getFrame(pick);
      if (b.hasAttribute('data-none')) {
        setBusy(b, true);
        await equip(null, '已取消外框');
        pick = null;
        paint();
      } else if (b.hasAttribute('data-use')) {
        setBusy(b, true);
        await equip(f.id, `已換上「${f.name}」`);
        paint();
      } else if (b.hasAttribute('data-buy')) {
        if (hearts.available < f.price) { toast(`愛心不夠，還差 ${f.price - hearts.available} 顆`, 'error'); return; }
        if (!(await confirmDialog(`用 ❤ ${f.price} 顆愛心買下「${f.name}」並換上？買完還剩 ${hearts.available - f.price} 顆。`, { title: '購買外框', ok: '購買並使用' }))) return;
        setBusy(b, true, '購買中…');
        const r = await S.backend.buyFrame(f.id);
        if (r === 'ok' || r === 'already_owned') {
          owned[f.id] = owned[f.id] || 'purchase';
          if (r === 'ok') hearts = { ...hearts, spent: hearts.spent + f.price, available: hearts.available - f.price };
          await equip(f.id, r === 'ok' ? `買下並換上「${f.name}」了！` : `已換上「${f.name}」`);
        } else if (r === 'not_enough_hearts') {
          hearts = (await S.backend.myHearts().catch(() => hearts));
          toast('愛心不夠喔', 'error');
        } else toast('這個外框不能購買', 'error');
        paint();
      }
    } catch (err) {
      console.warn(err);
      toast(err.message || '操作失敗', 'error');
      paint();
    }
  });
  return m;
}

// ════════════════════════════════════════════════════════════════
//  新功能介紹（更新後第一次打開，每台裝置一次）
// ════════════════════════════════════════════════════════════════

const WN_KEY = 'artday.whatsnew.v-hearts-frames';
const wnSeen = () => { try { return !!localStorage.getItem(WN_KEY); } catch { return false; } };
const wnMark = () => { try { localStorage.setItem(WN_KEY, '1'); } catch { /* 存不了就算了 */ } };

const sample = (frame) => avatar({ username: 'artday', displayName: S?.me?.displayName || '畫', avatar: S?.me?.avatar || null, frame }, 56);

function showWhatsNew() {
  if (wnSeen() || !S?.me) return Promise.resolve();
  wnMark();
  return new Promise((resolve) => {
    const pages = [
      `<div class="wn-art wn-heart">${icon('heart', 64)}<i></i><i></i><i></i></div>
       <h3>按愛心</h3>
       <p>看到喜歡的畫，在朋友的畫上點一下 <b>❤</b>。</p>
       <p class="muted">你收到的愛心只有你自己看得到，攢起來還可以買外框喔。</p>`,
      `<div class="wn-art wn-frames">${['peach', 'rainbow', 'cat'].map(sample).join('')}</div>
       <h3>頭像外框</h3>
       <p>到「我的」→「更換外框」，幫頭像戴上圓圓的外框。</p>
       <p class="muted">一共 20 款：用愛心購買（❤ 3、10、30），或完成成就免費解鎖。</p>`,
      `<h3>成就外框</h3>
       <ul class="wn-list">${ACHIEVEMENT_FRAMES.map((f) => `<li>${sample(f.id).replace('--size:56px', '--size:40px')}<span><b>${esc(f.name)}</b><small>${esc(f.short)}</small></span></li>`).join('')}</ul>`,
    ];
    let i = 0;
    const m = openModal({
      title: '新功能',
      className: 'modal-small wn-modal',
      onClose: resolve,
      content: `<div class="wn" role="group" aria-roledescription="輪播">
        <div class="wn-pages" aria-live="polite">${pages.map((p, k) => `<section class="wn-page${k ? ' off' : ''}" data-page="${k}" ${k ? 'aria-hidden="true"' : ''}>${p}</section>`).join('')}</div>
        <div class="wn-dots" aria-hidden="true">${pages.map((_, k) => `<i class="${k ? '' : 'on'}"></i>`).join('')}</div>
        <div class="modal-foot wn-foot">
          <button class="btn btn-ghost" data-close>略過</button>
          <button class="btn" data-prev hidden>上一頁</button>
          <button class="btn btn-primary" data-next autofocus>下一頁</button>
        </div></div>`,
    });
    const root = m.body;
    const next = root.querySelector('[data-next]');
    const prev = root.querySelector('[data-prev]');
    const go = (k) => {
      i = Math.max(0, Math.min(pages.length - 1, k));
      root.querySelectorAll('.wn-page').forEach((p, n) => { p.classList.toggle('off', n !== i); p.setAttribute('aria-hidden', String(n !== i)); });
      root.querySelectorAll('.wn-dots i').forEach((d, n) => d.classList.toggle('on', n === i));
      prev.hidden = i === 0;
      next.textContent = i === pages.length - 1 ? '開始逛逛' : '下一頁';
    };
    next.addEventListener('click', () => { if (i === pages.length - 1) m.close(); else go(i + 1); });
    prev.addEventListener('click', () => go(i - 1));
    let x0 = null;
    root.addEventListener('touchstart', (e) => { x0 = e.touches[0].clientX; }, { passive: true });
    root.addEventListener('touchend', (e) => {
      if (x0 === null) return;
      const dx = e.changedTouches[0].clientX - x0;
      x0 = null;
      if (Math.abs(dx) > 45) go(i + (dx < 0 ? 1 : -1));
    });
    m.el.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowRight') go(i + 1);
      else if (e.key === 'ArrowLeft') go(i - 1);
    });
  });
}
