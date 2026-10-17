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
import { runAnimAgent } from './agent.mjs';
import { bakeGlb, poseChecks } from './anim-pose.mjs';
import os from 'node:os';

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

// Скелет «Человека», где кости подписаны не своей стороной (Left стоит на −X):
// так строил «Человек по точкам» до 0.8.3, если запястье и колено ставили на
// разных сторонах. Имена меняются местами везде — скелет, модель с костями,
// ключи движений; сами кости и движения не меняются. Левая сторона — +X.
function fixSides(name) {
  const d = dirOf(name);
  const rig = readJson(path.join(d, 'rig.json'));
  if (!rig || rig.type !== 'human' || !Array.isArray(rig.bones)) return;
  const cx = Number.isFinite(rig.cx) ? rig.cx : 0;
  const sideAt = (id) => { const p = rig.joints[id]; return !p || Math.abs(p[0] - cx) < 0.01 ? null : p[0] > cx ? 'Left' : 'Right'; };
  const other = (n) => (/^Left/.test(n) ? n.replace(/^Left/, 'Right') : n.replace(/^Right/, 'Left'));
  const wrong = new Set();
  for (const b of rig.bones) {
    const m = /^(Left|Right)/.exec(b.name);
    const s = m && (sideAt(b.head) || sideAt(b.tail));
    if (m && s && s !== m[1]) { wrong.add(b.name); wrong.add(other(b.name)); }
  }
  if (!wrong.size) return;
  const map = new Map([...wrong].map((n) => [n, other(n)]));
  const ren = (n) => map.get(n) ?? n;
  // Точки тех же костей: .L ↔ .R по месту.
  const jmap = new Map();
  for (const b of rig.bones) {
    if (!wrong.has(b.name)) continue;
    for (const id of [b.head, b.tail]) {
      const m = /^(.*)\.(L|R)$/.exec(id);
      const s = sideAt(id);
      if (m && s && s[0] !== m[2]) jmap.set(id, `${m[1]}.${m[2] === 'L' ? 'R' : 'L'}`);
    }
  }
  const jr = (id) => jmap.get(id) ?? id;
  rig.bones = rig.bones.map((b) => ({ ...b, name: ren(b.name), parent: b.parent && ren(b.parent), head: jr(b.head), tail: jr(b.tail) }));
  rig.joints = Object.fromEntries(Object.entries(rig.joints).map(([k, v]) => [jr(k), v]));
  writeJson(path.join(d, 'rig.json'), rig);
  const skin = path.join(d, 'skin.glb');
  if (fs.existsSync(skin)) renameManyInGlb(skin, map);
  let files = [];
  try { files = fs.readdirSync(path.join(d, 'clips')).filter((f) => f.endsWith('.json')); } catch { /* движений нет */ }
  for (const f of files) {
    const p = path.join(d, 'clips', f);
    const c = readJson(p);
    if (!c?.keys) continue;
    c.keys = Object.fromEntries(Object.entries(c.keys).map(([k, v]) => [ren(k), v]));
    if (c.undo?.keys) c.undo.keys = Object.fromEntries(Object.entries(c.undo.keys).map(([k, v]) => [ren(k), v]));
    writeJson(p, c);
  }
}

