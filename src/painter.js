// Мост с 3DPainter: его рабочий файл `.3dpaint` — внутри обычный zip:
//
//   project.json                  описание (слои, варианты, лицо, поза, кисть…)
//   model.glb                     геометрия с той развёрткой, по которой красили
//   layers/<меш>/<слой>/*.bin     карты слоя сырыми байтами (rgba, rough, metal, opac, mask)
//   face/tris.bin, face/<часть>/<n>/*.bin   грани лица и выражения вырезками
//   zones/<n>/tris.bin            грани зоны (1 байт на треугольник)
//
// Открыть: слои сводятся здесь так же, как сводит сам 3DPainter, и модель
// уходит в out/<имя>/ готовым GLB с покраской — дальше с ней работает
// анимация. Лицо — отдельным материалом «Face» с нейтральным выражением, как в
// выгрузке лица 3DPainter, рядом — атласы выражений и описание для игры.
// Зоны (zones/<n>/tris.bin) — своими материалами с именем зоны.
//
// Сохранить: в тот же проект кладётся модель со скелетом и движениями.
// 🔴 Геометрия — из самого проекта, грань в грань: 3DPainter сверяет число
// граней, а грани лица помнит по номерам. Модель с костями из Blender для
// этого не годится — порядок граней там свой; с неё берутся только веса
// (по ближайшей точке) и сам скелет.

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { writeGlb } from './glb.js';
import { unzipSync, strFromU8 } from 'three/examples/jsm/libs/fflate.module.js';
import { bake } from './anim-clip.js';

export const PAINT_EXT = '3dpaint';
export const isPaint = (name) => /\.3dpaint$/i.test(name || '');

const SLOTS = ['full', 'eyes', 'mouth'];        // части лица снизу вверх, как в 3DPainter
const BG = [176, 176, 176];                     // подложка 3DPainter там, где не крашено
const BG_ROUGH = 230;
const BG_METAL = 0;

// Ошибка с кодом — страница покажет её словами из словаря (err.<код>).
const fail = (code) => Object.assign(new Error(code), { code });

/** Разобрать проект: описание, модель и доступ к файлам по пути. */
export function readPaint(bytes) {
  let files;
  try { files = unzipSync(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)); } catch { throw fail('paintBad'); }
  const desc = files['project.json'];
  const meta = desc && JSON.parse(strFromU8(desc));
  if (!meta || meta.format !== '3dpainter-project') throw fail('paintBad');
  if (!files['model.glb']) throw fail('paintBad');
  return { meta, model: files['model.glb'], file: (p) => files[p] || null };
}

// ── сведение слоёв ──────────────────────────────────────────────────────────

const rectW = (r) => r.x1 - r.x0 + 1;
const rectH = (r) => r.y1 - r.y0 + 1;

function readLayer(L, S, file) {
  const n = S * S;
  const out = {
    ...L,
    rgba: new Uint8ClampedArray(n * 4), rough: new Uint8Array(n), metal: new Uint8Array(n),
    opac: new Uint8Array(n).fill(255), mask: null,
  };
  for (const [key, p] of Object.entries(L.files || {})) {
    const b = file(p);
    if (!b) continue;
    if (key === 'mask') out.mask = new Uint8Array(n).fill(255);
    if (out[key] && b.length === out[key].length) out[key].set(b);
  }
  return out;
}

// Выражение лица в рабочий слой части: вырезка по прямоугольнику или пусто.
function putCrop(L, S, r, c) {
  const w = rectW(r), h = rectH(r);
  for (let y = 0; y < h; y++) {
    const dst = (r.y0 + y) * S + r.x0;
    if (c) {
      L.rgba.set(c.rgba.subarray(y * w * 4, (y + 1) * w * 4), dst * 4);
      L.rough.set(c.rough.subarray(y * w, (y + 1) * w), dst);
      L.metal.set(c.metal.subarray(y * w, (y + 1) * w), dst);
      L.opac.set(c.opac.subarray(y * w, (y + 1) * w), dst);
    } else {
      L.rgba.fill(0, dst * 4, (dst + w) * 4);
      L.rough.fill(0, dst, dst + w);
      L.metal.fill(0, dst, dst + w);
      L.opac.fill(255, dst, dst + w);
    }
  }
}

function readCrop(paths, r, file) {
  const n = rectW(r) * rectH(r);
  const c = { rgba: new Uint8ClampedArray(n * 4), rough: new Uint8Array(n), metal: new Uint8Array(n), opac: new Uint8Array(n) };
  for (const key of Object.keys(c)) { const b = file(paths?.[key]); if (b && b.length === c[key].length) c[key].set(b); }
  return c;
}
const cropEmpty = (c) => { for (let i = 3; i < c.rgba.length; i += 4) if (c.rgba[i] > 0) return false; return true; };

