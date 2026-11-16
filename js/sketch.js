// 隨手畫：簡單的畫板（筆、顏色、粗細、橡皮擦、復原）

import { icon } from './icons.js';
import { openModal, confirmDialog, toast } from './ui.js';

const SIZE = 1200;
const PAPER = '#ffffff';
const COLORS = [
  { name: '墨黑', value: '#2a2622' },
  { name: '暖橘', value: '#f2994a' },
  { name: '磚紅', value: '#d9614c' },
  { name: '草綠', value: '#6aa77a' },
  { name: '天藍', value: '#5b8fc7' },
  { name: '杏黃', value: '#f2c94c' },
];
const WIDTHS = [{ name: '細', value: 5 }, { name: '中', value: 12 }, { name: '粗', value: 28 }];

export function openSketchPad() {
  return new Promise((resolve) => {
    let result = null;
    const content = `
      <div class="sketch">
        <div class="sketch-paper"><canvas width="${SIZE}" height="${SIZE}" aria-label="畫布"></canvas></div>
        <div class="sketch-tools">
          <div class="tool-group" role="radiogroup" aria-label="顏色">
            ${COLORS.map((c, i) => `<button class="swatch ${i === 0 ? 'on' : ''}" data-color="${c.value}" style="--c:${c.value}" aria-label="${c.name}" title="${c.name}"></button>`).join('')}
            <button class="tool-btn" data-eraser aria-label="橡皮擦" title="橡皮擦">${icon('eraser', 20)}</button>
          </div>
          <div class="tool-group" role="radiogroup" aria-label="粗細">
            ${WIDTHS.map((w, i) => `<button class="size-btn ${i === 1 ? 'on' : ''}" data-width="${w.value}" aria-label="${w.name}" title="${w.name}"><i style="--d:${Math.max(4, w.value / 1.6)}px"></i></button>`).join('')}
          </div>
          <div class="tool-group">
            <button class="tool-btn" data-undo aria-label="復原" title="復原">${icon('undo', 20)}</button>
            <button class="tool-btn" data-clear aria-label="清除全部" title="清除全部">${icon('trash', 20)}</button>
          </div>
        </div>
        <div class="modal-foot">
          <button class="btn" data-close>取消</button>
          <button class="btn btn-primary" data-save>${icon('check', 18)}<span>完成，放進今天</span></button>
        </div>
      </div>`;

    const strokes = [];
    let color = COLORS[0].value;
    let width = WIDTHS[1].value;
    let erasing = false;

    const m = openModal({
      title: '隨手畫',
      content,
      className: 'modal-sketch',
      beforeClose: async () => result || !strokes.length || confirmDialog('這張畫還沒放進今天，確定要離開嗎？', { ok: '離開', danger: true }),
      onClose: () => resolve(result),
    });

    const canvas = m.body.querySelector('canvas');
    const g = canvas.getContext('2d');
    g.lineCap = 'round';
    g.lineJoin = 'round';

    const paint = () => {
      g.fillStyle = PAPER;
      g.fillRect(0, 0, SIZE, SIZE);
      for (const s of strokes) drawStroke(s);
    };

    function drawStroke(s, from = 0) {
      const pts = s.points;
      g.strokeStyle = s.color;
      g.fillStyle = s.color;
      g.lineWidth = s.width;
      if (pts.length === 1) {
        g.beginPath();
        g.arc(pts[0][0], pts[0][1], s.width / 2, 0, Math.PI * 2);
        g.fill();
        return;
      }
      g.beginPath();
      const start = Math.max(1, from);
      // 用中點做二次曲線，讓線條圓滑
      const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      const p0 = start === 1 ? pts[0] : mid(pts[start - 2], pts[start - 1]);
      g.moveTo(p0[0], p0[1]);
      for (let i = start; i < pts.length; i++) {
        const m1 = mid(pts[i - 1], pts[i]);
        g.quadraticCurveTo(pts[i - 1][0], pts[i - 1][1], m1[0], m1[1]);
      }
      if (from === 0 || pts.length === 2) {
        const last = pts[pts.length - 1];
        g.lineTo(last[0], last[1]);
      }
      g.stroke();
    }

    paint();

    const toCanvas = (e) => {
      const r = canvas.getBoundingClientRect();
      return [((e.clientX - r.left) / r.width) * SIZE, ((e.clientY - r.top) / r.height) * SIZE];
    };

    let current = null;
    canvas.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 && e.pointerType === 'mouse') return;
      e.preventDefault();
      canvas.setPointerCapture(e.pointerId);
      current = { color: erasing ? PAPER : color, width: erasing ? width * 2 : width, points: [toCanvas(e)] };
      strokes.push(current);
      drawStroke(current);
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!current) return;
      const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
      const from = current.points.length;
      for (const ev of (events.length ? events : [e])) current.points.push(toCanvas(ev));
      drawStroke(current, from);
    });
    const end = () => {
      if (current && current.points.length > 1) paint(); // 收尾重畫一次，讓線條乾淨
      current = null;
    };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);

    const tools = m.body.querySelector('.sketch-tools');
    tools.addEventListener('click', async (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.color) {
        color = b.dataset.color;
        erasing = false;
        tools.querySelectorAll('.swatch, [data-eraser]').forEach((x) => x.classList.toggle('on', x === b));
      } else if (b.hasAttribute('data-eraser')) {
        erasing = true;
        tools.querySelectorAll('.swatch, [data-eraser]').forEach((x) => x.classList.toggle('on', x === b));
      } else if (b.dataset.width) {
        width = Number(b.dataset.width);
        tools.querySelectorAll('.size-btn').forEach((x) => x.classList.toggle('on', x === b));
      } else if (b.hasAttribute('data-undo')) {
        strokes.pop();
        paint();
      } else if (b.hasAttribute('data-clear')) {
        if (strokes.length && await confirmDialog('要清除整張畫布嗎？', { ok: '清除', danger: true })) {
          strokes.length = 0;
          paint();
        }
      }
    });

    m.body.querySelector('[data-save]').addEventListener('click', () => {
      if (!strokes.length) { toast('先畫點什麼吧'); return; }
      canvas.toBlob((blob) => {
        result = blob;
        m.close(true);
      }, 'image/jpeg', 0.92);
    });
  });
}
