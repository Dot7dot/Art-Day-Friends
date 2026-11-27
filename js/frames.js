// 頭像外框：20 款內嵌 SVG（不用圖片檔，任何尺寸都清楚）。
//
// 每款外框畫在 100×100 的畫布上，圓心 (50, 50)；頭像照片縮在中間（半徑 37），外框畫在外圈（半徑約 35–50）。
// 畫面風格：圓圓的色塊、有點歪歪的手繪感（刻意不對稱）、扁平，沒有漸層、沒有 id（同一頁可以放很多個）。
//
// ⚠ id、價格與解鎖條件要和 supabase/schema.sql 的 frame_catalog 與 claim_frame_achievements 一致。

const rad = (d) => (d * Math.PI) / 180;
const n1 = (n) => Math.round(n * 10) / 10;
const pt = (r, deg, cx = 50, cy = 50) => [cx + r * Math.cos(rad(deg)), cy + r * Math.sin(rad(deg))];
const at = (r, deg) => pt(r, deg).map(n1).join(' ');

/** 半徑隨角度起伏的函式：base + Σ amp·sin(k·θ + phase)（θ 為角度；0° 在右邊、順時針） */
const wob = (base, parts = []) => (deg) => base + parts.reduce((s, [a, k, ph]) => s + a * Math.sin(rad(k * deg) + ph), 0);

/** 通過所有點的封閉平滑曲線（Catmull-Rom → 三次貝茲） */
function closedPath(p) {
  const n = p.length;
  let d = `M${n1(p[0][0])} ${n1(p[0][1])}`;
  for (let i = 0; i < n; i++) {
    const p0 = p[(i - 1 + n) % n];
    const p1 = p[i];
    const p2 = p[(i + 1) % n];
    const p3 = p[(i + 2) % n];
    d += `C${n1(p1[0] + (p2[0] - p0[0]) / 6)} ${n1(p1[1] + (p2[1] - p0[1]) / 6)} ${n1(p2[0] - (p3[0] - p1[0]) / 6)} ${n1(p2[1] - (p3[1] - p1[1]) / 6)} ${n1(p2[0])} ${n1(p2[1])}`;
  }
  return `${d}Z`;
}

function openPath(p) {
  const n = p.length;
  let d = `M${n1(p[0][0])} ${n1(p[0][1])}`;
  for (let i = 0; i < n - 1; i++) {
    const p0 = p[Math.max(0, i - 1)];
    const p1 = p[i];
    const p2 = p[i + 1];
    const p3 = p[Math.min(n - 1, i + 2)];
    d += `C${n1(p1[0] + (p2[0] - p0[0]) / 6)} ${n1(p1[1] + (p2[1] - p0[1]) / 6)} ${n1(p2[0] - (p3[0] - p1[0]) / 6)} ${n1(p2[1] - (p3[1] - p1[1]) / 6)} ${n1(p2[0])} ${n1(p2[1])}`;
  }
  return d;
}

/** 歪歪的圓：r 可以是數字或 (角度) => 半徑 */
function blobD(r, { n = 18, cx = 50, cy = 50 } = {}) {
  const f = typeof r === 'function' ? r : () => r;
  return closedPath(Array.from({ length: n }, (_, i) => pt(f((i * 360) / n), (i * 360) / n, cx, cy)));
}

/** 一整圈外框：外緣是歪歪的色塊，中間挖掉（露出頭像） */
function ring(fill, outer, hole = { r: 35.4, ox: 0.8, oy: -0.5 }, extra = '') {
  const h = typeof hole === 'number' ? { r: hole } : hole;
  const d = `${blobD(outer)}${blobD(h.fn || h.r, { n: 16, cx: 50 + (h.ox || 0), cy: 50 + (h.oy || 0) })}`;
  return `<path fill-rule="evenodd" fill="${fill}" d="${d}"${extra ? ` ${extra}` : ''}/>`;
}

