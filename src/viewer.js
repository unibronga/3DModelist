// Просмотр модели: GLB/glTF, FBX, OBJ. Всё матовое — блеск на гранях владелец
// читает как брак (решение 26.09). Режимы: материалы / глина / глина + сетка.

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';

const CLAY = new THREE.Color('#c9c5bf');
const WIRE = new THREE.Color('#2a2a28');

export class Viewer {
  constructor(host) {
    this.host = host;
    this.mode = 'material';
    this.flat = true;
    this.root = null;
    this.onInfo = () => {};

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
    this.url = null;
    this.onInfo(null);
  }

  async load(url) {
    const ext = url.split('?')[0].split('.').pop().toLowerCase();
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
    this.fit();
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

  setMode(mode) { this.mode = mode; this.apply(); }
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
