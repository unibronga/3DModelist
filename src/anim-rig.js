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

  // Точки стороны, куда их поставили; вторая — зеркало.
  const sides = markers.wrist[0] >= cx ? { L: (p) => p, R: (p) => mirror(p, cx) } : { L: (p) => mirror(p, cx), R: (p) => p };
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

// Пара сустава на другой стороне: elbow.L ↔ elbow.R; у осевых — null.
export const pairOf = (name) => (/\.L$/.test(name) ? name.replace(/L$/, 'R') : /\.R$/.test(name) ? name.replace(/R$/, 'L') : null);
export const pairBone = (name) => (/^Left/.test(name) ? name.replace(/^Left/, 'Right') : /^Right/.test(name) ? name.replace(/^Right/, 'Left') : null);

export { lerp };
