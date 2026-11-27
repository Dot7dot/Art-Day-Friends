// 畫作詳細頁：大圖 + 留言串 + 輸入框
// 好友的動態與自己的「今天」共用同一個視窗。

import { icon } from './icons.js';
import { formatTime } from './dates.js';
import { heartBtn, heartsOn, toggleHeart } from './extras.js';
import { esc, openModal, confirmDialog, avatar, toast, setBusy } from './ui.js';

export const COMMENT_MAX = 200;

/** 這則留言回覆的是哪一位（在同一份留言清單裡找；找不到就沒有） */
export function replyTarget(list, c) {
  return c.replyTo ? list.find((x) => x.id === c.replyTo)?.author || null : null;
}

/**
 * 一則留言的 HTML（內容一律跳脫）
 * replyTo = 被回覆的人（顯示「回覆 @xxx」）；canReply = 顯示「回覆」按鈕
 */
export function commentHtml(c, { canDelete = false, compact = false, canReply = false, replyTo = null } = {}) {
  return `<li class="comment ${compact ? 'compact' : ''}" data-comment="${esc(c.id)}">
    ${compact ? '' : avatar(c.author, 32)}
    <div class="comment-main">
      <div class="comment-meta"><b>${esc(c.author.displayName)}</b><span class="muted small">${esc(formatTime(c.createdAt))}</span></div>
      ${replyTo ? `<p class="comment-reply-to">${icon('reply', 13)}<span>回覆 @${esc(replyTo.username || replyTo.displayName)}</span></p>` : ''}
      <p class="comment-body">${esc(c.body)}</p>
      ${canReply ? `<button type="button" class="comment-reply-btn" data-reply-comment="${esc(c.id)}">回覆</button>` : ''}
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
 * @param {object} o.actions      { load(id) -> comments[], add(id, body, replyToId?) -> comment, remove(comment) }
 * @param {boolean} [o.readOnly] 只能看留言（過期的畫：不能新增或刪除）
 * @param {Function} [o.onDownload]
 * @param {Function} [o.onSave]   「存到相簿」：會在點擊當下同步呼叫（不要 await 之後才開分享表）
 * @param {Function} [o.onAddFriend] 推薦貼文用：「加好友」，回傳 Promise<'accepted'|'already_friends'|其他>
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
          ${o.onSave || o.onDownload || o.onAddFriend || (o.heartId && heartsOn()) || o.ownHearts != null ? `<div class="drawing-tools">
            ${o.heartId && heartsOn() ? heartBtn(o.heartId, 'heart-btn-wide', '愛心') : ''}
            ${o.ownHearts != null ? `<span class="heart-own" title="只有你看得到">${icon('heart', 16)}<span>收到 ${o.ownHearts} 顆愛心</span></span>` : ''}
            ${o.onAddFriend ? `<span class="drawing-friend" data-friend><button class="btn btn-small btn-primary" data-addfriend>${icon('userPlus', 18)}<span>加好友</span></button></span>` : ''}
            ${o.onSave ? `<button class="btn btn-small" data-save>${icon('image', 18)}<span>存到相簿</span></button>` : ''}
            ${o.onDownload ? `<button class="btn btn-small" data-download>${icon('download', 18)}<span>下載</span></button>` : ''}
          </div>` : ''}
          ${hasComments ? `<section class="comments" aria-label="留言">
            <h4 class="comments-title">留言 <span class="muted" data-count></span></h4>
            <ul class="comment-list" aria-live="polite"><li class="loading">${'<span class="spinner" aria-hidden="true"></span>'}<span>載入中…</span></li></ul>
          </section>` : ''}
        </div>
        ${hasComments && !o.readOnly ? `<form class="comment-form" autocomplete="off">
          <div class="reply-chip" data-reply-chip hidden><span class="reply-chip-text" data-reply-text></span><button type="button" class="reply-chip-x" data-reply-cancel aria-label="取消回覆">${icon('x', 14)}</button></div>
          <input name="body" maxlength="${COMMENT_MAX}" placeholder="說點什麼…" aria-label="留言內容" enterkeyhint="send">
          <span class="comment-left" data-left hidden></span>
          <button class="btn btn-primary btn-small" type="submit" aria-label="送出留言" disabled>${icon('send', 18)}<span>送出</span></button>
        </form>` : ''}
      </div>`,
  });
  m.body.querySelector('[data-download]')?.addEventListener('click', o.onDownload);
  // 直接呼叫（不包 async／await），分享表才拿得到點擊的啟動狀態
  m.body.querySelector('[data-save]')?.addEventListener('click', () => o.onSave());
  m.body.querySelector('[data-heart]')?.addEventListener('click', () => toggleHeart(o.heartId));
  const addBtn = m.body.querySelector('[data-addfriend]');
  addBtn?.addEventListener('click', async () => {
    setBusy(addBtn, true);
    try {
      const r = await o.onAddFriend();
      const done = r === 'accepted' || r === 'already_friends';
      m.body.querySelector('[data-friend]').innerHTML = `<span class="tag">${done ? '已成為好友' : '已邀請'}</span>`;
    } catch (err) {
      console.warn(err);
      setBusy(addBtn, false);
      toast(err.message || '發生錯誤', 'error');
    }
  });
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
  let replying = null; // 正在回覆的那則留言
  const chip = m.body.querySelector('[data-reply-chip]');

  const canDelete = (c) => !o.readOnly && (o.isOwner || c.author.id === o.me.id);
  const canReply = (c) => !!form && !o.readOnly && c.author.id !== o.me.id && !!c.author.username;

  function setReply(c) {
    replying = c;
    if (!chip) return;
    chip.hidden = !c;
    if (c) {
      chip.querySelector('[data-reply-text]').textContent = `回覆 @${c.author.username}`;
      input.placeholder = '寫下你的回覆…';
    } else {
      input.placeholder = '說點什麼…';
    }
  }

  function paint(scrollToEnd = false) {
    countEl.textContent = comments.length ? String(comments.length) : '';
    list.innerHTML = comments.length
      ? comments.map((c) => commentHtml(c, { canDelete: canDelete(c), canReply: canReply(c), replyTo: replyTarget(comments, c) })).join('')
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
      const c = await o.actions.add(o.drawingId, body, replying?.id || null);
      comments = [...comments, c];
      setReply(null);
      input.value = '';
      refreshSend();
      paint(true);
      o.onCount?.(comments.length);
    } catch (err) {
      console.warn(err);
      if (replying && /不見了/.test(err.message || '')) setReply(null); // 要回覆的留言已經被刪掉了
      toast(err.message || '留言失敗', 'error');
    }
    setBusy(sendBtn, false);
    refreshSend();
    input.focus();
  });

  chip?.querySelector('[data-reply-cancel]').addEventListener('click', () => { setReply(null); input.focus(); });

  list.addEventListener('click', async (e) => {
    const r = e.target.closest('[data-reply-comment]');
    if (r) {
      const target = comments.find((x) => x.id === r.dataset.replyComment);
      if (target && canReply(target)) { setReply(target); input.focus(); }
      return;
    }
    const b = e.target.closest('[data-del-comment]');
    if (!b) return;
    const c = comments.find((x) => x.id === b.dataset.delComment);
    if (!c || !(await confirmDialog('刪除這則留言？', { ok: '刪除', danger: true }))) return;
    try {
      await o.actions.remove(c);
      comments = comments.filter((x) => x.id !== c.id)
        .map((x) => (x.replyTo === c.id ? { ...x, replyTo: null } : x)); // 回覆它的留言：沒有回覆對象了
      if (replying?.id === c.id) setReply(null);
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
