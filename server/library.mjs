// Что уже лежит в проекте: модели в out/, кадры в renders/, референсы в refs/.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ws, tasksDir, loadTask } from './store.mjs';

export const MODEL_EXT = ['.glb', '.gltf', '.fbx', '.obj'];
const IMG_EXT = ['.png', '.jpg', '.jpeg', '.webp'];

function walk(dir, depth, out = []) {
  const ROOT = ws();
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    if (e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (depth > 0) walk(p, depth - 1, out); continue; }
    const st = fs.statSync(p);
    out.push({ path: path.relative(ROOT, p), mtime: st.mtimeMs / 1000, size: st.size });
  }
  return out;
}

const isModel = (f) => MODEL_EXT.includes(path.extname(f.path).toLowerCase());
const isImage = (f) => IMG_EXT.includes(path.extname(f.path).toLowerCase());

// Библиотека: папки out/ с моделями, превью и .blend.
export function library() {
  const ROOT = ws();
  if (!ROOT) return [];
  let dirs = [];
  try { dirs = fs.readdirSync(path.join(ROOT, 'out'), { withFileTypes: true }).filter((d) => d.isDirectory()); } catch { /* нет out */ }
  return dirs.map((d) => {
    const files = walk(path.join(ROOT, 'out', d.name), 2).filter(isModel)
      .sort((a, b) => a.path.localeCompare(b.path));
    const allShots = walk(path.join(ROOT, 'renders', d.name), 0).filter(isImage);
    const renders = allShots.filter((f) => !/peek/.test(f.path));
    // Превью: кадр сравнения с референсом, любой кадр, а у генератора — его собственная картинка.
    const genShot = walk(path.join(ROOT, 'out', d.name), 2).filter(isImage).find((f) => /rendered_image|thumbnail|preview/.test(f.path));
    const preview = renders.find((f) => /vs_ref/.test(f.path)) || renders[0] || genShot || allShots[0] || null;
    const blend = path.join('models', d.name + '.blend');
    return {
      name: d.name,
      files,
      preview: preview?.path || null,
      blend: fs.existsSync(path.join(ROOT, blend)) ? blend : null,
      mtime: Math.max(0, ...files.map((f) => f.mtime)),
    };
  }).filter((x) => x.files.length).sort((a, b) => b.mtime - a.mtime);
}

// Убрать модель в Корзину macOS: out/<имя>, models/<имя>.blend(1), renders/<имя>.
// Скрипт сцены и референсы остаются — по ним модель можно собрать снова.
export function trashModel(name) {
  const ROOT = ws();
  if (!/^[\w.-]+$/.test(name) || !fs.existsSync(path.join(ROOT, 'out', name))) return { ok: false, code: 'noModel' };
  const trash = path.join(os.homedir(), '.Trash');
  if (process.platform !== 'darwin' || !fs.existsSync(trash)) return { ok: false, code: 'trashUnsupported' };
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const parts = [`out/${name}`, `models/${name}.blend`, `models/${name}.blend1`, `renders/${name}`]
    .filter((rel) => fs.existsSync(path.join(ROOT, rel)));
  const moved = [];
  for (const rel of parts) {
    const dst = path.join(trash, `${rel.replace(/\//g, '_')} ${stamp}`);
    fs.renameSync(path.join(ROOT, rel), dst);
    moved.push(rel);
  }
  return { ok: true, moved };
}

// Задачу — в Корзину macOS: runs/studio/<id> (переписка, версии, метки).
// Готовые файлы модели, референсы и скрипт сцены остаются в рабочей папке.
export function trashTask(id) {
  const dir = path.join(tasksDir(), id);
  if (!/^[\w-]+$/.test(id) || !fs.existsSync(dir)) return { ok: false, code: 'noTask' };
  const trash = path.join(os.homedir(), '.Trash');
  if (process.platform !== 'darwin' || !fs.existsSync(trash)) return { ok: false, code: 'trashUnsupported' };
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const name = (loadTask(id)?.slug || id).replace(/[^\w.-]+/g, '_');
  try {
    fs.renameSync(dir, path.join(trash, `3DModelist task ${name} ${stamp}`));
  } catch {
    return { ok: false, code: 'trashUnsupported' };      // другой диск — в Корзину не переносится
  }
  return { ok: true };
}

