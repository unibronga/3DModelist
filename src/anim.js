// Вкладка «Анимации» у готовой модели.
// Скелет: основа лицом вперёд (Blender без окна) → пять точек на модели →
// скелет, суставы тянутся мышью (вторая сторона повторяет) → «Привязать»
// (Blender считает веса) → проверка сгибом и подкраска «что держит кость».
// Движения: щёлкнул кость — кольца поворота; отпустил — ключ на текущем
// кадре. Полоса времени снизу, паки, выгрузка GLB / FBX / .blend.
// Точки и суставы — в координатах модели (glTF: Y вверх, лицом на +Z).

import * as THREE from 'three';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { el, api, fileUrl, toast, errText } from './ui.js';
import { t } from './i18n.js';
import { HUMAN_POINTS, HUMAN_BONES, MIRRORED, buildHuman, centerX, mirror, pairOf, pairBone } from './anim-rig.js';
import { newClip, sample, setKey, deleteKey, moveKey, keyAt, keyFrames, bake } from './anim-clip.js';
import { Timeline } from './timeline.js';

const DOT = new THREE.Color('#3b5bdb');
const DOT_SEL = new THREE.Color('#f08c00');
const HOT = new THREE.Color('#ff5a1f');
const COLD = new THREE.Color('#c9c5bf');
const FRONT = new THREE.Vector3(0, 0, 1);
const V = (a) => new THREE.Vector3(...a);
const enc = encodeURIComponent;

// Кость — человеческими словами: «Плечо · слева» вместо LeftUpperArm.
export function boneLabel(name) {
  const m = /^(Left|Right)?(\w+)$/.exec(name || '');
  if (!m) return name;
  const part = t('bone.' + m[2]);
  return m[1] ? t('bone.side.' + m[1], { part }) : part;
}

