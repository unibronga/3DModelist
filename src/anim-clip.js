// Движение (клип): ключи по костям → поза в любой кадр.
//   { id, name, pack, fps, frames, loop, created,
//     keys: { Кость: [{ f, q:[x,y,z,w], p?:[x,y,z], e }] } }
// q — поворот кости в её родителе (как в glTF), p — сдвиг (только у таза).
// e — как идти от этого ключа к следующему: плавно, ровно или скачком.
// По кругу: после последнего ключа поза идёт к первому, как к кадру frames.

import * as THREE from 'three';

export const EASES = ['smooth', 'linear', 'step'];
const ease = (e, k) => (e === 'step' ? 0 : e === 'linear' ? k : k * k * (3 - 2 * k));

export function newClip({ name, pack, fps = 30, frames = 30 }) {
  return { id: 'c' + Date.now().toString(36), name, pack, fps, frames, loop: true, created: Date.now(), keys: {} };
}

const qa = new THREE.Quaternion();
const qb = new THREE.Quaternion();

// Поза кости в кадре f (может быть дробным): { q, p } или null — ключей нет.
export function sample(clip, bone, f) {
  const ks = clip.keys[bone];
  if (!ks?.length) return null;
  const n = clip.frames;
  let a;
  let b;
  let fa;
  let fb;
  const i = ks.findIndex((k) => k.f > f);
  if (i === -1) {
    a = ks[ks.length - 1]; fa = a.f;
    if (!clip.loop) return { q: a.q, p: a.p || null };
    b = ks[0]; fb = b.f + n;
  } else if (i === 0) {
    b = ks[0]; fb = b.f;
    if (!clip.loop) return { q: b.q, p: b.p || null };
    a = ks[ks.length - 1]; fa = a.f - n;
  } else {
    a = ks[i - 1]; b = ks[i]; fa = a.f; fb = b.f;
  }
  if (a === b || fb <= fa) return { q: a.q, p: a.p || null };
  const k = ease(a.e || 'smooth', (f - fa) / (fb - fa));
  const q = qa.fromArray(a.q).slerp(qb.fromArray(b.q), k).toArray();
  const p = a.p && b.p ? a.p.map((v, j) => v + (b.p[j] - v) * k) : a.p || b.p || null;
  return { q, p };
}

// Поставить ключ: на этом кадре уже есть — заменить значение, плавность оставить.
export function setKey(clip, bone, f, q, p = null) {
  const ks = (clip.keys[bone] ||= []);
  const old = ks.find((k) => k.f === f);
  const key = { f, q: q.map((v) => +v.toFixed(6)), e: old?.e || 'smooth' };
  if (p) key.p = p.map((v) => +v.toFixed(6));
  if (old) Object.assign(old, key);
  else { ks.push(key); ks.sort((x, y) => x.f - y.f); }
}

export function deleteKey(clip, bone, f) {
  const ks = clip.keys[bone];
  if (!ks) return;
  clip.keys[bone] = ks.filter((k) => k.f !== f);
  if (!clip.keys[bone].length) delete clip.keys[bone];
}

// Перенести ключ на другой кадр (там уже есть — заменить).
export function moveKey(clip, bone, from, to) {
  const ks = clip.keys[bone];
  const k = ks?.find((x) => x.f === from);
  if (!k || from === to) return;
  clip.keys[bone] = ks.filter((x) => x.f !== to);
  k.f = to;
  clip.keys[bone].sort((x, y) => x.f - y.f);
}

export const keyAt = (clip, bone, f) => clip.keys[bone]?.find((k) => k.f === f) || null;

// Кадры, где есть хоть один ключ.
export function keyFrames(clip) {
  const s = new Set();
  for (const ks of Object.values(clip.keys)) for (const k of ks) s.add(k.f);
  return [...s].sort((a, b) => a - b);
}

// Движение → клип three.js: поза снята в каждом кадре — в Godot, Unity и
// Blender оно выглядит точно как здесь, с той же плавностью. Кадры 0…frames:
// у движения по кругу последний равен первому, и круг замыкается без рывка.
export function bake(clip, boneNames) {
  const count = clip.frames + 1;
  const times = Float32Array.from({ length: count }, (_, i) => i / clip.fps);
  const tracks = [];
  for (const bone of boneNames) {
    if (!clip.keys[bone]?.length) continue;
    const q = new Float32Array(count * 4);
    const hasP = clip.keys[bone].some((k) => k.p);
    const p = hasP ? new Float32Array(count * 3) : null;
    for (let i = 0; i < count; i++) {
      const s = sample(clip, bone, i);
      q.set(s.q, i * 4);
      if (p && s.p) p.set(s.p, i * 3);
    }
    tracks.push(new THREE.QuaternionKeyframeTrack(`${bone}.quaternion`, times, q));
    if (p) tracks.push(new THREE.VectorKeyframeTrack(`${bone}.position`, times, p));
  }
  const name = clip.name.trim().replace(/\s+/g, '_') + (clip.loop ? '-loop' : '');
  return new THREE.AnimationClip(name, clip.frames / clip.fps, tracks);
}