// Выражения лица: часть → Map(имя → вырезка), в порядке списка 3DPainter.
function faceExprs(face, file) {
  const out = {};
  for (const slot of SLOTS) {
    const map = new Map();
    const all = face.expressions?.[slot] || {};
    const order = Array.isArray(face.list) ? face.list.filter((x) => x.slot === slot).map((x) => x.id) : [];
    for (const id of [...order, ...Object.keys(all)]) {
      if (map.has(id) || !all[id]) continue;
      const c = readCrop(all[id], face.rect, file);
      if (!cropEmpty(c)) map.set(id, c);
    }
    out[slot] = map;
  }
  return out;
}

/**
 * Итоговые карты меша — как PaintTarget.compositeRect у 3DPainter: подложка,
 * слои снизу вверх с прозрачностью, маской и режимом наложения; поверхность
 * (шероховатость, металл, непрозрачность) смешивается без режимов.
 * Холсты — в ориентации 3DPainter (верх к v = 1).
 */
function composite(S, layers, variant) {
  const color = new Uint8ClampedArray(S * S * 4);
  const orm = new Uint8ClampedArray(S * S * 4);
  let transparent = false, materialPaint = false;
  const on = layers.filter((L) => L.visible && L.opacity > 0 && (L.variant == null || L.variant === variant));
  for (let p = 0; p < S * S; p++) {
    const o = p * 4;
    let r = BG[0], g = BG[1], b = BG[2], rough = BG_ROUGH, metal = BG_METAL, opac = 255;
    for (const L of on) {
      let a = L.rgba[o + 3] / 255;
      if (a <= 0) continue;
      a *= L.opacity;
      if (L.mask) a *= L.mask[p] / 255;
      if (a <= 0) continue;
      const sr = L.rgba[o], sg = L.rgba[o + 1], sb = L.rgba[o + 2];
      let br = sr, bg = sg, bb = sb;
      if (L.blend === 'multiply') { br = (r * sr) / 255; bg = (g * sg) / 255; bb = (b * sb) / 255; }
      else if (L.blend === 'screen') {
        br = 255 - ((255 - r) * (255 - sr)) / 255;
        bg = 255 - ((255 - g) * (255 - sg)) / 255;
        bb = 255 - ((255 - b) * (255 - sb)) / 255;
      }
      r += (br - r) * a; g += (bg - g) * a; b += (bb - b) * a;
      rough += (L.rough[p] - rough) * a;
      metal += (L.metal[p] - metal) * a;
      opac += (L.opac[p] - opac) * a;
    }
    color[o] = r; color[o + 1] = g; color[o + 2] = b; color[o + 3] = opac;
    orm[o] = 255; orm[o + 1] = rough; orm[o + 2] = metal; orm[o + 3] = 255;
    if (opac < 250) transparent = true;
    if (orm[o + 2] > 4 || Math.abs(orm[o + 1] - BG_ROUGH) > 3) materialPaint = true;
  }
  return { color, orm, transparent, materialPaint };
}

function canvasOf(S, data) {
  const c = document.createElement('canvas');
  c.width = c.height = S;
  c.getContext('2d').putImageData(new ImageData(data, S, S), 0, 0);
  return c;
}

const canvasPng = (c) => new Promise((ok) => c.toBlob((b) => b.arrayBuffer().then((a) => ok(new Uint8Array(a))), 'image/png'));

// Части меша — лицо и зоны — своими примитивами: сперва тело, потом части по
// порядку (как разделитьНаЧасти у 3DPainter). Грань берёт первая часть, в
// которую попала; пустая часть примитива не получает.
// 🔴 Вершины не размножаются: у индексированной геометрии переставляется
// только индекс, атрибуты (со скином и морфами) общие. У неиндексированной
// переставляются тройки вершин — их и так 3·граней.
// Временную геометрию с общими атрибутами не освобождать через dispose():
// у отрисованной это сняло бы буферы видеокарты с рабочего меша.
const triCount = (geo) => (geo.index ? geo.index.count : geo.attributes.position.count) / 3;
const countTris = (tris) => { let n = 0; for (let i = 0; i < tris.length; i++) if (tris[i]) n++; return n; };

