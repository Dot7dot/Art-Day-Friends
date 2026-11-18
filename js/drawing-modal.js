// 畫作詳細頁：大圖 + 留言串 + 輸入框
// 好友的動態與自己的「今天」共用同一個視窗。

import { icon } from './icons.js';
import { formatTime } from './dates.js';
import { esc, openModal, confirmDialog, avatar, toast, setBusy } from './ui.js';

export const COMMENT_MAX = 200;

/** 一則留言的 HTML（內容一律跳脫） */
export function commentHtml(c, { canDelete = false, compact = false } = {}) {
  return `<li class="comment ${compact ? 'compact' : ''}" data-comment="${esc(c.id)}">
    ${compact ? '' : avatar(c.author, 32)}
    <div class="comment-main">
      <div class="comment-meta"><b>${esc(c.author.displayName)}</b><span class="muted small">${esc(formatTime(c.createdAt))}</span></div>
      <p class="comment-body">${esc(c.body)}</p>
    </div>
    ${canDelete ? `<button class="icon-btn small" data-del-comment="${esc(c.id)}" aria-label="刪除這則留言">${icon('trash', 17)}</button>` : ''}
  </li>`;
}

/**
 * @param {object} o
 * @param {string} o.title        標題（例如「桃桃 · 今天 14:20」）
 * @param {string} o.src          圖片網址
 * @param {string} o.alt
 * @param {string} [o.drawingId]  有值才顯示留言區
 * @param {object} o.me           目前使用者
 * @param {boolean} o.isOwner     這是不是我的畫（我可以刪除上面的任何留言）
 * @param {object} o.actions      { load(id) -> comments[], add(id, body) -> comment, remove(comment) }
 * @param {boolean} [o.readOnly] 只能看留言（過期的畫：不能新增或刪除）
 * @param {Function} [o.onDownload]
 * @param {Function} [o.onCount]  留言數改變時 (n) => void
 * @param {Function} [o.onClose]
 */
export function openDrawingModal(o) {
  const hasComments = !!o.drawingId;
  const m = openModal({
    title: o.title,
    className: 'modal-drawing',
    onClose: o.onClose,
    content: `
      <div class="drawing-detail">
        <div class="drawing-scroll">
          <figure class="drawing-fig"><img src="${esc(o.src)}" alt="${esc(o.alt || '畫作')}"></figure>
          ${o.onDownload ? `<div class="drawing-tools"><button class="btn btn-small" data-download>${icon('download', 18)}<span>下載</span></button></div>` : ''}
          ${hasComments ? `<section class="comments" aria-label="留言">
            <h4 class="comments-title">留言 <span class="muted" data-count></span></h4>
            <ul class="comment-list" aria-live="polite"><li class="loading">${'<span class="spinner" aria-hidden="true"></span>'}<span>載入中…</span></li></ul>
          </section>` : ''}
        </div>
        ${hasComments && !o.readOnly ? `<form class="comment-form" autocomplete="off">
          <input name="body" maxlength="${COMMENT_MAX}" placeholder="說點什麼…" aria-label="留言內容" enterkeyhint="send">
          <span class="comment-left" data-left hidden></span>
          <button class="btn btn-primary btn-small" type="submit" aria-label="送出留言" disabled>${icon('send', 18)}<span>送出</span></button>
        </form>` : ''}
      </div>`,
  });
  m.body.querySelector('[data-download]')?.addEventListener('click', o.onDownload);
  if (!hasComments) return m;

  const list = m.body.querySelector('.comment-list');
  const scroller = m.body.querySelector('.drawing-scroll');
  const countEl = m.body.querySelector('[data-count]');
  const form = m.body.querySelector('.comment-form');
  const input = form?.elements.body;
  const sendBtn = form?.querySelector('button[type="submit"]');
  const leftEl = m.body.querySelector('[data-left]');
  let comments = [];
  let loadFailed = false;

  const canDelete = (c) => !o.readOnly && (o.isOwner || c.author.id === o.me.id);

  function paint(scrollToEnd = false) {
    countEl.textContent = comments.length ? String(comments.length) : '';
    list.innerHTML = comments.length
      ? comments.map((c) => commentHtml(c, { canDelete: canDelete(c) })).join('')
      : `<li class="comment-empty muted">${loadFailed ? '留言暫時載入不到，晚點再試試' : '還沒有留言，說點什麼吧'}</li>`;
    if (scrollToEnd) scroller.scrollTop = scroller.scrollHeight;
  }

  const refreshSend = () => {
    if (!form) return;
    const n = [...input.value.trim()].length;
    sendBtn.disabled = !n;
    const left = COMMENT_MAX - input.value.length;
    leftEl.hidden = left > 40;
    leftEl.textContent = String(left);
  };
  input?.addEventListener('input', refreshSend);

  o.actions.load(o.drawingId).then((list2) => {
    comments = list2;
    loadFailed = !!list2.failed;
    paint();
    o.onCount?.(comments.length);
  }).catch((e) => { console.warn(e); loadFailed = true; paint(); });

  form?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const body = input.value.trim();
    if (!body) return;
    setBusy(sendBtn, true);
    try {
      const c = await o.actions.add(o.drawingId, body);
      comments = [...comments, c];
      input.value = '';
      refreshSend();
      paint(true);
      o.onCount?.(comments.length);
    } catch (err) {
      console.warn(err);
      toast(err.message || '留言失敗', 'error');
    }
    setBusy(sendBtn, false);
    refreshSend();
    input.focus();
  });

  list.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-del-comment]');
    if (!b) return;
    const c = comments.find((x) => x.id === b.dataset.delComment);
    if (!c || !(await confirmDialog('刪除這則留言？', { ok: '刪除', danger: true }))) return;
    try {
      await o.actions.remove(c);
      comments = comments.filter((x) => x.id !== c.id);
      paint();
      o.onCount?.(comments.length);
    } catch (err) {
      console.warn(err);
      toast(err.message || '刪除失敗', 'error');
    }
  });

  if (form) refreshSend();
  return m;
}
