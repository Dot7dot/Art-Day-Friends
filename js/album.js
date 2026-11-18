// 存到手機：盡量把畫放進「相簿」。
// 網頁沒有任何辦法在背景直接寫入 iOS「照片」或 Android「相簿」，所以用兩條合法的路：
//   1. 系統分享表（navigator.share 帶檔案）：iOS 選「儲存影像」就進「照片」，Android 可選相簿／檔案
//   2. 下載 JPEG：Android Chrome 會放進「下載」，相簿通常也看得到；電腦就是一般下載
// 注意：navigator.share 必須在點擊的「當下」同步呼叫（transient activation），
// 所以呼叫它之前不能有任何 await——要存的檔案請事先準備好。

import { downloadBlob } from './ui.js';

const ua = () => navigator.userAgent || '';

/** iPhone、iPod、iPad（包含偽裝成 Mac 桌面版的 iPadOS：Mac 平台 + 觸控） */
export function isIOS() {
  if (/iP(hone|od|ad)/.test(ua())) return true;
  return (navigator.platform === 'MacIntel' || /Macintosh/.test(ua())) && (navigator.maxTouchPoints || 0) > 1;
}

export const isAndroid = () => /Android/i.test(ua());

/** 手機或平板：才走分享表；電腦一律直接下載 */
export const isMobileDevice = () => isIOS() || isAndroid();

/** 已經用「加入主畫面」安裝成 App 在開啟嗎 */
export function isStandalone() {
  try {
    return window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  } catch { return navigator.standalone === true; }
}

export function canShareFiles(files) {
  try {
    return typeof navigator.share === 'function' && typeof navigator.canShare === 'function'
      && navigator.canShare({ files });
  } catch { return false; }
}

const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

/** 檔名：art-day-2026-11-18-1.jpg（同一天的第 n 張） */
export function albumName(day, n, type = 'image/jpeg') {
  return `art-day-${day}-${n}.${EXT[type] || 'jpg'}`;
}

export function toFile(blob, name) {
  const type = blob.type || 'image/jpeg';
  return new File([blob], name, { type, lastModified: Date.now() });
}

/** 一個接一個下載（每張間隔一下，瀏覽器才不會當成濫用） */
export async function downloadFiles(files, onProgress) {
  for (let i = 0; i < files.length; i++) {
    downloadBlob(files[i], files[i].name);
    onProgress?.(i + 1);
    if (i < files.length - 1) await new Promise((r) => setTimeout(r, 350));
  }
}

/**
 * 把這些檔案存到手機。必須在使用者點擊的事件裡「直接」呼叫（前面不能有 await）。
 * 回傳 Promise<'shared' | 'cancelled' | 'downloaded'>：
 *   手機且能分享 → 開系統分享表；使用者關掉分享表 = 'cancelled'（不算錯誤）
 *   電腦、或分享不能用／出錯 → 下載
 */
export function saveToAlbum(files) {
  if (isMobileDevice() && canShareFiles(files)) {
    let p;
    try {
      p = navigator.share({ files }); // 同步呼叫，保留點擊的啟動狀態
    } catch (e) {
      p = Promise.reject(e);
    }
    return p.then(() => 'shared', async (e) => {
      if (e?.name === 'AbortError') return 'cancelled';
      console.warn('share failed, falling back to download', e);
      await downloadFiles(files);
      return 'downloaded';
    });
  }
  return downloadFiles(files).then(() => 'downloaded');
}

/** 存完後該顯示的提示文字；分享成功、取消都不需要提示 */
export function savedMessage(result, n = 1) {
  if (result !== 'downloaded') return '';
  if (isAndroid()) return n > 1 ? `已下載 ${n} 張，可在相簿的「Download」或檔案 App 找到` : '已下載，可在相簿的「Download」或檔案 App 找到';
  return n > 1 ? `已下載 ${n} 張` : '已下載';
}

// ── 自動存到手機（每個帳號各自的設定）──

const autoKey = (uid) => `artday.autosave.${uid}`;

export function getAutoSave(uid) {
  try { return localStorage.getItem(autoKey(uid)) === '1'; } catch { return false; }
}

export function setAutoSave(uid, on) {
  try { localStorage.setItem(autoKey(uid), on ? '1' : '0'); } catch { /* 無痕模式存不了：只在這次有效 */ }
}

/** 第一次新增畫之後，順手請瀏覽器「不要自動清除」這個網站的資料（每台裝置只問一次） */
export async function requestPersistOnce() {
  try {
    if (localStorage.getItem('artday.persistAsked')) return;
    localStorage.setItem('artday.persistAsked', '1');
  } catch { /* 沒有 localStorage 也照樣問一次 */ }
  try {
    if (await navigator.storage?.persisted?.()) return;
    await navigator.storage?.persist?.();
  } catch { /* 瀏覽器不支援或拒絕：沒關係，「我的」裡還有手動按鈕 */ }
}