function splitParts(geo, parts) {
  const n = triCount(geo);
  const owner = new Int16Array(n).fill(-1);
  for (let t = 0; t < n; t++) {
    for (let k = 0; k < parts.length; k++) if (parts[k][t]) { owner[t] = k; break; }
  }
  const order = [];
  const who = [];                                   // по группам: -1 — тело, k — часть
  const out = new THREE.BufferGeometry();
  for (let k = -1; k < parts.length; k++) {
    const start = order.length;
    for (let t = 0; t < n; t++) if (owner[t] === k) order.push(t);
    if (order.length === start) continue;
    out.addGroup(start * 3, (order.length - start) * 3, who.length);
    who.push(k);
  }
  if (geo.index) {
    const src = geo.index.array;
    const idx = new src.constructor(n * 3);
    order.forEach((t, i) => { idx[i * 3] = src[t * 3]; idx[i * 3 + 1] = src[t * 3 + 1]; idx[i * 3 + 2] = src[t * 3 + 2]; });
    for (const [name, a] of Object.entries(geo.attributes)) out.setAttribute(name, a);
    for (const [name, list] of Object.entries(geo.morphAttributes)) out.morphAttributes[name] = list;
    out.setIndex(new THREE.BufferAttribute(idx, 1));
  } else {
    const move = (attr) => {
      const a = attr.isInterleavedBufferAttribute ? attr.clone() : attr;   // clone() снимает чередование
      const k = a.itemSize;
      const arr = new a.array.constructor(n * 3 * k);
      order.forEach((t, i) => arr.set(a.array.subarray(t * 3 * k, (t + 1) * 3 * k), i * 3 * k));
      return new THREE.BufferAttribute(arr, k, a.normalized);
    };
    for (const [name, a] of Object.entries(geo.attributes)) out.setAttribute(name, move(a));
    for (const [name, list] of Object.entries(geo.morphAttributes)) out.morphAttributes[name] = list.map(move);
  }
  out.morphTargetsRelative = geo.morphTargetsRelative;
  return { geometry: out, who };
}

// Атлас части лица: клетки размером с прямоугольник лица, ⌈√n⌉ столбцов,
// строки клетки перевёрнуты — атлас в ориентации картинки GLB (buildAtlas).
function atlas(crops, ids, r) {
  const w = rectW(r), h = rectH(r);
  const columns = Math.ceil(Math.sqrt(Math.max(1, ids.length)));
  const rows = Math.ceil(ids.length / columns);
  const c = document.createElement('canvas');
  c.width = columns * w;
  c.height = rows * h;
  const g = c.getContext('2d');
  ids.forEach((id, k) => {
    const src = crops.get(id).rgba;
    const flipped = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) flipped.set(src.subarray(y * w * 4, (y + 1) * w * 4), (h - 1 - y) * w * 4);
    g.putImageData(new ImageData(flipped, w, h), (k % columns) * w, Math.floor(k / columns) * h);
  });
  return { canvas: c, columns, rows };
}

// Описание лица для игры — то же, что пишет 3DPainter (faceDescription).
function faceDescription({ name, size, rect, eyes, mouth, full, zones = [] }) {
  const w = rectW(rect), h = rectH(rect);
  const y = size - 1 - rect.y1;
  const slot = (a) => a && { file: a.file, columns: a.columns, rows: a.rows, expressions: a.ids };
  return {
    format: '3dpainter-face', version: 1, model: name, material: 'Face',
    texture: { width: size, height: size },
    faceRect: { x: rect.x0, y, width: w, height: h, u0: rect.x0 / size, v0: y / size, u1: (rect.x1 + 1) / size, v1: (y + h) / size },
    cell: { width: w, height: h },
    eyes: slot(eyes), mouth: slot(mouth), full: slot(full),
    // Имена материалов зон в порядке примитивов; старые читатели поле не замечают.
    zones,
  };
}

const meshesOf = (root) => { const out = []; root.traverse((o) => { if (o.isMesh) out.push(o); }); return out; };

/**
 * Проект 3DPainter → GLB с покраской (+ атласы лица).
 * @returns {Promise<{glb: Uint8Array, extras: {name: string, bytes: Uint8Array}[], face: boolean, meta: object}>}
 */
