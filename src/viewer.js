// Просмотр модели: GLB/glTF, FBX, OBJ. Всё матовое — блеск на гранях владелец
// читает как брак (решение 26.09). Режимы: материалы / глина / глина + сетка.
// Метки: pick() находит часть модели под курсором и точку на ней, shot() —
// снимок окна с номерами меток для агента.

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';

const CLAY = new THREE.Color('#c9c5bf');
const WIRE = new THREE.Color('#2a2a28');
const HOVER = new THREE.Color('#5b6ee1');     // подсветка части под курсором в режиме меток

export class Viewer {
  constructor(host) {
    this.host = host;
    this.mode = 'material';
    this.flat = true;
    this.root = null;
    this.onInfo = () => {};
    this.onFrame = () => {};        // каждый кадр: метки поверх окна следуют за камерой
    this.hovered = null;
    this.raycaster = new THREE.Raycaster();

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

    // Свет мягкий и рассеянный: форма читается, бликов нет.
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x9a968f, 1.9));
    const key = (this.key = new THREE.DirectionalLight(0xffffff, 1.5));
    key.position.set(3, 5, 4);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.bias = -0.0004;
    key.shadow.radius = 4;
    this.scene.add(key, key.target);
    const rim = new THREE.DirectionalLight(0xffffff, 0.5);
    rim.position.set(-4, 2, -3);
    this.scene.add(rim);

    this.ground = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.ShadowMaterial({ opacity: 0.16 }),
    );
    this.ground.rotation.x = -Math.PI / 2;
    this.ground.receiveShadow = true;
    this.scene.add(this.ground);

    new ResizeObserver(() => this.resize()).observe(host);
    this.resize();
    const loop = () => {
      this.controls.update();
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
      for (const m of [].concat(o.material || [], o.userData.orig || [], o.userData.clay || [])) m?.dispose?.();
    });
    this.root = null;
    this.hovered = null;
    this.url = null;
    this.onInfo(null);
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
      tris += g.index ? g.index.count / 3 : g.attributes.position.count / 3;
      o.castShadow = true;
      o.receiveShadow = true;
      o.userData.orig = [].concat(o.material).map(matte);
      o.userData.clay = new THREE.MeshLambertMaterial({ color: CLAY, flatShading: true, side: THREE.DoubleSide });
      o.userData.wire = new THREE.LineSegments(
        new THREE.EdgesGeometry(g, 1),         // рёбра между негладкими гранями: сетка low-poly без диагоналей плоских квадов
        new THREE.LineBasicMaterial({ color: WIRE, transparent: true, opacity: 0.45 }),
      );
      o.userData.wire.visible = false;
      o.add(o.userData.wire);
    });
    this.scene.add(obj);

    const span = Math.max(size.x, size.y, size.z) || 1;
    this.ground.scale.setScalar(span * 8);
    this.key.shadow.camera.left = this.key.shadow.camera.bottom = -span * 1.5;
    this.key.shadow.camera.right = this.key.shadow.camera.top = span * 1.5;
    this.key.shadow.camera.far = span * 20;
    this.key.position.set(span * 1.2, span * 2.2, span * 1.6);
    this.key.shadow.camera.updateProjectionMatrix();

    this.size = size;
    this.apply();
    if (!keepView) this.fit();
    this.onInfo({ tris: Math.round(tris), meshes, size: [size.x, size.y, size.z], ext });
  }

  fit() {
    if (!this.root) return;
    const box = new THREE.Box3().setFromObject(this.root);
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const dist = sphere.radius / Math.sin(THREE.MathUtils.degToRad(this.camera.fov / 2)) * 1.05;
    const dir = new THREE.Vector3(0.55, 0.32, 1).normalize();
    this.controls.target.copy(sphere.center);
    this.camera.position.copy(sphere.center).addScaledVector(dir, dist);
    this.camera.near = dist / 100;
    this.camera.far = dist * 100;
    this.camera.updateProjectionMatrix();
    this.controls.update();
  }

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
    let part = '';
    for (let o = hit.object; o && o !== this.root; o = o.parent) {
      if (o.userData.name) { part = o.userData.name; break; }
      if (!part && o.name) part = o.name;          // FBX/OBJ: ближайшее имя
    }
    const local = this.root.worldToLocal(hit.point.clone());
    return { mesh: hit.object, part, local: [local.x, local.y, local.z] };
  }

  // Подсветить часть под курсором (null — снять).
  hover(mesh) {
    if (mesh === this.hovered) return;
    const paint = (m, on) => {
      for (const mat of [].concat(m?.material || [])) {
        if (!mat.emissive) continue;
        mat.emissive.copy(on ? HOVER : new THREE.Color(0x000000));
        mat.emissiveIntensity = on ? 0.35 : 1;
      }
    };
    paint(this.hovered, false);
    this.hovered = mesh;
    paint(mesh, true);
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
    this.hover(null);
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
    return c.toDataURL('image/png');
  }

  setMode(mode) { this.hover(null); this.mode = mode; this.apply(); }
  setFlat(flat) { this.flat = flat; this.apply(); }

  apply() {
    if (!this.root) return;
    this.root.traverse((o) => {
      if (!o.isMesh || !o.userData.orig) return;
      const mats = this.mode === 'material' ? o.userData.orig : [o.userData.clay];
      for (const m of mats) {
        if (m.flatShading !== this.flat) { m.flatShading = this.flat; m.needsUpdate = true; }
      }
      o.material = mats.length === 1 ? mats[0] : mats;
      o.userData.wire.visible = this.mode === 'wire';
    });
  }
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
