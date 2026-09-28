// Просмотр модели: GLB/glTF, FBX, OBJ. Всё матовое — блеск на гранях владелец
// читает как брак (решение 26.09). Режимы: материалы / глина / глина + сетка /
// нормали (лицевые грани синие, вывернутые — красные, как в Blender).
// Метки: pick() находит часть модели под курсором и точку на ней, shot() —
// снимок окна с номерами меток для агента.
// Проверка: части модели (скрыть, выбрать, в кадр), ракурсы как в листе
// агента, пол с сеткой в метрах, человек 1,8 м рядом, свет и вращение.

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';

const CLAY = new THREE.Color('#c9c5bf');
const WIRE = new THREE.Color('#2a2a28');
const HOVER = new THREE.Color('#5b6ee1');     // часть под курсором в режиме меток
const PICKED = new THREE.Color('#e0a030');    // часть, выбранная в списке частей
const BLACK = new THREE.Color(0x000000);

// Ракурсы — как в листе агента (peek): спереди = камера со стороны -Y Blender,
// то есть +Z в координатах окна; справа = +X; 3/4 — азимут 35°, высота 18°.
const VIEWS = {
  front: [0, 4], q34: [35, 18], right: [90, 4], back: [180, 10], left: [-90, 4], top: [0, 89],
};

