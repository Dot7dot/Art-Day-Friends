// 「待匯入的存檔」：在登入畫面選好備份檔後，先放在 IndexedDB（可能有好幾 MB，不能用 localStorage），
// 重新整理頁面也不會不見，直到登入／註冊後匯入完成，或使用者取消為止。
// 獨立的資料庫，跟 archive.js 的日曆資料分開，才不會跟畫面上的存檔混在一起。

import { openDB, promisify, run } from './idb.js';

let dbp;
const db = () => (dbp ||= openDB('artday-pending', 1, (d) => { d.createObjectStore('pending'); }));

/** { username, drawings, notes, savedAt }：只讀很小的摘要，不用把整份備份讀出來 */
export function getPendingMeta() {
  return run(db(), 'pending', 'readonly', ({ pending }) => promisify(pending.get('meta')))
    .then((m) => m || null).catch(() => null);
}

/** 整份備份資料（App 匯出的 JSON 物件） */
export function getPendingData() {
  return run(db(), 'pending', 'readonly', ({ pending }) => promisify(pending.get('data'))).then((d) => d || null);
}

export function savePending(data, meta) {
  return run(db(), 'pending', 'readwrite', ({ pending }) => Promise.all([
    promisify(pending.put(data, 'data')),
    promisify(pending.put({ ...meta, savedAt: Date.now() }, 'meta')),
  ]));
}

export function clearPending() {
  return run(db(), 'pending', 'readwrite', ({ pending }) => promisify(pending.clear())).catch((e) => console.warn(e));
}