export async function paintToGlb(bytes, base) {
  const { meta, model, file } = readPaint(bytes);
  const gltf = await new GLTFLoader().parseAsync(model.buffer.slice(model.byteOffset, model.byteOffset + model.byteLength), '');
  const meshes = meshesOf(gltf.scene);
  if (meshes.length !== (meta.meshes || []).length) throw fail('paintMismatch');
  // Скелет и движения, сохранённые сюда раньше, — до любых правок модели.
  const restore = rigFromModel(gltf);
  const variant = meta.activeVariant ?? (meta.variants?.[0]?.id ?? null);
  const face = meta.face && meshes[meta.face.mesh] ? meta.face : null;
  const exprs = face ? faceExprs(face, file) : null;
  // Зоны 3DPainter (1.3.0+): именованные наборы граней — своими примитивами с
  // материалом имени зоны. Не тот меш или другое число граней — зона не ложится.
  const zones = (Array.isArray(meta.zones) ? meta.zones : [])
    .map((z) => ({ name: z.name, mesh: z.mesh, tris: file(z.tris) }))
    .filter((z) => z.name && meshes[z.mesh] && z.tris && z.tris.length === triCount(meshes[z.mesh].geometry));
  const zoneNames = [];                          // по порядку примитивов — в описание лица

  meshes.forEach((mesh, i) => {
    const m = meta.meshes[i];
    const S = m.size || meta.texSize || 2048;
    const layers = m.layers.map((L) => readLayer(L, S, file));
    // Лицо — нейтральное выражение, как в выгрузке лица 3DPainter: глаза и
    // рот, а если их нет — всё лицо одной картинкой.
    if (face && face.mesh === i) {
      const separate = exprs.eyes.has('neutral') || exprs.mouth.has('neutral');
      for (const slot of SLOTS) {
        const want = (slot === 'full' ? !separate : true) && exprs[slot].has('neutral') ? 'neutral' : null;
        const L = layers.find((x) => x.slot === slot);
        if (L && face.shown?.[slot] !== want) putCrop(L, S, face.rect, want ? exprs[slot].get(want) : null);
      }
    }
    const k = composite(S, layers, variant);
    const name = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material)?.name || '';
    // Карты — CanvasTexture с flipY, как у 3DPainter: экспортёр сам
    // переворачивает картинку в ориентацию glTF. Холсты — одни на меш: тело и
    // лицо делят картинку, и в файл она ложится один раз.
    const colorCanvas = canvasOf(S, k.color);
    const ormCanvas = k.materialPaint ? canvasOf(S, k.orm) : null;
    const make = (matName) => {
      const map = new THREE.CanvasTexture(colorCanvas);
      map.colorSpace = THREE.SRGBColorSpace;
      const p = { map, roughness: 1, metalness: 0 };
      if (ormCanvas) {
        const ormMap = new THREE.CanvasTexture(ormCanvas);
        Object.assign(p, { roughnessMap: ormMap, metalnessMap: ormMap, metalness: 1 });
      }
      if (k.transparent) Object.assign(p, { transparent: true, side: THREE.DoubleSide });
      const mat = new THREE.MeshStandardMaterial(p);
      mat.name = matName;
      return mat;
    };
    // Части: лицо, потом зоны в порядке списка. Часть на весь меш — без
    // деления, только имя материала; проект без частей — как раньше.
    const parts = [];
    if (face && face.mesh === i) parts.push({ name: 'Face', tris: file(face.tris) || new Uint8Array(0), zone: false });
    for (const z of zones) if (z.mesh === i) parts.push({ ...z, zone: true });
    const live = parts.filter((p) => countTris(p.tris));
    if (!live.length) { mesh.material = make(name); return; }
    const { geometry, who } = splitParts(mesh.geometry, live.map((p) => p.tris));
    for (const k of who) if (k >= 0 && live[k].zone) zoneNames.push(live[k].name);
    const mats = who.map((k) => make(k < 0 ? name : live[k].name));
    if (who.length === 1) { mesh.material = mats[0]; return; }
    mesh.geometry = geometry;
    mesh.material = mats;
  });

  // userData загрузчика (исходные имена узлов) в extras не несём — как 3DPainter.
  gltf.scene.traverse((o) => { o.userData = {}; });
  const glb = await writeGlb(gltf.scene, gltf.animations || []);

  // Атласы выражений и описание лица — рядом с моделью, как у 3DPainter.
  const extras = [];
  if (face) {
    const size = meta.meshes[face.mesh].size || meta.texSize || 2048;
    const make = async (slot) => {
      const ids = [...exprs[slot].keys()];
      if (!ids.length || (slot === 'mouth' && face.mouth === false)) return null;
      const a = atlas(exprs[slot], ids, face.rect);
      const fileName = `${base}_face_${slot}.png`;
      extras.push({ name: fileName, bytes: await canvasPng(a.canvas) });
      return { file: fileName, columns: a.columns, rows: a.rows, ids };
    };
    const eyes = await make('eyes');
    const mouth = await make('mouth');
    const full = await make('full');
    const desc = faceDescription({ name: base, size, rect: face.rect, eyes, mouth, full, zones: zoneNames });
    extras.push({ name: `${base}_face.json`, bytes: new TextEncoder().encode(JSON.stringify(desc, null, 2)) });
  }
  return { glb, extras, face: !!face, meta, restore };
}

