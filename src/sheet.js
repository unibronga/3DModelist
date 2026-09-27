// Лист персонажа (перед / бок / спина рядом на одной картинке) → отдельные виды.
//
// Генераторы по одной картинке (Tripo P2, Trellis, Hunyuan) читают лист как
// ОДНУ сцену и лепят столько фигур, сколько на нём нарисовано (27.09: три
// Киана за $1). Модель должна быть одна: режем лист на виды, генератору —
// один вид спереди, остальные — агенту для сверки формы.
//
// Как режем: фон — цвет углов; столбец «занят», если в нём есть заметно
// отличные от фона пиксели. Подряд идущие занятые столбцы — фигура; узкие
// просветы внутри фигуры (между ногами, у рук) склеиваем.

const cache = new Map();

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('image'));
    img.src = src;
  });
}

// Возвращает { views: [dataURL…], aspect }. Меньше двух фигур — views пустой.
export async function splitSheet(src) {
  if (cache.has(src)) return cache.get(src);
  const img = await loadImage(src);
  const W = img.naturalWidth;
  const H = img.naturalHeight;
  const result = { views: [], aspect: W / H };
  // Узкая картинка — это один вид, резать нечего.
  if (W / H < 1.25) { cache.set(src, result); return result; }

  // Анализ — на уменьшенной копии, вырезка — из полной.
  const k = Math.min(1, 900 / W);
  const w = Math.max(1, Math.round(W * k));
  const h = Math.max(1, Math.round(H * k));
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(img, 0, 0, w, h);
  const d = g.getImageData(0, 0, w, h).data;

  // Фон — медиана по четырём углам.
  const corner = [];
  for (const [x0, y0] of [[0, 0], [w - 8, 0], [0, h - 8], [w - 8, h - 8]]) {
    for (let y = y0; y < y0 + 8; y++) for (let x = x0; x < x0 + 8; x++) {
      const i = (y * w + x) * 4;
      corner.push([d[i], d[i + 1], d[i + 2]]);
    }
  }
  const med = (j) => corner.map((p) => p[j]).sort((a, b) => a - b)[corner.length >> 1];
  const bg = [med(0), med(1), med(2)];
  const differs = (i) => Math.abs(d[i] - bg[0]) + Math.abs(d[i + 1] - bg[1]) + Math.abs(d[i + 2] - bg[2]) > 60;

  const col = new Float32Array(w);
  for (let x = 0; x < w; x++) {
    let n = 0;
    for (let y = 0; y < h; y++) if (differs((y * w + x) * 4)) n++;
    col[x] = n / h;
  }

  // Фигуры по столбцам; просвет уже 3% ширины — внутри фигуры.
  const busy = (x) => col[x] > 0.01;
  let runs = [];
  for (let x = 0; x < w;) {
    if (!busy(x)) { x++; continue; }
    const a = x;
    while (x < w && busy(x)) x++;
    runs.push([a, x]);
  }
  const gap = w * 0.03;
  runs = runs.reduce((acc, r) => {
    const last = acc[acc.length - 1];
    if (last && r[0] - last[1] < gap) last[1] = r[1]; else acc.push([...r]);
    return acc;
  }, []).filter(([a, b]) => b - a > w * 0.06);

  if (runs.length < 2) { cache.set(src, result); return result; }

  // Каждую фигуру — по вертикали до её содержимого, с полями, на фоне листа.
  for (const [a, b] of runs) {
    let top = h;
    let bottom = 0;
    for (let y = 0; y < h; y++) {
      for (let x = a; x < b; x++) {
        if (differs((y * w + x) * 4)) { if (y < top) top = y; if (y > bottom) bottom = y; break; }
      }
    }
    const pad = Math.round(Math.max(b - a, bottom - top) * 0.08);
    const sx = Math.max(0, a - pad) / k;
    const sy = Math.max(0, top - pad) / k;
    const sw = Math.min(w, b + pad) / k - sx;
    const sh = Math.min(h, bottom + pad) / k - sy;
    const out = document.createElement('canvas');
    out.width = Math.round(sw);
    out.height = Math.round(sh);
    const og = out.getContext('2d');
    og.fillStyle = `rgb(${bg[0]},${bg[1]},${bg[2]})`;
    og.fillRect(0, 0, out.width, out.height);
    og.drawImage(img, sx, sy, sw, sh, 0, 0, out.width, out.height);
    result.views.push(out.toDataURL('image/png'));
  }
  cache.set(src, result);
  return result;
}
