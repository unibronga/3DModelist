// Вкладка «Анимации» у готовой модели.
// Скелет строит человек: нажал на модели и потянул — выросла кость; от конца
// кости тянется следующая; суставы берутся мышью с любой стороны и едут в
// плоскости экрана (спереди — ширина и высота, сбоку — глубина). Зеркально —
// левая и правая сторона строятся вместе. Быстрый путь — «Человек по
// точкам»: пять точек спереди, скелет встаёт сам и дальше правится так же.
// «Привязать» — Blender без окна считает веса; проверка сгибом и подкраской.
// Движения: щёлкнул кость — кольца поворота; отпустил — ключ на текущем
// кадре. Полоса времени снизу, паки, выгрузка GLB / FBX / .blend.
// Точки и суставы — в координатах модели (glTF: Y вверх, лицом на +Z).

import * as THREE from 'three';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { el, api, fileUrl, toast, errText } from './ui.js';
import { t, has } from './i18n.js';
import { HUMAN_POINTS, HUMAN_BONES, MIRRORED, buildHuman, centerX, mirror, pairOf, pairBone, sideOf } from './anim-rig.js';
import { newClip, sample, setKey, deleteKey, moveKey, keyAt, keyFrames, bake } from './anim-clip.js';
import { Timeline } from './timeline.js';

// Цвет стороны персонажа: левая — синяя, правая — зелёная, середина — фиолетовая.
const SIDE_COLOR = { L: new THREE.Color('#3b5bdb'), R: new THREE.Color('#0ca678'), C: new THREE.Color('#7048e8') };
const SEL = new THREE.Color('#f08c00');
const HOT = new THREE.Color('#ff5a1f');
const COLD = new THREE.Color('#c9c5bf');
const FRONT = new THREE.Vector3(0, 0, 1);
const V = (a) => new THREE.Vector3(...a);
const enc = encodeURIComponent;
export const BONE_NAME = /^[\p{L}\p{N}_]{1,40}$/u;

// Кость — человеческими словами: «Плечо · слева» вместо LeftUpperArm,
// «Bone3 · слева» вместо Bone3_L.
export function boneLabel(name) {
  const m = /^(Left|Right)(\w+)$/.exec(name || '');
  if (m && has('bone.' + m[2])) return t('bone.side.' + m[1], { part: t('bone.' + m[2]) });
  if (has('bone.' + name)) return t('bone.' + name);
  const s = /^(.+)[._](L|R)$/.exec(name || '');
  if (s) return t(s[2] === 'L' ? 'bone.side.Left' : 'bone.side.Right', { part: s[1] });
  return name;
}

// Проверка сгибом у «Человека»: кость, куда тянуть, градусы при полном
// сгибе. Порядок — от родителей к детям. У своего скелета — все кости вперёд.
const BEND = [
  ['Spine', 'front', 12], ['Chest', 'front', 8], ['Head', 'turn', 30],
  ['LeftUpperArm', 'front', 35], ['RightUpperArm', 'front', 35],
  ['LeftLowerArm', 'front', 85], ['RightLowerArm', 'front', 85],
  ['LeftUpperLeg', 'front', 55], ['LeftLowerLeg', 'back', 85], ['RightUpperLeg', 'back', 20],
];

// Повернуть кость вокруг оси в мире: мир = P·L → D·P·L, значит L' = (P⁻¹·D·P)·L.
export function rotateWorld(bone, axis, angle) {
  const P = bone.parent.getWorldQuaternion(new THREE.Quaternion());
  const D = new THREE.Quaternion().setFromAxisAngle(axis, angle);
  bone.quaternion.premultiply(P.clone().invert().multiply(D).multiply(P));
  bone.updateMatrixWorld(true);
}