// ── из проекта обратно в студию: скелет и движения ──────────────────────────
// Проект, сохранённый студией, несёт скелет и запечённые движения. Если
// студия видит его впервые (другой компьютер, другое имя файла), по ним
// собираются скелет студии (rig.json) и её движения (clips), как будто их
// сделали здесь. Координаты — основы анимации: модель, повёрнутая на turn.
//
// - Кость в файле смотрит своей осью +Y на конец (так её пишет Blender), конец
//   — начало ребёнка на этой оси. У концевой кости (кисть, стопа, голова)
//   длина берётся по той части модели, которую она держит.
// - Движение запечено покадрово, а между ключами студия идёт по известному
//   закону (плавно, ровно, скачком) — ключи находятся обратно: от ключа
//   тянем отрезок, пока все кадры внутри ложатся на один из законов.

const ALLOWED_FPS = [12, 24, 25, 30, 60];
// Запечённые кадры расходятся с расчётом на сотые доли градуса (округление
// ключей, float32) — порог чуть выше, но далеко ниже заметного глазу.
const ROT_TOL = 1e-3;          // радианы (0,06°)
const POS_TOL = 5e-4;          // метры

export function rigFromModel(gltf) {
  const skinned = meshesOf(gltf.scene).filter((m) => m.isSkinnedMesh);
  if (!skinned.length) return null;
  gltf.scene.updateMatrixWorld(true);
  const bones = skinned[0].skeleton.bones;
  const set = new Set(bones);
  // Поворот основы: узел Rig студии висит с обратным поворотом.
  let rigNode = bones[0];
  while (rigNode && rigNode.name !== 'Rig') rigNode = rigNode.parent;
  const q = rigNode?.quaternion;
  const turn = q ? ((Math.round(THREE.MathUtils.radToDeg(-2 * Math.atan2(q.y, q.w))) % 360) + 360) % 360 : 0;
  const toBase = new THREE.Matrix4().makeRotationY(THREE.MathUtils.degToRad(turn));

  const head = new Map();
  const axis = new Map();
  for (const b of bones) {
    head.set(b, new THREE.Vector3().setFromMatrixPosition(b.matrixWorld));
    axis.set(b, new THREE.Vector3().setFromMatrixColumn(b.matrixWorld, 1).normalize());
  }
  const size = new THREE.Box3().setFromObject(skinned[0]).getSize(new THREE.Vector3()).length() || 1;

  // Вершины по костям — для длины концевых костей.
  const held = new Map(bones.map((b) => [b, []]));
  const v = new THREE.Vector3();
  for (const m of skinned) {
    const pos = m.geometry.attributes.position, si = m.geometry.attributes.skinIndex, sw = m.geometry.attributes.skinWeight;
    if (!si || !sw) continue;
    for (let i = 0; i < pos.count; i += 1) {
      for (let k = 0; k < 4; k++) {
        if (sw.getComponent(i, k) < 0.5) continue;
        const b = m.skeleton.bones[si.getComponent(i, k)];
        if (b && held.has(b)) held.get(b).push(v.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld).clone());
      }
    }
  }

  const tail = new Map();
  const lenOf = (b) => (tail.has(b) ? tail.get(b).distanceTo(head.get(b)) : 0);
  const order = [...bones].sort((a, b) => depth(a, set) - depth(b, set));
  for (const b of order) {
    const h = head.get(b), y = axis.get(b);
    // Конец — ближайшее начало ребёнка на оси кости.
    let best = null;
    for (const c of b.children) {
      if (!set.has(c)) continue;
      const d = head.get(c).clone().sub(h);
      const L = d.length();
      if (L > size * 1e-4 && d.dot(y) / L > 0.999 && (!best || L < best.L)) best = { L, p: head.get(c) };
    }
    if (best) { tail.set(b, best.p.clone()); continue; }
    // Метка конца, которую кладёт студия при сохранении (<кость>_end).
    const end = b.children.find((c) => !c.isBone && c.name === `${b.name}_end`);
    if (end) { tail.set(b, new THREE.Vector3().setFromMatrixPosition(end.matrixWorld)); continue; }
    // Концевая: докуда вдоль оси доходит её часть модели.
    let reach = 0;
    for (const p of held.get(b)) reach = Math.max(reach, p.clone().sub(h).dot(y));
    const parent = set.has(b.parent) ? b.parent : null;
    const fallback = parent ? lenOf(parent) * 0.5 : size * 0.05;
    tail.set(b, h.clone().addScaledVector(y, reach > size * 0.005 ? reach : fallback || size * 0.05));
  }

  // Точки: начала и концы, совпадающие — одна точка.
  const joints = {};
  const ids = [];
  const jointOf = (p) => {
    const w = p.clone().applyMatrix4(toBase);
    const near = ids.find(([, q2]) => q2.distanceTo(w) < size * 1e-5);
    if (near) return near[0];
    const id = 'j' + (ids.length + 1);
    ids.push([id, w]);
    joints[id] = w.toArray().map((x) => +x.toFixed(6));
    return id;
  };
  // Порядок костей — как в файле (так их ставил человек): от него зависит привязка.
  const rigBones = bones.map((b) => ({
    name: b.name, parent: set.has(b.parent) ? b.parent.name : null, head: jointOf(head.get(b)), tail: jointOf(tail.get(b)),
  }));

  const clips = (gltf.animations || []).map((a, i) => clipFromAnimation(a, new Set(bones.map((b) => b.name)), i)).filter(Boolean);
  return { turn, rig: { type: 'custom', cx: null, markers: {}, joints, bones: rigBones }, clips };
}