// Проверка сгибом: кость, куда тянуть, градусы при полном сгибе. Порядок —
// от родителей к детям: поворот родителя уже учтён, когда гнём ребёнка.
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
  // stageEl — поле с окном модели (там подсказка поверх окна).
  constructor(viewer, stageEl, { onLoad = () => {}, onChange = () => {} } = {}) {
    this.viewer = viewer;
    this.onLoad = onLoad;          // в окне другая модель (путь в рабочей папке)
    this.onChange = onChange;      // перерисовать правую панель
    this.name = null;
    this.st = null;
    this.markers = {};
    this.joints = null;
    this.editing = false;          // «Изменить скелет» у уже привязанной модели
    this.busy = null;              // 'prepare' | 'bind' — ждём Blender
    this.bones = [];
    this.meshes = [];
    this.sel = null;
    this.bend = 0;
    this.drag = null;
    this.group = new THREE.Group();
    this.lines = null;
    this.dots = [];
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

    // Слушаем раньше OrbitControls (фаза захвата на окне): тянем сустав —
    // камера стоит; просто щёлкнули — ставим точку или выбираем кость.
    const host = viewer.host;
    host.addEventListener('pointerdown', (e) => this.name && this.down(e), true);
    host.addEventListener('pointermove', (e) => this.name && this.move(e), true);
    host.addEventListener('pointerup', (e) => this.name && this.up(e), true);
  }

  get stage() {
    if (!this.st || this.busy === 'prepare') return 'prepare';
    if (this.busy === 'bind') return 'binding';
    if (this.st.skin && !this.editing) return 'bound';
    return this.joints ? 'skeleton' : 'points';
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
    this.viewer.host.style.cursor = '';
  }

  fromRig() {
    this.markers = { ...(this.st.rig?.markers || {}) };
    this.joints = this.st.rig?.joints ? structuredClone(this.st.rig.joints) : null;
  }

  // Задание Blender: пока идёт — панель показывает ожидание.
  async run(kind, fn) {
    this.busy = kind;
    this.onChange();
    try { return await fn(); } catch (e) { toast(errText(e), true); return null; } finally { this.busy = null; this.onChange(); }
  }

  // Модель в окне: привязанная — с костями, иначе основа.
  async show() {
    const bound = this.stage === 'bound';
    const f = bound ? this.st.skin : this.st.base;
    if (!f) return;
    this.sel = null;
    await this.viewer.load(fileUrl(f.path) + '?v=' + f.t);
    this.onLoad(f.path);
    if (bound) {
      this.collectBones();
      if (this.clip) this.setFrame(this.frame);
    } else this.viewer.setView('front');
    this.draw();
  }

  // ── точки и скелет ────────────────────────────────────────────────────
  localBox() {
    const root = this.viewer.root;
    root.updateMatrixWorld(true);
    const b = new THREE.Box3().setFromObject(root);
    return { min: root.worldToLocal(b.min.clone()).toArray(), max: root.worldToLocal(b.max.clone()).toArray() };
  }

  ray(e) {
    const rect = this.viewer.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    this.viewer.raycaster.setFromCamera(ndc, this.viewer.camera);
    return this.viewer.raycaster.ray;
  }

  // Точка — посередине толщи под курсором: между входом луча в модель и
  // выходом. Точку ставят спереди, а сустав должен быть внутри.
  inside(e) {
    const v = this.viewer;
    this.ray(e);
    const hits = v.raycaster.intersectObject(v.root, true).filter((h) => h.object.isMesh && h.object.visible);
    if (!hits.length) return null;
    const a = hits[0];
    const b = hits.find((h) => h.distance > a.distance + v.span * 0.002);
    const p = b && b.distance - a.distance < v.span * 0.5 ? a.point.clone().lerp(b.point, 0.5) : a.point.clone();
    return v.root.worldToLocal(p).toArray();
  }

  nextPoint() { return HUMAN_POINTS.find((k) => !this.markers[k]) || null; }

  placePoint(e) {
    const k = this.nextPoint();
    const p = k && this.inside(e);
    if (!p) return;
    this.markers[k] = p;
    if (!this.nextPoint()) {
      this.joints = buildHuman(this.markers, this.localBox());
      this.saveRig();
    }
    this.draw();
    this.onChange();
  }

  undoPoint() {
    if (this.joints) { this.joints = null; }
    const last = [...HUMAN_POINTS].reverse().find((k) => this.markers[k]);
    if (last) delete this.markers[last];
    this.draw();
    this.onChange();
  }

  async repoint() {
    this.markers = {};
    this.joints = null;
    this.editing = true;
    if (this.st.rig || this.st.skin) {
      const st = await api(`/anim/${enc(this.name)}/reset`, { method: 'POST' }).catch((e) => { toast(errText(e), true); return null; });
      if (st) this.st = st;
    }
    this.draw();
    this.onChange();
  }

  async turn() {
    const name = this.name;
    const st = await this.run('prepare', () => api(`/anim/${enc(name)}/prepare`, { method: 'POST', body: { turn: ((this.st?.turn || 0) + 90) % 360 } }));
    if (!st || this.name !== name) return;
    this.st = st;
    this.fromRig();
    await this.show();
    this.onChange();
  }

  async saveRig() {
    try {
      this.st = await api(`/anim/${enc(this.name)}/rig`, { method: 'PUT', body: { type: 'human', markers: this.markers, joints: this.joints, bones: HUMAN_BONES } });
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

  // ── кости привязанной модели ──────────────────────────────────────────
  collectBones() {
    const root = this.viewer.root;
    root.updateMatrixWorld(true);
    this.meshes = [];
    root.traverse((o) => { if (o.isSkinnedMesh) this.meshes.push(o); });
    this.bones = this.meshes[0]?.skeleton.bones || [];
    const joints = this.st.rig?.joints || {};
    this.rootBone = this.bones.find((b) => !b.parent?.isBone) || null;
    for (const b of this.bones) {
      b.userData.rest = b.quaternion.clone();
      b.userData.restP = b.position.clone();
      b.userData.restW = b.getWorldQuaternion(new THREE.Quaternion());
      b.userData.restWP = b.getWorldPosition(new THREE.Vector3());
      b.userData.depth = 0;
      for (let o = b.parent; o?.isBone; o = o.parent) b.userData.depth++;
      // Конец кости glTF не хранит — берём из скелета, в осях самой кости.
      const tail = joints[HUMAN_BONES.find((x) => x.name === b.name)?.tail];
      b.userData.tail = tail ? b.worldToLocal(root.localToWorld(V(tail))) : new THREE.Vector3(0, this.viewer.span * 0.05, 0);
    }
    this.bend = 0;
  }

  bone(name) { return this.bones.find((b) => b.name === name) || null; }

  setBend(k) {
    this.bend = k;
    for (const b of this.bones) b.quaternion.copy(b.userData.rest);
    this.viewer.root.updateMatrixWorld(true);
    for (const [name, how, deg] of BEND) {
      const b = this.bone(name);
      if (!b) continue;
      let axis;
      if (how === 'turn') axis = new THREE.Vector3(0, 1, 0);
      else {
        const head = b.getWorldPosition(new THREE.Vector3());
        const dir = b.localToWorld(b.userData.tail.clone()).sub(head).normalize();
        axis = new THREE.Vector3().crossVectors(dir, how === 'front' ? FRONT : FRONT.clone().negate());
        if (axis.lengthSq() < 1e-6) continue;
        axis.normalize();
      }
      rotateWorld(b, axis, THREE.MathUtils.degToRad(deg * k));
    }
  }

  // Выбор кости. В движении — кольца поворота (у таза можно и сдвигать);
  // без движения — подкраска: чем сильнее кость держит место модели, тем
  // оно краснее.
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
    const r = v.span * 0.011;
    const dot = (get, { color = DOT, opacity = 1, joint = null, bone = null } = {}) => {
      const m = new THREE.Mesh(new THREE.SphereGeometry(r, 14, 10),
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthTest: false }));
      m.renderOrder = 999;
      m.userData = { get, joint, bone };
      this.group.add(m);
      this.dots.push(m);
    };
    const local = (p) => () => v.root.localToWorld(V(p));
    const segs = [];
    if (stage === 'points') {
      const cx = this.markers.chin && this.markers.groin ? centerX(this.markers) : this.localBox().min[0] / 2 + this.localBox().max[0] / 2;
      for (const k of HUMAN_POINTS) {
        const p = this.markers[k];
        if (!p) continue;
        dot(local(p));
        if (MIRRORED.has(k)) dot(local(mirror(p, cx)), { opacity: 0.4 });
      }
    } else if (stage === 'skeleton' && this.joints) {
      for (const name of Object.keys(this.joints)) {
        if (/^(headTop|handEnd|toeEnd)/.test(name)) continue;   // концы — не суставы
        dot(() => v.root.localToWorld(V(this.joints[name])), { joint: name, color: this.drag?.joint === name ? DOT_SEL : DOT });
      }
      for (const b of HUMAN_BONES) segs.push([() => v.root.localToWorld(V(this.joints[b.head])), () => v.root.localToWorld(V(this.joints[b.tail]))]);
    } else if (stage === 'bound') {
      for (const b of this.bones) {
        const sel = b.name === this.sel;
        dot(() => b.getWorldPosition(new THREE.Vector3()), { bone: b.name, color: sel ? DOT_SEL : DOT, opacity: sel ? 1 : 0.85 });
        segs.push([() => b.getWorldPosition(new THREE.Vector3()), () => b.localToWorld(b.userData.tail.clone()), b.name]);
      }
    }
    if (segs.length) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(segs.length * 6), 3));
      this.lines = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: DOT, transparent: true, opacity: 0.9, depthTest: false }));
      this.lines.renderOrder = 998;
      this.lines.userData.segs = segs;
      this.group.add(this.lines);
    }
    const next = stage === 'points' && this.nextPoint();
    this.hint.hidden = !next;
    if (next) this.hint.textContent = t('anim.click', { name: t('anim.pt.' + next) });
    this.update();
  }

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
    for (const d of this.dots) d.position.copy(d.userData.get());
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

  // Точка мира → пиксели в окне.
  screen(p) {
    const rect = this.viewer.renderer.domElement.getBoundingClientRect();
    const q = p.clone().project(this.viewer.camera);
    return [rect.left + (q.x + 1) / 2 * rect.width, rect.top + (1 - q.y) / 2 * rect.height];
  }

  // Ближайший к курсору сустав (шаг «скелет») или кость (шаг «привязан»).
  pick(e) {
    let best = null;
    let bestD = 14;
    for (const d of this.dots) {
      if (!d.userData.joint && !d.userData.bone) continue;
      const [x, y] = this.screen(d.position);
      const dist = Math.hypot(x - e.clientX, y - e.clientY);
      if (dist < bestD) { bestD = dist; best = d.userData.joint || d.userData.bone; }
    }
    if (best || this.stage !== 'bound' || !this.lines) return best;
    bestD = 8;
    for (const [a, b, name] of this.lines.userData.segs) {
      const [ax, ay] = this.screen(a());
      const [bx, by] = this.screen(b());
      const vx = bx - ax;
      const vy = by - ay;
      const k = Math.max(0, Math.min(1, ((e.clientX - ax) * vx + (e.clientY - ay) * vy) / (vx * vx + vy * vy || 1)));
      const dist = Math.hypot(ax + vx * k - e.clientX, ay + vy * k - e.clientY);
      if (dist < bestD) { bestD = dist; best = name; }
    }
    return best;
  }

  down(e) {
    if (e.button !== 0) return;
    this.downAt = [e.clientX, e.clientY];
    if (this.stage !== 'skeleton') return;
    const joint = this.pick(e);
    if (!joint) return;
    e.stopPropagation();
    e.preventDefault();
    const v = this.viewer;
    const at = v.root.localToWorld(V(this.joints[joint]));
    const normal = v.camera.getWorldDirection(new THREE.Vector3());
    this.drag = { joint, plane: new THREE.Plane().setFromNormalAndCoplanarPoint(normal, at) };
    v.controls.enabled = false;
    e.target.setPointerCapture?.(e.pointerId);
    this.draw();
  }

  move(e) {
    const v = this.viewer;
    if (this.drag) {
      const hit = this.ray(e).intersectPlane(this.drag.plane, new THREE.Vector3());
      if (!hit) return;
      const p = v.root.worldToLocal(hit).toArray();
      const cx = centerX(this.markers);
      const name = this.drag.joint;
      const pair = pairOf(name);
      if (pair) this.joints[pair] = mirror(p, cx);
      else p[0] = cx;                                    // осевой сустав — на оси
      this.joints[name] = p;
      return;
    }
    const s = this.stage;
    v.host.style.cursor = (s === 'skeleton' || s === 'bound') && this.pick(e) ? (s === 'skeleton' ? 'grab' : 'pointer')
      : s === 'points' && this.nextPoint() ? 'crosshair' : '';
  }

  up(e) {
    if (this.drag) {
      this.drag = null;
      this.viewer.controls.enabled = true;
      this.saveRig();
      this.draw();
      return;
    }
    if (!this.downAt || Math.hypot(e.clientX - this.downAt[0], e.clientY - this.downAt[1]) > 4) return;
    if (this.tc.axis || this.tc.dragging) return;          // щёлкнули по кольцу, а не по кости
    const s = this.stage;
    if (s === 'points') this.placePoint(e);
    else if (s === 'bound') { const b = this.pick(e); this.selectBone(b === this.sel ? null : b); }
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
    const order = HUMAN_BONES.map((b) => b.name);
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
    if (!this.name || !this.clip || /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName)) return;
    const mod = e.metaKey || e.ctrlKey;
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
    const type = el('div', { class: 'seg full' },
      el('button', { class: 'on' }, t('anim.type.human')),
      el('button', { disabled: true, title: t('anim.soon') }, t('anim.type.prop') + ' · ' + t('anim.soon')));
    const field = (...kids) => el('div', { class: 'field' }, ...kids);

    if (s === 'points') {
      const next = this.nextPoint();
      wrap.append(
        field(el('div', { class: 'label' }, t('anim.skeleton')), type),
        field(el('div', { class: 'muted' }, t('anim.points.hint')),
          el('ol', { class: 'anim-points' }, ...HUMAN_POINTS.map((k) => el('li', { class: this.markers[k] ? 'done' : k === next ? 'next' : '' },
            el('span', { class: 'pt-mark' }, this.markers[k] ? '✓' : ''), t('anim.pt.' + k))))),
        field(el('div', { class: 'row' },
          el('button', { class: 'btn', disabled: !Object.keys(this.markers).length, onclick: () => this.undoPoint() }, '↶ ' + t('anim.undo')),
          el('button', { class: 'btn', onclick: () => this.turn() }, '↻ ' + t('anim.turn'))),
        el('div', { class: 'muted small' }, t('anim.turn.hint'))));
    } else if (s === 'skeleton') {
      wrap.append(
        field(el('div', { class: 'label' }, t('anim.skeleton')), type),
        field(el('div', { class: 'muted' }, t('anim.built'))),
        field(el('button', { class: 'btn primary wide', onclick: () => this.bind() }, t('anim.bind')),
          el('button', { class: 'btn wide', onclick: () => this.repoint() }, t('anim.repoint')),
          // Скелет не трогали — можно вернуться к прежней привязке.
          !!this.st.skin && el('button', { class: 'btn wide', onclick: () => this.cancelEdit() }, t('anim.keep'))));
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