export function state(name) {
  const m = model(name);
  const d = dirOf(name);
  try { fixSides(name); } catch { /* скелет кривой — покажем как есть */ }
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

// Модель перекрасили (проект 3DPainter открыт снова): основа — заново с тем же
// поворотом, привязка — заново к тому же скелету; движения не трогаются.
// Анимации у модели ещё не было — делать нечего. Возвращает, пересобрано ли.
export async function repaint(name) {
  const m = model(name);
  const d = dirOf(name);
  const was = readJson(path.join(d, 'base.json'), null);
  if (!was || !fs.existsSync(path.join(d, 'base.glb'))) return false;
  const bound = fs.existsSync(path.join(d, 'skin.glb')) && fs.existsSync(path.join(d, 'rig.json'));
  await job(name, 'prepare', async () => {
    await runPy('anim_base.py', [path.join(ws(), mainFile(m)), path.join(d, 'base.glb'), String(was.turn ?? 0), path.join(d, 'base.json')], 120000);
    if (!bound) return;
    const tmp = path.join(d, 'skin.tmp.glb');
    await runPy('anim_rig.py', [path.join(d, 'base.glb'), path.join(d, 'rig.json'), tmp, path.join(d, 'skin.json')]);
    fs.renameSync(tmp, path.join(d, 'skin.glb'));
  });
  return true;
}

// Скелет и движения из проекта 3DPainter, сохранённого студией (страница
// собрала их из файла, src/painter.js): основа с тем же поворотом, скелет,
// движения, пак, привязка. Свой скелет у модели уже есть — он главнее.
export async function restore(name, data = {}) {
  const m = model(name);
  const d = dirOf(name);
  if (fs.existsSync(path.join(d, 'rig.json')) || !data.rig) return false;
  const turn = Number.isInteger(data.turn) ? ((data.turn % 360) + 360) % 360 : 0;
  fs.mkdirSync(d, { recursive: true });
  await job(name, 'prepare', () => runPy('anim_base.py', [path.join(ws(), mainFile(m)), path.join(d, 'base.glb'), String(turn), path.join(d, 'base.json')], 120000));
  saveRig(name, data.rig);
  const clips = Array.isArray(data.clips) ? data.clips : [];
  if (clips.length) {
    const packs = Array.isArray(data.packs) && data.packs.length ? data.packs : [{ id: 'p1', name: 'Pack 1' }];
    savePacks(name, packs);
    for (const c of clips) saveClip(name, c.id, { ...c, pack: packs[0].id });
  }
  await bind(name);
  return true;
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
  if (clip.undo && typeof clip.undo === 'object' && typeof clip.undo.keys === 'object') out.undo = clip.undo;
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

// Переименовать кость у привязанной модели — везде: скелет, модель с костями
// (имя узла в skin.glb) и ключи всех движений.
export function renameBone(name, { from, to } = {}) {
  model(name);
  const d = dirOf(name);
  const rig = readJson(path.join(d, 'rig.json'));
  to = String(to || '').trim();
  if (!rig || !BONE_NAME.test(to) || !rig.bones.some((b) => b.name === from) || rig.bones.some((b) => b.name === to)) {
    throw new UserError('animBadName');
  }
  for (const b of rig.bones) {
    if (b.name === from) b.name = to;
    if (b.parent === from) b.parent = to;
  }
  writeJson(path.join(d, 'rig.json'), rig);
  const skin = path.join(d, 'skin.glb');
  if (fs.existsSync(skin)) renameInGlb(skin, from, to);
  let files = [];
  try { files = fs.readdirSync(path.join(d, 'clips')).filter((f) => f.endsWith('.json')); } catch { /* движений нет */ }
  for (const f of files) {
    const p = path.join(d, 'clips', f);
    const c = readJson(p);
    if (c?.keys?.[from]) { c.keys[to] = c.keys[from]; delete c.keys[from]; writeJson(p, c); }
  }
  return state(name);
}

// GLB: заголовок 12 байт, кусок JSON (длина, тип, текст с пробелами до
// кратного 4), кусок BIN. Меняем имя узла в JSON, BIN не трогаем.
function renameInGlb(file, from, to) { renameManyInGlb(file, new Map([[from, to]])); }

function renameManyInGlb(file, map) {
  const buf = fs.readFileSync(file);
  const len = buf.readUInt32LE(12);
  const json = JSON.parse(buf.subarray(20, 20 + len).toString('utf8'));
  for (const n of json.nodes || []) if (map.has(n.name)) n.name = map.get(n.name);
  let text = Buffer.from(JSON.stringify(json), 'utf8');
  text = Buffer.concat([text, Buffer.alloc((4 - (text.length % 4)) % 4, 0x20)]);
  const rest = buf.subarray(20 + len);
  const out = Buffer.alloc(20 + text.length + rest.length);
  buf.copy(out, 0, 0, 12);
  out.writeUInt32LE(out.length, 8);
  out.writeUInt32LE(text.length, 12);
  out.writeUInt32LE(0x4e4f534a, 16);      // 'JSON'
  text.copy(out, 20);
  rest.copy(out, 20 + text.length);
  fs.writeFileSync(file + '.tmp', out);
  fs.renameSync(file + '.tmp', file);
}

// ── движение по словам: агент ставит ключи ──────────────────────────────────
// Страница присылает скелет «по-человечески» (кости, где начинаются и
// кончаются, пол), покой каждой кости (кватернионы — чтобы перевести ответ в
// ключи) и нынешнее движение в том же виде, что ждёт от агента. Агент
// отвечает поворотами в градусах относительно родителя в осях модели; здесь
// они становятся ключами клипа (local = pw⁻¹ · D · w), прежние ключи — в
// clip.undo, чтобы «Вернуть как было».

const jobs = new Map();          // id → { name, clip, state, reply, error, cost, t0, proc }
const agentBusy = (name) => [...jobs.values()].some((j) => j.name === name && j.state === 'running');

// Кватернионы [x, y, z, w].
const qmul = (a, b) => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];
const qinv = (a) => [-a[0], -a[1], -a[2], a[3]];
const qaxis = (i, deg) => { const h = (deg * Math.PI) / 360; const q = [0, 0, 0, Math.cos(h)]; q[i] = Math.sin(h); return q; };
// Поворот по осям модели: сперва X, затем Y, затем Z (как Euler 'ZYX' у three.js).
const fromDeg = ([x, y, z]) => qmul(qaxis(2, z), qmul(qaxis(1, y), qaxis(0, x)));
const qrot = (q, v) => qmul(qmul(q, [...v, 0]), qinv(q)).slice(0, 3);

const chatFile = (name, clipId) => path.join(dirOf(name), 'chat', clipId + '.json');
export function chatLog(name, clipId) {
  model(name);
  if (!okId(clipId)) throw new UserError('animBadClip');
  return readJson(chatFile(name, clipId), []);
}
function chatAdd(name, clipId, row) {
  const log = readJson(chatFile(name, clipId), []);
  log.push({ t: Date.now(), ...row });
  writeJson(chatFile(name, clipId), log.slice(-60));
}

// Правила аниматора — отдельным файлом (server/anim-guide.md): их проще дополнять.
const guide = () => { try { return fs.readFileSync(path.join(HERE, 'anim-guide.md'), 'utf8').trim(); } catch { return ''; } };

// Числа позы покоя, которые агенту иначе пришлось бы угадывать: насколько
// разведены руки, есть ли кости пальцев.
function restNotes(ctx) {
  const b = (n) => ctx.bones.find((x) => x.name === n);
  const out = [];
  const arm = b('LeftUpperArm');
  if (arm) {
    const deg = Math.round((Math.atan2(arm.tail[0] - arm.head[0], arm.head[1] - arm.tail[1]) * 180) / Math.PI);
    const down = Math.max(0, deg - 8);
    out.push(`В покое плечо отведено от тела на ${deg}° (A-поза). Опустить руки вдоль тела: LeftUpperArm rz ≈ −${down}°, RightUpperArm rz ≈ +${down}° (к этому добавляй мах вперёд-назад по rx).`);
  }
  const fingers = ctx.bones.filter((x) => /Fingers|Thumb/.test(x.name)).map((x) => x.name);
  if (fingers.length) out.push(`Кости пальцев: ${fingers.join(', ')}. В покое ладони смотрят к телу: сжать кисть — левые Fingers/Thumb rz < 0, правые rz > 0.`);
  return out.join('\n');
}

function agentPrompt(ctx, clip, message, history) {
  const f3 = (v) => v.map((x) => +Number(x).toFixed(3));
  const bones = ctx.bones.map((b) => `- ${b.name}${b.parent ? ` (родитель ${b.parent})` : ' (корень)'} — «${b.label}», от ${JSON.stringify(f3(b.head))} до ${JSON.stringify(f3(b.tail))}`).join('\n');
  const now = ctx.motion?.keys?.length ? JSON.stringify(ctx.motion) : 'ключей пока нет — поза покоя';
  const past = history.filter((h) => h.role === 'user').slice(-6).map((h) => `- «${h.text}»`).join('\n');
  return `Ты — аниматор персонажа в программе 3DModelist. Сделай движение по просьбе человека на готовом скелете. Инструменты не вызывай: ответь текстом и одним блоком \`\`\`json.

Оси модели: X — влево от персонажа (+X — его левая сторона), Y — вверх, Z — вперёд (персонаж смотрит на +Z). Единицы — метры. Пол — y = ${Number(ctx.floor || 0).toFixed(3)}.

Скелет (кость, родитель, откуда и куда идёт в покое):
${bones}

Поворот кости r = [rx, ry, rz] — градусы, от позы покоя, относительно родителя (ребёнок движется вместе с родителем, его r — добавка), по осям модели: сперва X, затем Y, затем Z. [0, 0, 0] — поза покоя, как модель стоит сейчас. Правило правой руки:
- rx > 0: кость, что смотрит вверх, наклоняется вперёд; что смотрит вниз — уходит назад. Шаг вперёд бедром — rx < 0; согнуть колено (голень назад) — rx > 0; наклон корпуса вперёд — rx > 0; рука, висящая вниз, вперёд — rx < 0.
- ry > 0: поворот вокруг вертикали влево (перед уходит к +X). Голову или корпус влево — ry > 0.
- rz > 0: конец кости уходит к +X. Левую руку (висит вниз-влево) поднять в сторону — rz > 0; правую — rz < 0.
Сдвиг p = [dx, dy, dz] — метры по осям модели, только у корневой кости: подпрыгнуть — dy > 0, присесть — dy < 0.

Ответ — JSON такого вида:
{"frames": 24, "fps": 30, "loop": true,
 "keys": [{"f": 0, "e": "smooth", "bones": {"Bone1": {"r": [0, 0, 0], "p": [0, 0, 0]}, "Bone2": {"r": [5, 0, 0]}}}]}
- f — кадр от 0 до frames; e — переход к следующему ключу: smooth (плавно), linear (ровно), step (скачком).
- В каждом ключе перечисляй все кости, что участвуют в движении, — иначе кость потянется к ключу из другого кадра. Кость, которой нет ни в одном ключе, стоит в покое.
- loop: true — по кругу (бег, ходьба, стойка): программа сама замкнёт круг от последнего ключа к первому.
- Длина по умолчанию — как у нынешнего движения (${clip.frames} кадров, ${clip.fps} к/с); меняй, если просят или так нужно.
- Движение живое: противоход рук и ног при шаге и беге, перенос веса, лёгкая работа корпуса и головы; ступни не проходят сквозь пол.
- Правка («сделай плавнее», «поправь руку») — меняй только то, о чём просят, остальное оставь как есть, и верни движение целиком.

${restNotes(ctx)}

${guide()}

Нынешнее движение «${clip.name}» (${clip.frames} кадров, ${clip.fps} к/с, по кругу: ${clip.loop ? 'да' : 'нет'}):
${now}
${past ? `\nРаньше по этому движению просили:\n${past}\n` : ''}
Просьба человека: «${message}»

Перед блоком json в одной-двух фразах, на языке просьбы, скажи, что сделал.`;
}

// Ответ агента → чистое движение: только известные кости, числа, кадры в пределах.
function parseMotion(reply, ctx, clip) {
  const m = [...String(reply || '').matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].pop();
  let j;
  try { j = JSON.parse(m ? m[1] : reply); } catch { return null; }
  if (!j || !Array.isArray(j.keys)) return null;
  const names = new Set(ctx.bones.map((b) => b.name));
  const roots = new Set(ctx.bones.filter((b) => !b.parent).map((b) => b.name));
  const frames = Number.isInteger(j.frames) && j.frames >= 2 && j.frames <= 2000 ? j.frames : clip.frames;
  const num3 = (v) => Array.isArray(v) && v.length === 3 && v.every((x) => Number.isFinite(Number(x))) ? v.map(Number) : null;
  const keys = [];
  for (const k of j.keys) {
    const f = Math.round(Number(k?.f));
    if (!Number.isFinite(f) || f < 0 || f > frames || typeof k.bones !== 'object') continue;
    const bones = {};
    for (const [b, v] of Object.entries(k.bones)) {
      if (!names.has(b)) continue;
      const r = num3(v?.r) || [0, 0, 0];
      const pp = roots.has(b) ? num3(v?.p) : null;
      bones[b] = pp ? { r, p: pp } : { r };
    }
    if (Object.keys(bones).length) keys.push({ f, e: ['smooth', 'linear', 'step'].includes(k.e) ? k.e : 'smooth', bones });
  }
  if (!keys.length) return null;
  return { frames, fps: [24, 30, 60].includes(j.fps) ? j.fps : clip.fps, loop: typeof j.loop === 'boolean' ? j.loop : clip.loop, keys };
}

// Движение агента → ключи клипа: local = pw⁻¹ · D · w; сдвиг корня — в осях родителя.
function motionToKeys(motion, ctx) {
  const keys = {};
  for (const k of [...motion.keys].sort((a, b) => a.f - b.f)) {
    for (const [b, v] of Object.entries(k.bones)) {
      const rest = ctx.rest[b];
      if (!rest) continue;
      const q = qmul(qmul(qinv(rest.pw), fromDeg(v.r)), rest.w).map((x) => +x.toFixed(6));
      const key = { f: k.f, q, e: k.e };
      if (v.p) key.p = rest.p0.map((x, i) => +(x + qrot(qinv(rest.pw), v.p)[i]).toFixed(6));
      const list = (keys[b] ||= []);
      const old = list.findIndex((x) => x.f === k.f);
      if (old >= 0) list[old] = key; else list.push(key);
    }
  }
  return keys;
}

// Ход агента: движение → лист кадров с трёх сторон и замеры → агент смотрит
// и правит, пока не скажет, что всё хорошо (не больше REVIEWS кругов).
// Каждый круг — тот же разговор (--resume): агент помнит, что делал.
const REVIEWS = 2;
const sheetFrames = (c) => {
  const n = c.frames;
  const at = c.loop ? [0, n / 4, n / 2, (3 * n) / 4] : [0, n / 3, (2 * n) / 3, n];
  return [...new Set(at.map((x) => Math.round(x)))];
};

async function runMotion({ name, d, clipId, clip, ctx, job, prompt, model }) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'modelist-anim-'));
  const file = path.join(d, 'clips', clipId + '.json');
  let session = null;
  let cost = 0;
  let undoSaved = false;
  const ask = async (text, maxTurns) => {
    const r = await runAnimAgent({ prompt: text, model, cwd, resume: session, maxTurns, onSpawn: (p) => { job.proc = p; } });
    job.proc = null;
    if (r.session) session = r.session;
    if (r.cost) cost += r.cost;
    return r;
  };
  const apply = (motion) => {
    const cur = readJson(file) || clip;
    if (!undoSaved) { cur.undo = { keys: cur.keys, frames: cur.frames, fps: cur.fps, loop: cur.loop }; undoSaved = true; }
    Object.assign(cur, { frames: motion.frames, fps: motion.fps, loop: motion.loop, keys: motionToKeys(motion, ctx) });
    writeJson(file, cur);
    return cur;
  };
  const say = (reply) => String(reply || '').split('```')[0].trim().slice(0, 800);
  try {
    let r = await ask(prompt, 2);
    let motion = r.ok ? parseMotion(r.reply, ctx, clip) : null;
    if (!motion) {
      job.state = 'error';
      job.error = r.ok ? { code: 'animAgentJson' } : { code: r.code || 'animAgentFail', params: r.params || { msg: String(r.error || '').slice(0, 300) } };
      chatAdd(name, clipId, { role: 'error', code: job.error.code, params: job.error.params, text: r.ok ? String(r.reply || '').slice(0, 600) : '' });
      return;
    }
    let cur = apply(motion);
    const said = [say(r.reply)];
    // Проверка глазами: без привязанной модели или Blender'а — просто без неё.
    const skin = path.join(d, 'skin.glb');
    const rig = readJson(path.join(d, 'rig.json'));
    for (let round = 1; round <= REVIEWS && fs.existsSync(skin) && rig && !job.stopReq; round++) {
      job.phase = 'review';
      const frames = sheetFrames(cur);
      const glb = path.join(cwd, 'motion.glb');
      const png = path.join(cwd, `sheet_${round}.png`);
      try {
        bakeGlb(skin, cur, glb);
        await runPy('anim_sheet.py', [glb, png, frames.join(',')], 180000);
      } catch { break; }
      let checks = [];
      try { checks = poseChecks(skin, cur, rig, Number(ctx.floor) || 0); } catch { /* замеры — подсказка, не обязаловка */ }
      r = await ask(reviewPrompt(png, frames, checks, cur), 4);
      if (!r.ok || job.stopReq) break;
      const fix = /```/.test(r.reply || '') ? parseMotion(r.reply, ctx, cur) : null;
      said.push(say(r.reply));
      if (!fix) break;                       // агент доволен — движение остаётся
      cur = apply(fix);
    }
    job.cost = load().claude.mode === 'api' ? cost : undefined;   // по подписке — только оценка, не показываем
    job.reply = said.filter(Boolean).join('\n\n').slice(0, 1600);
    job.state = 'done';
    chatAdd(name, clipId, { role: 'agent', text: job.reply, cost: job.cost });
  } finally {
    job.phase = null;
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

function reviewPrompt(png, frames, checks, clip) {
  return `Вот твоё движение глазами — лист кадров: ${png}
Открой его инструментом Read. Строки сверху вниз — кадры ${frames.join(', ')} из ${clip.frames}; столбцы слева направо — спереди, сбоку (правый бок персонажа, он смотрит вправо), сзади. Серая плоскость — пол.

Замеры позы по всем кадрам:
${checks.length ? checks.map((x) => '- ' + x).join('\n') : '- нет'}

Проверь движение по своему списку правил — особенно вид спереди и сзади: руки вдоль тела, а не разведены; ноги под тазом, не в раскорячку; стопы на полу; суставы гнутся в своих пределах; противоход рук и ног.
- Всё хорошо — ответь одной-двумя фразами, что проверил, без блока json.
- Есть что поправить — исправь и верни движение целиком тем же блоком \`\`\`json, а перед ним одной-двумя фразами скажи, что поправил.`;
}

export function agentStart(name, body = {}) {
  model(name);
  const d = dirOf(name);
  const clipId = String(body.clip || '');
  const clip = okId(clipId) ? readJson(path.join(d, 'clips', clipId + '.json')) : null;
  const message = String(body.message || '').trim().slice(0, 2000);
  const ctx = body.context;
  if (!clip || !message || !ctx || !Array.isArray(ctx.bones) || typeof ctx.rest !== 'object') throw new UserError('animBadClip');
  if (agentBusy(name)) throw new UserError('animAgentBusy');
  const history = readJson(chatFile(name, clipId), []);
  chatAdd(name, clipId, { role: 'user', text: message });
  const id = 'a' + Date.now().toString(36);
  const job = { id, name, clip: clipId, state: 'running', t0: Date.now() };
  jobs.set(id, job);
  const modelName = /^[\w.:-]{1,80}$/.test(body.model || '') ? body.model : 'opus';
  runMotion({ name, d, clipId, clip, ctx, job, prompt: agentPrompt(ctx, clip, message, history), model: modelName })
    .catch((e) => { job.state = 'error'; job.error = { code: 'animAgentFail', params: { msg: String(e.message || e).slice(0, 300) } }; chatAdd(name, clipId, { role: 'error', code: job.error.code, params: job.error.params }); });
  return { job: id };
}

export function agentJob(name, id) {
  const j = jobs.get(id);
  if (!j || j.name !== name) throw new UserError('animBadClip');
  return { id: j.id, clip: j.clip, state: j.state, phase: j.phase || null, reply: j.reply, error: j.error, cost: j.cost, t0: j.t0 };
}

// Что сейчас делает агент по этой модели (страницу могли закрыть и открыть).
export function agentRunning(name) {
  return [...jobs.values()].filter((j) => j.name === name && j.state === 'running').map((j) => agentJob(name, j.id));
}

export function agentStop(name, id) {
  const j = jobs.get(id);
  if (!j || j.name !== name) throw new UserError('animBadClip');
  j.stopReq = true;                     // круг проверки дальше не идёт
  if (j.proc) { try { process.kill(-j.proc.pid, 'SIGTERM'); } catch { /* уже вышел */ } }
  return agentJob(name, id);
}
