// 日期工具：一律以「使用者裝置的當地日期」為準（YYYY-MM-DD）

const pad = (n) => String(n).padStart(2, '0');

export function dayKey(date = new Date()) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function parseDay(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function addDays(key, n) {
  const d = parseDay(key);
  d.setDate(d.getDate() + n);
  return dayKey(d);
}

/** 每張畫在雲端分享的時間：從上傳那一刻起 24 小時（不看日期） */
export const SHARE_MS = 24 * 60 * 60 * 1000;

/** 這張畫（createdAt：毫秒或日期字串）的分享截止時間（毫秒） */
export const shareEnd = (createdAt) => new Date(createdAt).getTime() + SHARE_MS;

/** 還在分享期內嗎？ */
export const isSharing = (createdAt, now = Date.now()) => shareEnd(createdAt) > now;

/** 剩餘時間的文字：「5 小時」「40 分鐘」；已到期回傳空字串 */
export function formatRemaining(ms) {
  if (!(ms > 0)) return '';
  const mins = Math.ceil(ms / 60000);
  return mins >= 60 ? `${Math.floor(mins / 60)} 小時` : `${mins} 分鐘`;
}

export const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];
const MONTHS_EN = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

export function dayParts(key) {
  const d = parseDay(key);
  return {
    year: d.getFullYear(),
    month: d.getMonth() + 1,
    date: d.getDate(),
    monthEn: MONTHS_EN[d.getMonth()],
    weekday: `星期${WEEKDAYS[d.getDay()]}`,
  };
}

export function formatDayLong(key) {
  const p = dayParts(key);
  return `${p.year} 年 ${p.month} 月 ${p.date} 日 · ${p.weekday}`;
}

export function formatDayShort(key) {
  const p = dayParts(key);
  return `${p.month} 月 ${p.date} 日 ${p.weekday}`;
}

export function formatTime(ts) {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function monthKey(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}`;
}

/** 「剛剛」「5 分鐘前」「3 小時前」，超過一天就顯示日期（例如 3/14 09:30） */
export function formatAgo(ts, now = Date.now()) {
  const t = new Date(ts).getTime();
  if (!Number.isFinite(t)) return '';
  const mins = Math.floor((now - t) / 60000);
  if (mins < 1) return '剛剛';
  if (mins < 60) return `${mins} 分鐘前`;
  if (mins < 60 * 24) return `${Math.floor(mins / 60)} 小時前`;
  const d = new Date(t);
  return `${d.getMonth() + 1}/${d.getDate()} ${formatTime(t)}`;
}