export class Viewer {
  constructor(host) {
    this.host = host;
    this.mode = 'material';
    this.flat = true;
    this.root = null;
    this.onInfo = () => {};
    this.onFrame = () => {};        // каждый кадр: метки поверх окна следуют за камерой
    this.onParts = () => {};        // список частей поменялся (новая модель, скрыли, выбрали)
    this.tickers = new Set();       // каждый кадр: анимация, скелет поверх модели
    this.hovered = null;
    this.picked = null;             // выбранная часть (ключ)
    this.hidden = new Set();        // скрытые части по имени — переживают смену версии
    this.raycaster = new THREE.Raycaster();
    this.light = { power: 1, angle: 0 };

    const r = (this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true }));
    r.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.toneMapping = THREE.NeutralToneMapping;
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFSoftShadowMap;
    host.appendChild(r.domElement);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(35, 1, 0.01, 1000);
    this.camera.position.set(2.5, 1.6, 3.5);

    this.controls = new OrbitControls(this.camera, r.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.autoRotateSpeed = 1.6;

    // Свет мягкий и рассеянный: форма читается, бликов нет.
    this.hemi = new THREE.HemisphereLight(0xffffff, 0x9a968f, 1.9);
    this.scene.add(this.hemi);
    const key = (this.key = new THREE.DirectionalLight(0xffffff, 1.5));
    key.position.set(3, 5, 4);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.bias = -0.0004;
    key.shadow.radius = 4;
    this.scene.add(key, key.target);
    const rim = (this.rim = new THREE.DirectionalLight(0xffffff, 0.5));
    rim.position.set(-4, 2, -3);
    this.scene.add(rim);
    this.keyBase = new THREE.Vector3(1.2, 2.2, 1.6);   // направление ключевого света в долях размера модели
    this.span = 1;

    this.ground = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.ShadowMaterial({ opacity: 0.16 }),
    );
    this.ground.rotation.x = -Math.PI / 2;
    this.ground.receiveShadow = true;
    this.scene.add(this.ground);

    this.grid = null;
    this.human = null;

    new ResizeObserver(() => this.resize()).observe(host);
    this.resize();
    const loop = () => {
      this.controls.update();
      for (const f of this.tickers) f();
      r.render(this.scene, this.camera);
      this.onFrame();
      requestAnimationFrame(loop);
    };
    loop();
  }

  // Масштаб интерфейса (--ui): окно 3D от него не зависит — см. .viewport в
  // style.css, — но буфер рисуем с учётом плотности экрана.
  setScale() { this.resize(); }

  resize() {
    const w = this.host.clientWidth || 1;
    const h = this.host.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  clear() {
    if (!this.root) return;
    this.scene.remove(this.root);
    this.root.traverse((o) => {
      o.geometry?.dispose();
      for (const m of [].concat(o.material || [], o.userData.orig || [], o.userData.clay || [], o.userData.normal || [])) m?.dispose?.();
    });
    this.root = null;
    this.hovered = null;
    this.picked = null;
    this.partList = [];
    this.url = null;
    this.onInfo(null);
    this.onParts();
  }

  // ext — когда адрес без расширения (файл с диска открыт как blob:).
  // keepView — не трогать камеру: версии одной модели сравниваются с одного ракурса.
  async load(url, ext = url.split('?')[0].split('.').pop().toLowerCase(), { keepView = false } = {}) {
    let obj;
    if (ext === 'glb' || ext === 'gltf') obj = (await new GLTFLoader().loadAsync(url)).scene;
    else if (ext === 'fbx') obj = await new FBXLoader().loadAsync(url);
    else if (ext === 'obj') obj = await new OBJLoader().loadAsync(url);
    else throw new Error('не умею открывать .' + ext);

    this.clear();
    this.url = url;
    this.root = obj;

    // Модель ставим подошвой на пол и центром по X/Z — как в Blender после посадки.
    obj.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(obj);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    obj.position.x -= center.x;
    obj.position.z -= center.z;
    obj.position.y -= box.min.y;

    let tris = 0;
    let meshes = 0;
    obj.traverse((o) => {
      if (!o.isMesh) return;
      meshes++;
      const g = o.geometry;
      tris += triCount(g);
      o.castShadow = true;
      o.receiveShadow = true;
      o.userData.orig = [].concat(o.material).map(matte);
      o.userData.clay = new THREE.MeshLambertMaterial({ color: CLAY, flatShading: true, side: THREE.DoubleSide });
      o.userData.normal = facing();
      o.userData.wire = new THREE.LineSegments(
        new THREE.EdgesGeometry(g, 1),         // рёбра между негладкими гранями: сетка low-poly без диагоналей плоских квадов
        new THREE.LineBasicMaterial({ color: WIRE, transparent: true, opacity: 0.45 }),
      );
      o.userData.wire.visible = false;
      o.add(o.userData.wire);
    });
    this.scene.add(obj);

    const span = (this.span = Math.max(size.x, size.y, size.z) || 1);
    this.ground.scale.setScalar(span * 8);
    this.key.shadow.camera.left = this.key.shadow.camera.bottom = -span * 1.5;
    this.key.shadow.camera.right = this.key.shadow.camera.top = span * 1.5;
    this.key.shadow.camera.far = span * 20;
    this.key.shadow.camera.updateProjectionMatrix();
    this.placeLight();

    this.size = size;
    this.collectParts();
    this.apply();
    if (this.grid) this.setGrid(true);
    if (this.human) this.setHuman(true);
    if (!keepView) this.fit();
    this.onInfo({ tris: Math.round(tris), meshes, size: [size.x, size.y, size.z], ext });
  }

  // Вписать в кадр: всю модель — с привычного ракурса 3/4, часть (box) — не
  // меняя направления взгляда.
  fit(box = null) {
    if (!this.root) return;
    const part = !!box;
    box ||= new THREE.Box3().setFromObject(this.root);
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const dist = sphere.radius / Math.sin(THREE.MathUtils.degToRad(this.camera.fov / 2)) * 1.05;
    const dir = part ? this.camera.position.clone().sub(this.controls.target) : new THREE.Vector3(0.55, 0.32, 1);
    if (dir.lengthSq() < 1e-9) dir.set(0.55, 0.32, 1);
    dir.normalize();
    this.controls.target.copy(sphere.center);
    this.camera.position.copy(sphere.center).addScaledVector(dir, dist);
    this.camera.near = dist / 100;
    this.camera.far = dist * 100;
    this.camera.updateProjectionMatrix();
    this.controls.update();
  }

  // Ракурс как в листе агента: камера смотрит на центр модели с той же дали.
  setView(name) {
    if (!this.root || !VIEWS[name]) return;
    const [az, el] = VIEWS[name].map(THREE.MathUtils.degToRad);
    const dir = new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el));
    const box = new THREE.Box3().setFromObject(this.root);
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const dist = sphere.radius / Math.sin(THREE.MathUtils.degToRad(this.camera.fov / 2)) * 1.05;
    this.controls.target.copy(sphere.center);
    this.camera.position.copy(sphere.center).addScaledVector(dir, dist);
    this.controls.update();
  }

  // ── части модели ───────────────────────────────────────────────────────
  // Часть — объект Blender: GLTFLoader хранит исходное имя узла в
  // userData.name; у FBX/OBJ — ближайшее имя. Меши одной части — вместе.
  partKey(mesh) {
    let key = '';
    for (let o = mesh; o && o !== this.root; o = o.parent) {
      if (o.userData.name) return o.userData.name;
      if (!key && o.name) key = o.name;
    }
    return key || mesh.uuid;
  }

  collectParts() {
    const map = new Map();
    this.root.updateMatrixWorld(true);
    const inv = this.root.matrixWorld.clone().invert();
    this.root.traverse((o) => {
      if (!o.isMesh) return;
      const key = this.partKey(o);
      let p = map.get(key);
      if (!p) { p = { key, name: key, meshes: [], tris: 0, box: new THREE.Box3() }; map.set(key, p); }
      p.meshes.push(o);
      p.tris += triCount(o.geometry);
      o.geometry.computeBoundingBox();
      p.box.union(o.geometry.boundingBox.clone().applyMatrix4(o.matrixWorld).applyMatrix4(inv));
    });
    this.partList = [...map.values()].map((p) => {
      const s = p.box.getSize(new THREE.Vector3());
      p.size = [s.x, s.z, s.y];                // как в Blender: ширина × глубина × высота
      return p;
    });
    for (const p of this.partList) if (this.hidden.has(p.key)) p.meshes.forEach((m) => { m.visible = false; });
    this.onParts();
  }

  parts() { return this.partList || []; }

  setPartHidden(key, hide) {
    if (hide) this.hidden.add(key); else this.hidden.delete(key);
    for (const p of this.parts()) if (p.key === key) p.meshes.forEach((m) => { m.visible = !hide; });
    this.onParts();
  }

  showAll() {
    this.hidden.clear();
    for (const p of this.parts()) p.meshes.forEach((m) => { m.visible = true; });
    this.onParts();
  }

  selectPart(key) {
    this.picked = this.picked === key ? null : key;
    this.tint();
    this.onParts();
  }

  framePart(key) {
    const p = this.parts().find((x) => x.key === key);
    if (!p) return;
    const box = p.box.clone().applyMatrix4(this.root.matrixWorld);
    this.fit(box);
  }

  // ── пол, человек, свет ─────────────────────────────────────────────────
  // Сетка в метрах: крупная клетка 1 м; у небольших моделей — и мелкая 10 см.
  setGrid(on) {
    if (this.grid) { this.scene.remove(this.grid); this.grid.traverse((o) => { o.geometry?.dispose(); o.material?.dispose?.(); }); this.grid = null; }
    if (!on) return;
    const g = (this.grid = new THREE.Group());
    const n = Math.max(4, Math.ceil(this.span * 3 / 2) * 2);
    const major = new THREE.GridHelper(n, n, 0x8a93a6, 0x8a93a6);
    major.material.transparent = true;
    major.material.opacity = 0.45;
    g.add(major);
    if (this.span < 3) {
      const minor = new THREE.GridHelper(n, n * 10, 0x8a93a6, 0x8a93a6);
      minor.material.transparent = true;
      minor.material.opacity = 0.14;
      minor.position.y = -0.0005;
      g.add(minor);
    }
    g.position.y = 0.0005;
    this.scene.add(g);
  }

  // Человек 1,8 м рядом с моделью — видно, в масштабе ли она.
  setHuman(on) {
    if (this.human) { this.scene.remove(this.human); this.human.traverse((o) => { o.geometry?.dispose(); o.material?.dispose?.(); }); this.human = null; }
    if (!on) return;
    const mat = new THREE.MeshLambertMaterial({ color: 0x8a93a6, transparent: true, opacity: 0.6 });
    const g = (this.human = new THREE.Group());
    const box = (w, h, d, x, y) => { const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat); m.position.set(x, y, 0); g.add(m); };
    box(0.15, 0.86, 0.17, -0.1, 0.43);          // ноги
    box(0.15, 0.86, 0.17, 0.1, 0.43);
    box(0.44, 0.6, 0.24, 0, 1.16);              // туловище
    box(0.1, 0.62, 0.12, -0.28, 1.13);          // руки
    box(0.1, 0.62, 0.12, 0.28, 1.13);
    box(0.08, 0.06, 0.08, 0, 1.49);             // шея
    box(0.2, 0.26, 0.23, 0, 1.67);              // голова
    const half = this.size ? this.size.x / 2 : 0.5;
    g.position.set(-(half + 0.25 + 0.35), 0, 0);
    this.scene.add(g);
  }

  // Сила (доля от обычного) и поворот ключевого света вокруг модели.
  setLight({ power = this.light.power, angle = this.light.angle } = {}) {
    this.light = { power, angle };
    this.hemi.intensity = 1.9 * power;
    this.key.intensity = 1.5 * power;
    this.rim.intensity = 0.5 * power;
    this.placeLight();
  }

  placeLight() {
    const a = THREE.MathUtils.degToRad(this.light.angle);
    const b = this.keyBase;
    const x = b.x * Math.cos(a) + b.z * Math.sin(a);
    const z = -b.x * Math.sin(a) + b.z * Math.cos(a);
    this.key.position.set(x * this.span, b.y * this.span, z * this.span);
  }

  setSpin(on) { this.controls.autoRotate = on; }

  // Часть модели и точка под курсором. clientX/Y — координаты события мыши.
  // local — точка в координатах файла (glTF: Y вверх), part — имя объекта как в
  // Blender (GLTFLoader хранит исходное имя в userData.name).
  pick(clientX, clientY) {
    if (!this.root) return null;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const hit = this.raycaster.intersectObject(this.root, true).find((h) => h.object.isMesh && h.object.visible);
    if (!hit) return null;
    const part = this.partKey(hit.object);
    const local = this.root.worldToLocal(hit.point.clone());
    return { mesh: hit.object, part: part === hit.object.uuid ? '' : part, local: [local.x, local.y, local.z] };
  }

  // Подсветить часть под курсором (null — снять).
  hover(mesh) {
    if (mesh === this.hovered) return;
    this.hovered = mesh;
    this.tint();
  }

  // Подсветка: под курсором — синим, выбранная в списке частей — янтарным.
  tint() {
    if (!this.root) return;
    const hoverKey = this.hovered ? this.partKey(this.hovered) : null;
    this.root.traverse((o) => {
      if (!o.isMesh) return;
      const key = this.partKey(o);
      const c = o === this.hovered || key === hoverKey ? HOVER : key === this.picked ? PICKED : null;
      for (const mat of [].concat(o.material || [])) {
        if (!mat.emissive) continue;
        mat.emissive.copy(c || BLACK);
        mat.emissiveIntensity = c ? 0.35 : 1;
      }
    });
  }

  // Точка модели → место в окне: доли ширины и высоты (0…1), за камерой — null.
  project(local) {
    if (!this.root) return null;
    const v = this.root.localToWorld(new THREE.Vector3(...local));
    if (v.clone().sub(this.camera.position).dot(this.camera.getWorldDirection(new THREE.Vector3())) <= 0) return null;
    v.project(this.camera);
    return { x: (v.x + 1) / 2, y: (1 - v.y) / 2 };
  }

  // Снимок окна PNG (data URL) с номерами меток — агент читает его глазами.
  shot(pins = [], { bg = '#2b3139', mark = '#5b6ee1' } = {}) {
    const keep = this.hovered;
    this.hovered = null;
    this.tint();
    this.renderer.render(this.scene, this.camera);
    const src = this.renderer.domElement;
    const k = Math.min(1, 1400 / src.width);
    const c = document.createElement('canvas');
    c.width = Math.round(src.width * k);
    c.height = Math.round(src.height * k);
    const g = c.getContext('2d');
    g.fillStyle = bg;
    g.fillRect(0, 0, c.width, c.height);
    g.drawImage(src, 0, 0, c.width, c.height);
    const r = Math.max(11, Math.round(c.width / 90));
    pins.forEach((p, i) => {
      const at = this.project(p.local);
      if (!at) return;
      const x = at.x * c.width;
      const y = at.y * c.height;
      g.beginPath();
      g.arc(x, y, r, 0, Math.PI * 2);
      g.fillStyle = mark;
      g.fill();
      g.lineWidth = Math.max(2, r / 5);
      g.strokeStyle = '#ffffff';
      g.stroke();
      g.fillStyle = '#ffffff';
      g.font = `700 ${Math.round(r * 1.1)}px -apple-system, sans-serif`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(String(i + 1), x, y + 1);
    });
    this.hovered = keep;
    this.tint();
    return c.toDataURL('image/png');
  }

  setMode(mode) { this.hovered = null; this.mode = mode; this.apply(); }
  setFlat(flat) { this.flat = flat; this.apply(); }

  apply() {
    if (!this.root) return;
    this.root.traverse((o) => {
      if (!o.isMesh || !o.userData.orig) return;
      const mats = this.mode === 'material' ? o.userData.orig : this.mode === 'normals' ? [o.userData.normal] : [o.userData.clay];
      for (const m of mats) {
        if (m.flatShading !== this.flat) { m.flatShading = this.flat; m.needsUpdate = true; }
      }
      o.material = mats.length === 1 ? mats[0] : mats;
      o.userData.wire.visible = this.mode === 'wire' && !o.isSkinnedMesh;   // рёбра с костями не гнутся
    });
    this.tint();
  }
}

