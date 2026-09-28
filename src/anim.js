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
import { el, api, fileUrl, toast, errText, money } from './ui.js';
import { t, has } from './i18n.js';
import { HUMAN_POINTS, HUMAN_BONES, MIRRORED, buildHuman, centerX, mirror, pairOf, pairBone, sideOf } from './anim-rig.js';
import { newClip, sample, setKey, deleteKey, moveKey, keyAt, keyFrames, bake } from './anim-clip.js';
import { Timeline, inlineRename } from './timeline.js';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';

// Цвет стороны персонажа: левая — синяя, правая — зелёная, середина — фиолетовая.
const SIDE_COLOR = { L: new THREE.Color('#3b5bdb'), R: new THREE.Color('#0ca678'), C: new THREE.Color('#7048e8') };
const SEL = new THREE.Color('#f08c00');
const HOVER = new THREE.Color('#ffc078');      // под курсором — видно, что возьмётся щелчком
const HOT = new THREE.Color('#ff5a1f');
const COLD = new THREE.Color('#c9c5bf');
const FRONT = new THREE.Vector3(0, 0, 1);
const V = (a) => new THREE.Vector3(...a);
const enc = encodeURIComponent;

// Инструменты позы — колонка слева в окне (как справа, те же кнопки).
const POSE_ICONS = {
  rotate: '<path d="M20 12a8 8 0 1 1-2.34-5.66"/><path d="M20 4v5h-5"/>',
  move: '<path d="M12 3v18M3 12h18"/><path d="M9 6l3-3 3 3M9 18l3 3 3-3M6 9l-3 3 3 3M18 9l3 3-3 3"/>',
  reset: '<path d="M4 4v6h6"/><path d="M5.5 15a8 8 0 1 0 1.9-8.3L4 10"/>',
};
const poseIcon = (n) => el('span', { class: 'rail-ico', html: `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${POSE_ICONS[n]}</svg>` });
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
  constructor(viewer, stageEl, { onLoad = () => {}, onChange = () => {}, modelPicker = null } = {}) {
    this.viewer = viewer;
    this.modelPicker = modelPicker;  // выбор модели Claude для «Задачи агенту»
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
    this.poseMode = 'rotate';      // rotate — кольца, move — стрелки (любая кость)
    this.poseRail = el('div', { class: 'pose-rail', hidden: true });
    stageEl.append(this.poseRail);
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
      onBone: (name) => this.selectBone(name),
      onRename: (from, to) => this.renameAny(from, to),
    });
    viewer.host.after(this.tl.root);            // под окном модели, окно становится ниже

    // Задача агенту: чат на месте полосы времени.
    this.agentOpen = false;
    this.agentJob = null;                       // { id, clip, t0 } — агент работает
    this.agentLog = [];
    try { this.agentModel = localStorage.getItem('modelist.anim.model') || 'opus'; } catch { this.agentModel = 'opus'; }
    this.agentCard = el('div', { class: 'timeline agent-card', hidden: true });
    this.tl.root.after(this.agentCard);
    document.addEventListener('keydown', (e) => this.key(e));

    // Слушаем раньше OrbitControls (фаза захвата на окне): тянем сустав или
    // кость — камера стоит; просто щёлкнули — точка или выбор кости.
    // Только по самому окну модели: куб ориентации и панели поверх — мимо.
    const host = viewer.host;
    const mine = (e) => this.name && (e.target === viewer.renderer.domElement || this.drag);
    host.addEventListener('pointerdown', (e) => mine(e) && this.down(e), true);
    host.addEventListener('pointermove', (e) => mine(e) && this.move(e), true);
    host.addEventListener('pointerup', (e) => mine(e) && this.up(e), true);
    host.addEventListener('pointerleave', () => { if (this.hoverKey) { this.hoverKey = null; this.draw(); } });
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
      // Основы нет или она из 0.5.0 (там лево-право угадывалось по ширине и
      // модель могла остаться боком) — подготовить заново; скелет повернётся с ней.
      if (!st.base || st.baseV < 2) st = await this.run('prepare', () => api(`/anim/${enc(name)}/prepare`, { method: 'POST', body: {} }));
      if (this.name !== name || !st) return;
      this.st = st;
      this.clips = st.clips || [];
      this.packs = st.packs || [];
      this.fromRig();
      await this.show();
      const run = (await this.api('/agent').catch(() => []))[0];
      if (run && this.name === name) { this.agentJob = { id: run.id, clip: run.clip, t0: run.t0 }; this.pollAgent(); }
    } catch (e) { toast(errText(e), true); }
    this.onChange();
  }

  close() {
    if (!this.name) return;
    clearTimeout(this.agentTimer);
    this.agentJob = null;                 // агент доработает сам; откроют вкладку — подхватим
    this.agentOpen = false;
    this.agentCard.hidden = true;
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
    this.draw();                                       // с экрана — сразу, не дожидаясь сервера
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

  // Стоит спиной — развернуть на 180°. Лево и право программа находит сама,
  // скелет поворачивается вместе с моделью.
  async turn() {
    const name = this.name;
    const st = await this.run('prepare', () => api(`/anim/${enc(name)}/prepare`, { method: 'POST', body: { turn: ((this.st?.turn || 0) + 180) % 360 } }));
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

  renameBone(name, from = this.bsel) {
    const b = this.rbone(from);
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
      b.userData.pw = b.parent.getWorldQuaternion(new THREE.Quaternion());   // родитель в покое
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
        this.setPoseMode(this.poseMode, false);
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
    this.linesTop = null;
  }

  draw() {
    this.clearOverlay();
    const v = this.viewer;
    if (!this.name || !v.root) return;
    const stage = this.stage;
    v.controls.enableRotate = stage !== 'points';          // точки — только спереди
    new THREE.Box3().setFromObject(v.root).getCenter(this.center);
    const r = v.span * 0.012;
    const hv = this.hoverKey;
    const dot = (get, { color, opacity = 1, joint = null, bone = null, big = false } = {}) => {
      const m = new THREE.Mesh(new THREE.SphereGeometry(big ? r * 1.4 : r, 14, 10),
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthTest: false }));
      m.renderOrder = 999;
      m.userData = { get, joint, bone, opacity };
      this.group.add(m);
      this.dots.push(m);
    };
    const local = (p) => () => v.root.localToWorld(V(p));
    // [начало, конец, имя, цвет, выделена]
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
      // Сустав мог уже исчезнуть (правка, отмена) — точка остаётся на месте.
      const J = (id) => { let last = new THREE.Vector3(); return () => (this.joints[id] ? (last = v.root.localToWorld(V(this.joints[id]))) : last); };
      const sb = this.rbone(this.bsel);
      const used = new Set(this.rbones.flatMap((b) => [b.head, b.tail]));
      for (const id of used) {
        const on = this.drag?.joint === id || (sb && (sb.head === id || sb.tail === id));
        dot(J(id), { joint: id, color: on ? SEL : hv === id ? HOVER : SIDE_COLOR[sideOf(id)], big: on || hv === id });
      }
      for (const b of this.rbones) {
        const on = b.name === this.bsel;
        segs.push([J(b.head), J(b.tail), b.name, on ? SEL : hv === b.name ? HOVER : SIDE_COLOR[sideOf(b.name)], on || hv === b.name]);
      }
    } else if (stage === 'bound') {
      for (const b of this.bones) {
        const on = b.name === this.sel;
        const color = on ? SEL : hv === b.name ? HOVER : SIDE_COLOR[sideOf(b.name)];
        dot(() => b.getWorldPosition(new THREE.Vector3()), { bone: b.name, color, big: on || hv === b.name });
        segs.push([() => b.getWorldPosition(new THREE.Vector3()), () => b.localToWorld(b.userData.tail.clone()), b.name, color, on || hv === b.name]);
      }
    }
    // Кости — толстыми линиями (обычная линия WebGL — в пиксель, в неё не попасть);
    // выбранная и та, что под курсором, — ещё толще, поверх остальных.
    const fat = (list, width, order) => {
      if (!list.length) return null;
      const g = new LineSegmentsGeometry();
      g.setPositions(new Float32Array(list.length * 6));
      const col = new Float32Array(list.length * 6);
      list.forEach((sg, k) => { sg[3].toArray(col, k * 6); sg[3].toArray(col, k * 6 + 3); });
      g.setColors(col);
      const m = new LineMaterial({ linewidth: width, vertexColors: true, transparent: true, opacity: 0.95, depthTest: false });
      const line = new LineSegments2(g, m);
      line.frustumCulled = false;
      line.renderOrder = order;
      line.userData.segs = list;
      this.group.add(line);
      return line;
    };
    this.lines = fat(segs, 3, 997);
    this.linesTop = fat(segs.filter((sg) => sg[4]), 6, 998);
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
    const size = this.viewer.renderer.getSize(new THREE.Vector2());
    for (const line of [this.lines, this.linesTop]) {
      if (!line) continue;
      const buf = line.geometry.attributes.instanceStart.data;   // начала и концы — в одном буфере
      line.userData.segs.forEach(([a, b], i) => { a().toArray(buf.array, i * 6); b().toArray(buf.array, i * 6 + 3); });
      buf.needsUpdate = true;
      line.material.resolution.copy(size);
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
    let bestD = 18;
    let bestZ = Infinity;
    for (const d of this.dots) {
      const id = d.userData.joint || d.userData.bone;
      if (!id) continue;
      const [x, y, z] = this.screen(d.position);
      const dist = Math.hypot(x - e.clientX, y - e.clientY);
      if (dist >= 18) continue;
      if (dist < bestD - 4 || (Math.abs(dist - bestD) <= 4 && z < bestZ)) { best = d.userData; bestD = dist; bestZ = z; }
    }
    if (best) return best.joint ? { joint: best.joint } : { bone: best.bone };
    if (!this.lines) return null;
    let name = null;
    bestD = 12;
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
    const key = hit?.joint || hit?.bone || null;
    if (key !== this.hoverKey) { this.hoverKey = key; this.draw(); }
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
    if (this.agentOpen) this.openAgent();
    this.onChange();
  }

  closeClip(redraw = true) {
    this.agentOpen = false;
    this.agentCard.hidden = true;
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
    if (!c || !this.name) return Promise.resolve();
    return this.api(`/clips/${c.id}`, { method: 'PUT', body: c }).catch((e) => toast(errText(e), true));
  }

  // Поза движения в кадре f → кости. Кость без ключей — в покое.
  applyPose(f) {
    for (const b of this.bones) {
      const s = this.clip ? sample(this.clip, b.name, f) : null;
      if (s) b.quaternion.fromArray(s.q); else b.quaternion.copy(b.userData.rest);
      if (s?.p) b.position.fromArray(s.p); else b.position.copy(b.userData.restP);
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
    // Сдвиг пишем, если кость сдвинута или уже двигалась в этом движении;
    // первым сдвигом старым ключам дописываем место покоя — без рывка.
    const ks = this.clip.keys[b.name] || [];
    const withP = b === this.rootBone || b.position.distanceToSquared(b.userData.restP) > 1e-10 || ks.some((k) => k.p);
    if (withP) for (const k of ks) if (!k.p) k.p = b.userData.restP.toArray().map((v) => +v.toFixed(6));
    setKey(this.clip, b.name, f, b.quaternion.toArray(), withP ? b.position.toArray() : null);
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
    const V3 = THREE.Vector3;
    // Поворот от покоя (в мире) и сдвиг от покоя под нынешним родителем.
    const delta = new Map();
    const shift = new Map();
    for (const b of this.bones) {
      delta.set(b.name, b.getWorldQuaternion(new THREE.Quaternion()).multiply(b.userData.restW.clone().invert()));
      shift.set(b.name, b.getWorldPosition(new V3()).sub(b.userData.restP.clone().applyMatrix4(b.parent.matrixWorld)));
    }
    for (const b of [...this.bones].sort((a, c) => a.userData.depth - c.userData.depth)) {
      const src = pairBone(b.name) && delta.has(pairBone(b.name)) ? pairBone(b.name) : b.name;
      const d = delta.get(src);
      const w = new THREE.Quaternion(d.x, -d.y, -d.z, d.w).multiply(b.userData.restW);
      b.quaternion.copy(b.parent.getWorldQuaternion(new THREE.Quaternion()).invert().multiply(w));
      const sh = shift.get(src);
      const at = b.userData.restP.clone().applyMatrix4(b.parent.matrixWorld).add(new V3(-sh.x, sh.y, sh.z));
      b.position.copy(b.parent.worldToLocal(at));
      b.updateMatrixWorld(true);
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
      b.position.fromArray(p);
    }
    this.viewer.root.updateMatrixWorld(true);
    this.keyAll();
  }

  renderTl() {
    if (!this.clip || this.stage !== 'bound') { this.tl.hide(); this.agentCard.hidden = true; this.renderPoseRail(); return; }
    if (this.agentOpen) { this.tl.hide(); this.agentCard.hidden = false; this.renderPoseRail(); return; }
    // Все кости по дереву: у каждой своя строка, щелчок по имени — выбрать.
    const rows = this.boneTree().map((b) => ({ bone: b.name, label: boneLabel(b.name), depth: b.depth }));
    const k = this.selKeys()[0];
    this.renderPoseRail();
    this.tl.render({
      clip: this.clip, frame: this.frame, playing: this.playing, rows, sel: this.keySel, bone: this.sel,
      ease: k ? keyAt(this.clip, k[0], k[1])?.e || 'smooth' : null, canPaste: !!this.poseBuf,
    });
  }

  // Кости по дереву (ребёнок сразу под родителем) с глубиной — для списка и полосы.
  boneTree() {
    const skel = this.stage === 'skeleton';
    const list = skel ? this.rbones.map((b) => ({ name: b.name, parent: b.parent || null }))
      : this.bones.map((b) => ({ name: b.name, parent: b.parent?.isBone ? b.parent.name : null }));
    const out = [];
    const walk = (parent, depth) => {
      for (const b of list.filter((x) => x.parent === parent)) { out.push({ ...b, depth }); walk(b.name, depth + 1); }
    };
    walk(null, 0);
    for (const b of list) if (!out.some((x) => x.name === b.name)) out.push({ ...b, depth: 0 });
    return out;
  }

  // Колонка слева в окне: вращать, двигать, вернуть кость в покой.
  renderPoseRail() {
    const show = !!this.clip && this.stage === 'bound';
    this.poseRail.hidden = !show;
    if (!show) return;
    const b = (mode, title) => el('button', { class: 'rail-btn' + (this.poseMode === mode ? ' on' : ''), title, onclick: () => this.setPoseMode(mode) }, poseIcon(mode));
    this.poseRail.replaceChildren(
      b('rotate', t('pose.rotate')), b('move', t('pose.move')),
      el('div', { class: 'rail-sep' }),
      el('button', { class: 'rail-btn', title: t('pose.reset'), disabled: !this.sel, onclick: () => this.resetBone() }, poseIcon('reset')));
  }

  // Вращать — кольца в осях кости; двигать — стрелки в осях мира.
  setPoseMode(mode, render = true) {
    this.poseMode = mode;
    this.tc.setMode(mode === 'move' ? 'translate' : 'rotate');
    this.tc.setSpace(mode === 'move' ? 'world' : 'local');
    if (render) { this.renderPoseRail(); this.onChange(); }
  }

  resetBone() {
    const b = this.sel && this.bone(this.sel);
    if (!b || !this.clip) return;
    this.pause();
    b.quaternion.copy(b.userData.rest);
    b.position.copy(b.userData.restP);
    b.updateMatrixWorld(true);
    this.keyBone(b);
  }

  // Переименовать кость. В скелете — только скелет; у привязанной модели —
  // везде: скелет, модель с костями и ключи всех движений (на сервере).
  async renameAny(from, to) {
    to = String(to || '').trim();
    if (!to || to === from) return;
    if (this.stage === 'skeleton') { this.renameBone(to, from); return; }
    if (!BONE_NAME.test(to) || this.bone(to)) { toast(t('anim.bone.badName'), true); return; }
    await this.flushClip();
    try {
      const st = await this.api('/rename', { method: 'POST', body: { from, to } });
      this.st.rig = st.rig;
      this.st.skin = st.skin;
    } catch (e) { toast(errText(e), true); return; }
    const b = this.bone(from);
    if (b) b.name = to;
    for (const c of this.clips) if (c.keys[from]) { c.keys[to] = c.keys[from]; delete c.keys[from]; }
    if (this.sel === from) this.sel = to;
    if (this.keySel?.bone === from) this.keySel.bone = to;
    this.draw();
    this.renderTl();
    this.onChange();
  }

  // ── движение по словам: задача агенту ─────────────────────────────────
  // Агенту — скелет «по-человечески» (кости, откуда и куда идут, пол),
  // покой каждой кости (чтобы сервер перевёл ответ в ключи) и нынешнее
  // движение в том же виде, что он вернёт: повороты от покоя относительно
  // родителя в осях модели, градусы (X → Y → Z), сдвиг корня в метрах.
  agentContext() {
    const rig = this.st.rig;
    const bones = this.boneTree().map((b) => {
      const def = rig.bones.find((x) => x.name === b.name);
      return { name: b.name, parent: b.parent, label: boneLabel(b.name), head: rig.joints[def?.head], tail: rig.joints[def?.tail] };
    }).filter((b) => b.head && b.tail);
    const rest = {};
    for (const b of this.bones) rest[b.name] = { pw: b.userData.pw.toArray(), w: b.userData.restW.toArray(), p0: b.userData.restP.toArray() };
    const c = this.clip;
    const keys = keyFrames(c).map((f) => {
      const out = {};
      let e = 'smooth';
      for (const b of this.bones) {
        const k = keyAt(c, b.name, f);
        if (!k) continue;
        e = k.e || e;
        const D = b.userData.pw.clone().multiply(new THREE.Quaternion().fromArray(k.q)).multiply(b.userData.restW.clone().invert());
        const eu = new THREE.Euler().setFromQuaternion(D, 'ZYX');
        const v = { r: [eu.x, eu.y, eu.z].map((a) => +THREE.MathUtils.radToDeg(a).toFixed(1)) };
        if (k.p && !b.parent?.isBone) v.p = new THREE.Vector3().fromArray(k.p).sub(b.userData.restP).applyQuaternion(b.userData.pw).toArray().map((x) => +x.toFixed(3));
        out[b.name] = v;
      }
      return { f, e, bones: out };
    });
    return { bones, rest, floor: this.localBox().min[1], motion: { frames: c.frames, fps: c.fps, loop: c.loop, keys } };
  }

  async openAgent() {
    if (!this.clip) return;
    this.pause();
    this.agentOpen = true;
    const id = this.clip.id;
    this.agentLog = [];
    this.renderTl();
    this.renderAgent();
    this.onChange();
    const log = await this.api(`/chat/${id}`).catch(() => []);
    if (this.clip?.id === id) { this.agentLog = log; this.renderAgent(); }
  }

  closeAgent() {
    this.agentOpen = false;
    this.agentCard.hidden = true;
    this.renderTl();
    this.onChange();
  }

  renderAgent() {
    const card = this.agentCard;
    const show = this.agentOpen && !!this.clip && this.stage === 'bound';
    card.hidden = !show;
    if (!show) return;
    card.style.height = this.tl.root.style.height;
    const job = this.agentJob && this.agentJob.clip === this.clip.id ? this.agentJob : null;
    const draft = card.querySelector('textarea')?.value || '';
    const send = () => this.sendAgent(ta.value);
    const ta = el('textarea', {
      class: 'textarea agent-input', placeholder: t('agent.ph'), disabled: !!job,
      onkeydown: (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); } },
    });
    ta.value = draft;
    const msg = (m) => el('div', { class: 'agent-msg ' + m.role },
      m.role === 'error' ? errText({ code: m.code, params: m.params, error: m.text }) : m.text,
      m.cost ? el('span', { class: 'agent-cost' }, money(m.cost)) : null);
    const log = el('div', { class: 'agent-log' },
      ...(this.agentLog.length ? this.agentLog.map(msg) : [el('div', { class: 'muted agent-empty' }, t('agent.empty'))]),
      job && el('div', { class: 'agent-msg working' },
        el('span', { class: 'typing agent-time' }, t('agent.working', { time: '0:00' })),
        el('button', { class: 'link-btn', title: t('tip.agentStop'), onclick: () => this.api(`/agent/${job.id}/stop`, { method: 'POST' }).catch(() => {}) }, t('chat.stop'))));
    card.replaceChildren(
      el('div', { class: 'agent-head' },
        el('span', { class: 'agent-title' }, '✦ ' + t('agent.title', { name: this.clip.name })),
        el('span', { class: 'tl-sp' }),
        this.modelPicker && this.modelPicker(this.agentModel, (v) => {
          this.agentModel = v;
          try { localStorage.setItem('modelist.anim.model', v); } catch { /* приватный режим */ }
          this.renderAgent();
        }),
        el('button', { class: 'btn tl-btn', title: t('tip.agentBack'), onclick: () => this.closeAgent() }, '↩ ' + t('agent.back'))),
      log,
      el('div', { class: 'agent-foot' }, ta,
        el('button', { class: 'btn primary', disabled: !!job, title: t('tip.agentSend'), onclick: send }, t('chat.send'))));
    log.scrollTop = log.scrollHeight;
    this.tickAgent();
    if (!job) ta.focus();
  }

  // Часы в строке «Агент делает движение…» — без перерисовки чата.
  tickAgent() {
    const label = this.agentCard.querySelector('.agent-time');
    if (!label || !this.agentJob) return;
    const s = Math.max(0, Math.round((Date.now() - this.agentJob.t0) / 1000));
    label.textContent = t('agent.working', { time: `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` });
  }

  async sendAgent(text) {
    text = String(text || '').trim();
    if (!text || !this.clip || this.agentJob) return;
    await this.flushClip();
    const clip = this.clip;
    try {
      const { job } = await this.api('/agent', { method: 'POST', body: { clip: clip.id, message: text, model: this.agentModel, context: this.agentContext() } });
      this.agentLog.push({ role: 'user', text });
      this.agentJob = { id: job, clip: clip.id, t0: Date.now() };
      const ta = this.agentCard.querySelector('textarea');
      if (ta) ta.value = '';
      this.renderAgent();
      this.pollAgent();
    } catch (e) { toast(errText(e), true); }
  }

  pollAgent() {
    clearTimeout(this.agentTimer);
    const job = this.agentJob;
    if (!job || !this.name) return;
    this.agentTimer = setTimeout(async () => {
      this.tickAgent();
      const st = await this.api(`/agent/${job.id}`).catch(() => null);
      if (this.agentJob !== job) return;
      if (!st || st.state === 'running') { this.pollAgent(); return; }
      this.agentJob = null;
      await this.agentDone(job.clip, st);
    }, 1000);
  }

  // Агент закончил: ключи уже в файле движения — забрать и показать на полосе.
  async agentDone(clipId, st) {
    const log = await this.api(`/chat/${clipId}`).catch(() => null);
    if (log && this.clip?.id === clipId) this.agentLog = log;
    if (st.state === 'done') {
      const fresh = await this.api('').catch(() => null);
      const c = fresh?.clips?.find((x) => x.id === clipId);
      if (c) {
        const i = this.clips.findIndex((x) => x.id === clipId);
        if (i >= 0) this.clips[i] = c; else this.clips.push(c);
        if (this.clip?.id === clipId) this.clip = c;
      }
      if (this.clip?.id === clipId) {
        this.agentOpen = false;
        this.agentCard.hidden = true;
        this.keySel = null;
        this.setFrame(0);
        this.togglePlay();              // сразу показать, что вышло
      }
      toast(t('agent.done'));
    } else if (this.clip?.id === clipId) {
      this.renderAgent();
    }
    this.onChange();
  }

  // «Вернуть как было»: ключи движения до правки агента.
  undoAgent() {
    const c = this.clip;
    if (!c?.undo) return;
    this.pause();
    Object.assign(c, { keys: c.undo.keys, frames: c.undo.frames, fps: c.undo.fps, loop: c.undo.loop });
    delete c.undo;
    this.saveClip(c, true);
    this.keySel = null;
    this.setFrame(0);
    this.onChange();
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
      el('button', { class: this.way === 'manual' ? 'on' : '', title: t('tip.way.manual'), onclick: () => this.setWay('manual') }, t('anim.way.manual')),
      el('button', { class: this.way === 'points' ? 'on' : '', title: t('tip.way.points'), onclick: () => this.setWay('points') }, t('anim.way.points')));

    if (s === 'points') {
      const next = this.nextPoint();
      wrap.append(
        field(el('div', { class: 'label' }, t('anim.skeleton')), way),
        field(el('div', { class: 'muted' }, t('anim.points.hint')),
          el('ol', { class: 'anim-points' }, ...HUMAN_POINTS.map((k) => el('li', { class: this.markers[k] ? 'done' : k === next ? 'next' : '' },
            el('span', { class: 'pt-mark' }, this.markers[k] ? '✓' : ''), t('anim.pt.' + k))))),
        field(el('div', { class: 'row' },
          el('button', { class: 'btn', disabled: !Object.keys(this.markers).length, title: t('tip.undoPoint'), onclick: () => this.undoPoint() }, '↶ ' + t('anim.undo')),
          el('button', { class: 'btn', title: t('tip.turn'), onclick: () => this.turn() }, '↻ ' + t('anim.turn'))),
        el('div', { class: 'muted small' }, t('anim.turn.hint'))));
    } else if (s === 'skeleton') {
      const sb = this.rbone(this.bsel);
      const tool = (id, label) => el('button', { class: this.tool === id ? 'on' : '', title: t('tip.tool.' + id), onclick: () => { this.tool = id; this.onChange(); } }, label);
      wrap.append(...[
        field(el('div', { class: 'label' }, t('anim.skeleton')), way),
        field(el('div', { class: 'seg full' }, tool('add', t('anim.tool.add')), tool('move', t('anim.tool.move'))),
          el('div', { class: 'muted small' }, t(this.tool === 'add' ? (this.rbones.length ? 'anim.tool.add.more' : 'anim.first.hint') : 'anim.tool.move.hint')),
          el('label', { class: 'check' }, el('input', { type: 'checkbox', checked: this.mirrorEdit, onchange: (e) => { this.mirrorEdit = e.target.checked; this.onChange(); } }), t('anim.mirrorEdit')),
          el('div', { class: 'muted small anim-legend' },
            el('span', { class: 'lg l' }), t('anim.legend.l'), el('span', { class: 'lg r' }), t('anim.legend.r'))),
        this.boneList(),
        !!sb && field(el('div', { class: 'label' }, t('anim.bone.sel')),
          el('input', { class: 'input', value: sb.name, title: boneLabel(sb.name), onchange: (e) => this.renameBone(e.target.value) }),
          el('button', { class: 'btn danger wide', title: t('tip.boneDelete'), onclick: () => this.deleteBone() }, t('anim.bone.delete'))),
        field(
          el('button', { class: 'btn primary wide', disabled: !this.rbones.length, title: t('tip.bind'), onclick: () => this.bind() }, t('anim.bind')),
          el('div', { class: 'row' },
            el('button', { class: 'btn', disabled: !this.undoStack.length, title: t('tip.undo'), onclick: () => this.undo() }, '↶ ' + t('anim.undo')),
            el('button', { class: 'btn', title: t('tip.turn'), onclick: () => this.turn() }, '↻ ' + t('anim.turn'))),
          el('button', { class: 'btn wide', disabled: !this.rbones.length, title: t('tip.restart'), onclick: () => this.clearSkeleton() }, t('anim.restart')),
          // Скелет не трогали — можно вернуться к прежней привязке.
          !!this.st.skin && el('button', { class: 'btn wide', title: t('tip.keep'), onclick: () => this.cancelEdit() }, t('anim.keep'))),
      ].filter(Boolean));   // DOM-append печатает false словом
    } else if (s === 'binding') {
      wrap.append(field(el('div', { class: 'label' }, t('anim.skeleton')), el('div', { class: 'typing' }, t('anim.binding'))));
    } else if (s === 'bound') {
      wrap.append(field(el('div', { class: 'row between' },
        el('div', { class: 'anim-ok' }, '✓ ' + t('anim.bound')),
        el('button', { class: 'link-btn', title: t('tip.editRig'), onclick: () => this.editRig() }, t('anim.editRig')))));
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
      wrap.append(...[this.boneList(), this.exportField()].filter(Boolean));
    }
    return wrap;
  }

  // Список костей: щелчок по имени — выбрать (в окне кости бывают друг за
  // другом), второй щелчок сразу следом — переименовать. Отступ — какая к
  // какой крепится.
  boneList() {
    const skel = this.stage === 'skeleton';
    const list = this.boneTree();
    if (!list.length) return false;
    const cur = skel ? this.bsel : this.sel;
    const pick = (name) => (skel ? (this.bsel = name, this.draw(), this.onChange()) : this.selectBone(name));
    const click = (name) => {
      const again = this.lastRow && this.lastRow.name === name && Date.now() - this.lastRow.t < 450;
      this.lastRow = { name, t: Date.now() };
      if (!again) { pick(name === cur ? null : name); return; }
      const label = document.querySelector(`.bone-row[data-bone="${CSS.escape(name)}"] .bone-name`);
      if (label) inlineRename(label, name, (to) => this.renameAny(name, to));
    };
    return el('div', { class: 'field' },
      el('div', { class: 'label' }, t('anim.bones'), el('span', { class: 'hint' }, t('anim.bones.hint'))),
      el('div', { class: 'bone-list' }, ...list.map((b) => el('div', {
        class: 'bone-row' + (b.name === cur ? ' on' : ''), style: `padding-left:${8 + b.depth * 12}px`, 'data-bone': b.name,
        onclick: () => click(b.name),
        onmouseenter: () => { this.hoverKey = b.name; this.draw(); },
        onmouseleave: () => { this.hoverKey = null; this.draw(); },
      }, el('span', { class: 'bone-dot ' + sideOf(b.name) }), el('span', { class: 'bone-name' }, boneLabel(b.name))))));
  }

  // Движения по пакам: имя пака правится прямо в строке.
  clipsField() {
    const list = el('div', { class: 'anim-packs' });
    for (const p of this.packs) {
      const clips = this.clips.filter((c) => c.pack === p.id);
      list.append(el('div', { class: 'anim-pack' },
        el('div', { class: 'pack-head' },
          el('span', { class: 'pack-ico', html: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>' }),
          el('input', { class: 'input pack-name', value: p.name, title: t('anim.pack.rename'), onchange: (e) => this.renamePack(p.id, e.target.value) }),
          el('button', { class: 'link-btn', title: t('tip.clipAdd'), onclick: () => this.addClip(p.id) }, '+ ' + t('anim.clip.new').toLowerCase()),
          !clips.length && el('button', { class: 'icon-mini', title: t('tip.packDelete'), onclick: () => this.deletePack(p.id) }, '✕')),
        ...clips.map((c) => el('button', {
          class: 'clip-item' + (c === this.clip ? ' on' : ''), title: t('tip.clipItem'),
          onclick: () => (c === this.clip ? this.closeClip() : this.openClip(c.id)),
        }, el('span', {}, c.name + (c.loop ? ' ⟲' : '')), el('span', { class: 'muted' }, t('anim.frames.n', { n: c.frames }))))));
    }
    // Паки без движений (чужие id) — движения всё равно видны.
    const orphans = this.clips.filter((c) => !this.packs.some((p) => p.id === c.pack));
    for (const c of orphans) list.append(el('button', { class: 'clip-item' + (c === this.clip ? ' on' : ''), title: t('tip.clipItem'), onclick: () => this.openClip(c.id) }, c.name));
    return el('div', { class: 'field' },
      el('div', { class: 'label' }, t('anim.clips')),
      el('div', { class: 'muted small' }, t('anim.packs.hint')),
      !this.clips.length && el('div', { class: 'muted small' }, t('anim.clips.none')),
      list,
      el('div', { class: 'row' },
        el('button', { class: 'btn', title: t('tip.clipNew'), onclick: () => this.addClip(this.clip?.pack) }, '+ ' + t('anim.clip.new')),
        el('button', { class: 'btn', title: t('tip.packNew'), onclick: () => this.newPack() }, '+ ' + t('anim.pack.new'))));
  }

  // Выбранное движение: имя, длина, скорость, по кругу, пак.
  clipField() {
    const c = this.clip;
    return el('div', { class: 'field anim-clip' },
      el('div', { class: 'label' }, t('anim.clip')),
      el('input', { class: 'input', value: c.name, onchange: (e) => e.target.value.trim() && this.updateClip({ name: e.target.value.trim() }) }),
      el('div', { class: 'row' },
        el('label', { class: 'anim-num' }, t('anim.frames'),
          el('input', { class: 'input', type: 'number', min: 2, max: 2000, value: c.frames, onchange: (e) => { const n = Math.round(Number(e.target.value)); if (n >= 2 && n <= 2000) this.updateClip({ frames: n }); } })),
        el('div', { class: 'seg' }, ...[24, 30, 60].map((f) => el('button', { class: c.fps === f ? 'on' : '', title: t('tip.fps', { n: f }), onclick: () => this.updateClip({ fps: f }) }, t('anim.fps', { n: f }))))),
      el('label', { class: 'check' }, el('input', { type: 'checkbox', checked: c.loop, onchange: (e) => this.updateClip({ loop: e.target.checked }) }), t('anim.loop')),
      // Движение по словам: чат с агентом на месте полосы времени.
      el('button', {
        class: 'btn accent wide agent-btn' + (this.agentOpen ? ' on' : ''), title: t('tip.agent'),
        onclick: () => (this.agentOpen ? this.closeAgent() : this.openAgent()),
      }, (this.agentJob?.clip === c.id ? '⏳ ' : '✦ ') + t(this.agentOpen ? 'agent.back' : 'anim.agent.btn')),
      !!c.undo && el('button', { class: 'link-btn', title: t('tip.agentUndo'), onclick: () => this.undoAgent() }, t('agent.undo')),
      this.packs.length > 1 && el('select', { class: 'input', onchange: (e) => this.updateClip({ pack: e.target.value }) },
        ...this.packs.map((p) => el('option', { value: p.id, selected: p.id === c.pack }, t('anim.inPack', { name: p.name })))),
      el('div', { class: 'muted small' }, t(this.sel ? 'anim.pose.hint' : 'anim.pick.hint')),
      el('button', { class: 'btn danger wide', title: t('tip.clipDelete'), onclick: () => this.removeClip() }, t('anim.clip.delete')));
  }

  exportField() {
    const busy = this.exporting;
    const packs = this.packs.filter((p) => this.clips.some((c) => c.pack === p.id));
    this.expPack = packs.some((p) => p.id === this.expPack) ? this.expPack : null;
    const dl = (fmt, hint) => el('button', { class: 'btn dl-btn', disabled: !!busy, title: t('tip.exp.' + fmt), onclick: () => this.exportAnim(this.expPack, fmt) },
      el('span', { class: 'dl-fmt' }, fmt === 'blend' ? '.blend' : fmt.toUpperCase()), el('span', { class: 'dl-hint' }, busy === fmt ? t('anim.exp.busy') : hint));
    return el('div', { class: 'field' },
      el('div', { class: 'label' }, t('anim.exp')),
      packs.length > 0 && el('select', { class: 'input', title: t('anim.exp.what'), onchange: (e) => { this.expPack = e.target.value || null; } },
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
