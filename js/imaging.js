// 圖片處理：本機保存較高畫質，雲端只放壓縮過的 24 小時分享副本，縮圖給日曆用。

const LOCAL_MAX = 2048;   // 本機保存的最長邊
const CLOUD_MAX = 1080;   // 雲端副本的最長邊（好友在手機上看，夠清楚又省流量）
const THUMB_MAX = 360;    // 日曆縮圖
const CLOUD_QUALITY = 0.75;  // 雲端副本的 JPEG 品質
const CLOUD_LIMIT = 260_000; // 雲端副本 data URL 的大小上限（字元，約 190 KB）；太複雜的圖會逐步縮小直到低於它

/** 先用 <img> 讀出（已套用 EXIF 方向的）尺寸；失敗就回傳 null */
function probeSize(blob) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    const done = (v) => { URL.revokeObjectURL(url); resolve(v); };
    img.onload = () => done(img.naturalWidth && img.naturalHeight ? { w: img.naturalWidth, h: img.naturalHeight } : null);
    img.onerror = () => done(null);
    img.src = url;
  });
}

/**
 * 解碼成可以畫在 canvas 上的來源。
 * max：預期用到的最長邊。相機照片常有 12–50 MP，整張解開要吃掉上百 MB 記憶體，
 * 所以超過 max 時請瀏覽器「邊解碼邊縮小」（createImageBitmap 的 resize 選項），不行再退回完整解碼。
 */
async function decode(blob, max = Infinity) {
  if ('createImageBitmap' in window) {
    if (Number.isFinite(max)) {
      try {
        const dim = await probeSize(blob);
        if (dim && Math.max(dim.w, dim.h) > max * 1.5) {
          const s = max / Math.max(dim.w, dim.h);
          const w = Math.max(1, Math.round(dim.w * s));
          const h = Math.max(1, Math.round(dim.h * s));
          const bmp = await createImageBitmap(blob, { imageOrientation: 'from-image', resizeWidth: w, resizeHeight: h, resizeQuality: 'high' });
          // 保險：尺寸比例不符（有些瀏覽器的方向與縮放順序不同）就不用這個結果
          if (Math.abs(bmp.width / bmp.height - dim.w / dim.h) < 0.02) return bmp;
          bmp.close?.();
        }
      } catch { /* 改用完整解碼 */ }
    }
    try { return await createImageBitmap(blob, { imageOrientation: 'from-image' }); } catch { /* 改用 <img> */ }
  }
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('無法讀取這張圖片，請改用 JPG 或 PNG')); };
    img.src = url;
  });
}

const sizeOf = (src) => ({ w: src.naturalWidth || src.width, h: src.naturalHeight || src.height });

function drawScaled(src, max) {
  const { w, h } = sizeOf(src);
  const s = Math.min(1, max / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w * s));
  c.height = Math.max(1, Math.round(h * s));
  const g = c.getContext('2d');
  g.fillStyle = '#ffffff'; // 透明背景一律鋪白，像畫在白紙上
  g.fillRect(0, 0, c.width, c.height);
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = 'high';
  g.drawImage(src, 0, 0, c.width, c.height);
  return c;
}

const canvasToBlob = (c, q) => new Promise((resolve, reject) => {
  c.toBlob((b) => (b ? resolve(b) : reject(new Error('圖片轉換失敗'))), 'image/jpeg', q);
});

const release = (src) => { if (typeof src.close === 'function') src.close(); };

/** 處理一張新圖：回傳本機版、縮圖與尺寸 */
export async function processImage(blob) {
  if (blob.type && !blob.type.startsWith('image/')) throw new Error('只能上傳圖片檔');
  const src = await decode(blob, LOCAL_MAX);
  try {
    const big = drawScaled(src, LOCAL_MAX);
    const full = await canvasToBlob(big, 0.9);
    const thumb = await canvasToBlob(drawScaled(big, THUMB_MAX), 0.78);
    return { full, thumb, width: big.width, height: big.height };
  } finally { release(src); }
}

export async function makeThumb(blob) {
  const src = await decode(blob);
  try { return await canvasToBlob(drawScaled(src, THUMB_MAX), 0.78); } finally { release(src); }
}

/** 產生要上傳到雲端的壓縮副本（data URL） */
export async function cloudCopy(blob) {
  const src = await decode(blob);
  try {
    let max = CLOUD_MAX;
    let q = CLOUD_QUALITY;
    let url = '';
    for (let i = 0; i < 6; i++) {
      url = drawScaled(src, max).toDataURL('image/jpeg', q);
      if (url.length <= CLOUD_LIMIT) break;
      max = Math.round(max * 0.85);
      q = Math.max(0.5, q - 0.06);
    }
    return url;
  } finally { release(src); }
}

export function dataURLToBlob(url) {
  const [head, body] = url.split(',');
  const mime = (head.match(/data:([^;,]+)/) || [])[1] || 'application/octet-stream';
  if (/;base64/.test(head)) {
    const bin = atob(body);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: mime });
  }
  return new Blob([decodeURIComponent(body)], { type: mime });
}

const AVATAR_SIZE = 160;
const AVATAR_LIMIT = 30_000; // data URL 字元數上限（目標值，資料庫上限是 60000）

/** 大頭貼：置中裁成正方形、縮成 160×160、轉成 JPEG data URL（盡量小於 30 KB） */
export async function makeAvatar(blob) {
  if (blob.type && !blob.type.startsWith('image/')) throw new Error('只能使用圖片檔');
  const src = await decode(blob, 2048);
  try {
    const { w, h } = sizeOf(src);
    const side = Math.min(w, h);
    const c = document.createElement('canvas');
    c.width = c.height = AVATAR_SIZE;
    const g = c.getContext('2d');
    g.fillStyle = '#ffffff';
    g.fillRect(0, 0, AVATAR_SIZE, AVATAR_SIZE);
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';
    g.drawImage(src, (w - side) / 2, (h - side) / 2, side, side, 0, 0, AVATAR_SIZE, AVATAR_SIZE);
    let url = '';
    for (let q = 0.8; q >= 0.4; q -= 0.1) {
      url = c.toDataURL('image/jpeg', q);
      if (url.length <= AVATAR_LIMIT) break;
    }
    return url;
  } finally { release(src); }
}
