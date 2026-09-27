// Что уже лежит в проекте: модели в out/, кадры в renders/, референсы в refs/.

import fs from 'node:fs';
import path from 'node:path';
import { ws } from './store.mjs';

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
    const renders = walk(path.join(ROOT, 'renders', d.name), 0).filter(isImage)
      .filter((f) => !/peek/.test(f.path));
    const preview = renders.find((f) => /vs_ref/.test(f.path)) || renders[0] || null;
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
  return {
    frames, models,
    blend: fs.existsSync(path.join(ROOT, blend)) ? blend : null,
    spec: fs.existsSync(path.join(ROOT, spec)) ? spec : null,
  };
}

// Папки референсов проекта — чтобы взять уже лежащий референс, а не грузить заново.
export function refsTree() {
  const ROOT = ws();
  if (!ROOT) return [];
  return walk(path.join(ROOT, 'refs'), 3).filter(isImage)
    .sort((a, b) => a.path.localeCompare(b.path)).map((f) => f.path);
}
