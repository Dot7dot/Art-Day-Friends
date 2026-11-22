// 本機日曆存檔：所有的畫與文字記錄都永久存在這台裝置的 IndexedDB。
// 雲端只放「今天」的副本，這裡才是你真正的藝術日曆。

import { openDB, promisify, run } from './idb.js';

let dbp;
function db() {
  dbp ||= openDB('artday-archive', 2, (d, oldVersion) => {
    if (oldVersion < 1) {
      const drawings = d.createObjectStore('drawings', { keyPath: 'id' });
      drawings.createIndex('byUserDay', ['userId', 'day']);
      d.createObjectStore('notes', { keyPath: ['userId', 'day'] });
    }
    if (oldVersion < 2) {
      // 好友留在我的畫上的留言（雲端永久保存，這裡留一份，離線也看得到）
      const comments = d.createObjectStore('comments', { keyPath: 'id' });
      comments.createIndex('byDrawing', 'drawingId');
      comments.createIndex('byUserDay', ['userId', 'day']);
    }
  });
  return dbp;
}

const LOW = '0000-00-00';
const HIGH = '9999-99-99';
const range = (userId, from = LOW, to = HIGH) => IDBKeyRange.bound([userId, from], [userId, to]);
const byCreated = (a, b) => a.createdAt - b.createdAt;

// ── 圖片 ─────────────────────────────────────────

export function putDrawing(rec) {
  return run(db(), 'drawings', 'readwrite', ({ drawings }) => promisify(drawings.put(rec)));
}

export function getDrawing(id) {
  return run(db(), 'drawings', 'readonly', ({ drawings }) => promisify(drawings.get(id)));
}

export function deleteDrawing(id) {
  return run(db(), 'drawings', 'readwrite', ({ drawings }) => promisify(drawings.delete(id)));
}

export async function drawingsOfDay(userId, day) {
  const list = await drawingsInRange(userId, day, day);
  return list.sort(byCreated);
}

export function drawingsInRange(userId, from, to) {
  return run(db(), 'drawings', 'readonly', ({ drawings }) =>
    promisify(drawings.index('byUserDay').getAll(range(userId, from, to))));
}

/** 更新符合條件的圖片（例如把過去的「已同步」標記成「只在本機」） */
export function updateDrawings(userId, filter, patch) {
  return run(db(), 'drawings', 'readwrite', ({ drawings }) => new Promise((resolve, reject) => {
    let n = 0;
    const req = drawings.index('byUserDay').openCursor(range(userId));
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const cur = req.result;
      if (!cur) return resolve(n);
      if (filter(cur.value)) { cur.update({ ...cur.value, ...patch(cur.value) }); n++; }
      cur.continue();
    };
  }));
}

// ── 文字記錄 ─────────────────────────────────────

export async function getNote(userId, day) {
  const rec = await run(db(), 'notes', 'readonly', ({ notes }) => promisify(notes.get([userId, day])));
  return rec ? rec.text : '';
}

export function putNote(userId, day, text) {
  return run(db(), 'notes', 'readwrite', ({ notes }) => promisify(
    text.trim() ? notes.put({ userId, day, text, updatedAt: Date.now() }) : notes.delete([userId, day]),
  ));
}

export function notesInRange(userId, from, to) {
  return run(db(), 'notes', 'readonly', ({ notes }) => promisify(notes.getAll(range(userId, from, to))));
}

// ── 留言（別人留在「我的畫」上的字）──────────────────

const plainComment = (userId, c) => ({
  id: c.id, drawingId: c.drawingId, userId, day: c.day, author: c.author, body: c.body, createdAt: c.createdAt, replyTo: c.replyTo || null,
});

/** 以雲端最新的結果覆蓋這些畫的留言快取（雲端已刪除的留言也會從快取消失） */
export function replaceComments(userId, drawingIds, comments) {
  return run(db(), 'comments', 'readwrite', async ({ comments: store }) => {
    const ids = new Set(drawingIds);
    for (const id of ids) {
      const keys = await promisify(store.index('byDrawing').getAllKeys(id));
      keys.forEach((k) => store.delete(k));
    }
    for (const c of comments) if (ids.has(c.drawingId)) store.put(plainComment(userId, c));
  });
}