function triCount(g) {
  return g.index ? g.index.count / 3 : g.attributes.position.count / 3;
}

// Любой материал → матовый Lambert с тем же цветом и картой.
function matte(m) {
  const n = new THREE.MeshLambertMaterial({
    color: m.color ? m.color.clone() : new THREE.Color('#ffffff'),
    map: m.map || null,
    vertexColors: !!m.vertexColors,
    transparent: m.transparent,
    opacity: m.opacity ?? 1,
    alphaTest: m.alphaTest || 0,
    side: THREE.DoubleSide,
    flatShading: true,
  });
  if (n.map) n.map.colorSpace = THREE.SRGBColorSpace;
  return n;
}

// Лицевые грани — синие, вывернутые — красные (как Face Orientation в Blender),
// поверх светотени глины: форма читается, изнанка видна сразу.
function facing() {
  const m = new THREE.MeshLambertMaterial({ color: 0xffffff, side: THREE.DoubleSide, flatShading: true });
  m.onBeforeCompile = (sh) => {
    sh.fragmentShader = sh.fragmentShader.replace('#include <dithering_fragment>',
      '#include <dithering_fragment>\n  gl_FragColor.rgb *= gl_FrontFacing ? vec3(0.42, 0.58, 1.0) : vec3(1.0, 0.36, 0.36);');
  };
  return m;
}
