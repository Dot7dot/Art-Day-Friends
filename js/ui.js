// 共用 UI 小工具：跳脫、提示、對話框、燈箱、頭像

import { icon } from './icons.js';

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function debounce(fn, ms) {
  let t;
  const d = (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  d.flush = (...args) => { clearTimeout(t); return fn(...args); };
  d.cancel = () => clearTimeout(t);
  return d;
}

// ── 提示 ─────────────────────────────────────────

/** action = { label, onClick }：提示裡多一個可以點的連結（顯示久一點） */
export function toast(message, kind = '', { action } = {}) {
  const root = document.getElementById('toast-root');
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.setAttribute('role', 'status');
  const text = document.createElement('span');
  text.textContent = message;
  el.append(text);
  const hide = () => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 300);
  };
  if (action) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'toast-action';
    b.textContent = action.label;
    b.addEventListener('click', () => { hide(); action.onClick?.(); });
    el.append(b);
  }
  root.append(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(hide, action ? 5200 : 2600);
}

// ── 對話框 ───────────────────────────────────────

const openModals = [];

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && openModals.length) openModals[openModals.length - 1].close();
});

export function openModal({ title = '', content = '', className = '', beforeClose, onClose } = {}) {
  const root = document.getElementById('modal-root');
  const wrap = document.createElement('div');
  wrap.className = 'overlay';
  wrap.innerHTML = `
    <div class="modal ${className}" role="dialog" aria-modal="true" aria-label="${esc(title)}">
      ${title ? `<div class="modal-head"><h3>${esc(title)}</h3>
        <button class="icon-btn" data-close aria-label="關閉">${icon('x')}</button></div>` : ''}
      <div class="modal-body"></div>
    </div>`;
  const body = wrap.querySelector('.modal-body');
  if (typeof content === 'string') body.innerHTML = content; else body.append(content);

  let closed = false;
  const api = {
    el: wrap,
    body,
    async close(force = false) {
      if (closed) return;
      if (!force && beforeClose && !(await beforeClose())) return;
      closed = true;
      openModals.splice(openModals.indexOf(api), 1);
      wrap.classList.remove('open');
      if (!openModals.length) document.body.classList.remove('no-scroll');
      setTimeout(() => wrap.remove(), 220);
      onClose?.();
    },
  };
  wrap.addEventListener('click', (e) => {
    if (e.target === wrap || e.target.closest('[data-close]')) api.close();
  });
  openModals.push(api);
  document.body.classList.add('no-scroll');
  root.append(wrap);
  requestAnimationFrame(() => wrap.classList.add('open'));
  setTimeout(() => (wrap.querySelector('[autofocus]') || wrap.querySelector('.modal'))?.focus?.(), 50);
  return api;
}

export function confirmDialog(message, { title = '確認一下', ok = '確定', cancel = '取消', danger = false } = {}) {
  return new Promise((resolve) => {
    let answer = false;
    const m = openModal({
      title,
      className: 'modal-small',
      content: `<p class="confirm-text">${esc(message)}</p>
        <div class="modal-foot">
          <button class="btn" data-close>${esc(cancel)}</button>
          <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-ok autofocus>${esc(ok)}</button>
        </div>`,
      onClose: () => resolve(answer),
    });
    m.body.querySelector('[data-ok]').addEventListener('click', () => { answer = true; m.close(true); });
  });
}

// ── 燈箱（看大圖）──────────────────────────────────

export function lightbox(src, { caption = '', onDownload } = {}) {
  const content = `
    <figure class="lightbox-figure">
      <img src="${esc(src)}" alt="${esc(caption || '畫作')}">
      ${caption || onDownload ? `<figcaption>
        <span>${esc(caption)}</span>
        ${onDownload ? `<button class="btn btn-small" data-download>${icon('download', 18)}<span>下載</span></button>` : ''}
      </figcaption>` : ''}
    </figure>
    <button class="icon-btn lightbox-close" data-close aria-label="關閉">${icon('x')}</button>`;
  const m = openModal({ content, className: 'modal-lightbox' });
  m.el.classList.add('overlay-light');
  m.body.querySelector('[data-download]')?.addEventListener('click', onDownload);
  return m;
}

// ── 頭像 ─────────────────────────────────────────

const AVATAR_TINTS = ['#FFE9D6', '#FFF1C9', '#E4F2E6', '#E3EEF9', '#F3E6F6', '#FBE3E3'];

function hash(str) {
  let h = 0;
  for (const ch of String(str)) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return h;
}

export function avatar(profile, size = 40) {
  const name = profile?.displayName || profile?.username || '?';
  const initial = [...name.trim()][0] || '?';
  const tint = AVATAR_TINTS[hash(profile?.username || name) % AVATAR_TINTS.length];
  const photo = typeof profile?.avatar === 'string' && /^data:image\/(jpeg|png|webp);base64,/.test(profile.avatar) ? profile.avatar : '';
  if (photo) {
    return `<span class="avatar has-img" style="--size:${size}px;--tint:${tint}" aria-hidden="true"><img src="${esc(photo)}" alt="" decoding="async"></span>`;
  }
  return `<span class="avatar" style="--size:${size}px;--tint:${tint}" aria-hidden="true">${esc(initial.toUpperCase())}</span>`;
}

// ── 其他 ─────────────────────────────────────────

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export function setBusy(btn, busy, label) {
  if (!btn) return;
  if (busy) {
    btn.dataset.label = btn.innerHTML;
    btn.disabled = true;
    if (label) btn.innerHTML = `<span class="spinner"></span><span>${esc(label)}</span>`;
  } else {
    btn.disabled = false;
    if (btn.dataset.label) btn.innerHTML = btn.dataset.label;
  }
}
