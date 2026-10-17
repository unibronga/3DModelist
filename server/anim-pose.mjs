// Движение без страницы: поза в любой кадр, GLB с движением для Blender и
// замеры позы — чтобы агент проверял своё движение, а не ставил ключи вслепую.
//
// Источник — привязанная модель anim/<модель>/skin.glb (узлы костей с позой
// покоя) и движение студии (clips/<id>.json). Законы перехода между ключами —
// те же, что у страницы (src/anim-clip.js): плавно, ровно, скачком, по кругу.

import fs from 'node:fs';

// ── кватернионы [x, y, z, w] и матрицы 4×4 (по столбцам, как в glTF) ────────
const qnorm = (q) => { const l = Math.hypot(...q) || 1; return q.map((v) => v / l); };
function slerp(a, b, t) {
  let [bx, by, bz, bw] = b;
  let cos = a[0] * bx + a[1] * by + a[2] * bz + a[3] * bw;
  if (cos < 0) { cos = -cos; bx = -bx; by = -by; bz = -bz; bw = -bw; }
  if (cos > 0.9995) return qnorm([a[0] + (bx - a[0]) * t, a[1] + (by - a[1]) * t, a[2] + (bz - a[2]) * t, a[3] + (bw - a[3]) * t]);
  const th = Math.acos(cos), s = Math.sin(th);
  const ka = Math.sin((1 - t) * th) / s, kb = Math.sin(t * th) / s;
  return [a[0] * ka + bx * kb, a[1] * ka + by * kb, a[2] * ka + bz * kb, a[3] * ka + bw * kb];
}
function compose(t = [0, 0, 0], q = [0, 0, 0, 1], s = [1, 1, 1]) {
  const [x, y, z, w] = q;
  return [
    (1 - 2 * (y * y + z * z)) * s[0], 2 * (x * y + z * w) * s[0], 2 * (x * z - y * w) * s[0], 0,
    2 * (x * y - z * w) * s[1], (1 - 2 * (x * x + z * z)) * s[1], 2 * (y * z + x * w) * s[1], 0,
    2 * (x * z + y * w) * s[2], 2 * (y * z - x * w) * s[2], (1 - 2 * (x * x + y * y)) * s[2], 0,
    t[0], t[1], t[2], 1,
  ];
}
function mmul(a, b) {
  const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return o;
}
const apply = (m, p) => [0, 1, 2].map((r) => m[r] * p[0] + m[4 + r] * p[1] + m[8 + r] * p[2] + m[12 + r]);
function invRigid(m) {   // обратная к повороту со сдвигом (масштаб костей — 1): [Rᵀ | −Rᵀt]
  const t = [m[12], m[13], m[14]];
  const col = (c) => [m[c * 4], m[c * 4 + 1], m[c * 4 + 2]];     // столбец R = строка Rᵀ
  const [c0, c1, c2] = [col(0), col(1), col(2)];
  const d = (a) => a[0] * t[0] + a[1] * t[1] + a[2] * t[2];
  return [c0[0], c1[0], c2[0], 0, c0[1], c1[1], c2[1], 0, c0[2], c1[2], c2[2], 0, -d(c0), -d(c1), -d(c2), 1];
}

