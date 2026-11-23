// 別人的畫（好友／推薦）的裝置端快取：省下重複下載（Supabase 免費方案每月流量有限）。
//
// • 存在獨立的 IndexedDB（artday-imgcache），每張圖是一個 Blob，附上 expiresAt（雲端副本的到期時間）與 cachedAt。
// • 過了 expiresAt 就視為不存在並刪掉；超過 3 天、或總量超過上限的（最舊的先刪）在啟動／每天維護時清掉。
// • 只放「別人的」畫：自己的畫本來就完整存在本機 archive。
// • IndexedDB 不能用（無痕模式、被擋、壞掉）時一律靜默退回「直接下載」，不影響使用。
// • 記憶體層只放 Promise<Blob>：同一張圖同時被要求多次時只會下載一次。

import { openDB, promisify, run } from './idb.js';

const DB_NAME = 'artday-imgcache';
const STORE = 'images';
export const MAX_AGE_MS = 3 * 24 * 3600 * 1000;
export const MAX_BYTES = 80 * 1024 * 1024;

let dbPromise = null;
function db() {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, 1, (d) => {
      const s = d.createObjectStore(STORE, { keyPath: 'id' });
      s.createIndex('byCachedAt', 'cachedAt');
    });
    dbPromise.catch(() => { dbPromise = null; }); // 下次再試
  }
  return dbPromise;
}

const mem = new Map(); // id → Promise<Blob>

async function readEntry(id) {
  try {
    const rec = await run(db(), STORE, 'readonly', (s) => promisify(s[STORE].get(id)));
    if (!rec || !(rec.blob instanceof Blob)) return null;
    if (rec.expiresAt && Date.parse(rec.expiresAt) <= Date.now()) { remove(id); return null; }
    return rec;
  } catch { return null; }
}

async function remove(id) {
  try { await run(db(), STORE, 'readwrite', (s) => promisify(s[STORE].delete(id))); } catch { /* 忽略 */ }
}

async function store(id, blob, expiresAt) {
  try {
    await run(db(), STORE, 'readwrite', (s) => promisify(s[STORE].put({ id, blob, size: blob.size, expiresAt: expiresAt || null, cachedAt: Date.now() })));
  } catch { /* 空間不足或不能用：這張就不快取 */ }
}

/**
 * 取得一張雲端圖片的 Blob：記憶體 → IndexedDB → loader()。
 * loader 回傳 { blob, expiresAt, skipStore }；skipStore 為 true（例如自己的畫）時不寫入裝置快取。
 */
export function getImageBlob(id, loader) {
  let p = mem.get(id);
  if (p) return p;
  p = (async () => {
    const hit = await readEntry(id);
    if (hit) return hit.blob;
    const { blob, expiresAt, skipStore } = await loader();
    if (!skipStore) store(id, blob, expiresAt); // 背景寫入，不擋住畫面
    return blob;
  })();
  mem.set(id, p);
  p.catch(() => { if (mem.get(id) === p) mem.delete(id); });
  return p;
}

/** 清掉過期、太舊、超過上限的項目（最舊的先刪）。回傳刪掉幾張 */
export async function maintain({ maxAge = MAX_AGE_MS, maxBytes = MAX_BYTES } = {}) {
  try {
    const now = Date.now();
    const rows = await run(db(), STORE, 'readonly', (s) => promisify(s[STORE].getAll()));
    // getAll 會把 Blob 一起帶出來（只是參照，不會整個讀進記憶體）
    const dead = new Set();
    let live = [];
    for (const r of rows) {
      const expired = r.expiresAt && Date.parse(r.expiresAt) <= now;
      if (expired || now - (r.cachedAt || 0) > maxAge) dead.add(r.id); else live.push(r);
    }
    live.sort((a, b) => (a.cachedAt || 0) - (b.cachedAt || 0));
    let total = live.reduce((n, r) => n + (r.size || r.blob?.size || 0), 0);
    for (const r of live) {
      if (total <= maxBytes) break;
      dead.add(r.id);
      total -= r.size || r.blob?.size || 0;
    }
    if (dead.size) {
      await run(db(), STORE, 'readwrite', (s) => { for (const id of dead) s[STORE].delete(id); });
      for (const id of dead) mem.delete(id);
    }
    return dead.size;
  } catch { return 0; }
}

/** { count, bytes }；不能用時回傳 { count: 0, bytes: 0, unavailable: true } */
export async function stats() {
  try {
    const rows = await run(db(), STORE, 'readonly', (s) => promisify(s[STORE].getAll()));
    return { count: rows.length, bytes: rows.reduce((n, r) => n + (r.size || r.blob?.size || 0), 0) };
  } catch { return { count: 0, bytes: 0, unavailable: true }; }
}

export async function clear() {
  mem.clear();
  try { await run(db(), STORE, 'readwrite', (s) => promisify(s[STORE].clear())); } catch { /* 忽略 */ }
}