function depth(b, set) { let n = 0; while (set.has(b.parent)) { b = b.parent; n++; } return n; }

const easeK = (e, k) => (e === 'step' ? 0 : e === 'linear' ? k : k * k * (3 - 2 * k));
const qA = new THREE.Quaternion(), qB = new THREE.Quaternion(), qC = new THREE.Quaternion(), qD = new THREE.Quaternion();

// Покадровые позы кости → ключи студии с плавностью.
function keysFromSamples(Q, P, n) {
  const fits = (a, b, e) => {
    // Числа в файле — float32, длина кватерниона чуть меньше 1: без нормировки
    // angleTo видит «поворот» в 0,1° там, где его нет.
    qA.fromArray(Q[a]).normalize(); qB.fromArray(Q[b]).normalize();
    for (let f = a + 1; f < b; f++) {
      const k = easeK(e, (f - a) / (b - a));
      qC.copy(qA).slerp(qB, k).normalize();
      if (qC.angleTo(qD.fromArray(Q[f]).normalize()) > ROT_TOL) return false;
      if (P) for (let j = 0; j < 3; j++) if (Math.abs(P[a][j] + (P[b][j] - P[a][j]) * k - P[f][j]) > POS_TOL) return false;
    }
    return true;
  };
  const keys = [];
  let a = 0;
  while (a < n) {
    // Самый дальний кадр, до которого отрезок ложится на закон. Не до первого
    // промаха: кусок плавного перехода сам плавным переходом не является.
    let bestB = a + 1, bestE = 'linear';
    for (let b = a + 1; b <= n; b++) {
      const e = ['smooth', 'linear', 'step'].find((x) => fits(a, b, x));
      if (e) { bestB = b; bestE = e; }
    }
    keys.push({ f: a, e: bestE });
    a = bestB;
  }
  keys.push({ f: n, e: 'smooth' });
  return keys.map((k) => ({ f: k.f, q: Q[k.f].map((x) => +x.toFixed(6)), e: k.e, ...(P ? { p: P[k.f].map((x) => +x.toFixed(6)) } : {}) }));
}