// Цели из спеки — для сверки модели в окне: габариты (Ш × Г × В, в метрах) и
// полигонаж (от–до треугольников). Спеку пишет агент; строки ищем по смыслу,
// на русском и английском, и прощаем единицы (мм, см, м).
export function specTarget(text) {
  const out = {};
  const n = (s) => Number(String(s).replace(/[\s ]/g, '').replace(',', '.'));
  const size = /(?:габарит|размер|size|dimension)[^\n\d]*?([\d.,]+)\s*[×xх*]\s*([\d.,]+)\s*[×xх*]\s*([\d.,]+)\s*(мм|см|м|mm|cm|m)(?![\p{L}])/iu.exec(text);
  if (size) {
    const k = { мм: 0.001, mm: 0.001, см: 0.01, cm: 0.01 }[size[4].toLowerCase()] || 1;
    const v = [size[1], size[2], size[3]].map((x) => n(x) * k);
    if (v.every((x) => x > 0 && x < 10000)) out.size = v;
  }
  // Треугольники — целые: разделители тысяч (пробел, запятая, точка) выбрасываем.
  const int = (x) => Number(String(x).replace(/[\s ,.]/g, ''));
  const num = String.raw`(\d(?:[\d ,.]*\d)?)`;
  const key = '(?:полигонаж|треугольник|бюджет|polycount|poly budget|budget|triangles|tris)';
  const range = new RegExp(key + String.raw`[^\n\d]*?` + num + String.raw`\s*(?:[–—-]|до|to)\s*` + num, 'iu').exec(text);
  const cap = !range && new RegExp(key + String.raw`[^\n\d]*?(?:≤|<=|до|up to|max\.?|не более)\s*` + num, 'iu').exec(text);
  if (range) out.tris = [int(range[1]), int(range[2])];
  else if (cap) out.tris = [0, int(cap[1])];
  if (out.tris && !(out.tris[1] > 0 && out.tris[0] <= out.tris[1])) delete out.tris;
  return out.size || out.tris ? out : null;
}

// Материалы задачи: кадры и модели, появившиеся после её создания.
export function taskMedia(task) {
  const ROOT = ws();
  const since = task.created_at - 5;
  const frames = walk(path.join(ROOT, 'renders'), 2).filter(isImage)
    .filter((f) => f.mtime >= since || f.path.startsWith(`renders/${task.slug}/`))
    .sort((a, b) => b.mtime - a.mtime).slice(0, 40);
  // Превью, которое рисует сам генератор, — тоже кадр: по нему видно, что вышло.
  const genShots = walk(path.join(ROOT, 'out', task.slug), 2).filter(isImage).filter((f) => f.path.includes('/gen_') && !/texture|_map/.test(f.path));
  frames.unshift(...genShots);
  const models = walk(path.join(ROOT, 'out'), 3).filter(isModel)
    .filter((f) => f.path.startsWith(`out/${task.slug}/`) || f.mtime >= since)
    .sort((a, b) => b.mtime - a.mtime);
  const blend = path.join('models', task.slug + '.blend');
  const spec = path.join('refs', task.slug, 'spec.md');
  const hasSpec = fs.existsSync(path.join(ROOT, spec));
  let target = null;
  if (hasSpec) { try { target = specTarget(fs.readFileSync(path.join(ROOT, spec), 'utf8')); } catch { /* нечитаемая спека — без сверки */ } }
  return {
    frames, models,
    blend: fs.existsSync(path.join(ROOT, blend)) ? blend : null,
    spec: hasSpec ? spec : null,
    target,
  };
}

// Папки референсов проекта — чтобы взять уже лежащий референс, а не грузить заново.
export function refsTree() {
  const ROOT = ws();
  if (!ROOT) return [];
  return walk(path.join(ROOT, 'refs'), 3).filter(isImage)
    .sort((a, b) => a.path.localeCompare(b.path)).map((f) => f.path);
}