export function putComment(userId, comment) {
  return run(db(), 'comments', 'readwrite', ({ comments }) => promisify(comments.put(plainComment(userId, comment))));
}

export function deleteComment(id) {
  return run(db(), 'comments', 'readwrite', ({ comments }) => promisify(comments.delete(id)));
}

/** 這些畫的本機留言快取，依時間排序 */
export function commentsOfDrawings(drawingIds) {
  return run(db(), 'comments', 'readonly', async ({ comments }) => {
    const lists = await Promise.all(drawingIds.map((id) => promisify(comments.index('byDrawing').getAll(id))));
    return lists.flat().sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  });
}

export function commentsInRange(userId, from, to) {
  return run(db(), 'comments', 'readonly', ({ comments }) =>
    promisify(comments.index('byUserDay').getAll(range(userId, from, to))));
}

// ── 統計 ─────────────────────────────────────────

/** 回傳 { drawingDays:Set, noteDays:Set, drawingCount } */
export function activity(userId) {
  return run(db(), ['drawings', 'notes'], 'readonly', ({ drawings, notes }) => Promise.all([
    new Promise((resolve, reject) => {
      const days = new Set();
      let count = 0;
      const req = drawings.index('byUserDay').openKeyCursor(range(userId));
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const cur = req.result;
        if (!cur) return resolve({ days, count });
        days.add(cur.key[1]);
        count++;
        cur.continue();
      };
    }),
    promisify(notes.getAllKeys(range(userId))),
  ]).then(([d, noteKeys]) => ({
    drawingDays: d.days,
    drawingCount: d.count,
    noteDays: new Set(noteKeys.map((k) => k[1])),
  })));
}

// ── 備份 ─────────────────────────────────────────

const blobToDataURL = (blob) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(r.result);
  r.onerror = () => reject(r.error);
  r.readAsDataURL(blob);
});

export async function exportArchive(user) {
  const [drawings, notes, comments] = await Promise.all([
    drawingsInRange(user.id, LOW, HIGH),
    notesInRange(user.id, LOW, HIGH),
    commentsInRange(user.id, LOW, HIGH),
  ]);
  drawings.sort(byCreated);
  const out = [];
  for (const d of drawings) {
    out.push({
      id: d.id, day: d.day, createdAt: d.createdAt, width: d.width, height: d.height,
      source: d.source || 'upload', image: await blobToDataURL(d.blob),
    });
  }
  return {
    app: 'art-day', version: 1, exportedAt: new Date().toISOString(),
    username: user.username,
    notes: notes.map((n) => ({ day: n.day, text: n.text, updatedAt: n.updatedAt })),
    comments: comments.map((c) => ({ id: c.id, drawingId: c.drawingId, day: c.day, author: c.author, body: c.body, createdAt: c.createdAt })),
    drawings: out,
  };
}

/** 匯入備份；makeThumb(blob) 用來重新產生縮圖。回傳新增的張數 */
export async function importArchive(userId, data, { makeThumb, dataURLToBlob }) {
  if (!data || data.app !== 'art-day' || !Array.isArray(data.drawings)) {
    throw new Error('這不是 Art Day 的備份檔');
  }
  let added = 0;
  for (const d of data.drawings) {
    if (!d.id || !/^\d{4}-\d{2}-\d{2}$/.test(d.day) || typeof d.image !== 'string') continue;
    const existing = await getDrawing(d.id);
    if (existing) continue;
    const blob = dataURLToBlob(d.image);
    await putDrawing({
      id: d.id, userId, day: d.day, blob, thumb: await makeThumb(blob),
      width: d.width, height: d.height, createdAt: d.createdAt || Date.now(),
      source: d.source || 'upload', cloud: 'local',
    });
    added++;
  }
  for (const n of data.notes || []) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(n.day) || typeof n.text !== 'string') continue;
    const current = await getNote(userId, n.day);
    if (!current) await putNote(userId, n.day, n.text);
  }
  for (const c of data.comments || []) {
    if (!c.id || !c.drawingId || !/^\d{4}-\d{2}-\d{2}$/.test(c.day) || typeof c.body !== 'string' || !c.author) continue;
    await putComment(userId, { ...c, body: c.body.slice(0, 200) });
  }
  return added;
}
