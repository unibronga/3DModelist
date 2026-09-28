// Куб ориентации в правом верхнем углу окна — как в 3DPainter, с осями как
// в Blender. Показывает, откуда смотрит камера; щелчок по грани — осевой вид,
// по ребру — под 45°, по углу — изометрия, по шарику оси — вид вдоль оси;
// протяжка — вращать вид, будто взялись за куб рукой.
//
// Оси подписаны по-блендеровски: Z вверх, перед модели смотрит на −Y (в окне
// three.js Y вверх, перед — +Z; Blender X = X, Y = −Z, Z = Y).
// Живёт в своём маленьком полотне со своей сценой: в основной сцене его
// пришлось бы прятать от луча, меток и кадрирования.

import * as THREE from 'three';
import { t, onLangChange } from './i18n.js';

const SIZE = 104;         // сторона полотна в пикселях
const EDGE = 0.34;        // с какой доли от центра грани считаем, что задето ребро
const REACH = 0.86;       // где стоят шарики осей (у куба полусторона 0.5)

// Порядок граней BoxGeometry: +X, −X, +Y, −Y, +Z, −Z (оси окна).
const FACES = ['cube.right', 'cube.left', 'cube.top', 'cube.bottom', 'cube.front', 'cube.back'];

// Оси Blender в осях окна: цвет и подпись — как в Blender.
const AXES = [
  { dir: [1, 0, 0], color: '#e5484d', label: 'X' },
  { dir: [0, 0, -1], color: '#30a46c', label: 'Y' },
  { dir: [0, 1, 0], color: '#3e63dd', label: 'Z' },
];

// Куб под тему окна: в светлой — светлый, в тёмной — тёмный (владелец 28.09).
// Тема — атрибут data-theme на <html>; нет его — как в системе.
const isDark = () => {
  const th = document.documentElement.dataset.theme;
  return th ? th === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
};
const PALETTE = {
  dark: { face: '#31353b', border: '#4b525b', text: '#d8dce2', edge: 0x8b929c },
  light: { face: '#f4f5f7', border: '#d3d7dd', text: '#3a3f47', edge: 0xa3aab4 },
};
const palette = () => PALETTE[isDark() ? 'dark' : 'light'];

