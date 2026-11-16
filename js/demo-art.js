// 本機示範模式用：替示範好友每天產生一張不一樣的線條小畫（SVG）

function rng(seedStr) {
  let h = 1779033703 ^ seedStr.length;
  for (let i = 0; i < seedStr.length; i++) {
    h = Math.imul(h ^ seedStr.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const INK = '#2a2622';
const ORANGE = '#f2994a';
const SOFT = '#fbd9bd';
const GREEN = '#8cc29a';
const BLUE = '#a9c7e8';

const f = (n) => n.toFixed(1);

function hills(r) {
  const sunX = 140 + r() * 320;
  const sunY = 140 + r() * 80;
  let out = `<circle cx="${f(sunX)}" cy="${f(sunY)}" r="${f(56 + r() * 30)}" fill="${SOFT}" stroke="${ORANGE}" stroke-width="6"/>`;
  for (let k = 0; k < 3; k++) {
    const base = 360 + k * 70;
    let d = `M -10 ${base}`;
    for (let x = 0; x <= 620; x += 120) d += ` Q ${x + 60} ${f(base - 40 - r() * 70)} ${x + 120} ${f(base - r() * 20)}`;
    out += `<path d="${d} L 620 620 L -10 620 Z" fill="${k === 1 ? '#fff4ea' : '#fff'}" stroke="${INK}" stroke-width="5" stroke-linejoin="round"/>`;
  }
  for (let i = 0; i < 3; i++) {
    const x = 80 + r() * 420;
    const y = 90 + r() * 120;
    out += `<path d="M ${f(x)} ${f(y)} q 14 -14 28 0 q 14 -14 28 0" fill="none" stroke="${INK}" stroke-width="4" stroke-linecap="round"/>`;
  }
  return out;
}

function plant(r) {
  let out = `<path d="M 205 430 L 395 430 L 370 560 L 230 560 Z" fill="${SOFT}" stroke="${INK}" stroke-width="6" stroke-linejoin="round"/>
    <path d="M 190 430 L 410 430" stroke="${INK}" stroke-width="6" stroke-linecap="round"/>`;
  const stems = 3 + Math.floor(r() * 3);
  for (let i = 0; i < stems; i++) {
    const ex = 300 + (r() - 0.5) * 260;
    const ey = 120 + r() * 160;
    const cx = 300 + (r() - 0.5) * 120;
    out += `<path d="M 300 430 Q ${f(cx)} ${f((ey + 430) / 2)} ${f(ex)} ${f(ey)}" fill="none" stroke="${INK}" stroke-width="5" stroke-linecap="round"/>`;
    const angle = (r() - 0.5) * 80;
    out += `<ellipse cx="${f(ex)}" cy="${f(ey)}" rx="${f(26 + r() * 14)}" ry="${f(13 + r() * 6)}" transform="rotate(${f(angle)} ${f(ex)} ${f(ey)})" fill="${GREEN}" stroke="${INK}" stroke-width="5"/>`;
  }
  return out;
}

function teacup(r) {
  let out = `<ellipse cx="300" cy="500" rx="190" ry="34" fill="#fff" stroke="${INK}" stroke-width="6"/>
    <path d="M 160 300 L 440 300 Q 440 470 300 480 Q 160 470 160 300 Z" fill="#fff" stroke="${INK}" stroke-width="6" stroke-linejoin="round"/>
    <path d="M 440 330 Q 520 330 505 385 Q 492 425 432 410" fill="none" stroke="${INK}" stroke-width="6" stroke-linecap="round"/>
    <path d="M 175 345 Q 300 365 425 345" fill="none" stroke="${ORANGE}" stroke-width="10" stroke-linecap="round"/>`;
  for (let i = 0; i < 3; i++) {
    const x = 230 + i * 70 + (r() - 0.5) * 20;
    out += `<path d="M ${f(x)} 270 q -26 -34 0 -68 q 26 -34 0 -68" fill="none" stroke="${INK}" stroke-width="5" stroke-linecap="round" opacity=".75"/>`;
  }
  for (let i = 0; i < 5; i++) {
    out += `<circle cx="${f(200 + r() * 200)}" cy="${f(400 + r() * 50)}" r="${f(5 + r() * 6)}" fill="${ORANGE}" opacity=".55"/>`;
  }
  return out;
}

function shapes(r) {
  let out = '';
  const fills = [SOFT, BLUE, '#fff', GREEN, '#ffe9a8'];
  for (let i = 0; i < 6; i++) {
    const x = 90 + r() * 420;
    const y = 90 + r() * 420;
    const s = 40 + r() * 90;
    const fill = fills[Math.floor(r() * fills.length)];
    out += r() > 0.5
      ? `<circle cx="${f(x)}" cy="${f(y)}" r="${f(s / 2)}" fill="${fill}" stroke="${INK}" stroke-width="5"/>`
      : `<rect x="${f(x - s / 2)}" y="${f(y - s / 2)}" width="${f(s)}" height="${f(s)}" rx="${f(s / 4)}" fill="${fill}" stroke="${INK}" stroke-width="5" transform="rotate(${f((r() - 0.5) * 40)} ${f(x)} ${f(y)})"/>`;
  }
  let d = `M 40 ${f(300 + (r() - 0.5) * 200)}`;
  for (let x = 40; x < 560; x += 65) d += ` T ${x + 65} ${f(300 + (r() - 0.5) * 260)}`;
  out += `<path d="${d}" fill="none" stroke="${ORANGE}" stroke-width="7" stroke-linecap="round"/>`;
  return out;
}

const THEMES = [hills, plant, teacup, shapes];

export function demoArt(seed, themeIndex) {
  const r = rng(seed);
  const theme = THEMES[(themeIndex ?? Math.floor(r() * THEMES.length)) % THEMES.length];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 600" width="600" height="600"><rect width="600" height="600" fill="#fffdfa"/>${theme(r)}</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}