/** 沿著圓圈畫一段圓頭粗線（像一顆顆圓圓的色塊拼起來） */
function arc(r, a0, a1, w, color, { step = 7, extra = '' } = {}) {
  const f = typeof r === 'function' ? r : () => r;
  const n = Math.max(2, Math.ceil(Math.abs(a1 - a0) / step) + 1);
  const p = Array.from({ length: n }, (_, i) => {
    const a = a0 + ((a1 - a0) * i) / (n - 1);
    return pt(f(a), a);
  });
  return `<path d="${openPath(p)}" fill="none" stroke="${color}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"${extra ? ` ${extra}` : ''}/>`;
}

const dot = (x, y, r, fill, extra = '') => `<circle cx="${n1(x)}" cy="${n1(y)}" r="${r}" fill="${fill}"${extra ? ` ${extra}` : ''}/>`;
const dotAt = (r, deg, size, fill, extra = '') => { const [x, y] = pt(r, deg); return dot(x, y, size, fill, extra); };
const ell = (x, y, rx, ry, rot, fill, extra = '') => `<ellipse cx="${n1(x)}" cy="${n1(y)}" rx="${rx}" ry="${ry}" transform="rotate(${n1(rot)} ${n1(x)} ${n1(y)})" fill="${fill}"${extra ? ` ${extra}` : ''}/>`;
const poly = (pts, fill, stroke = '', sw = 0) => `<path d="M${pts.map((p) => `${n1(p[0])} ${n1(p[1])}`).join('L')}Z" fill="${fill}"${stroke ? ` stroke="${stroke}" stroke-width="${sw}" stroke-linejoin="round"` : ''}/>`;
const line = (a, b, color, w) => `<path d="M${n1(a[0])} ${n1(a[1])}L${n1(b[0])} ${n1(b[1])}" stroke="${color}" stroke-width="${w}" stroke-linecap="round" fill="none"/>`;

function star(cx, cy, R, fill, rot = -90, points = 5) {
  const pts = [];
  for (let i = 0; i < points * 2; i++) {
    const [x, y] = pt(i % 2 ? R * 0.46 : R, rot + (i * 180) / points, cx, cy);
    pts.push([x, y]);
  }
  return poly(pts, fill, fill, 1.1);
}

function flower(x, y, size, petal, center, rot = 0) {
  let s = '';
  for (let i = 0; i < 5; i++) {
    const [px, py] = pt(size * 0.5, rot + i * 72, x, y);
    s += dot(px, py, n1(size * 0.36), petal);
  }
  return s + dot(x, y, n1(size * 0.26), center);
}

/** 一片草葉：從 (x, y) 往 deg 方向長出 len，稍微彎曲 */
function blade(x, y, deg, len, w, color, bend = 0.25) {
  const [tx, ty] = pt(len, deg, x, y);
  const [mx, my] = pt(len * 0.55, deg + bend * 60, x, y);
  const [lx, ly] = pt(w / 2, deg - 90, x, y);
  const [rx, ry] = pt(w / 2, deg + 90, x, y);
  return `<path d="M${n1(lx)} ${n1(ly)}Q${n1(mx + (lx - x))} ${n1(my + (ly - y))} ${n1(tx)} ${n1(ty)}Q${n1(mx + (rx - x))} ${n1(my + (ry - y))} ${n1(rx)} ${n1(ry)}Z" fill="${color}"/>`;
}

/** 新月：外圓（半徑 R）減掉內圓（半徑 r，圓心往 deg 方向偏 d） */
function crescent(cx, cy, R, r, d, deg, fill) {
  const a = (d * d + R * R - r * r) / (2 * d);
  const h = Math.sqrt(Math.max(0, R * R - a * a));
  const [ux, uy] = [Math.cos(rad(deg)), Math.sin(rad(deg))];
  const p1 = [cx + a * ux - h * uy, cy + a * uy + h * ux];
  const p2 = [cx + a * ux + h * uy, cy + a * uy - h * ux];
  return `<path d="M${n1(p1[0])} ${n1(p1[1])}A${R} ${R} 0 1 0 ${n1(p2[0])} ${n1(p2[1])}A${r} ${r} 0 0 1 ${n1(p1[0])} ${n1(p1[1])}Z" fill="${fill}" stroke="${fill}" stroke-width="1" stroke-linejoin="round"/>`;
}