function faceTexture(label) {
  const pal = palette();
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = pal.face;
  g.fillRect(0, 0, 128, 128);
  g.strokeStyle = pal.border;
  g.lineWidth = 7;
  g.strokeRect(3.5, 3.5, 121, 121);
  g.fillStyle = pal.text;
  g.font = '600 22px -apple-system, "SF Pro Text", system-ui, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(label, 64, 66);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

// Шарик оси: плюс — цветной с буквой, минус — тот же цвет бледнее, без буквы.
function ballTexture(color, label) {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  g.beginPath();
  g.arc(32, 32, 28, 0, Math.PI * 2);
  g.fillStyle = color;
  g.globalAlpha = label ? 1 : 0.45;
  g.fill();
  if (label) {
    g.globalAlpha = 1;
    g.fillStyle = '#ffffff';
    g.font = '700 34px -apple-system, "SF Pro Text", system-ui, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(label, 32, 34);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export class ViewCube {
  // hooks: onPick(dir) — встать на направление взгляда (откуда смотрим);
  //        onOrbit(dx, dy) — довернуть камеру на смещение в пикселях.
  constructor(container, hooks) {
    this.hooks = hooks;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
    this.renderer.setSize(SIZE, SIZE, false);
    const el = (this.el = this.renderer.domElement);
    el.className = 'viewcube';
    el.title = t('tip.cube');
    container.append(el);

    this.scene = new THREE.Scene();
    // Ортография: указатель не должен «падать» в перспективу.
    const k = 1.08;
    this.camera = new THREE.OrthographicCamera(-k, k, k, -k, 0.1, 10);
    this.camera.position.set(0, 0, 4);
    this.camera.lookAt(0, 0, 0);

    this.rig = new THREE.Group();
    this.scene.add(this.rig);
    this.materials = FACES.map((key) => new THREE.MeshBasicMaterial({ map: faceTexture(t(key)) }));
    this.cube = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), this.materials);
    // Рёбра — без них куб в ортографии читается плоским пятном.
    this.edges = new THREE.LineSegments(new THREE.EdgesGeometry(this.cube.geometry), new THREE.LineBasicMaterial({ color: palette().edge }));
    this.cube.add(this.edges);
    this.rig.add(this.cube);

    // Оси из центра наружу: линия до шарика, шарики на плюсе и на минусе.
    this.balls = [];
    for (const a of AXES) {
      const d = new THREE.Vector3(...a.dir);
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), d.clone().multiplyScalar(REACH)]),
        new THREE.LineBasicMaterial({ color: a.color }));
      this.rig.add(line);
      for (const sign of [1, -1]) {
        // Шарик за кубом куб и закрывает — как в Blender.
        const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: ballTexture(a.color, sign > 0 ? a.label : '') }));
        s.scale.setScalar(sign > 0 ? 0.3 : 0.2);
        s.position.copy(d).multiplyScalar(REACH * sign);
        s.renderOrder = sign > 0 ? 3 : 2;
        s.userData.dir = d.clone().multiplyScalar(sign);
        this.rig.add(s);
        this.balls.push(s);
      }
    }

    this.raycaster = new THREE.Raycaster();
    this.ndc = new THREE.Vector2();
    this.hovered = -1;
    this.drag = null;
    this.bind();
    // Подписи и цвета нарисованы в текстурах — смена языка и темы их перерисовывает.
    onLangChange(() => this.relabel());
    new MutationObserver(() => this.relabel()).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => this.relabel());
  }

  relabel() {
    FACES.forEach((key, i) => {
      this.materials[i].map?.dispose();
      this.materials[i].map = faceTexture(t(key));
      this.materials[i].needsUpdate = true;
    });
    this.edges.material.color.set(palette().edge);
    this.el.title = t('tip.cube');
  }

  // Повернуть куб так, как мир повёрнут относительно камеры, и нарисовать.
  sync(camera) {
    this.rig.quaternion.copy(camera.quaternion).invert();
    this.renderer.render(this.scene, this.camera);
  }

  // Что под курсором: шарик оси — его направление; куб — грань, ребро или угол.
  dirAt(x, y) {
    const r = this.el.getBoundingClientRect();
    this.ndc.set(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(this.ndc, this.camera);
    // Берём ближнее к зрителю: шарик перед кубом — его, за кубом — грань.
    const hit = this.raycaster.intersectObject(this.cube, false)[0];
    const ball = this.raycaster.intersectObjects(this.balls, false)[0];
    if (ball && (!hit || ball.distance < hit.distance)) return { dir: ball.object.userData.dir.clone(), face: -1 };
    if (!hit) return null;
    // Точка — в осях куба: они совпадают с осями мира (поворот куба и есть поворот мира).
    const p = this.cube.worldToLocal(hit.point.clone());
    const ax = (v) => (v > EDGE ? 1 : v < -EDGE ? -1 : 0);
    const dir = new THREE.Vector3(ax(p.x), ax(p.y), ax(p.z));
    return dir.lengthSq() ? { dir: dir.normalize(), face: hit.face?.materialIndex ?? -1 } : null;
  }

  bind() {
    const el = this.el;
    const clear = () => { this.hovered = -1; this.materials.forEach((m) => m.color.set(0xffffff)); };
    el.addEventListener('pointermove', (e) => {
      if (this.drag) {
        const dx = e.clientX - this.drag.x;
        const dy = e.clientY - this.drag.y;
        if (!this.drag.moved && Math.hypot(dx, dy) < 4) return;
        if (!this.drag.moved) { this.drag.moved = true; clear(); el.style.cursor = 'grabbing'; }
        this.drag.x = e.clientX;
        this.drag.y = e.clientY;
        this.hooks.onOrbit(dx, dy);
        return;
      }
      const r = this.dirAt(e.clientX, e.clientY);
      const idx = r ? r.face : -1;
      el.style.cursor = r ? 'pointer' : '';
      if (idx === this.hovered) return;
      this.hovered = idx;
      this.materials.forEach((m, i) => m.color.set(i === idx ? 0xe0a355 : 0xffffff));
    });
    el.addEventListener('pointerleave', () => { if (!this.drag) clear(); });
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      try { el.setPointerCapture(e.pointerId); } catch { /* не беда */ }
      this.drag = { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, moved: false };
    });
    const finish = () => {
      if (!this.drag) return;
      const { moved, sx, sy } = this.drag;
      this.drag = null;
      el.style.cursor = '';
      if (!moved) { const r = this.dirAt(sx, sy); if (r) this.hooks.onPick(r.dir); }
    };
    el.addEventListener('pointerup', finish);
    el.addEventListener('pointercancel', finish);
    el.addEventListener('contextmenu', (e) => e.preventDefault());
  }
}
