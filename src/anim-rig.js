// Скелет «Человек» по пяти точкам — как авто-риг Mixamo: подбородок, запястье,
// локоть, колено, пах. Вторая сторона — зеркально. Точки и суставы — в
// координатах модели (glTF: Y вверх, лицом на +Z, левая сторона персонажа —
// +X). Имена костей — как у Unity Humanoid: Unity и Godot узнают их сами.

export const HUMAN_POINTS = ['chin', 'wrist', 'elbow', 'knee', 'groin'];
export const MIRRORED = new Set(['wrist', 'elbow', 'knee']);

// Кость: имя, родитель, сустав-начало, сустав-конец.
const SIDE = (s) => [
  [`${s}Shoulder`, 'Chest', `clav.${s[0]}`, `shoulder.${s[0]}`],
  [`${s}UpperArm`, `${s}Shoulder`, `shoulder.${s[0]}`, `elbow.${s[0]}`],
  [`${s}LowerArm`, `${s}UpperArm`, `elbow.${s[0]}`, `wrist.${s[0]}`],
  [`${s}Hand`, `${s}LowerArm`, `wrist.${s[0]}`, `handEnd.${s[0]}`],
  [`${s}UpperLeg`, 'Hips', `hip.${s[0]}`, `knee.${s[0]}`],
  [`${s}LowerLeg`, `${s}UpperLeg`, `knee.${s[0]}`, `ankle.${s[0]}`],
  [`${s}Foot`, `${s}LowerLeg`, `ankle.${s[0]}`, `toe.${s[0]}`],
  [`${s}Toes`, `${s}Foot`, `toe.${s[0]}`, `toeEnd.${s[0]}`],
];
export const HUMAN_BONES = [
  ['Hips', null, 'hips', 'spine'],
  ['Spine', 'Hips', 'spine', 'chest'],
  ['Chest', 'Spine', 'chest', 'neck'],
  ['Neck', 'Chest', 'neck', 'head'],
  ['Head', 'Neck', 'head', 'headTop'],
  ...SIDE('Left'),
  ...SIDE('Right'),
].map(([name, parent, head, tail]) => ({ name, parent, head, tail }));

const add = (a, b) => a.map((v, i) => v + b[i]);
const sub = (a, b) => a.map((v, i) => v - b[i]);
const mul = (a, k) => a.map((v) => v * k);
const len = (a) => Math.hypot(...a);
const norm = (a) => mul(a, 1 / (len(a) || 1));
const lerp = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);

// Ось симметрии — по подбородку и паху (они посередине тела).
export function centerX(markers) {
  return (markers.chin[0] + markers.groin[0]) / 2;
}

// Точка на другой стороне тела.
export const mirror = (p, cx) => [2 * cx - p[0], p[1], p[2]];

// Суставы по точкам. box — габариты модели: {min:[x,y,z], max:[x,y,z]}.
export function buildHuman(markers, box) {
  const cx = centerX(markers);
  const C = markers.chin;
  const G = markers.groin;
  const floor = box.min[1];
  const top = box.max[1];
  const H = C[1] - G[1];                       // от паха до подбородка
  const zc = (C[2] + G[2]) / 2;
  const j = {};
  j.hips = [cx, G[1] + 0.1 * H, G[2]];
  j.spine = [cx, G[1] + 0.38 * H, zc];
  j.chest = [cx, G[1] + 0.66 * H, zc];
  j.neck = [cx, C[1] - 0.12 * H, (zc + C[2]) / 2];
  j.head = [cx, C[1], C[2]];
  j.headTop = [cx, top, C[2]];

  // Каждая точка — на свою сторону по своему месту: запястье могли поставить
  // на левой руке, а колено — на правой ноге (так и было у Kian 13.10, и ноги
  // вышли подписаны наоборот). Левая сторона персонажа — +X.
  const toL = (p) => (p[0] >= cx ? p : mirror(p, cx));
  const sides = { L: (p) => toL(p), R: (p) => mirror(toL(p), cx) };
  for (const s of ['L', 'R']) {
    const f = sides[s];
    const W = f(markers.wrist);
    const E = f(markers.elbow);
    const K = f(markers.knee);
    const sign = s === 'L' ? 1 : -1;
    const fore = len(sub(W, E));
    // Плечо — на продолжении предплечья за локоть, не ближе к оси, чем полпути до локтя.
    let sh = add(E, mul(norm(sub(E, W)), fore));
    const minOff = Math.abs(E[0] - cx) * 0.45;
    if ((sh[0] - cx) * sign < minOff) sh = [cx + sign * minOff, sh[1], sh[2]];
    sh = [sh[0], Math.min(sh[1], j.neck[1]), (sh[2] + zc) / 2];
    j[`shoulder.${s}`] = sh;
    j[`clav.${s}`] = [cx + sign * Math.abs(sh[0] - cx) * 0.2, sh[1], zc];
    j[`elbow.${s}`] = E;
    j[`wrist.${s}`] = W;
    j[`handEnd.${s}`] = add(W, mul(norm(sub(W, E)), fore * 0.5));
    const leg = K[1] - floor;
    j[`hip.${s}`] = [K[0], j.hips[1] - 0.06 * H, G[2]];
    j[`knee.${s}`] = K;
    j[`ankle.${s}`] = [K[0], floor + leg * 0.3, K[2]];
    j[`toe.${s}`] = [K[0], floor + leg * 0.08, K[2] + leg * 0.35];
    j[`toeEnd.${s}`] = [K[0], floor + leg * 0.06, K[2] + leg * 0.55];
  }
  return j;
}

