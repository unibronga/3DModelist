// Генераторы формы через очередь fal.ai. ПЛАТНО — запускается только кнопкой
// человека, цена показана до нажатия.
//
// 🔴 Одна кнопка = одна генерация. request_id сохраняется в задаче сразу после
// отправки: перезапуск сервера продолжает ждать тот же запрос, а не шлёт новый.

import fs from 'node:fs';
import path from 'node:path';
import { ws, addEvent, patchTask, loadTask } from './store.mjs';
import { load as settings } from './settings.mjs';

// Цены — со страниц fal и счёта (см. скил fal-generate); get_pricing врёт.
// `detail` — один регулятор «сколько граней»: у каждого генератора своё поле.
export const GENERATORS = [
  {
    id: 'tripo3d/p2/image-to-3d', label: 'Tripo P2', tag: 'персонажи, чистая квад-сетка',
    price: (o) => (o.texture ? 1.10 : 1.00),
    detail: { min: 500, max: 25000, def: 3500, unit: 'граней' },
    input: (img, o) => ({
      image_url: img, quad: true, face_limit: o.detail, texture: !!o.texture, pbr: false,
      texture_quality: 'standard',
    }),
  },
  {
    id: 'fal-ai/trellis-2', label: 'Trellis 2', tag: 'органика, стилизация',
    price: () => 0.30,
    detail: { min: 5000, max: 200000, def: 20000, unit: 'вершин' },
    input: (img, o) => ({
      image_url: img, decimation_target: o.detail, texture_size: 1024, remesh: true,
    }),
  },
  {
    id: 'fal-ai/hunyuan-3d/v3.1/rapid/image-to-3d', label: 'Hunyuan 3.1 Rapid', tag: 'быстрый черновик',
    price: () => 0.225,
    detail: null,
    input: (img, o) => ({ input_image_url: img, enable_geometry: !o.texture }),
  },
];

export const genById = (id) => GENERATORS.find((g) => g.id === id);

// Ключ: из настроек; запасные — переменная FAL_KEY и .mcp.json рабочей папки
// (так он лежит у тех, кто уже работал с fal из Claude Code).
export function falKey() {
  const k = settings().fal.key;
  if (k) return k;
  if (process.env.FAL_KEY) return process.env.FAL_KEY;
  if (!ws()) return null;
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(ws(), '.mcp.json'), 'utf8'));
    const h = cfg.mcpServers?.['fal-ai']?.headers?.Authorization || '';
    return h.replace(/^(Bearer|Key)\s+/i, '').trim() || null;
  } catch { return null; }
}

export const falKeySource = () => (settings().fal.key ? 'settings' : process.env.FAL_KEY ? 'env' : falKey() ? 'mcp.json' : null);

// Проверка ключа без денег: статус несуществующего запроса. 404 — ключ
// принят, 401/403 — нет.
export async function testFal() {
  const key = falKey();
  if (!key) return { ok: false, error: 'ключ fal.ai не задан' };
  try {
    const r = await fetch('https://queue.fal.run/fal-ai/trellis-2/requests/00000000-0000-0000-0000-000000000000/status',
      { headers: { Authorization: `Key ${key}` } });
    if (r.status === 401 || r.status === 403) return { ok: false, error: 'fal.ai не принял ключ' };
    return { ok: true, source: falKeySource() };
  } catch (e) {
    return { ok: false, error: 'нет связи с fal.ai: ' + e.message };
  }
}

const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };

function dataUri(rel) {
  const abs = path.join(ws(), rel);
  const ext = path.extname(abs).toLowerCase();
  return `data:${MIME[ext] || 'image/png'};base64,${fs.readFileSync(abs).toString('base64')}`;
}