function clipFromAnimation(anim, boneNames, i) {
  const byBone = {};
  let times = null;
  for (const tr of anim.tracks) {
    const m = /^(.+)\.(quaternion|position)$/.exec(tr.name);
    if (!m || !boneNames.has(m[1])) continue;
    (byBone[m[1]] ||= {})[m[2]] = tr;
    if (!times || tr.times.length > times.length) times = tr.times;
  }
  if (!times || times.length < 2) return null;
  const step = times[1] - times[0];
  const fps = ALLOWED_FPS.reduce((b, x) => (Math.abs(1 / step - x) < Math.abs(1 / step - b) ? x : b), 30);
  const frames = Math.max(1, Math.round(anim.duration * fps));
  const loop = /-loop$/.test(anim.name);
  const keys = {};
  // Значение трека в кадр f (кадры могут не совпадать с выборками — берём ближайшую).
  const at = (tr, f, size) => {
    const t = f / fps;
    let j = 0;
    while (j < tr.times.length - 1 && Math.abs(tr.times[j + 1] - t) <= Math.abs(tr.times[j] - t)) j++;
    return Array.from(tr.values.subarray(j * size, j * size + size));
  };
  for (const [bone, tr] of Object.entries(byBone)) {
    if (!tr.quaternion) continue;
    const Q = [], P = tr.position ? [] : null;
    for (let f = 0; f <= frames; f++) {
      Q.push(at(tr.quaternion, f, 4));
      if (P) P.push(at(tr.position, f, 3));
    }
    let ks = keysFromSamples(Q, P, frames);
    // По кругу последний кадр обычно и есть первый — тогда отдельный ключ не
    // нужен; другой (ключ стоял на последнем кадре) — остаётся.
    const last = ks[ks.length - 1], first = ks[0];
    const same = (x, y) => qA.fromArray(x.q).normalize().angleTo(qB.fromArray(y.q).normalize()) <= ROT_TOL
      && (!x.p || x.p.every((v, j) => Math.abs(v - y.p[j]) <= POS_TOL));
    if (loop && ks.length > 1 && first.f === 0 && same(first, last)) ks = ks.slice(0, -1);
    // Неподвижная кость — один ключ, а не два одинаковых.
    if (ks.length === 2 && same(ks[0], ks[1])) ks = ks.slice(0, 1);
    keys[bone] = ks;
  }
  if (!Object.keys(keys).length) return null;
  const name = anim.name.replace(/-loop$/, '').replace(/_/g, ' ').trim() || `Motion ${i + 1}`;
  return { id: 'r' + i + Date.now().toString(36), name, fps, frames, loop, created: Date.now() + i, keys };
}

// ── обратно в проект: модель проекта + скелет и движения ────────────────────

/**
 * Модель для проекта 3DPainter: геометрия проекта грань в грань (сведённая в
 * мировые координаты), кости и веса — с привязанной модели (skin.glb),
 * движения — запечённые клипы. Скелет висит под узлом с обратным поворотом
 * основы: основа анимации могла быть повёрнута лицом вперёд, а геометрия
 * проекта остаётся, как была.
 *
 * @param {Uint8Array} paintBytes  проект
 * @param {string} skinUrl         привязанная модель
 * @param {number} turn            поворот основы, градусы вокруг вертикали
 * @param {object[]} clips         движения (JSON студии)
 * @param {object} [rig]           скелет студии: концы концевых костей — метками
 * @returns {Promise<{glb: Uint8Array, report: {meshes: number, maxDist: number}}>}
 */