// ── GLB ─────────────────────────────────────────────────────────────────────
export function readGlb(file) {
  const buf = fs.readFileSync(file);
  const len = buf.readUInt32LE(12);
  const json = JSON.parse(buf.subarray(20, 20 + len).toString('utf8'));
  const bin = buf.subarray(20 + len + 8, 20 + len + 8 + buf.readUInt32LE(20 + len));
  return { json, bin };
}
function writeGlb(file, json, bin) {
  let text = Buffer.from(JSON.stringify(json), 'utf8');
  text = Buffer.concat([text, Buffer.alloc((4 - (text.length % 4)) % 4, 0x20)]);
  const b = Buffer.concat([bin, Buffer.alloc((4 - (bin.length % 4)) % 4, 0)]);
  const head = Buffer.alloc(12);
  head.writeUInt32LE(0x46546c67, 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(12 + 8 + text.length + 8 + b.length, 8);
  const c1 = Buffer.alloc(8); c1.writeUInt32LE(text.length, 0); c1.writeUInt32LE(0x4e4f534a, 4);
  const c2 = Buffer.alloc(8); c2.writeUInt32LE(b.length, 0); c2.writeUInt32LE(0x004e4942, 4);
  fs.writeFileSync(file, Buffer.concat([head, c1, text, c2, b]));
}

// ── поза в кадр — как sample() у страницы ───────────────────────────────────
const ease = (e, k) => (e === 'step' ? 0 : e === 'linear' ? k : k * k * (3 - 2 * k));
export function sample(clip, bone, f) {
  const ks = clip.keys[bone];
  if (!ks?.length) return null;
  const n = clip.frames;
  let a, b, fa, fb;
  const i = ks.findIndex((k) => k.f > f);
  if (i === -1) {
    a = ks[ks.length - 1]; fa = a.f;
    if (!clip.loop) return { q: a.q, p: a.p || null };
    b = ks[0]; fb = b.f + n;
  } else if (i === 0) {
    b = ks[0]; fb = b.f;
    if (!clip.loop) return { q: b.q, p: b.p || null };
    a = ks[ks.length - 1]; fa = a.f - n;
  } else { a = ks[i - 1]; b = ks[i]; fa = a.f; fb = b.f; }
  if (a === b || fb <= fa) return { q: a.q, p: a.p || null };
  const k = ease(a.e || 'smooth', (f - fa) / (fb - fa));
  const p = a.p && b.p ? a.p.map((v, j) => v + (b.p[j] - v) * k) : a.p || b.p || null;
  return { q: slerp(qnorm(a.q), qnorm(b.q), k), p };
}

// Скелет привязанной модели: узлы, родители, поза покоя.
export function skeleton(skinFile) {
  const { json, bin } = readGlb(skinFile);
  const parent = new Map();
  json.nodes.forEach((n, i) => (n.children || []).forEach((c) => parent.set(c, i)));
  const joints = new Set(json.skins?.[0]?.joints || []);
  const byName = new Map(json.nodes.map((n, i) => [n.name, i]));
  return { json, bin, parent, joints, byName };
}

// Мировые матрицы всех узлов в кадр f (без движения — поза покоя).
export function worlds(sk, clip = null, f = 0) {
  const W = new Map();
  const local = (i) => {
    const n = sk.json.nodes[i];
    if (n.matrix) return n.matrix;
    const s = clip && sk.joints.has(i) ? sample(clip, n.name, f) : null;
    return compose(s?.p || n.translation, s?.q || n.rotation, n.scale);
  };
  const get = (i) => {
    if (W.has(i)) return W.get(i);
    const m = sk.parent.has(i) ? mmul(get(sk.parent.get(i)), local(i)) : local(i);
    W.set(i, m);
    return m;
  };
  sk.json.nodes.forEach((_, i) => get(i));
  return W;
}

/**
 * Привязанная модель + движение → GLB с одной анимацией (для Blender).
 * Каждый кадр — ключ, как в выгрузке студии.
 */
export function bakeGlb(skinFile, clip, out) {
  const sk = skeleton(skinFile);
  const { json } = sk;
  const parts = [sk.bin];
  let off = sk.bin.length + ((4 - (sk.bin.length % 4)) % 4);
  if (off > sk.bin.length) parts.push(Buffer.alloc(off - sk.bin.length));
  json.bufferViews ||= []; json.accessors ||= [];
  const push = (arr, type, count, extra = {}) => {
    const b = Buffer.from(new Float32Array(arr).buffer);
    json.bufferViews.push({ buffer: 0, byteOffset: off, byteLength: b.length });
    json.accessors.push({ bufferView: json.bufferViews.length - 1, componentType: 5126, count, type, ...extra });
    parts.push(b);
    off += b.length;
    return json.accessors.length - 1;
  };
  const n = clip.frames + 1;
  const times = Array.from({ length: n }, (_, i) => i / clip.fps);
  const input = push(times, 'SCALAR', n, { min: [0], max: [times[n - 1]] });
  const samplers = [], channels = [];
  for (const bone of Object.keys(clip.keys)) {
    const node = sk.byName.get(bone);
    if (node == null || !clip.keys[bone]?.length) continue;
    const q = [], p = [];
    const hasP = clip.keys[bone].some((k) => k.p);
    for (let f = 0; f < n; f++) {
      const s = sample(clip, bone, f);
      q.push(...s.q);
      if (hasP) p.push(...(s.p || json.nodes[node].translation || [0, 0, 0]));
    }
    samplers.push({ input, output: push(q, 'VEC4', n), interpolation: 'LINEAR' });
    channels.push({ sampler: samplers.length - 1, target: { node, path: 'rotation' } });
    if (hasP) {
      samplers.push({ input, output: push(p, 'VEC3', n), interpolation: 'LINEAR' });
      channels.push({ sampler: samplers.length - 1, target: { node, path: 'translation' } });
    }
  }
  json.animations = [{ name: 'check', samplers, channels }];
  const bin = Buffer.concat(parts);
  json.buffers[0].byteLength = bin.length + ((4 - (bin.length % 4)) % 4);
  writeGlb(out, json, bin);
}

/**
 * Замеры позы по кадрам — то, что на глаз легко пропустить. Оси модели:
 * Y вверх, лицом на +Z, левая сторона персонажа — +X.
 * rig — скелет студии (концы костей), floor — высота пола.
 * Возвращает строки для агента (пусто — замечаний нет).
 */
export function poseChecks(skinFile, clip, rig, floor = 0) {
  const sk = skeleton(skinFile);
  const rest = worlds(sk);
  const bone = new Map(rig.bones.map((b) => [b.name, b]));
  // Конец кости в её осях — по позе покоя.
  const tailLocal = new Map();
  for (const b of rig.bones) {
    const i = sk.byName.get(b.name);
    if (i == null || !rig.joints[b.tail]) continue;
    tailLocal.set(b.name, apply(invRigid(rest.get(i)), rig.joints[b.tail]));
  }
  const at = (W, name) => { const i = sk.byName.get(name); return i == null ? null : [W.get(i)[12], W.get(i)[13], W.get(i)[14]]; };
  const tailAt = (W, name) => { const i = sk.byName.get(name); return i == null || !tailLocal.has(name) ? null : apply(W.get(i), tailLocal.get(name)); };
  const deg = (r) => Math.round((r * 180) / Math.PI);
  // Отведение плеча от тела во фронтальной плоскости (0° — рука вдоль тела).
  const abduction = (W, side) => {
    const h = at(W, side + 'UpperArm'), t = tailAt(W, side + 'UpperArm');
    if (!h || !t) return null;
    const dx = (t[0] - h[0]) * (side === 'Left' ? 1 : -1), dy = h[1] - t[1];
    return deg(Math.atan2(dx, dy));
  };
  const human = bone.has('Hips') && bone.has('LeftUpperArm');
  const lines = [];
  if (!human) return lines;
  const restAbd = abduction(rest, 'Left');
  const hipW = Math.abs((at(rest, 'LeftUpperLeg')?.[0] ?? 0) - (at(rest, 'RightUpperLeg')?.[0] ?? 0));
  let abd = { Left: [999, -999], Right: [999, -999] }, spread = 0, low = Infinity, lowAt = 0;
  for (let f = 0; f <= clip.frames; f++) {
    const W = worlds(sk, clip, f);
    for (const s of ['Left', 'Right']) { const a = abduction(W, s); if (a != null) abd[s] = [Math.min(abd[s][0], a), Math.max(abd[s][1], a)]; }
    const fl = tailAt(W, 'LeftFoot') || at(W, 'LeftFoot'), fr = tailAt(W, 'RightFoot') || at(W, 'RightFoot');
    if (fl && fr) spread = Math.max(spread, Math.abs(fl[0] - fr[0]));
    for (const n of ['LeftFoot', 'RightFoot', 'LeftToes', 'RightToes']) {
      const p = tailAt(W, n);
      if (p && p[1] < low) { low = p[1]; lowAt = f; }
    }
  }
  lines.push(`Руки: в покое (A-поза) плечо отведено от тела на ${restAbd}°. В движении: левое ${abd.Left[0]}…${abd.Left[1]}°, правое ${abd.Right[0]}…${abd.Right[1]}° (0° — рука вдоль тела).`);
  if (Number.isFinite(spread) && hipW > 0) lines.push(`Стопы: наибольший разнос по ширине ${spread.toFixed(2)} м при ширине таза ${hipW.toFixed(2)} м.`);
  if (Number.isFinite(low)) lines.push(`Пол на высоте ${floor.toFixed(3)} м; ниже всего носок опускается до ${low.toFixed(3)} м (кадр ${lowAt})${low < floor - 0.01 ? ' — уходит под пол' : ''}.`);
  return lines;
}