// 小小的偽隨機（每款外框固定長一樣）
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── 20 款 ────────────────────────────────────────

/** 單色外框共用：歪歪的色塊 + 一小段淺色高光 */
function solid(color, light, outer, hole, hl) {
  return ring(color, outer, hole) + arc(wob(hl.r, [[0.8, 2, 0.4]]), hl.a0, hl.a1, 2.2, light) + dotAt(hl.r + 0.2, hl.a1 + 12, 1.1, light);
}

const FRAMES_DEF = [
  // ═══ 成就解鎖（7）═══
  {
    id: 'black', name: '黑外框', group: 'achievement', cond: '建立帳號', short: '建立帳號',
    draw: () => solid('#2D2926', '#6F655D', wob(45, [[2.4, 2, 0.6], [1.4, 3, 2.1], [0.7, 5, 1]]), { r: 35.2, ox: 0.9, oy: -0.7 }, { r: 41.6, a0: 196, a1: 262 }),
  },
  {
    id: 'white', name: '白外框', group: 'achievement', cond: '設定忘記密碼的問題', short: '設好忘記密碼的問題',
    draw: () => `<g transform="translate(1.3 1.6)">${ring('#EBDFD2', wob(44.6, [[2.3, 2, 2.2], [1.3, 3, 0.4], [0.7, 4, 1.3]]), { r: 35.2, ox: 0.9, oy: 0.4 })}</g>`
      + ring('#FFFFFF', wob(44.6, [[2.3, 2, 2.2], [1.3, 3, 0.4], [0.7, 4, 1.3]]), { r: 35.2, ox: 0.9, oy: 0.4 }, 'stroke="#D9C9B8" stroke-width="1.1" stroke-linejoin="round"'),
  },
  {
    id: 'blue', name: '藍外框', group: 'achievement', cond: '第一次成功把畫上傳到雲端', short: '第一次上傳畫到雲端',
    draw: () => solid('#5B9BE8', '#A9CCF6', wob(45.2, [[2.2, 2, 1.3], [1.3, 3, 4.1], [0.9, 5, 2]]), { r: 35.3, ox: -0.8, oy: 0.8 }, { r: 41.8, a0: 215, a1: 290 }),
  },
  {
    id: 'green', name: '綠外框', group: 'achievement', cond: '留下第一則留言', short: '留下第一則留言',
    draw: () => solid('#5DB77C', '#A8E0BA', wob(45, [[2.3, 2, 3.4], [1.2, 3, 0.9], [0.9, 4, 2.7]]), { r: 35.3, ox: 0.6, oy: 0.9 }, { r: 41.7, a0: 170, a1: 240 }),
  },
  {
    id: 'orange', name: '橘外框', group: 'achievement', cond: '使用 Art Day 超過 3 天（第 4 個不同的日子）', short: '用 Art Day 超過 3 天',
    draw: () => solid('#F29A4C', '#FFC994', wob(45.3, [[2, 2, 5.2], [1.4, 3, 1.9], [1, 5, 4]]), { r: 35.2, ox: -0.9, oy: -0.5 }, { r: 41.8, a0: 20, a1: 95 }),
  },
  {
    id: 'flowers', name: '花花外框', group: 'achievement', cond: '連續 7 天上傳畫', short: '連續 7 天上傳畫',
    draw: () => {
      let s = ring('#8FCB85', wob(43.6, [[1.4, 2, 1], [0.9, 3, 2.5]]), { r: 35.4, ox: 0.5, oy: 0.4 });
      const leaf = [[-60, 0.6], [-5, 0.7], [48, 0.6], [100, 0.7], [150, 0.6], [200, 0.7], [250, 0.6]];
      for (const [a] of leaf) { const [x, y] = pt(43, a + 0); s += ell(x, y, 4.6, 2.2, a + 90, '#5FAF68'); }
      const petals = ['#FF9EBB', '#FFE07A', '#FFFFFF', '#C9A8F5', '#FFB38A'];
      const centers = ['#FFE07A', '#F29A4C', '#F2B94B', '#FFF3A3', '#F7DA6B'];
      const fl = [[-90, 8.8], [-38, 7.2], [12, 8.4], [62, 7.4], [112, 8.8], [160, 7.2], [208, 8.2], [254, 7]];
      fl.forEach(([a, sz], i) => {
        const [x, y] = pt(43.2, a);
        s += flower(x, y, sz, petals[i % petals.length], centers[i % centers.length], a * 1.7);
      });
      return s;
    },
  },
  {
    id: 'grass', name: '草草外框', group: 'achievement', cond: '連續 7 天在別人的畫上留言', short: '連續 7 天幫朋友的畫留言',
    draw: () => {
      let s = ring('#A9DB8E', wob(42.6, [[1.3, 2, 2], [0.9, 3, 0.7]]), { r: 35.4, ox: -0.5, oy: 0.4 });
      const r = rng(7);
      const cols = ['#5DAE5B', '#7CC46B', '#9ED77E'];
      const tufts = [-95, -62, -28, 8, 42, 78, 112, 146, 181, 214, 247];
      tufts.forEach((a, i) => {
        const [x, y] = pt(40.6, a);
        const bl = 3 + (i % 2);
        for (let k = 0; k < bl; k++) {
          const tilt = (k - (bl - 1) / 2) * 24 + (r() - 0.5) * 14;
          s += blade(x, y, a + tilt, 8.2 + r() * 3.6 + (k === 1 ? 1.6 : 0), 3.4, cols[(i + k) % 3], k % 2 ? 0.3 : -0.3);
        }
      });
      s += flower(...pt(44.4, 24), 5.2, '#FFFFFF', '#FFD84D');
      s += flower(...pt(44.4, 197), 4.6, '#FFFFFF', '#FFD84D');
      return s;
    },
  },

  // ═══ ❤ 3（3 款）═══
  {
    id: 'peach', name: '蜜桃', group: 'shop', price: 3,
    draw: () => {
      const rr = wob(42.4, [[1.2, 2, 0.5], [0.8, 3, 2]]);
      let s = ring('#FFEADF', wob(44.2, [[1.2, 2, 0.5], [0.8, 3, 2]]), { r: 35.4, ox: 0.4, oy: 0.3 });
      [['#FFC9B3', -70, 10], ['#FFE3D6', 14, 92], ['#FFB29A', 100, 178], ['#FFD5C2', 170, 250], ['#FFBDA4', 235, 295]]
        .forEach(([c, a0, a1], i) => { s += arc(rr, a0 + 6, a1 - 6, 11.6 - (i % 2) * 1.6, c); });
      s += ell(...pt(44, -92), 5.2, 2.5, -20, '#7CC47B') + ell(...pt(45, -70), 4.4, 2.2, 30, '#5FAE62');
      s += dotAt(41.8, 130, 1.3, '#fff', 'fill-opacity=".8"') + dotAt(41.5, 305, 1.3, '#fff', 'fill-opacity=".8"');
      return s;
    },
  },
  {
    id: 'mint', name: '薄荷', group: 'shop', price: 3,
    draw: () => {
      let s = ring('#BDEBDC', wob(45.4, [[1.8, 2, 4], [1.1, 3, 1.4], [0.7, 5, 3]]), { r: 35.4, ox: -0.6, oy: 0.6 });
      s += arc(wob(41, [[0.9, 3, 1]]), 20, 150, 7, '#8EDDC3') + arc(wob(41.4, [[0.8, 2, 2]]), 215, 300, 6, '#8EDDC3');
      const r = rng(11);
      for (let i = 0; i < 9; i++) s += dotAt(41 + (r() - 0.5) * 6, i * 40 + r() * 20, 1.2 + r() * 0.9, '#fff', 'fill-opacity=".92"');
      s += ell(...pt(46, -100), 4.6, 2.4, -62, '#59C3A0') + ell(...pt(46, -78), 4.6, 2.4, 62, '#7BD3B4');
      return s;
    },
  },
  {
    id: 'milktea', name: '奶茶', group: 'shop', price: 3,
    draw: () => {
      let s = ring('#DDBFA2', wob(45.6, [[1.6, 2, 0.8], [1.3, 3, 3.2], [0.7, 4, 1]]), { r: 35.4, ox: 0.7, oy: 0.5 });
      s += arc(wob(41.2, [[1.6, 6, 0.4]]), -40, 130, 3.4, '#F6EADD') + arc(wob(41.5, [[1.5, 5, 1]]), 175, 262, 3, '#F6EADD');
      const pearls = [[36, 7], [64, 8.6], [88, 7.4]];
      pearls.forEach(([a]) => { const [x, y] = pt(41.4, a + 62); s += dot(x, y, 2.9, '#6B4631') + dot(x - 0.8, y - 0.9, 0.9, '#B38A6C'); });
      s += dotAt(41.6, 205, 2.6, '#6B4631') + dotAt(41.6, -122, 2.4, '#6B4631');
      return s;
    },
  },

  // ═══ ❤ 10（5 款）═══
  {
    id: 'rainbow', name: '彩虹拼接', group: 'shop', price: 10,
    draw: () => {
      const cols = ['#F2686C', '#F8A24E', '#F7D457', '#7CCB7B', '#5BB5E9', '#7D86EA', '#B880E2'];
      const rr = wob(42.3, [[1.3, 2, 0.4], [0.9, 3, 2.2]]);
      return cols.map((c, i) => arc(rr, -100 + i * 51.4 + 3, -100 + (i + 1) * 51.4 + 4, 11.8 - (i % 3) * 0.7, c)).join('');
    },
  },
  {
    id: 'sunset', name: '夕陽', group: 'shop', price: 10,
    draw: () => {
      const rr = wob(42.4, [[1.2, 2, 1.6], [0.8, 3, 0.2]]);
      let s = arc(rr, 150, 232, 11.6, '#B461B8') + arc(rr, 80, 168, 11.6, '#F0627F') + arc(rr, 8, 98, 12, '#FF985F');
      s += arc(rr, -62, 24, 11.8, '#FFC663') + arc(rr, -150, -48, 11.2, '#FFE08C');
      const [sx, sy] = pt(43.6, -52);
      s += dot(sx, sy, 7, '#FFF4C2', 'stroke="#FFB84D" stroke-width="1.6"') + dot(sx, sy, 3.3, '#FFD36E');
      s += line(pt(41, 200), pt(44, 212), '#FFE9C6', 1.6) + line(pt(40.5, 122), pt(43.4, 136), '#FFD1B8', 1.5);
      return s;
    },
  },
  {
    id: 'waves', name: '海浪', group: 'shop', price: 10,
    draw: () => {
      let s = ring('#58AEE8', wob(45.4, [[1.6, 2, 0.5], [1.2, 3, 2.4], [0.7, 5, 0.8]]), { r: 35.4, ox: 0.5, oy: -0.5 });
      s += arc(wob(38.8, [[0.6, 3, 1]]), 95, 235, 4.2, '#3D8DD2') + arc(wob(40.6, [[0.6, 2, 2]]), 270, 350, 4.4, '#3D8DD2');
      const wave = (r0, a0, a1, amp, k, ph, w) => arc((a) => r0 + amp * Math.sin(rad(a * k) + ph), a0, a1, w, '#FFFFFF', { step: 3 });
      s += wave(42.8, -150, -20, 1.8, 11, 0, 1.7) + wave(42.2, 18, 135, 1.8, 11, 1.3, 1.7) + wave(42.6, 170, 260, 1.7, 11, 2.2, 1.6);
      s += dotAt(46.6, -10, 1.4, '#fff') + dotAt(47, 148, 1.2, '#fff') + dotAt(45.6, 292, 1.5, '#fff') + dotAt(39.2, 62, 1, '#DFF1FF');
      return s;
    },
  },
  {
    id: 'lemon', name: '檸檬汽水', group: 'shop', price: 10,
    draw: () => {
      let s = ring('#FFE46B', wob(45.2, [[1.8, 2, 3.1], [1.1, 3, 0.4], [0.7, 4, 2]]), { r: 35.4, ox: -0.6, oy: -0.5 });
      s += arc(wob(41.2, [[0.9, 3, 1]]), 100, 190, 6, '#FFF1A3') + arc(wob(41.6, [[0.9, 2, 0.5]]), 260, 330, 5, '#FFF1A3');
      const bub = [[-112, 43.4, 3.1], [-92, 47, 1.9], [-20, 44, 2.4], [160, 44.4, 2.9], [205, 42.4, 1.8], [128, 47, 1.6], [286, 46.6, 2.2]];
      bub.forEach(([a, r, sz]) => { const [x, y] = pt(r, a); s += dot(x, y, sz, '#FFFFFF', 'fill-opacity=".85" stroke="#F5C531" stroke-width=".9"') + dot(x - sz * 0.3, y - sz * 0.3, n1(sz * 0.22), '#fff'); });
      // 檸檬片
      const [lx, ly] = pt(42.6, 48);
      s += dot(lx, ly, 8.2, '#FFD23F', 'stroke="#F2B71D" stroke-width="1"') + dot(lx, ly, 6.4, '#FFF4B5');
      for (let i = 0; i < 6; i++) s += line(pt(0.8, i * 60, lx, ly), pt(5.7, i * 60, lx, ly), '#FFD23F', 1.1);
      s += dot(lx, ly, 1.3, '#FFD23F');
      return s;
    },
  },
  {
    id: 'purple', name: '紫色塗鴉', group: 'shop', price: 10,
    draw: () => {
      // 像用麥克筆亂塗的一圈：很粗、很不均勻，起筆和收筆還有點重疊
      let s = ring('#B28DFF', (a) => 44.6 + 4.6 * Math.sin(rad(a * 2) + 0.4) + 2 * Math.sin(rad(a * 3) + 2.6) + 1 * Math.sin(rad(a * 7) + 1),
        { fn: (a) => 34.2 + 1.4 * Math.sin(rad(a * 2) + 1.6) + 0.9 * Math.sin(rad(a * 3) + 4.2), ox: 1.2, oy: 0.4 });
      s += arc((a) => 41.4 + (a + 150) * 0.012 + 1.6 * Math.sin(rad(a * 2)), -150, 118, 5.6, '#C7A9FF', { step: 8 });
      s += arc((a) => 41.8 + 0.9 * Math.sin(rad(a * 3)), 168, 306, 3, '#9C73F0', { step: 8 });
      return s;
    },
  },

  // ═══ ❤ 30（5 款）═══
  {
    id: 'palette', name: '調色盤', group: 'shop', price: 30,
    draw: () => {
      let s = ring('#F3D7A9', (a) => 44.6 + 2.6 * Math.sin(rad(a * 2) + 3.6) + 1.5 * Math.sin(rad(a * 3) + 0.6) + 0.8 * Math.sin(rad(a * 6)), { r: 35.4, ox: 0.6, oy: -0.4 });
      s += arc(wob(38.6, [[0.6, 3, 1]]), 190, 250, 2.6, '#E6BE82');
      const dabs = [[-98, '#EA574D', 4.2, 3.4], [-52, '#F8C945', 3.6, 4.2], [-6, '#4C93E6', 4.2, 3.4], [38, '#52B96B', 3.4, 4], [150, '#9B6FE0', 4, 3.2], [196, '#FFFFFF', 3.8, 3.4], [244, '#F28DB0', 3.4, 3.8]];
      dabs.forEach(([a, c, rx, ry]) => {
        const [x, y] = pt(41.6, a);
        s += ell(x, y, rx, ry, a * 0.8, c, c === '#FFFFFF' ? 'stroke="#E6CFA4" stroke-width=".8"' : '');
      });
      // 畫筆
      s += `<g transform="translate(66.5 66.5) rotate(45)">
        <rect x="14" y="-2.5" width="22" height="5" rx="2.5" fill="#C98A52"/>
        <rect x="8.5" y="-2.8" width="7" height="5.6" rx="1.2" fill="#C7CDD6"/>
        <path d="M-1 0C1.5-2.8 5-3 9-2.8V2.8C5 3 1.5 2.8-1 0Z" fill="#3F7FDB"/></g>`;
      return s;
    },
  },
  {
    id: 'donut', name: '甜甜圈', group: 'shop', price: 30,
    draw: () => {
      let s = ring('#EEB878', wob(47.4, [[1.2, 2, 0.4], [0.9, 3, 2.1]]), { r: 35.2, ox: 0.5, oy: 0.4 });
      s += ring('#FF9EC0', (a) => 44.6 + 1.5 * Math.sin(rad(a * 2) + 1) + 2 * Math.sin(rad(a * 7) + 0.3) + 1.1 * Math.sin(rad(a * 11)), { r: 36.4, ox: 0.3, oy: 0.2 });
      const r = rng(5);
      const cols = ['#FFFFFF', '#FFE16B', '#7ED6A8', '#6EC1F5', '#B58CF5', '#FF6F6F'];
      for (let i = 0; i < 17; i++) {
        const a = i * 21.2 + r() * 8;
        const [x, y] = pt(37.8 + r() * 5.6, a);
        const o = r() * 180;
        s += line(pt(-1.5, o, x, y), pt(1.5, o, x, y), cols[i % cols.length], 1.8);
      }
      return s;
    },
  },
  {
    id: 'cat', name: '貓耳', group: 'shop', price: 30,
    draw: () => {
      const col = '#F6B574';
      let s = '';
      for (const sd of [-1, 1]) {
        const c = sd < 0 ? -128 : -52;
        const base1 = pt(41, c - sd * 17);
        const base2 = pt(41, c + sd * 17);
        const tip = pt(50.6, c - sd * 1);
        s += poly([base1, tip, base2], col, col, 3.4);
        s += poly([pt(40.6, c - sd * 10), pt(47.2, c - sd * 1), pt(40.6, c + sd * 9)], '#FFB4C2', '#FFB4C2', 1.6);
      }
      s += ring(col, wob(45, [[1.7, 2, 0.4], [1.1, 3, 2.9], [0.7, 5, 1]]), { r: 35.3, ox: 0.5, oy: 0.4 });
      for (const [a, sd] of [[172, 1], [188, 1], [8, -1], [-8, -1]]) s += line(pt(38.6, a), pt(43.4, a), '#E58F57', 1.7);
      // 肉球
      const [px, py] = pt(41.6, 90);
      s += dot(px, py, 2.9, '#E58F57') + dot(px - 4.2, py - 1.6, 1.3, '#E58F57') + dot(px + 4.2, py - 1.6, 1.3, '#E58F57')
        + dot(px - 1.7, py - 4, 1.2, '#E58F57') + dot(px + 1.7, py - 4, 1.2, '#E58F57');
      return s;
    },
  },
  {
    id: 'starry', name: '星空', group: 'shop', price: 30,
    draw: () => {
      let s = ring('#2E3A75', wob(45.4, [[1.7, 2, 2], [1.1, 3, 0.4], [0.7, 5, 2.5]]), { r: 35.4, ox: -0.5, oy: 0.5 });
      s += arc(wob(41, [[1, 3, 1]]), 120, 215, 6, '#44539A') + arc(wob(41.4, [[0.9, 2, 1.5]]), 285, 20, 5, '#44539A');
      s += star(...pt(42.2, 160), 4.6, '#FFE27A') + star(...pt(41.6, 75), 3.6, '#FFF0A8', -80) + star(...pt(42.2, 250), 4.2, '#FFE27A', -100)
        + star(...pt(41.8, 330), 3.4, '#FFF0A8', -95);
      s += dotAt(44.6, 112, 1, '#fff') + dotAt(39.6, 205, 0.9, '#fff') + dotAt(44.4, 296, 1, '#fff') + dotAt(38.6, 40, 0.9, '#fff') + dotAt(45.4, 12, 0.9, '#fff');
      const [mx, my] = pt(44, -48);
      s += crescent(mx, my, 7.2, 6, 3.6, -48, '#FFE27A');
      return s;
    },
  },
  {
    id: 'crown', name: '王冠', group: 'shop', price: 30,
    draw: () => {
      // 草草外框的金色版：一圈尖尖的葉冠 + 高光（只用實心形狀，不用漸層 id）
      const edge = '#C99A1E';
      let s = ring('#F2C94C', wob(42.6, [[1.1, 2, 2], [0.7, 3, 0.7]]), { r: 35.4, ox: -0.5, oy: 0.4 }, `stroke="${edge}" stroke-width=".9" stroke-linejoin="round"`);
      const r = rng(21);
      const cols = ['#E9B52F', '#F2C94C', '#F8DB75'];
      let blades = '';
      let glints = '';
      const tufts = [-90, -60, -30, 0, 30, 60, 90, 120, 150, 180, 210, 240];
      tufts.forEach((a, i) => {
        const [x, y] = pt(40.6, a);
        const bl = 3;
        for (let k = 0; k < bl; k++) {
          const tilt = (k - 1) * 27 + (r() - 0.5) * 5;
          const len = (k === 1 ? 12.4 : 9.4) + r() * 1.2;
          blades += blade(x, y, a + tilt, len, 5, cols[(i + k) % 3], (k - 1) * 0.12);
          // 左上方的尖尖上一小道反光
          const up = Math.cos(rad(a + tilt - 225));
          if (up > 0.55 && k % 2 === 0) {
            const [bx, by] = pt(len * 0.3, a + tilt, x, y);
            const [tx, ty] = pt(len * 0.68, a + tilt - 3, x, y);
            glints += `<path d="M${n1(bx)} ${n1(by)}L${n1(tx)} ${n1(ty)}" stroke="#FFF9D6" stroke-width="1.1" stroke-linecap="round" fill="none"/>`;
          }
        }
      });
      s += `<g stroke="${edge}" stroke-width=".5" stroke-linejoin="round">${blades}</g>`;
      // 環上的反光：左上一道長的、旁邊一小段，右下一點暗金
      s += arc(41.2, 188, 262, 2.6, '#FFF6C8', { extra: 'stroke-opacity=".95"' });
      s += arc(41.2, 270, 292, 2.2, '#FFFFFF');
      s += arc(41.4, 20, 70, 2.2, '#D9A521', { extra: 'stroke-opacity=".8"' });
      s += arc(41.4, 122, 160, 2.2, '#D9A521', { extra: 'stroke-opacity=".8"' });
      s += glints;
      s += dotAt(41.2, 178, 1.2, '#FFFFFF') + dotAt(41.2, 300, 1, '#FFFFFF') + dotAt(41, 40, 0.9, '#FFF6C8');
      s += star(...pt(45.4, 225), 4.6, '#FFFFFF', -90, 4) + star(...pt(45, 15), 3.4, '#FFFDE8', -90, 4);
      return s;
    },
  },
];

/** 每款外框：{ id, name, group('achievement'|'shop'), price, cond, short, draw } */
export const FRAMES = FRAMES_DEF.map((f) => ({ price: 0, cond: '', short: '', ...f }));
const BY_ID = new Map(FRAMES.map((f) => [f.id, f]));

export const getFrame = (id) => BY_ID.get(id) || null;
export const isFrameId = (id) => BY_ID.has(id);
export const ACHIEVEMENT_FRAMES = FRAMES.filter((f) => f.group === 'achievement');
export const SHOP_FRAMES = FRAMES.filter((f) => f.group === 'shop');

const cache = new Map();
/** 外框的 SVG 字串（放在頭像外圈，pointer-events 關掉）；不認得的 id 回傳空字串 */
export function frameSvg(id) {
  const f = BY_ID.get(id);
  if (!f) return '';
  if (!cache.has(id)) cache.set(id, `<svg class="frame-ring" viewBox="0 0 100 100" aria-hidden="true" focusable="false">${f.draw()}</svg>`);
  return cache.get(id);
}

/** 頭像照片（內圈）佔外框尺寸的比例：外圈 13% 留給外框 */
export const FRAME_INNER = 0.74;