export async function paintModelWithRig(paintBytes, skinUrl, turn, clips, rig = null) {
  const { meta, model } = readPaint(paintBytes);
  const loader = new GLTFLoader();
  const src = await loader.parseAsync(model.buffer.slice(model.byteOffset, model.byteOffset + model.byteLength), '');
  const skin = await loader.loadAsync(skinUrl);
  src.scene.updateMatrixWorld(true);
  skin.scene.updateMatrixWorld(true);

  const skinned = meshesOf(skin.scene).filter((m) => m.isSkinnedMesh);
  if (!skinned.length) throw fail('paintNoSkin');
  // Кости — в порядке скелета студии: от порядка зависит привязка Blender'а,
  // и при восстановлении из файла скелет должен прийти тем же.
  const rank = new Map((rig?.bones || []).map((b, i) => [b.name, i]));
  const bones = [...skinned[0].skeleton.bones].sort((a, b) => (rank.get(a.name) ?? 1e9) - (rank.get(b.name) ?? 1e9));
  const boneIndex = new Map(bones.map((b, i) => [b.name, i]));

  // Точки привязанной модели (в покое) с весами — в сетку для поиска ближайшей.
  const pts = [];
  const tmp = new THREE.Vector3();
  for (const m of skinned) {
    const pos = m.geometry.attributes.position, si = m.geometry.attributes.skinIndex, sw = m.geometry.attributes.skinWeight;
    for (let v = 0; v < pos.count; v++) {
      tmp.fromBufferAttribute(pos, v).applyMatrix4(m.matrixWorld);
      const idx = [0, 1, 2, 3].map((k) => boneIndex.get(m.skeleton.bones[si.getComponent(v, k)]?.name) ?? 0);
      pts.push({ p: tmp.clone(), idx, w: [0, 1, 2, 3].map((k) => sw.getComponent(v, k)) });
    }
  }
  const box = new THREE.Box3().setFromPoints(pts.map((x) => x.p));
  const cell = Math.max(box.getSize(new THREE.Vector3()).length() / 150, 1e-4);
  const grid = new Map();
  const key = (x, y, z) => `${x},${y},${z}`;
  for (const q of pts) {
    const k = key(Math.floor(q.p.x / cell), Math.floor(q.p.y / cell), Math.floor(q.p.z / cell));
    (grid.get(k) || grid.set(k, []).get(k)).push(q);
  }
  const nearest = (p) => {
    const cx = Math.floor(p.x / cell), cy = Math.floor(p.y / cell), cz = Math.floor(p.z / cell);
    for (let r = 1; r < 64; r++) {
      let best = null, bd = Infinity;
      for (let x = cx - r; x <= cx + r; x++) for (let y = cy - r; y <= cy + r; y++) for (let z = cz - r; z <= cz + r; z++) {
        for (const q of grid.get(key(x, y, z)) || []) { const d = q.p.distanceToSquared(p); if (d < bd) { bd = d; best = q; } }
      }
      if (best && Math.sqrt(bd) <= r * cell) return { q: best, d: Math.sqrt(bd) };
    }
    return null;
  };

  // Скелет: копия арматуры привязанной модели под узлом с обратным поворотом.
  const toBase = new THREE.Matrix4().makeRotationY(THREE.MathUtils.degToRad(turn || 0));
  const rigRoot = new THREE.Group();
  rigRoot.name = 'Rig';
  rigRoot.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeRotationY(-THREE.MathUtils.degToRad(turn || 0)));
  let top = bones[0];
  while (top.parent && top.parent !== skin.scene && !top.parent.isSkinnedMesh) top = top.parent;
  rigRoot.add(top);
  // Сетки привязанной модели, висящие под арматурой, в проект не берём.
  const stray = [];
  rigRoot.traverse((o) => { if (o.isMesh) stray.push(o); });
  stray.forEach((o) => o.removeFromParent());

  const scene = new THREE.Scene();
  let maxDist = 0;
  const out = [];
  for (const m of meshesOf(src.scene)) {
    const geo = m.geometry.clone();
    geo.applyMatrix4(m.matrixWorld);               // геометрия — в мировых, порядок граней тот же
    const pos = geo.attributes.position;
    const si = new Uint16Array(pos.count * 4), sw = new Float32Array(pos.count * 4);
    for (let v = 0; v < pos.count; v++) {
      tmp.fromBufferAttribute(pos, v).applyMatrix4(toBase);
      const hit = nearest(tmp);
      if (!hit) { sw[v * 4] = 1; continue; }
      maxDist = Math.max(maxDist, hit.d);
      si.set(hit.q.idx, v * 4);
      sw.set(hit.q.w, v * 4);
    }
    geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4));
    geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(sw, 4));
    // Материал — простой, с именем исходного, как в проекте 3DPainter.
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1 });
    mat.name = (Array.isArray(m.material) ? m.material[0] : m.material)?.name || '';
    const sm = new THREE.SkinnedMesh(geo, mat);
    sm.name = m.name;
    out.push(sm);
    scene.add(sm);
  }
  if (out.length !== (meta.meshes || []).length) throw fail('paintMismatch');
  scene.add(rigRoot);
  scene.updateMatrixWorld(true);
  const skeleton = new THREE.Skeleton(bones);      // обратные матрицы — по позе покоя сейчас
  for (const sm of out) sm.bind(skeleton);
  // Конец кости в glTF не хранится: у концевых костей — пустой узел
  // <кость>_end на месте конца. По нему студия восстановит скелет из файла
  // точно (src/painter.js, rigFromModel); 3DPainter такие узлы сохраняет.
  if (rig?.joints && Array.isArray(rig.bones)) {
    const heads = new Set(rig.bones.map((b) => b.head));
    const fromBase = new THREE.Matrix4().makeRotationY(-THREE.MathUtils.degToRad(turn || 0));
    for (const b of rig.bones) {
      const bone = bones.find((x) => x.name === b.name);
      const p = rig.joints[b.tail];
      if (!bone || !p || rig.bones.some((c) => c.parent === b.name && c.head === b.tail) || heads.has(b.tail)) continue;
      const end = new THREE.Object3D();
      end.name = `${b.name}_end`;
      end.position.copy(bone.worldToLocal(new THREE.Vector3(...p).applyMatrix4(fromBase)));
      bone.add(end);
    }
    scene.updateMatrixWorld(true);
  }

  const names = bones.map((b) => b.name);
  const anims = clips.filter((c) => Object.keys(c.keys || {}).length).map((c) => bake(c, names));
  const glb = await writeGlb(scene, anims);
  return { glb, report: { meshes: out.length, maxDist } };
}

export function toBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