// Сторона сустава или кости: L — левая персонажа (+X), R — правая, C — ось.
// «Человек»: elbow.L, LeftUpperArm; свои кости и суставы: j3_L, Bone3_L.
export const sideOf = (id) => (/^Left|[._]L$/.test(id) ? 'L' : /^Right|[._]R$/.test(id) ? 'R' : 'C');
// Пара на другой стороне: elbow.L ↔ elbow.R, j3_L ↔ j3_R; у осевых — null.
export const pairOf = (id) => (/[._]L$/.test(id) ? id.slice(0, -1) + 'R' : /[._]R$/.test(id) ? id.slice(0, -1) + 'L' : null);
export const pairBone = (name) => (/^Left/.test(name) ? name.replace(/^Left/, 'Right') : /^Right/.test(name) ? name.replace(/^Right/, 'Left') : pairOf(name));

export { lerp };

// ── пальцы варежкой ─────────────────────────────────────────────────────────
// Две кости на кисть: четыре пальца вместе (Fingers) и большой (Thumb) — хватит,
// чтобы сжать кулак и взять предмет. Места — по форме самой кисти: точки
// модели за запястьем, одним куском с ладонью. Кончики пальцев — дальше всего
// по оси кисти, большой палец — дальше всего вперёд (в A-позе ладони смотрят
// к телу, большие пальцы — вперёд, на +Z).
//
// pts — точки модели [x,y,z], tris — тройки номеров точек (для кусков),
// wrist/handEnd — сустав запястья и прежний конец кисти.
// Возвращает { knuckle, fingersEnd, thumb, thumbEnd } или null.
export function handFingers(pts, tris, wrist, handEnd) {
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const L0 = len(sub(handEnd, wrist));
  if (!(L0 > 0)) return null;
  const axis = norm(sub(handEnd, wrist));
  const tOf = (p) => dot(sub(p, wrist), axis);
  const radial = (p) => len(sub(sub(p, wrist), mul(axis, tOf(p))));
  // Область кисти: за запястьем, не дальше трёх длин кисти, недалеко от оси.
  const inRegion = (p) => { const tt = tOf(p); return tt > -0.05 * L0 && tt < 3 * L0 && radial(p) < 1.4 * L0; };
  // Куски — по общим точкам (сетка разрезана по швам: склеиваем по месту).
  const key = (p) => p.map((v) => Math.round(v * 2000)).join(',');
  const id = new Map();
  const ids = pts.map((p) => { const k = key(p); if (!id.has(k)) id.set(k, id.size); return id.get(k); });
  const parent = Array.from({ length: id.size }, (_, i) => i);
  const find = (a) => { while (parent[a] !== a) a = parent[a] = parent[parent[a]]; return a; };
  for (let i = 0; i < tris.length; i += 3) {
    const [a, b, c] = [tris[i], tris[i + 1], tris[i + 2]];
    if (!inRegion(pts[a]) || !inRegion(pts[b]) || !inRegion(pts[c])) continue;
    const ra = find(ids[a]);
    parent[find(ids[b])] = ra;
    parent[find(ids[c])] = ra;
  }
  // Ладонь — кусок у середины кисти.
  const palm = add(wrist, mul(axis, L0 * 0.5));
  let best = -1, bd = Infinity;
  pts.forEach((p, i) => { if (inRegion(p)) { const d = len(sub(p, palm)); if (d < bd) { bd = d; best = i; } } });
  if (best < 0) return null;
  const root = find(ids[best]);
  const hand = pts.filter((p, i) => inRegion(p) && find(ids[i]) === root);
  if (hand.length < 12) return null;
  const T = Math.max(...hand.map(tOf));
  if (!(T > 0.3 * L0)) return null;
  const mean = (list) => mul(list.reduce((s, p) => add(s, p), [0, 0, 0]), 1 / list.length);
  const slab = (a, b) => { const s = hand.filter((p) => { const tt = tOf(p) / T; return tt >= a && tt <= b; }); return s.length ? s : null; };
  const knuckleSlab = slab(0.42, 0.56);
  const tipSlab = slab(0.88, 1);
  if (!knuckleSlab || !tipSlab) return null;
  const knuckle = mean(knuckleSlab);
  const fingersEnd = mean(tipSlab);
  // Большой палец — вперёд, поперёк оси кисти.
  let f = [0, 0, 1];
  f = norm(sub(f, mul(axis, dot(f, axis))));
  const side = slab(0.08, 0.8) || hand;
  const thumbEnd = side.reduce((m, p) => (dot(p, f) > dot(m, f) ? p : m), side[0]);
  const baseSlab = slab(0.05, 0.3) || side;
  const baseC = mean(baseSlab);
  const reach = Math.max(...baseSlab.map((p) => dot(sub(p, baseC), f)));
  const thumb = add(baseC, mul(f, reach * 0.6));
  if (len(sub(thumbEnd, thumb)) < 0.15 * L0) return null;
  return { knuckle, fingersEnd, thumb, thumbEnd };
}
