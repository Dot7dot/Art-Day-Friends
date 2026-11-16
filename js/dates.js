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

/** 該日結束（隔天 00:00）的時間點：雲端的圖會在這之後失效 */
export function endOfDay(key) {
  const d = parseDay(key);
  d.setDate(d.getDate() + 1);
  return d;
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

/** 距離今天結束還有多久，例如「7 小時 12 分」 */
export function timeLeftToday(now = new Date()) {
  const end = endOfDay(dayKey(now));
  const mins = Math.max(0, Math.ceil((end - now) / 60000));
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h > 0 ? `${h} 小時 ${m} 分` : `${m} 分鐘`;
}

export function formatTime(ts) {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function monthKey(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}`;
}
