// Анимация готовой модели: основа, скелет, привязка к модели (Blender без
// окна), движения и паки. Всё — в <папка>/anim/<модель>/, сама модель в out/
// не меняется:
//   base.glb, base.json   модель лицом вперёд, без старых костей (+ поворот)
//   rig.json              точки, суставы и кости скелета (координаты glTF)
//   skin.glb, skin.json   модель с костями и весами (+ отчёт привязки)
//   clips/<id>.json       движения; packs.json — паки

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ws } from './store.mjs';
import { library } from './library.mjs';
import { load, exists } from './settings.mjs';
import { UserError } from './errors.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const py = (name) => fs.readFileSync(path.join(HERE, 'py', name), 'utf8');

const dirOf = (name) => path.join(ws(), 'anim', name);
// Имя кости: буквы любого алфавита, цифры и _ (точка и пробел ломают имена в three.js).
const BONE_NAME = /^[\p{L}\p{N}_]{1,40}$/u;
const rel = (abs) => path.relative(ws(), abs).split(path.sep).join('/');

function readJson(abs, def = null) {
  try { return JSON.parse(fs.readFileSync(abs, 'utf8')); } catch { return def; }
}
function writeJson(abs, v) {
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs + '.tmp', JSON.stringify(v, null, 1));
  fs.renameSync(abs + '.tmp', abs);
}

// Готовая модель из библиотеки: имя папки в out/.
function model(name) {
  const m = /^[\w.-]+$/.test(name) && !name.startsWith('.') ? library().find((x) => x.name === name) : null;
  if (!m) throw new UserError('noModel');
  return m;
}
const mainFile = (m) => (m.files.find((f) => /\.glb$/i.test(f.path) && !f.path.includes('/gen_')) || m.files[0]).path;

function fileInfo(abs) {
  try { return { path: rel(abs), t: Math.round(fs.statSync(abs).mtimeMs) }; } catch { return null; }
}

// Одно задание Blender на модель за раз.
const busy = new Map();

export function state(name) {
  const m = model(name);
  const d = dirOf(name);
  const clips = [];
  try {
    for (const f of fs.readdirSync(path.join(d, 'clips'))) {
      if (f.endsWith('.json')) { const c = readJson(path.join(d, 'clips', f)); if (c) clips.push(c); }
    }
  } catch { /* движений ещё нет */ }
  clips.sort((a, b) => (a.created || 0) - (b.created || 0));
  return {
    name,
    source: mainFile(m),
    base: fileInfo(path.join(d, 'base.glb')),
    turn: readJson(path.join(d, 'base.json'), {}).turn ?? null,
    baseV: readJson(path.join(d, 'base.json'), {}).v || 1,     // 2 — лево и право найдены по симметрии
    rig: readJson(path.join(d, 'rig.json')),
    skin: fileInfo(path.join(d, 'skin.glb')),
    report: readJson(path.join(d, 'skin.json')),
    clips,
    packs: readJson(path.join(d, 'packs.json'), []),
    busy: busy.get(name) || null,
  };
}

// Blender без окна с кодом из server/py и аргументами после «--».
function runPy(file, args, timeoutMs = 300000) {
  return new Promise((resolve, reject) => {
    const bin = load().blender.bin;
    if (!exists(bin)) { reject(new UserError('blNotFound')); return; }
    const p = spawn(bin, ['--background', '--factory-startup', '--python-expr', py(file), '--', ...args],
      { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    const timer = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
    p.stderr.on('data', (c) => { err = (err + c).slice(-3000); });
    p.on('error', (e) => { clearTimeout(timer); reject(e); });
    p.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new UserError('animFail', { msg: err.trim().split('\n').filter(Boolean).slice(-1)[0] || `код ${code}` }));
    });
  });
}

async function job(name, kind, fn) {
  if (busy.has(name)) throw new UserError('animBusy');
  busy.set(name, kind);
  try { return await fn(); } finally { busy.delete(name); }
}

// Основа: модель лицом вперёд. turn — 'auto' или градусы. Модель повернулась —
// скелет поворачивается вместе с ней (не пропадает), привязка считается заново.
export function prepare(name, turn = 'auto') {
  const m = model(name);
  const d = dirOf(name);
  fs.mkdirSync(d, { recursive: true });
  return job(name, 'prepare', async () => {
    const was = readJson(path.join(d, 'base.json'), null)?.turn ?? null;
    await runPy('anim_base.py', [path.join(ws(), mainFile(m)), path.join(d, 'base.glb'), String(turn), path.join(d, 'base.json')], 120000);
    const now = readJson(path.join(d, 'base.json'), {}).turn ?? 0;
    const rig = readJson(path.join(d, 'rig.json'));
    if (rig && was != null && now !== was) {
      const turnPoint = rotator(now - was);
      for (const k of Object.keys(rig.joints || {})) rig.joints[k] = turnPoint(rig.joints[k]);
      for (const k of Object.keys(rig.markers || {})) rig.markers[k] = turnPoint(rig.markers[k]);
      rig.cx = null;                                   // ось симметрии — снова по модели
      writeJson(path.join(d, 'rig.json'), rig);
    } else if (rig && was == null) fs.rmSync(path.join(d, 'rig.json'), { force: true });
    if (now !== was) for (const f of ['skin.glb', 'skin.json']) fs.rmSync(path.join(d, f), { force: true });
    return state(name);
  });
}

