// 圖片處理：本機保存較高畫質，雲端只放壓縮過的「今天」副本，縮圖給日曆用。

const LOCAL_MAX = 2048;   // 本機保存的最長邊
const CLOUD_MAX = 1280;   // 雲端副本的最長邊
const THUMB_MAX = 360;    // 日曆縮圖
const CLOUD_LIMIT = 900_000; // 雲端副本 data URL 的大小上限（字元）

async function decode(blob) {
  if ('createImageBitmap' in window) {
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
  const src = await decode(blob);
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
    let q = 0.82;
    let url = '';
    for (let i = 0; i < 5; i++) {
      url = drawScaled(src, max).toDataURL('image/jpeg', q);
      if (url.length <= CLOUD_LIMIT) break;
      max = Math.round(max * 0.8);
      q = Math.max(0.5, q - 0.08);
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