async function falFetch(url, opts = {}) {
  const key = falKey();
  if (!key) throw new Error('нет ключа fal.ai — Настройки ▸ fal.ai');
  const r = await fetch(url, {
    ...opts,
    headers: { Authorization: `Key ${key}`, 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  const text = await r.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { raw: text }; }
  if (!r.ok) {
    const d = body.detail;
    const msg = Array.isArray(d) ? d.map((x) => x.msg || JSON.stringify(x)).join('; ') : (d || body.raw || r.statusText);
    const err = new Error(`fal ${r.status}: ${String(msg).slice(0, 300)}`);
    err.status = r.status;
    throw err;
  }
  return body;
}

// Отправить генерацию. Возвращает сразу; ожидание идёт в фоне.
export async function submit(id, { model, texture, detail, ref }) {
  const g = genById(model);
  if (!g) throw new Error('неизвестный генератор');
  const task = loadTask(id);
  if (!task) throw new Error('нет такой задачи');
  if (task.gen?.state === 'queued' || task.gen?.state === 'running') throw new Error('генерация уже идёт');
  const refRel = ref || task.refs?.[0];
  if (!refRel) throw new Error('нет референса для генератора');

  const opts = { texture: !!texture, detail: g.detail ? Math.round(Math.min(g.detail.max, Math.max(g.detail.min, Number(detail) || g.detail.def))) : null };
  const price = g.price(opts);
  const q = await falFetch(`https://queue.fal.run/${g.id}`, {
    method: 'POST', body: JSON.stringify(g.input(dataUri(refRel), opts)),
  });
  patchTask(id, (t) => {
    t.gen = {
      state: 'queued', model: g.id, label: g.label, opts, ref: refRel, price,
      request_id: q.request_id, status_url: q.status_url, response_url: q.response_url,
      started_at: Date.now() / 1000, files: [],
    };
    t.spent_usd = (t.spent_usd || 0) + price;
  });
  addEvent(id, { kind: 'gen', text: `Генерация ${g.label} отправлена (≈ $${price.toFixed(2)}).` });
  watch(id);
}

const watching = new Set();

// Ждать результат запроса, записанного в задаче. Безопасно звать повторно.
export async function watch(id) {
  if (watching.has(id)) return;
  watching.add(id);
  try {
    for (;;) {
      const t = loadTask(id);
      const g = t?.gen;
      if (!g || !['queued', 'running'].includes(g.state)) return;
      let st;
      try { st = await falFetch(g.status_url); } catch (e) {
        if (e.status && e.status < 500) throw e;
        await sleep(5000); continue;          // сеть моргнула — ждём дальше
      }
      if (st.status === 'COMPLETED') break;
      const state = st.status === 'IN_PROGRESS' ? 'running' : 'queued';
      if (state !== g.state) patchTask(id, (x) => { x.gen.state = state; });
      await sleep(4000);
    }
    const t = loadTask(id);
    const res = await falFetch(t.gen.response_url);   // тут же приходят ошибки валидации
    const files = await download(t, res);
    patchTask(id, (x) => {
      x.gen.state = 'done';
      x.gen.files = files;
      x.gen.finished_at = Date.now() / 1000;
    });
    addEvent(id, { kind: 'gen', text: `Генерация готова: ${files.map((f) => path.basename(f)).join(', ')}` });
  } catch (e) {
    patchTask(id, (x) => { if (x.gen) { x.gen.state = 'error'; x.gen.error = e.message; } });
    addEvent(id, { kind: 'error', text: 'Генерация не удалась: ' + e.message });
  } finally {
    watching.delete(id);
  }
}

// Скачать всё, что вернул генератор, в out/<папка>/gen_<модель>_<n>/.
async function download(task, res) {
  const short = task.gen.label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/_+$/, '');
  let n = 1;
  let dir;
  do { dir = path.join(ws(), 'out', task.slug, `gen_${short}_${n++}`); } while (fs.existsSync(dir));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'fal_response.json'), JSON.stringify(res, null, 2));

  // Собираем все {url} из ответа, без повторов по url.
  const found = new Map();
  (function walk(o, key) {
    if (!o || typeof o !== 'object') return;
    if (typeof o.url === 'string' && /^https?:/.test(o.url)) { found.set(o.url, { key, name: o.file_name }); return; }
    for (const [k, v] of Object.entries(o)) walk(v, k);
  })(res, 'file');

  const saved = [];
  for (const [url, { key, name }] of found) {
    const ext = path.extname(new URL(url).pathname) || path.extname(name || '') || '.bin';
    const fname = `${task.slug}_${key}${ext}`.replace(/[^\w.-]/g, '_');
    const r = await fetch(url);
    if (!r.ok) continue;
    fs.writeFileSync(path.join(dir, fname), Buffer.from(await r.arrayBuffer()));
    saved.push(path.relative(ws(), path.join(dir, fname)));
  }
  return saved;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
