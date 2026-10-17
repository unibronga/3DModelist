// Запись GLB экспортёром three.js — одна на всю студию.
//
// 🔴 GLTFExporter пишет имя только узлу, меш в glTF у него безымянный. Пока
// меш — один примитив, этого не видно: загрузчик называет объект по узлу. Но
// меш с лицом и зонами — несколько примитивов, и их называют по имени МЕША:
// three.js — «mesh_0», «mesh_0_1», Blender — данные «Mesh_0» вместо «Kian».
// Расширение ниже пишет имя меша, как это делает 3DPainter (1.4.3+).

import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';

// Имя безымянного меша: mesh_<номер>[_<n>] даёт three.js, Mesh_<номер> —
// Blender, когда импортировал такой файл (привязки, сделанные до 0.8.4).
const AUTO = /^[Mm]esh_\d+(_\d+)?$/;

// Безымянный меш из нескольких примитивов three.js грузит группой с именем
// узла и детьми «mesh_0», «mesh_0_1»… — имя тогда берём от узла: Kian_1, Kian_2.
function meshName(mesh) {
  if (!AUTO.test(mesh.name || '')) return mesh.name;
  const p = mesh.parent;
  const kids = p && !p.isScene && p.name ? p.children.filter((o) => o.isMesh) : [];
  if (kids.length > 1 && kids.every((o) => AUTO.test(o.name || ''))) return `${p.name}_${kids.indexOf(mesh) + 1}`;
  return mesh.name;
}

const meshNames = () => ({
  writeMesh(mesh, meshDef) {
    const name = meshName(mesh);
    if (name && !meshDef.name) meshDef.name = name;
  },
});

/** Сцена → GLB (Uint8Array), меши с именами. */
export async function writeGlb(scene, animations = []) {
  const exporter = new GLTFExporter();
  exporter.register(meshNames);
  return new Uint8Array(await exporter.parseAsync(scene, { binary: true, animations, onlyVisible: false }));
}