export class Animator {
  // stageEl — поле с окном модели (там подсказка поверх окна и полоса времени).
  constructor(viewer, stageEl, { onLoad = () => {}, onChange = () => {} } = {}) {
    this.viewer = viewer;
    this.onLoad = onLoad;          // в окне другая модель (путь в рабочей папке)
    this.onChange = onChange;      // перерисовать правую панель
    this.name = null;
    this.st = null;
    this.editing = false;          // «Изменить скелет» у уже привязанной модели
    this.busy = null;              // 'prepare' | 'bind' — ждём Blender

    // Скелет в работе: суставы (id → точка) и кости между ними.
    this.markers = {};
    this.joints = {};
    this.rbones = [];              // { name, parent, head, tail }; head/tail — id суставов
    this.rigType = 'custom';       // human — из «Человека по точкам»
    this.rigCx = null;             // ось симметрии модели (x)
    this.way = 'manual';           // manual — строю сам, points — человек по точкам
    this.tool = 'add';             // add — тянуть кости, move — двигать суставы
    this.mirrorEdit = true;        // левая и правая сторона вместе
    this.bsel = null;              // выбранная кость скелета
    this.undoStack = [];

    // Привязанная модель: кости three.js, выбранная кость, сгиб.
    this.bones = [];
    this.meshes = [];
    this.sel = null;
    this.bend = 0;
    this.drag = null;
    this.group = new THREE.Group();
    this.lines = null;
    this.dots = [];
    this.center = new THREE.Vector3();
    this.heat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true, side: THREE.DoubleSide });
    this.hint = el('div', { class: 'anim-hint', hidden: true });
    stageEl.append(this.hint);
    this.tick = () => this.update();

    // Движения: выбранное, кадр, проигрывание, выбранный ключ, поза в буфере.
    this.clips = [];
    this.packs = [];
    this.clip = null;
    this.frame = 0;
    this.playing = false;
    this.keySel = null;
    this.poseBuf = null;
    this.saveTimer = null;
    this.tc = new TransformControls(viewer.camera, viewer.renderer.domElement);
    this.tc.setMode('rotate');
    this.tc.setSpace('local');
    this.tc.size = 0.8;
    this.tc.addEventListener('dragging-changed', (e) => {
      viewer.controls.enabled = !e.value;
      if (e.value) this.pause();
      else this.keyBone(this.tc.object);        // отпустил кольцо — ключ на кадре
    });
    this.tl = new Timeline(stageEl, {
      onFrame: (f) => { this.pause(); this.setFrame(f); },
      onSelect: (k) => { this.keySel = k; this.renderTl(); },
      onMove: (bone, from, to) => this.moveKeys(bone, from, to),
      onPlay: () => this.togglePlay(),
      onLoop: (on) => this.updateClip({ loop: on }),
      onKey: () => this.keyNow(),
      onMirror: () => this.mirrorPose(),
      onCopy: () => this.copyPose(),
      onPaste: () => this.pastePose(),
      onEase: (e) => this.setEase(e),
      onDelete: () => this.deleteSel(),
    });
    viewer.host.after(this.tl.root);            // под окном модели, окно становится ниже
    document.addEventListener('keydown', (e) => this.key(e));

    // Слушаем раньше OrbitControls (фаза захвата на окне): тянем сустав или
    // кость — камера стоит; просто щёлкнули — точка или выбор кости.
    const host = viewer.host;
    host.addEventListener('pointerdown', (e) => this.name && this.down(e), true);
    host.addEventListener('pointermove', (e) => this.name && this.move(e), true);
    host.addEventListener('pointerup', (e) => this.name && this.up(e), true);
  }

  get stage() {
    if (!this.st || this.busy === 'prepare') return 'prepare';
    if (this.busy === 'bind') return 'binding';
    if (this.st.skin && !this.editing) return 'bound';
    return this.way === 'points' && !this.rbones.length ? 'points' : 'skeleton';
  }

  // ── открыть / закрыть ─────────────────────────────────────────────────
  async open(name) {
    this.close();
    this.name = name;
    this.viewer.tickers.add(this.tick);
    this.viewer.scene.add(this.group, this.tc.getHelper());
    this.onChange();
    try {
      let st = await api(`/anim/${enc(name)}`);
      if (this.name !== name) return;
      this.st = st;
      if (!st.base) st = await this.run('prepare', () => api(`/anim/${enc(name)}/prepare`, { method: 'POST', body: {} }));
      if (this.name !== name || !st) return;
      this.st = st;
      this.clips = st.clips || [];
      this.packs = st.packs || [];
      this.fromRig();
      await this.show();
    } catch (e) { toast(errText(e), true); }
    this.onChange();
  }

  close() {
    if (!this.name) return;
    this.flushClip();
    this.closeClip(false);
    this.name = null;
    this.st = null;
    this.busy = null;
    this.editing = false;
    this.sel = null;
    this.bsel = null;
    this.bend = 0;
    this.drag = null;
    this.bones = [];
    this.meshes = [];
    this.viewer.tickers.delete(this.tick);
    this.viewer.scene.remove(this.group);
    this.viewer.scene.remove(this.tc.getHelper());
    this.clearOverlay();
    this.hint.hidden = true;
    this.viewer.controls.enabled = true;
    this.viewer.controls.enableRotate = true;
    this.viewer.setXray(false);
    this.viewer.host.style.cursor = '';
  }

  fromRig() {
    const rig = this.st.rig;
    this.markers = { ...(rig?.markers || {}) };
    this.joints = rig?.joints ? structuredClone(rig.joints) : {};
    this.rbones = rig?.bones ? structuredClone(rig.bones) : [];
    this.rigType = rig?.type || 'custom';
    this.rigCx = Number.isFinite(rig?.cx) ? rig.cx : null;
    this.bsel = null;
    this.undoStack = [];
    if (this.rbones.length) this.way = 'manual';
    this.tool = this.rbones.length ? 'move' : 'add';     // скелет уже есть — его правят, а не начинают
  }

  // Задание Blender: пока идёт — панель показывает ожидание.
  async run(kind, fn) {
    this.busy = kind;
    this.onChange();
    try { return await fn(); } catch (e) { toast(errText(e), true); return null; } finally { this.busy = null; this.onChange(); }
  }

  // Модель в окне: привязанная — с костями; пока строим скелет — основа,
  // полупрозрачная, чтобы кости было видно внутри.
  async show() {
    const bound = this.stage === 'bound';
    const f = bound ? this.st.skin : this.st.base;
    if (!f) return;
    this.sel = null;
    await this.viewer.load(fileUrl(f.path) + '?v=' + f.t);
    this.onLoad(f.path);
    this.viewer.setXray(!bound);
    if (bound) {
      this.collectBones();
      if (this.clip) this.setFrame(this.frame);
    } else if (!this.rbones.length) this.viewer.setView('front');
    this.draw();
  }

  // ── точки и суставы ───────────────────────────────────────────────────
  localBox() {
    const root = this.viewer.root;
    root.updateMatrixWorld(true);
    const b = new THREE.Box3().setFromObject(root);
    return { min: root.worldToLocal(b.min.clone()).toArray(), max: root.worldToLocal(b.max.clone()).toArray() };
  }

  // Ось симметрии: у «Человека» — по подбородку и паху, иначе — середина модели.
  cx() {
    if (this.markers.chin && this.markers.groin) return centerX(this.markers);
    if (this.rigCx != null) return this.rigCx;
    const b = this.localBox();
    return (b.min[0] + b.max[0]) / 2;
  }

  ray(e) {
    const rect = this.viewer.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    this.viewer.raycaster.setFromCamera(ndc, this.viewer.camera);
    return this.viewer.raycaster.ray;
  }

  // Точка посередине толщи под курсором — между входом луча в модель и
  // дальней стенкой того же места: щёлкают по поверхности, а сустав должен
  // быть внутри. Одежда слоями (куртка, рубашка) даёт много стенок подряд —
  // берём последнюю в пределах трети модели, а не вторую.
  inside(e) {
    const v = this.viewer;
    this.ray(e);
    const hits = v.raycaster.intersectObject(v.root, true).filter((h) => h.object.isMesh && h.object.visible);
    if (!hits.length) return null;
    const a = hits[0];
    const near = hits.filter((h) => h.distance > a.distance + v.span * 0.002 && h.distance - a.distance < v.span * 0.35);
    const b = near[near.length - 1];
    const p = b ? a.point.clone().lerp(b.point, 0.5) : a.point.clone();
    return v.root.worldToLocal(p).toArray();
  }

  nextPoint() { return HUMAN_POINTS.find((k) => !this.markers[k]) || null; }

  placePoint(e) {
    const k = this.nextPoint();
    const p = k && this.inside(e);
    if (!p) return;
    this.markers[k] = p;
    if (!this.nextPoint()) {
      // Пять точек есть — скелет «Человека»; дальше он правится как свой.
      this.joints = buildHuman(this.markers, this.localBox());
      this.rbones = HUMAN_BONES.map((b) => ({ ...b }));
      this.rigType = 'human';
      this.rigCx = centerX(this.markers);
      this.way = 'manual';
      this.tool = 'move';
      this.saveRig();
    }
    this.draw();
    this.onChange();
  }

  undoPoint() {
    const last = [...HUMAN_POINTS].reverse().find((k) => this.markers[k]);
    if (last) delete this.markers[last];
    this.draw();
    this.onChange();
  }

  // Начать скелет заново: суставы, кости, точки, прежняя привязка — прочь.
  async clearSkeleton(ask = true) {
    if (ask && this.rbones.length && !confirm(t('anim.restart.confirm'))) return;
    this.markers = {};
    this.joints = {};
    this.rbones = [];
    this.rigType = 'custom';
    this.rigCx = null;
    this.bsel = null;
    this.undoStack = [];
    this.tool = 'add';
    this.editing = true;
    if (this.st.rig || this.st.skin) {
      const st = await api(`/anim/${enc(this.name)}/reset`, { method: 'POST' }).catch((e) => { toast(errText(e), true); return null; });
      if (st) this.st = st;
    }
    this.viewer.setView('front');
    this.draw();
    this.onChange();
  }

  async setWay(way) {
    if (this.way === way) return;
    if (this.rbones.length && !confirm(t('anim.restart.confirm'))) return;
    this.way = way;
    await this.clearSkeleton(false);
  }

  async turn() {
    if (this.rbones.length && !confirm(t('anim.restart.confirm'))) return;
    const name = this.name;
    const st = await this.run('prepare', () => api(`/anim/${enc(name)}/prepare`, { method: 'POST', body: { turn: ((this.st?.turn || 0) + 90) % 360 } }));
    if (!st || this.name !== name) return;
    this.st = st;
    this.fromRig();
    await this.show();
    this.onChange();
  }

  async saveRig() {
    const name = this.name;
    try {
      // Костей не осталось — прежний скелет на диске не нужен.
      this.st = this.rbones.length
        ? await api(`/anim/${enc(name)}/rig`, { method: 'PUT', body: { type: this.rigType, cx: this.cx(), markers: this.markers, joints: this.joints, bones: this.rbones } })
        : await api(`/anim/${enc(name)}/reset`, { method: 'POST' });
    } catch (e) { toast(errText(e), true); }
  }

  async bind() {
    const name = this.name;
    const st = await this.run('bind', () => api(`/anim/${enc(name)}/bind`, { method: 'POST' }));
    if (!st || this.name !== name) return;
    this.st = st;
    this.editing = false;
    await this.show();
    this.onChange();
  }

  async cancelEdit() {
    this.editing = false;
    this.fromRig();
    await this.show();
    this.onChange();
  }

  async editRig() {
    // Движения держатся за оси костей: новый скелет может их сдвинуть.
    if (this.clips.length && !confirm(t('anim.redo.confirm'))) return;
    this.closeClip(false);
    this.editing = true;
    this.fromRig();
    await this.show();
    this.onChange();
  }

  // ── редактор скелета ──────────────────────────────────────────────────
  // Каждая правка — снимок для ⌘Z.
  snapshot() {
    this.undoStack.push(JSON.stringify([this.joints, this.rbones, this.rigType]));
    if (this.undoStack.length > 80) this.undoStack.shift();
  }

  restore(snap) {
    [this.joints, this.rbones, this.rigType] = JSON.parse(snap);
    if (this.bsel && !this.rbones.some((b) => b.name === this.bsel)) this.bsel = null;
  }

  undo() {
    const snap = this.undoStack.pop();
    if (!snap) return;
    this.restore(snap);
    this.saveRig();
    this.draw();
    this.onChange();
  }

  newId(prefix, taken) {
    let n = 0;
    for (const id of taken) { const m = new RegExp(`^${prefix}(\\d+)`).exec(id); if (m) n = Math.max(n, Number(m[1])); }
    return prefix + (n + 1);
  }
  newJoint(p, suffix = '') {
    const id = this.newId('j', Object.keys(this.joints)) + suffix;
    this.joints[id] = p;
    return id;
  }
  newBoneName() { return this.newId('Bone', this.rbones.map((b) => b.name)); }
  rbone(name) { return this.rbones.find((b) => b.name === name) || null; }

  // К какой кости крепится новая, выросшая из сустава: из конца кости — к ней,
  // из начала — к её родителю (у корня — к нему самому: ноги из таза).
  parentAt(joint) {
    const asTail = this.rbones.find((b) => b.tail === joint);
    if (asTail) return asTail.name;
    const asHead = this.rbones.find((b) => b.head === joint);
    return asHead ? asHead.parent ?? asHead.name : null;      // из начала корня (таза) — к самому корню
  }

  onAxis(p) { return Math.abs(p[0] - this.cx()) < this.viewer.span * 0.01; }

  // Новая кость из сустава (или из точки на модели, если сустава нет).
  // Сустав на одной стороне и «Зеркально» — сразу растёт и пара.
  startBone(fromJoint, at) {
    this.snapshot();
    const snap = this.undoStack[this.undoStack.length - 1];
    let head = fromJoint;
    let parent = fromJoint ? this.parentAt(fromJoint) : (this.bsel || null);
    const side = fromJoint ? sideOf(fromJoint) : this.mirrorEdit && !this.onAxis(at) ? (at[0] > this.cx() ? 'L' : 'R') : 'C';
    if (!fromJoint) head = this.newJoint(at, side === 'C' ? '' : '_' + side);
    const base = this.newBoneName();
    const tail = this.newJoint([...this.joints[head]], side === 'C' ? '' : '_' + side);
    const name = side === 'C' ? base : `${base}_${side}`;
    this.rbones.push({ name, parent, head, tail });
    if (side !== 'C' && this.mirrorEdit) {
      const o = side === 'L' ? 'R' : 'L';
      const cx = this.cx();
      const mHead = pairOf(head) && this.joints[pairOf(head)] ? pairOf(head) : head;
      if (!this.joints[mHead]) this.joints[mHead] = mirror(this.joints[head], cx);
      if (!fromJoint) this.joints[pairOf(head)] = mirror(this.joints[head], cx);
      const mTail = pairOf(tail);
      this.joints[mTail] = mirror(this.joints[tail], cx);
      const mParent = parent && this.rbone(pairBone(parent)) ? pairBone(parent) : parent;
      this.rbones.push({ name: `${base}_${o}`, parent: mParent, head: fromJoint ? mHead : pairOf(head), tail: mTail });
    }
    this.bsel = name;
    this.drag = { kind: 'bone', joint: tail, bone: name, snap, plane: this.planeAt(this.joints[head]) };
  }

  startMove(joint) {
    this.snapshot();
    const p = this.joints[joint];
    this.drag = { kind: 'move', joint, snap: this.undoStack[this.undoStack.length - 1], plane: this.planeAt(p), axis: !pairOf(joint) && this.onAxis(p) };
  }

  planeAt(local) {
    const v = this.viewer;
    return new THREE.Plane().setFromNormalAndCoplanarPoint(v.camera.getWorldDirection(new THREE.Vector3()), v.root.localToWorld(V(local)));
  }

  // Сустав едет в плоскости экрана; пара на другой стороне — зеркально;
  // сустав на оси при «Зеркально» с оси не уходит.
  dragTo(e) {
    const v = this.viewer;
    const hit = this.ray(e).intersectPlane(this.drag.plane, new THREE.Vector3());
    if (!hit) return;
    let p = v.root.worldToLocal(hit).toArray();
    // Новая кость в виде спереди или сзади: глубину спереди не видно — конец
    // встаёт посередине толщи модели под курсором. Сбоку и сверху — ровно по
    // экрану: там луч проходит обе руки или ноги, середина была бы чужой.
    if (this.drag.kind === 'bone' && Math.abs(v.camera.getWorldDirection(new THREE.Vector3()).z) > 0.85) p = this.inside(e) || p;
    const id = this.drag.joint;
    const pair = pairOf(id);
    if (this.mirrorEdit && pair && this.joints[pair]) this.joints[pair] = mirror(p, this.cx());
    else if (this.mirrorEdit && this.drag.axis) p[0] = this.cx();
    this.joints[id] = p;
    this.drag.moved = true;
  }

  endDrag() {
    const d = this.drag;
    this.drag = null;
    this.viewer.controls.enabled = true;
    if (!d.moved) {
      // Щелчок без протяжки — это выбор кости, а не правка.
      this.restore(d.snap);
      this.undoStack.pop();
      const hit = this.rbones.find((b) => b.tail === d.joint) || this.rbones.find((b) => b.head === d.joint);
      this.bsel = d.kind === 'bone' ? this.parentAt(d.joint) ?? hit?.name ?? null : hit?.name ?? null;
    } else if (d.kind === 'bone') {
      const b = this.rbone(d.bone);
      const len = V(this.joints[b.tail]).distanceTo(V(this.joints[b.head]));
      if (len < this.viewer.span * 0.01) { this.restore(d.snap); this.undoStack.pop(); }
      else if (sideOf(b.name) === 'C' && this.mirrorEdit && !this.onAxis(this.joints[b.tail])) this.splitSides(b);
    }
    this.saveRig();
    this.draw();
    this.onChange();
  }

  // Кость из середины ушла в сторону — это пара: левая и правая.
  splitSides(b) {
    const s = this.joints[b.tail][0] > this.cx() ? 'L' : 'R';
    const o = s === 'L' ? 'R' : 'L';
    const tail = `${b.tail}_${s}`;
    this.joints[tail] = this.joints[b.tail];
    delete this.joints[b.tail];
    const base = b.name;
    b.name = `${base}_${s}`;
    b.tail = tail;
    this.joints[pairOf(tail)] = mirror(this.joints[tail], this.cx());
    this.rbones.push({ name: `${base}_${o}`, parent: b.parent, head: b.head, tail: pairOf(tail) });
    this.bsel = b.name;
  }

  deleteBone(name = this.bsel) {
    if (!name || !this.rbone(name)) return;
    this.snapshot();
    const gone = new Set([name]);
    if (this.mirrorEdit && this.rbone(pairBone(name))) gone.add(pairBone(name));
    for (const n of gone) {
      const b = this.rbone(n);
      for (const c of this.rbones) if (c.parent === n) c.parent = b.parent;
    }
    this.rbones = this.rbones.filter((b) => !gone.has(b.name));
    const used = new Set(this.rbones.flatMap((b) => [b.head, b.tail]));
    for (const id of Object.keys(this.joints)) if (!used.has(id)) delete this.joints[id];
    this.bsel = null;
    this.saveRig();
    this.draw();
    this.onChange();
  }

  renameBone(name) {
    const b = this.rbone(this.bsel);
    name = name.trim();
    if (!b || name === b.name) return;
    if (!BONE_NAME.test(name) || this.rbone(name)) { toast(t('anim.bone.badName'), true); this.onChange(); return; }
    this.snapshot();
    for (const c of this.rbones) if (c.parent === b.name) c.parent = name;
    b.name = name;
    this.bsel = name;
    this.saveRig();
    this.draw();
    this.onChange();
  }

  // ── кости привязанной модели ──────────────────────────────────────────
  collectBones() {
    const root = this.viewer.root;
    root.updateMatrixWorld(true);
    this.meshes = [];
    root.traverse((o) => { if (o.isSkinnedMesh) this.meshes.push(o); });
    this.bones = this.meshes[0]?.skeleton.bones || [];
    this.rootBone = this.bones.find((b) => !b.parent?.isBone) || null;
    const joints = this.st.rig?.joints || {};
    const defs = this.st.rig?.bones || [];
    for (const b of this.bones) {
      b.userData.rest = b.quaternion.clone();
      b.userData.restP = b.position.clone();
      b.userData.restW = b.getWorldQuaternion(new THREE.Quaternion());
      b.userData.restWP = b.getWorldPosition(new THREE.Vector3());
      b.userData.depth = 0;
      for (let o = b.parent; o?.isBone; o = o.parent) b.userData.depth++;
      // Конец кости glTF не хранит — берём из скелета, в осях самой кости.
      const tail = joints[defs.find((x) => x.name === b.name)?.tail];
      b.userData.tail = tail ? b.worldToLocal(root.localToWorld(V(tail))) : new THREE.Vector3(0, this.viewer.span * 0.05, 0);
    }
    this.bend = 0;
  }

  bone(name) { return this.bones.find((b) => b.name === name) || null; }

  setBend(k) {
    this.bend = k;
    for (const b of this.bones) { b.quaternion.copy(b.userData.rest); b.position.copy(b.userData.restP); }
    this.viewer.root.updateMatrixWorld(true);
    const human = this.bone('Hips') && this.bone('LeftUpperArm');
    const plan = human ? BEND : [...this.bones].filter((b) => b.parent?.isBone)
      .sort((a, c) => a.userData.depth - c.userData.depth).map((b) => [b.name, 'front', 18]);
    for (const [name, how, deg] of plan) {
      const b = this.bone(name);
      if (!b) continue;
      let axis;
      if (how === 'turn') axis = new THREE.Vector3(0, 1, 0);
      else {
        const head = b.getWorldPosition(new THREE.Vector3());
        const dir = b.localToWorld(b.userData.tail.clone()).sub(head).normalize();
        axis = new THREE.Vector3().crossVectors(dir, how === 'front' ? FRONT : FRONT.clone().negate());
        if (axis.lengthSq() < 1e-6) axis = new THREE.Vector3(1, 0, 0);   // кость смотрит вперёд — гнём вниз
        axis.normalize();
      }
      rotateWorld(b, axis, THREE.MathUtils.degToRad(deg * k));
    }
  }

  // Выбор кости привязанной модели. В движении — кольца поворота (корневую
  // кость можно и сдвигать); без движения — подкраска: чем сильнее кость
  // держит место модели, тем оно краснее.
  selectBone(name) {
    this.sel = name;
    this.viewer.apply();
    if (this.clip) {
      const b = name && this.bone(name);
      if (b) {
        if (b !== this.rootBone) this.tc.setMode('rotate');
        this.tc.attach(b);
      } else this.tc.detach();
      this.draw();
      this.renderTl();
      this.onChange();
      return;
    }
    if (name) {
      for (const m of this.meshes) {
        const idx = m.skeleton.bones.findIndex((b) => b.name === name);
        const g = m.geometry;
        const si = g.attributes.skinIndex;
        const sw = g.attributes.skinWeight;
        const col = new Float32Array(si.count * 3);
        const c = new THREE.Color();
        for (let i = 0; i < si.count; i++) {
          let w = 0;
          for (let k = 0; k < 4; k++) if (si.getComponent(i, k) === idx) w += sw.getComponent(i, k);
          c.copy(COLD).lerp(HOT, w).toArray(col, i * 3);
        }
        g.setAttribute('color', new THREE.BufferAttribute(col, 3));
        m.material = this.heat;
      }
    }
    this.draw();
    this.onChange();
  }

  // ── поверх окна: точки, суставы, кости ────────────────────────────────
  clearOverlay() {
    for (const o of [...this.group.children]) {
      this.group.remove(o);
      o.geometry?.dispose();
      o.material?.dispose();
    }
    this.dots = [];
    this.lines = null;
  }

  draw() {
    this.clearOverlay();
    const v = this.viewer;
    if (!this.name || !v.root) return;
    const stage = this.stage;
    v.controls.enableRotate = stage !== 'points';          // точки — только спереди
    new THREE.Box3().setFromObject(v.root).getCenter(this.center);
    const r = v.span * 0.011;
    const dot = (get, { color, opacity = 1, joint = null, bone = null, big = false } = {}) => {
      const m = new THREE.Mesh(new THREE.SphereGeometry(big ? r * 1.35 : r, 14, 10),
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthTest: false }));
      m.renderOrder = 999;
      m.userData = { get, joint, bone, opacity };
      this.group.add(m);
      this.dots.push(m);
    };
    const local = (p) => () => v.root.localToWorld(V(p));
    const segs = [];
    if (stage === 'points') {
      const cx = this.markers.chin && this.markers.groin ? centerX(this.markers) : this.cx();
      for (const k of HUMAN_POINTS) {
        const p = this.markers[k];
        if (!p) continue;
        dot(local(p), { color: SIDE_COLOR.L });
        if (MIRRORED.has(k)) dot(local(mirror(p, cx)), { color: SIDE_COLOR.R, opacity: 0.6 });
      }
    } else if (stage === 'skeleton') {
      const J = (id) => () => v.root.localToWorld(V(this.joints[id]));
      const sb = this.rbone(this.bsel);
      const used = new Set(this.rbones.flatMap((b) => [b.head, b.tail]));
      for (const id of used) {
        const on = this.drag?.joint === id || (sb && (sb.head === id || sb.tail === id));
        dot(J(id), { joint: id, color: on ? SEL : SIDE_COLOR[sideOf(id)], big: on });
      }
      for (const b of this.rbones) segs.push([J(b.head), J(b.tail), b.name, b.name === this.bsel ? SEL : SIDE_COLOR[sideOf(b.name)]]);
    } else if (stage === 'bound') {
      for (const b of this.bones) {
        const on = b.name === this.sel;
        const color = on ? SEL : SIDE_COLOR[sideOf(b.name)];
        dot(() => b.getWorldPosition(new THREE.Vector3()), { bone: b.name, color, big: on });
        segs.push([() => b.getWorldPosition(new THREE.Vector3()), () => b.localToWorld(b.userData.tail.clone()), b.name, color]);
      }
    }
    if (segs.length) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(segs.length * 6), 3));
      const col = new Float32Array(segs.length * 6);
      segs.forEach((s, i) => { s[3].toArray(col, i * 6); s[3].toArray(col, i * 6 + 3); });
      g.setAttribute('color', new THREE.BufferAttribute(col, 3));
      this.lines = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.95, depthTest: false }));
      this.lines.renderOrder = 998;
      this.lines.userData.segs = segs;
      this.group.add(this.lines);
    }
    const next = stage === 'points' && this.nextPoint();
    const hint = next ? t('anim.click', { name: t('anim.pt.' + next) })
      : stage === 'skeleton' && !this.rbones.length ? t('anim.first.hint') : '';
    this.hint.hidden = !hint;
    this.hint.textContent = hint;
    this.update();
  }

  // Каждый кадр: проигрывание, точки следуют за костями; суставы за моделью
  // (дальше центра модели от камеры) — бледнее: слева и справа не спутать.
  update() {
    if (this.playing && this.clip) {
      const now = performance.now();
      const n = this.clip.frames;
      let f = this.frame + ((now - this.lastT) / 1000) * this.clip.fps;
      this.lastT = now;
      if (f >= n) {
        if (this.clip.loop) f %= n;
        else { f = n; this.playing = false; this.renderTl(); }
      }
      this.frame = f;
      this.applyPose(f);
      this.tl.setFrame(f);
    }
    const cam = this.viewer.camera;
    const dir = cam.getWorldDirection(new THREE.Vector3());
    const tmp = new THREE.Vector3();
    for (const d of this.dots) {
      d.position.copy(d.userData.get());
      const far = tmp.copy(d.position).sub(this.center).dot(dir) > this.viewer.span * 0.03;
      d.material.opacity = d.userData.opacity * (far ? 0.35 : 1);
    }
    if (this.lines) {
      const pos = this.lines.geometry.attributes.position;
      this.lines.userData.segs.forEach(([a, b], i) => {
        pos.setXYZ(i * 2, ...a().toArray());
        pos.setXYZ(i * 2 + 1, ...b().toArray());
      });
      pos.needsUpdate = true;
      this.lines.geometry.computeBoundingSphere();
    }
  }

  // Точка мира → пиксели в окне и глубина (меньше — ближе к камере).
  screen(p) {
    const rect = this.viewer.renderer.domElement.getBoundingClientRect();
    const q = p.clone().project(this.viewer.camera);
    return [rect.left + (q.x + 1) / 2 * rect.width, rect.top + (1 - q.y) / 2 * rect.height, q.z];
  }

  // Что под курсором: сустав { joint } или кость { bone }. Совпали на экране
  // (сбоку левое закрывает правое) — берём ближний к камере.
  pick(e) {
    let best = null;
    let bestD = 14;
    let bestZ = Infinity;
    for (const d of this.dots) {
      const id = d.userData.joint || d.userData.bone;
      if (!id) continue;
      const [x, y, z] = this.screen(d.position);
      const dist = Math.hypot(x - e.clientX, y - e.clientY);
      if (dist >= 14) continue;
      if (dist < bestD - 4 || (Math.abs(dist - bestD) <= 4 && z < bestZ)) { best = d.userData; bestD = dist; bestZ = z; }
    }
    if (best) return best.joint ? { joint: best.joint } : { bone: best.bone };
    if (!this.lines) return null;
    let name = null;
    bestD = 8;
    for (const [a, b, n] of this.lines.userData.segs) {
      const [ax, ay] = this.screen(a());
      const [bx, by] = this.screen(b());
      const vx = bx - ax;
      const vy = by - ay;
      const k = Math.max(0, Math.min(1, ((e.clientX - ax) * vx + (e.clientY - ay) * vy) / (vx * vx + vy * vy || 1)));
      const dist = Math.hypot(ax + vx * k - e.clientX, ay + vy * k - e.clientY);
      if (dist < bestD) { bestD = dist; name = n; }
    }
    return name ? { bone: name } : null;
  }

  down(e) {
    if (e.button !== 0) return;
    this.downAt = [e.clientX, e.clientY];
    if (this.stage !== 'skeleton') return;
    const hit = this.pick(e);
    if (hit?.joint) {
      if (this.tool === 'add') this.startBone(hit.joint);
      else this.startMove(hit.joint);
    } else if (this.tool === 'add' && !hit?.bone) {
      const p = this.inside(e);
      if (p) this.startBone(null, p);
    }
    if (!this.drag) return;
    e.stopPropagation();
    e.preventDefault();
    this.viewer.controls.enabled = false;
    try { e.target.setPointerCapture(e.pointerId); } catch { /* указатель уже отпущен */ }
    this.draw();
  }

  move(e) {
    if (this.drag) { this.dragTo(e); return; }
    const s = this.stage;
    const hit = (s === 'skeleton' || s === 'bound') ? this.pick(e) : null;
    this.viewer.host.style.cursor = hit?.joint ? (this.tool === 'add' ? 'copy' : 'grab') : hit?.bone ? 'pointer'
      : (s === 'points' && this.nextPoint()) || (s === 'skeleton' && this.tool === 'add') ? 'crosshair' : '';
  }

  up(e) {
    if (this.drag) { this.endDrag(); return; }
    if (!this.downAt || Math.hypot(e.clientX - this.downAt[0], e.clientY - this.downAt[1]) > 4) return;
    if (this.tc.axis || this.tc.dragging) return;          // щёлкнули по кольцу, а не по кости
    const s = this.stage;
    if (s === 'points') this.placePoint(e);
    else if (s === 'skeleton') { this.bsel = this.pick(e)?.bone || null; this.draw(); this.onChange(); }
    else if (s === 'bound') { const b = this.pick(e)?.bone || null; this.selectBone(b === this.sel ? null : b); }
  }

  // ── движения ──────────────────────────────────────────────────────────
  api(pathTail, opts) { return api(`/anim/${enc(this.name)}${pathTail}`, opts); }

  async newPack() {
    const pack = { id: 'p' + Date.now().toString(36), name: t('anim.pack.n', { n: this.packs.length + 1 }) };
    this.packs = [...this.packs, pack];
    await this.savePacks();
    return pack;
  }

  async savePacks() {
    try { await this.api('/packs', { method: 'PUT', body: this.packs }); } catch (e) { toast(errText(e), true); }
    this.onChange();
  }

  renamePack(id, name) {
    const p = this.packs.find((x) => x.id === id);
    if (!p || !name.trim()) return;
    p.name = name.trim();
    this.savePacks();
  }

  deletePack(id) {
    if (this.clips.some((c) => c.pack === id)) return;
    this.packs = this.packs.filter((x) => x.id !== id);
    this.savePacks();
  }

  async addClip(packId) {
    const pack = this.packs.find((x) => x.id === packId) || this.packs[0] || await this.newPack();
    const clip = newClip({ name: t('anim.clip.n', { n: this.clips.length + 1 }), pack: pack.id });
    this.clips.push(clip);
    this.saveClip(clip, true);
    this.openClip(clip.id);
  }

  openClip(id) {
    const clip = this.clips.find((c) => c.id === id);
    if (!clip) return;
    this.flushClip();
    this.pause();
    this.clip = clip;
    this.frame = 0;
    this.keySel = null;
    if (this.bend) this.setBend(0);
    this.bend = 0;
    this.selectBone(this.sel);          // подкраску убрать, кольца — на выбранную кость
    this.setFrame(0);
    this.onChange();
  }

  closeClip(redraw = true) {
    this.flushClip();
    this.pause();
    this.clip = null;
    this.keySel = null;
    this.tc.detach();
    this.tl.hide();
    for (const b of this.bones) { b.quaternion.copy(b.userData.rest); b.position.copy(b.userData.restP); }
    if (redraw) { this.draw(); this.onChange(); }
  }

  updateClip(props) {
    if (!this.clip) return;
    Object.assign(this.clip, props);
    if (props.frames) this.frame = Math.min(this.frame, this.clip.frames);
    this.saveClip(this.clip);
    this.setFrame(Math.round(this.frame));
    this.onChange();
  }

  async removeClip() {
    const c = this.clip;
    if (!c || !confirm(t('anim.clip.delete.confirm', { name: c.name }))) return;
    this.closeClip(false);
    this.clips = this.clips.filter((x) => x.id !== c.id);
    try { await this.api(`/clips/${c.id}`, { method: 'DELETE' }); } catch (e) { toast(errText(e), true); }
    this.draw();
    this.onChange();
  }

  // Сохранение — через полсекунды после последней правки: ключи ставят часто.
  saveClip(clip = this.clip, now = false) {
    if (!clip) return;
    clearTimeout(this.saveTimer);
    this.pendingClip = clip;
    if (now) this.flushClip();
    else this.saveTimer = setTimeout(() => this.flushClip(), 500);
  }

  flushClip() {
    clearTimeout(this.saveTimer);
    const c = this.pendingClip;
    this.pendingClip = null;
    if (!c || !this.name) return;
    this.api(`/clips/${c.id}`, { method: 'PUT', body: c }).catch((e) => toast(errText(e), true));
  }

  // Поза движения в кадре f → кости. Кость без ключей — в покое.
  applyPose(f) {
    for (const b of this.bones) {
      const s = this.clip ? sample(this.clip, b.name, f) : null;
      if (s) b.quaternion.fromArray(s.q); else b.quaternion.copy(b.userData.rest);
      if (b === this.rootBone) { if (s?.p) b.position.fromArray(s.p); else b.position.copy(b.userData.restP); }
    }
    this.viewer.root?.updateMatrixWorld(true);
  }

  setFrame(f) {
    if (!this.clip) return;
    this.frame = Math.max(0, Math.min(this.clip.frames, f));
    this.applyPose(this.frame);
    this.renderTl();
  }

  pause() {
    if (!this.playing) return;
    this.playing = false;
    this.setFrame(Math.round(this.frame));
  }

  togglePlay() {
    if (!this.clip) return;
    if (this.playing) { this.pause(); return; }
    if (!this.clip.loop && this.frame >= this.clip.frames) this.frame = 0;
    this.playing = true;
    this.lastT = performance.now();
    this.renderTl();
  }

  // Ключ кости на текущем кадре — её нынешняя поза.
  keyBone(b, render = true) {
    if (!this.clip || !b) return;
    const f = Math.round(this.frame);
    setKey(this.clip, b.name, f, b.quaternion.toArray(), b === this.rootBone ? b.position.toArray() : null);
    this.keySel = { bone: b.name, f };
    this.saveClip();
    if (render) this.renderTl();
  }

  keyAll() {
    for (const b of this.bones) this.keyBone(b, false);
    this.keySel = { bone: null, f: Math.round(this.frame) };
    this.renderTl();
  }

  // «◆ Ключ»: выбрана кость — ключ ей, нет — всему телу.
  keyNow() {
    const b = this.sel && this.bone(this.sel);
    if (b) this.keyBone(b); else this.keyAll();
  }

  // Ключ выбран в строке кости — он один; в строке «Всё тело» — весь кадр.
  selKeys() {
    const k = this.keySel;
    if (!this.clip || !k) return [];
    if (k.bone) return keyAt(this.clip, k.bone, k.f) ? [[k.bone, k.f]] : [];
    return Object.keys(this.clip.keys).filter((b) => keyAt(this.clip, b, k.f)).map((b) => [b, k.f]);
  }

  deleteSel() {
    for (const [b, f] of this.selKeys()) deleteKey(this.clip, b, f);
    this.keySel = null;
    this.saveClip();
    this.setFrame(Math.round(this.frame));
  }

  moveKeys(bone, from, to) {
    if (!this.clip) return;
    for (const b of bone ? [bone] : Object.keys(this.clip.keys)) moveKey(this.clip, b, from, to);
    this.keySel = { bone, f: to };
    this.saveClip();
    this.setFrame(to);
  }

  setEase(e) {
    for (const [b, f] of this.selKeys()) keyAt(this.clip, b, f).e = e;
    this.saveClip();
    this.setFrame(Math.round(this.frame));
  }

  // Отразить позу: левое ↔ правое. Поворот каждой кости от покоя (в мире)
  // берём у кости-пары и отражаем плоскостью симметрии модели (x → −x):
  // у кватерниона (x, y, z, w) → (x, −y, −z, w). Кости — от родителей к детям.
  mirrorPose() {
    if (!this.clip) return;
    this.pause();
    this.viewer.root.updateMatrixWorld(true);
    const delta = new Map();
    for (const b of this.bones) delta.set(b.name, b.getWorldQuaternion(new THREE.Quaternion()).multiply(b.userData.restW.clone().invert()));
    const r = this.rootBone;
    const shift = r ? r.getWorldPosition(new THREE.Vector3()).sub(r.userData.restWP) : null;
    for (const b of [...this.bones].sort((a, c) => a.userData.depth - c.userData.depth)) {
      const d = delta.get(pairBone(b.name) || b.name);
      const w = new THREE.Quaternion(d.x, -d.y, -d.z, d.w).multiply(b.userData.restW);
      b.quaternion.copy(b.parent.getWorldQuaternion(new THREE.Quaternion()).invert().multiply(w));
      b.updateMatrixWorld(true);
    }
    if (r) {
      r.position.copy(r.parent.worldToLocal(r.userData.restWP.clone().add(new THREE.Vector3(-shift.x, shift.y, shift.z))));
      r.updateMatrixWorld(true);
    }
    this.keyAll();
  }

  copyPose() {
    if (!this.clip) return;
    this.poseBuf = this.bones.map((b) => [b.name, b.quaternion.toArray(), b.position.toArray()]);
    toast(t('anim.pose.copied'));
  }

  pastePose() {
    if (!this.clip || !this.poseBuf) return;
    this.pause();
    for (const [name, q, p] of this.poseBuf) {
      const b = this.bone(name);
      if (!b) continue;
      b.quaternion.fromArray(q);
      if (b === this.rootBone) b.position.fromArray(p);
    }
    this.viewer.root.updateMatrixWorld(true);
    this.keyAll();
  }

  renderTl() {
    if (!this.clip || this.stage !== 'bound') { this.tl.hide(); return; }
    const order = (this.st.rig?.bones || []).map((b) => b.name);   // как строили скелет
    const names = new Set(Object.keys(this.clip.keys));
    if (this.sel) names.add(this.sel);
    const rows = [...names].sort((a, b) => order.indexOf(a) - order.indexOf(b)).map((bone) => ({ bone, label: boneLabel(bone) }));
    const k = this.selKeys()[0];
    this.tl.render({
      clip: this.clip, frame: this.frame, playing: this.playing, rows, sel: this.keySel, bone: this.sel,
      ease: k ? keyAt(this.clip, k[0], k[1])?.e || 'smooth' : null, canPaste: !!this.poseBuf,
    });
  }

  key(e) {
    if (!this.name || /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName)) return;
    const mod = e.metaKey || e.ctrlKey;
    // Скелет: ⌘Z — отменить правку, Delete — убрать выбранную кость.
    if (this.stage === 'skeleton') {
      if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); this.undo(); }
      else if ((e.key === 'Delete' || e.key === 'Backspace') && this.bsel) { e.preventDefault(); this.deleteBone(); }
      return;
    }
    if (!this.clip) return;
    if (e.key === ' ') { e.preventDefault(); this.togglePlay(); }
    else if (e.key === 'Delete' || e.key === 'Backspace') { if (this.keySel) { e.preventDefault(); this.deleteSel(); } }
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      this.pause();
      const fs = keyFrames(this.clip);
      const f = Math.round(this.frame);
      // С Shift — к соседнему ключу, без — на кадр.
      const to = e.shiftKey ? (e.key === 'ArrowLeft' ? [...fs].reverse().find((x) => x < f) ?? 0 : fs.find((x) => x > f) ?? this.clip.frames)
        : f + (e.key === 'ArrowLeft' ? -1 : 1);
      this.setFrame(to);
    } else if (mod && e.key.toLowerCase() === 'c') { e.preventDefault(); this.copyPose(); }
    else if (mod && e.key.toLowerCase() === 'v') { e.preventDefault(); this.pastePose(); }
    else if (!mod && (e.key.toLowerCase() === 'k' || e.key.toLowerCase() === 'л')) this.keyNow();
  }

  // ── выгрузка: движения → GLB (страница, GLTFExporter) → нужный формат ─
  // Файл строится из чистой модели с костями: те же материалы, что в out/.
  async exportAnim(packId, fmt) {
    this.flushClip();
    const clips = this.clips.filter((c) => (!packId || c.pack === packId) && Object.keys(c.keys).length);
    if (!clips.length) { toast(t('anim.exp.empty'), true); return; }
    this.exporting = fmt;
    this.onChange();
    try {
      const { path, file } = await this.buildExport(packId, clips);
      const fps = Math.max(...clips.map((c) => c.fps));
      const r = await fetch(`/api/export?path=${enc(path)}&fmt=${fmt}&name=${enc(file)}&fps=${fps}`);
      if (!r.ok) { const e = await r.json().catch(() => ({})); throw Object.assign(new Error(e.error || r.statusText), e); }
      const url = URL.createObjectURL(await r.blob());
      const a = el('a', { href: url, download: `${file}.${fmt}` });
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (e) { toast(errText(e), true); }
    this.exporting = null;
    this.onChange();
  }

  // GLB с движениями → anim/<модель>/export/ на сервере: { path, file }.
  async buildExport(packId, clips) {
    const gltf = await new GLTFLoader().loadAsync(fileUrl(this.st.skin.path) + '?v=' + this.st.skin.t);
    const names = [];
    gltf.scene.traverse((o) => { if (o.isBone) names.push(o.name); });
    const buf = await new GLTFExporter().parseAsync(gltf.scene, { binary: true, animations: clips.map((c) => bake(c, names)), onlyVisible: false });
    const pack = this.packs.find((x) => x.id === packId);
    const file = [this.name, pack ? pack.name : 'anim'].join('_').replace(/[^\p{L}\w.-]+/gu, '_');
    const { path } = await this.api('/export', { method: 'POST', body: { file, data: toBase64(buf) } });
    return { path, file };
  }

  // ── правая панель ─────────────────────────────────────────────────────
  panel() {
    const s = this.stage;
    const wrap = el('div', { class: 'anim-panel' });
    if (s === 'prepare') {
      wrap.append(el('div', { class: 'field' }, el('div', { class: 'typing' }, t('anim.preparing'))));
      return wrap;
    }
    const field = (...kids) => el('div', { class: 'field' }, ...kids);
    const way = el('div', { class: 'seg full' },
      el('button', { class: this.way === 'manual' ? 'on' : '', onclick: () => this.setWay('manual') }, t('anim.way.manual')),
      el('button', { class: this.way === 'points' ? 'on' : '', onclick: () => this.setWay('points') }, t('anim.way.points')));

    if (s === 'points') {
      const next = this.nextPoint();
      wrap.append(
        field(el('div', { class: 'label' }, t('anim.skeleton')), way),
        field(el('div', { class: 'muted' }, t('anim.points.hint')),
          el('ol', { class: 'anim-points' }, ...HUMAN_POINTS.map((k) => el('li', { class: this.markers[k] ? 'done' : k === next ? 'next' : '' },
            el('span', { class: 'pt-mark' }, this.markers[k] ? '✓' : ''), t('anim.pt.' + k))))),
        field(el('div', { class: 'row' },
          el('button', { class: 'btn', disabled: !Object.keys(this.markers).length, onclick: () => this.undoPoint() }, '↶ ' + t('anim.undo')),
          el('button', { class: 'btn', onclick: () => this.turn() }, '↻ ' + t('anim.turn'))),
        el('div', { class: 'muted small' }, t('anim.turn.hint'))));
    } else if (s === 'skeleton') {
      const sb = this.rbone(this.bsel);
      const tool = (id, label) => el('button', { class: this.tool === id ? 'on' : '', onclick: () => { this.tool = id; this.onChange(); } }, label);
      wrap.append(...[
        field(el('div', { class: 'label' }, t('anim.skeleton')), way),
        field(el('div', { class: 'seg full' }, tool('add', t('anim.tool.add')), tool('move', t('anim.tool.move'))),
          el('div', { class: 'muted small' }, t(this.tool === 'add' ? (this.rbones.length ? 'anim.tool.add.more' : 'anim.first.hint') : 'anim.tool.move.hint')),
          el('label', { class: 'check' }, el('input', { type: 'checkbox', checked: this.mirrorEdit, onchange: (e) => { this.mirrorEdit = e.target.checked; this.onChange(); } }), t('anim.mirrorEdit')),
          el('div', { class: 'muted small anim-legend' },
            el('span', { class: 'lg l' }), t('anim.legend.l'), el('span', { class: 'lg r' }), t('anim.legend.r'))),
        !!sb && field(el('div', { class: 'label' }, t('anim.bone.sel')),
          el('input', { class: 'input', value: sb.name, title: boneLabel(sb.name), onchange: (e) => this.renameBone(e.target.value) }),
          el('button', { class: 'btn danger wide', onclick: () => this.deleteBone() }, t('anim.bone.delete') + ' — Delete')),
        field(
          el('button', { class: 'btn primary wide', disabled: !this.rbones.length, onclick: () => this.bind() }, t('anim.bind')),
          el('div', { class: 'row' },
            el('button', { class: 'btn', disabled: !this.undoStack.length, onclick: () => this.undo() }, '↶ ' + t('anim.undo') + ' — ⌘Z'),
            el('button', { class: 'btn', onclick: () => this.turn() }, '↻ ' + t('anim.turn'))),
          el('button', { class: 'btn wide', disabled: !this.rbones.length, onclick: () => this.clearSkeleton() }, t('anim.restart')),
          // Скелет не трогали — можно вернуться к прежней привязке.
          !!this.st.skin && el('button', { class: 'btn wide', onclick: () => this.cancelEdit() }, t('anim.keep'))),
      ].filter(Boolean));   // DOM-append печатает false словом
    } else if (s === 'binding') {
      wrap.append(field(el('div', { class: 'label' }, t('anim.skeleton')), el('div', { class: 'typing' }, t('anim.binding'))));
    } else if (s === 'bound') {
      wrap.append(field(el('div', { class: 'row between' },
        el('div', { class: 'anim-ok' }, '✓ ' + t('anim.bound')),
        el('button', { class: 'link-btn', onclick: () => this.editRig() }, t('anim.editRig')))));
      if (!this.clip) {
        const slider = el('input', {
          type: 'range', class: 'range', min: 0, max: 1, step: 0.01, value: this.bend,
          oninput: (e) => this.setBend(Number(e.target.value)),
        });
        wrap.append(field(el('div', { class: 'label' }, t('anim.bend')), slider,
          el('div', { class: 'muted small' }, this.sel ? t('anim.bone', { name: boneLabel(this.sel) }) : t('anim.weights.hint'))));
      }
      wrap.append(this.clipsField());
      if (this.clip) wrap.append(this.clipField());
      wrap.append(this.exportField());
    }
    return wrap;
  }

  // Движения по пакам: имя пака правится прямо в строке.
  clipsField() {
    const list = el('div', { class: 'anim-packs' });
    for (const p of this.packs) {
      const clips = this.clips.filter((c) => c.pack === p.id);
      list.append(el('div', { class: 'anim-pack' },
        el('div', { class: 'row' },
          el('input', { class: 'input pack-name', value: p.name, title: t('anim.pack.rename'), onchange: (e) => this.renamePack(p.id, e.target.value) }),
          el('button', { class: 'icon-mini', title: t('anim.clip.add'), onclick: () => this.addClip(p.id) }, '+'),
          !clips.length && el('button', { class: 'icon-mini', title: t('anim.pack.delete'), onclick: () => this.deletePack(p.id) }, '✕')),
        ...clips.map((c) => el('button', {
          class: 'clip-item' + (c === this.clip ? ' on' : ''),
          onclick: () => (c === this.clip ? this.closeClip() : this.openClip(c.id)),
        }, el('span', {}, c.name + (c.loop ? ' ⟲' : '')), el('span', { class: 'muted' }, t('anim.frames.n', { n: c.frames }))))));
    }
    // Паки без движений (чужие id) — движения всё равно видны.
    const orphans = this.clips.filter((c) => !this.packs.some((p) => p.id === c.pack));
    for (const c of orphans) list.append(el('button', { class: 'clip-item' + (c === this.clip ? ' on' : ''), onclick: () => this.openClip(c.id) }, c.name));
    return el('div', { class: 'field' },
      el('div', { class: 'label' }, t('anim.clips')),
      !this.clips.length && el('div', { class: 'muted small' }, t('anim.clips.none')),
      list,
      el('div', { class: 'row' },
        el('button', { class: 'btn', onclick: () => this.addClip(this.clip?.pack) }, '+ ' + t('anim.clip.new')),
        el('button', { class: 'btn', onclick: () => this.newPack() }, '+ ' + t('anim.pack.new'))));
  }

  // Выбранное движение: имя, длина, скорость, по кругу, пак.
  clipField() {
    const c = this.clip;
    const root = this.sel && this.bone(this.sel) === this.rootBone;
    return el('div', { class: 'field anim-clip' },
      el('div', { class: 'label' }, t('anim.clip')),
      el('input', { class: 'input', value: c.name, onchange: (e) => e.target.value.trim() && this.updateClip({ name: e.target.value.trim() }) }),
      el('div', { class: 'row' },
        el('label', { class: 'anim-num' }, t('anim.frames'),
          el('input', { class: 'input', type: 'number', min: 2, max: 2000, value: c.frames, onchange: (e) => { const n = Math.round(Number(e.target.value)); if (n >= 2 && n <= 2000) this.updateClip({ frames: n }); } })),
        el('div', { class: 'seg' }, ...[24, 30, 60].map((f) => el('button', { class: c.fps === f ? 'on' : '', onclick: () => this.updateClip({ fps: f }) }, t('anim.fps', { n: f }))))),
      el('label', { class: 'check' }, el('input', { type: 'checkbox', checked: c.loop, onchange: (e) => this.updateClip({ loop: e.target.checked }) }), t('anim.loop')),
      this.packs.length > 1 && el('select', { class: 'input', onchange: (e) => this.updateClip({ pack: e.target.value }) },
        ...this.packs.map((p) => el('option', { value: p.id, selected: p.id === c.pack }, t('anim.inPack', { name: p.name })))),
      // Таз можно и сдвигать: прыжок, приседание.
      root && el('div', { class: 'seg full' },
        el('button', { class: this.tc.mode === 'rotate' ? 'on' : '', onclick: () => { this.tc.setMode('rotate'); this.onChange(); } }, t('anim.rotate')),
        el('button', { class: this.tc.mode === 'translate' ? 'on' : '', onclick: () => { this.tc.setMode('translate'); this.onChange(); } }, t('anim.move'))),
      el('div', { class: 'muted small' }, t(this.sel ? 'anim.pose.hint' : 'anim.pick.hint')),
      el('button', { class: 'btn danger wide', onclick: () => this.removeClip() }, t('anim.clip.delete')));
  }

  exportField() {
    const busy = this.exporting;
    const packs = this.packs.filter((p) => this.clips.some((c) => c.pack === p.id));
    this.expPack = packs.some((p) => p.id === this.expPack) ? this.expPack : null;
    const dl = (fmt, hint) => el('button', { class: 'btn dl-btn', disabled: !!busy, onclick: () => this.exportAnim(this.expPack, fmt) },
      el('span', { class: 'dl-fmt' }, fmt === 'blend' ? '.blend' : fmt.toUpperCase()), el('span', { class: 'dl-hint' }, busy === fmt ? t('anim.exp.busy') : hint));
    return el('div', { class: 'field' },
      el('div', { class: 'label' }, t('anim.exp')),
      packs.length > 1 && el('select', { class: 'input', onchange: (e) => { this.expPack = e.target.value || null; } },
        el('option', { value: '' }, t('anim.exp.all')),
        ...packs.map((p) => el('option', { value: p.id, selected: p.id === this.expPack }, t('anim.exp.pack', { name: p.name })))),
      el('div', { class: 'dl-list' },
        dl('glb', t('anim.exp.glb')), dl('fbx', t('anim.exp.fbx')), dl('blend', t('anim.exp.blend'))));
  }
}

function toBase64(buf) {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