// Поворот точки glTF (Y вверх) так же, как Blender повернул модель вокруг
// своей вертикали Z на deg градусов (glTF x = Blender x, z = −Blender y).
function rotator(deg) {
  const a = (deg * Math.PI) / 180;
  const c = Math.cos(a);
  const sn = Math.sin(a);
  return ([x, y, z]) => [+(x * c + z * sn).toFixed(6), y, +(-x * sn + z * c).toFixed(6)];
}

// Скелет со страницы: точки, суставы, кости. Проверяем только форму.
export function saveRig(name, rig) {
  model(name);
  const joints = rig?.joints && typeof rig.joints === 'object' ? rig.joints : null;
  const okPoint = (p) => Array.isArray(p) && p.length === 3 && p.every(Number.isFinite);
  const bones = Array.isArray(rig.bones) ? rig.bones : [];
  const names = new Set(bones.map((b) => b?.name));
  if (!joints || !Object.values(joints).every(okPoint) || !bones.length || names.size !== bones.length
    || !bones.every((b) => b && BONE_NAME.test(b.name) && joints[b.head] && joints[b.tail] && (!b.parent || names.has(b.parent)))) {
    throw new UserError('animBadRig');
  }
  const d = dirOf(name);
  writeJson(path.join(d, 'rig.json'), {
    type: rig.type === 'human' ? 'human' : 'custom', cx: Number.isFinite(rig.cx) ? rig.cx : null,
    markers: rig.markers || {}, joints,
    bones: bones.map(({ name: n, parent, head, tail }) => ({ name: n, parent: parent || null, head, tail })),
  });
  // Скелет поменялся — прежняя привязка к нему уже не подходит.
  for (const f of ['skin.glb', 'skin.json']) fs.rmSync(path.join(d, f), { force: true });
  return state(name);
}

export function bind(name) {
  model(name);
  const d = dirOf(name);
  if (!fs.existsSync(path.join(d, 'base.glb')) || !fs.existsSync(path.join(d, 'rig.json'))) throw new UserError('animBadRig');
  return job(name, 'bind', async () => {
    const tmp = path.join(d, 'skin.tmp.glb');
    await runPy('anim_rig.py', [path.join(d, 'base.glb'), path.join(d, 'rig.json'), tmp, path.join(d, 'skin.json')]);
    fs.renameSync(tmp, path.join(d, 'skin.glb'));
    return state(name);
  });
}

// Снова к точкам: скелет и привязка — в сторону, основа остаётся.
export function resetRig(name) {
  model(name);
  const d = dirOf(name);
  for (const f of ['rig.json', 'skin.glb', 'skin.json']) fs.rmSync(path.join(d, f), { force: true });
  return state(name);
}

// ── движения и паки ─────────────────────────────────────────────────────────
const okId = (id) => /^[\w-]{1,40}$/.test(id);

// Движение целиком со страницы. Проверяем форму, чтобы кривой файл не сломал
// выгрузку: кадры — целые, повороты — четыре числа.
export function saveClip(name, id, clip) {
  model(name);
  const num = (v) => Number.isFinite(v);
  const okKey = (k) => Number.isInteger(k?.f) && k.f >= 0 && Array.isArray(k.q) && k.q.length === 4 && k.q.every(num)
    && (!k.p || (Array.isArray(k.p) && k.p.length === 3 && k.p.every(num)));
  if (!okId(id) || !clip || typeof clip.name !== 'string' || !Number.isInteger(clip.frames) || clip.frames < 1 || clip.frames > 2000
    || ![12, 24, 25, 30, 60].includes(clip.fps) || typeof clip.keys !== 'object'
    || !Object.entries(clip.keys).every(([b, ks]) => BONE_NAME.test(b) && Array.isArray(ks) && ks.every(okKey))) {
    throw new UserError('animBadClip');
  }
  const out = {
    id, name: clip.name.slice(0, 60), pack: String(clip.pack || '').slice(0, 40), fps: clip.fps, frames: clip.frames,
    loop: !!clip.loop, created: Number(clip.created) || Date.now(), keys: clip.keys,
  };
  writeJson(path.join(dirOf(name), 'clips', id + '.json'), out);
  return out;
}

export function deleteClip(name, id) {
  model(name);
  if (!okId(id)) throw new UserError('animBadClip');
  fs.rmSync(path.join(dirOf(name), 'clips', id + '.json'), { force: true });
  return state(name);
}

export function savePacks(name, packs) {
  model(name);
  if (!Array.isArray(packs) || !packs.every((p) => okId(p?.id) && typeof p.name === 'string')) throw new UserError('animBadClip');
  writeJson(path.join(dirOf(name), 'packs.json'), packs.map((p) => ({ id: p.id, name: p.name.slice(0, 40) })));
  return state(name);
}

// Выгрузка: страница собрала GLB с движениями (из skin.glb) — кладём его в
// anim/<модель>/export/. FBX и .blend из него делает /api/export Blender'ом.
export function saveExport(name, { file, data } = {}) {
  model(name);
  const base = String(file || '').replace(/[^\p{L}\w.-]+/gu, '_').slice(0, 80);
  if (!base || typeof data !== 'string') throw new UserError('animBadClip');
  const abs = path.join(dirOf(name), 'export', base + '.glb');
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, Buffer.from(data, 'base64'));
  return { path: rel(abs) };
}
