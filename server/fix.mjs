// Улучшение готовой модели: проверка, нормали, починка, мусор, меньше граней,
// ретопология, огранка (владелец 09.10).
//
// Каждый шаг — Blender без окна над копией: исходник в out/ не трогаем. Шаги
// одной правки лежат в runs/fix/<sid>/step<N>.glb, следующий шаг берёт
// предыдущий. «Сохранить как новую модель» кладёт последний шаг в
// out/<имя>/<имя>.glb — модель появляется в списке готовых.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ws } from './store.mjs';
import { runPy } from './blender.mjs';
import { UserError } from './errors.mjs';

export const FIX_OPS = ['check', 'normals', 'repair', 'cleanup', 'decimate', 'retopo', 'shade'];

const FIX_PY = String.raw`
import bpy, bmesh, sys, json, math
from mathutils import Vector

args = sys.argv[sys.argv.index('--') + 1:]
src, dst, op, P = args[0], args[1], args[2], json.loads(args[3] or '{}')
bpy.ops.wm.read_factory_settings(use_empty=True)
ext = src.rsplit('.', 1)[1].lower()
if ext in ('glb', 'gltf'):
    bpy.ops.import_scene.gltf(filepath=src)
elif ext == 'fbx':
    bpy.ops.import_scene.fbx(filepath=src)
elif ext == 'obj':
    bpy.ops.wm.obj_import(filepath=src)
bpy.context.view_layer.update()
meshes = [o for o in bpy.context.scene.objects if o.type == 'MESH']
if not meshes:
    raise SystemExit('в файле нет сетки')

def tris():
    return sum(len(p.vertices) - 2 for o in meshes for p in o.data.polygons)

pts = [o.matrix_world @ Vector(c) for o in meshes for c in o.bound_box]
diag = (Vector([max(p[i] for p in pts) for i in range(3)]) - Vector([min(p[i] for p in pts) for i in range(3)])).length or 1.0

def merge_dist(o):
    # Точки швов генератора совпадают до 1e-6 размера; 1e-5 диагонали — с запасом,
    # но не склеивает соседние вершины low-poly.
    s = max(o.matrix_world.to_scale()) or 1.0
    return diag * 1e-5 / s

def islands(bm):
    seen, out = set(), []
    for f in bm.faces:
        if f in seen:
            continue
        stack, comp = [f], []
        seen.add(f)
        while stack:
            x = stack.pop()
            comp.append(x)
            for e in x.edges:
                for y in e.link_faces:
                    if y not in seen:
                        seen.add(y)
                        stack.append(y)
        out.append(comp)
    return out

def boundary_loops(bm):
    edges = [e for e in bm.edges if e.is_boundary]
    parent = {}
    def find(v):
        while parent.get(v, v) is not v:
            parent[v] = parent.get(parent[v], parent[v])
            v = parent[v]
        return v
    for e in edges:
        a, b = find(e.verts[0]), find(e.verts[1])
        if a is not b:
            parent[a] = b
    loops = {}
    for e in edges:
        loops.setdefault(find(e.verts[0]), []).append(e)
    return list(loops.values())

# Дыра — только мелкая: меньше 1,2 % размера модели (у персонажа ~2 см).
# Крупный открытый край у генератора — вырез одежды: полы куртки, ворот,
# манжеты, голенища. Его не закрываем — заплатка ложится поверх рубашки
# и кулона (Киан, 09.10).
def is_hole(loop):
    vs = {v for e in loop for v in e.verts}
    c = sum((v.co for v in vs), Vector()) / len(vs)
    return max((v.co - c).length for v in vs) * 2 < diag * 0.012

def tiny(comp, total):
    # Мусор — кусочек меньше 0,2 % граней модели и меньше 2 % её размера.
    vs = {v for f in comp for v in f.verts}
    lo = Vector([min(v.co[i] for v in vs) for i in range(3)])
    hi = Vector([max(v.co[i] for v in vs) for i in range(3)])
    return len(comp) < max(4, total * 0.002) and (hi - lo).length < diag * 0.02

def stats():
    # Швы развёртки не считаем: GLB сам режет по ним точки, это не дефект.
    r = dict(tris=tris(), parts=0, holes=0, openings=0, flipped=0, loose=0, junk=0, nonmanifold=0)
    total = sum(len(o.data.polygons) for o in meshes)
    for o in meshes:
        bm = bmesh.new()
        bm.from_mesh(o.data)
        bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=merge_dist(o))
        r['loose'] += sum(1 for v in bm.verts if not v.link_edges) + sum(1 for e in bm.edges if e.is_wire)
        loops = boundary_loops(bm)
        n = sum(1 for lp in loops if is_hole(lp))
        r['holes'] += n
        r['openings'] += len(loops) - n
        r['flipped'] += sum(1 for e in bm.edges if e.is_manifold and not e.is_contiguous)
        r['nonmanifold'] += sum(1 for e in bm.edges if len(e.link_faces) > 2)
        comps = islands(bm)
        r['parts'] += len(comps)
        r['junk'] += sum(1 for c in comps if tiny(c, total))
        bm.free()
    return r

def clear_custom(o):
    bpy.ops.object.select_all(action='DESELECT')
    o.select_set(True)
    bpy.context.view_layer.objects.active = o
    try:
        bpy.ops.mesh.customdata_custom_splitnormals_clear()
    except Exception:
        pass

def with_bm(o, fn):
    bm = bmesh.new()
    bm.from_mesh(o.data)
    res = fn(bm)
    bm.to_mesh(o.data)
    bm.free()
    o.data.update()
    return res

def recalc(bm):
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])

done = {}
before = tris()
total = sum(len(o.data.polygons) for o in meshes)

if op == 'check':
    print('FIXRESULT ' + json.dumps({'report': stats(), 'tris': before}))
    sys.exit(0)

if op == 'normals':
    def fn(bm):
        n0 = sum(1 for e in bm.edges if e.is_manifold and not e.is_contiguous)
        recalc(bm)
        return n0
    done['flipped'] = sum(with_bm(o, fn) for o in meshes)
    for o in meshes:
        clear_custom(o)

elif op in ('repair', 'cleanup'):
    for o in meshes:
        def fn(bm):
            bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=merge_dist(o))
            loose = [v for v in bm.verts if not v.link_edges]
            wires = [e for e in bm.edges if e.is_wire]
            bmesh.ops.delete(bm, geom=wires, context='EDGES')
            loose = [v for v in bm.verts if not v.link_faces]
            bmesh.ops.delete(bm, geom=loose, context='VERTS')
            done['loose'] = done.get('loose', 0) + len(wires) + len(loose)
            bmesh.ops.dissolve_degenerate(bm, edges=bm.edges[:], dist=merge_dist(o))
            if op == 'cleanup':
                junk = [c for c in islands(bm) if tiny(c, total)]
                if junk:
                    bmesh.ops.delete(bm, geom=[f for c in junk for f in c], context='FACES')
                    loose = [v for v in bm.verts if not v.link_faces]
                    bmesh.ops.delete(bm, geom=loose, context='VERTS')
                done['junk'] = done.get('junk', 0) + len(junk)
            else:
                small = [lp for lp in boundary_loops(bm) if is_hole(lp)]
                if small:
                    res = bmesh.ops.holes_fill(bm, edges=[e for lp in small for e in lp], sides=0)
                    bmesh.ops.triangulate(bm, faces=[f for f in res['faces'] if len(f.verts) > 4])
                    done['holes'] = done.get('holes', 0) + len(small)
                recalc(bm)
        with_bm(o, fn)
        clear_custom(o)

elif op == 'decimate':
    target = max(100, int(P.get('target', before // 2)))
    ratio = min(1.0, target / max(before, 1))
    for o in meshes:
        bpy.ops.object.select_all(action='DESELECT')
        o.select_set(True)
        bpy.context.view_layer.objects.active = o
        m = o.modifiers.new('Decimate', 'DECIMATE')
        m.ratio = ratio
        m.use_collapse_triangulate = False
        bpy.ops.object.modifier_apply(modifier=m.name)

elif op == 'retopo':
    target = max(200, int(P.get('target', before // 2)))
    for o in meshes:
        share = sum(len(p.vertices) - 2 for p in o.data.polygons) / max(before, 1)
        # квады: одна грань = два треугольника; Quadriflow недобирает ~25 %
        faces = max(50, int(target * share / 2 * 1.25))
        mats = list(o.data.materials)
        def prep(bm):
            bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=merge_dist(o))
            bmesh.ops.dissolve_degenerate(bm, edges=bm.edges[:], dist=merge_dist(o))
            small = [lp for lp in boundary_loops(bm) if is_hole(lp)]
            if small:
                bmesh.ops.holes_fill(bm, edges=[e for lp in small for e in lp], sides=0)
            recalc(bm)
        with_bm(o, prep)
        bpy.ops.object.select_all(action='DESELECT')
        o.select_set(True)
        bpy.context.view_layer.objects.active = o
        n0 = len(o.data.polygons)
        keep = o.data.copy()
        box0 = [(min(v.co[i] for v in o.data.vertices), max(v.co[i] for v in o.data.vertices)) for i in range(3)]
        try:
            bpy.ops.object.quadriflow_remesh(target_faces=faces, use_preserve_sharp=True, use_preserve_boundary=False, seed=0)
        except Exception:
            pass
        # На незамкнутой сетке Quadriflow иногда «взрывается»: точки улетают
        # на метры от модели (Киан, 09.10). Вышел за габариты — не годится.
        tol = diag * 0.03
        out = len(o.data.polygons) == n0 or not o.data.vertices or any(
            min(v.co[i] for v in o.data.vertices) < box0[i][0] - tol or max(v.co[i] for v in o.data.vertices) > box0[i][1] + tol
            for i in range(3))
        if out:
            o.data = keep
            # Запасной путь: объём вокселями и упрощение.
            m = o.modifiers.new('Remesh', 'REMESH')
            m.mode = 'VOXEL'
            m.voxel_size = diag / 160
            bpy.ops.object.modifier_apply(modifier=m.name)
            r = o.modifiers.new('Decimate', 'DECIMATE')
            r.ratio = min(1.0, faces * 2 / max(1, sum(len(p.vertices) - 2 for p in o.data.polygons)))
            bpy.ops.object.modifier_apply(modifier=r.name)
            done['voxel'] = done.get('voxel', 0) + 1
        o.data.materials.clear()
        for mt in mats:
            o.data.materials.append(mt)
        done['quads'] = done.get('quads', 0) + sum(1 for p in o.data.polygons if len(p.vertices) == 4)

elif op == 'shade':
    flat = P.get('mode', 'flat') == 'flat'
    thr = math.radians(float(P.get('angle', 30)))
    for o in meshes:
        def fn(bm):
            for f in bm.faces:
                f.smooth = not flat
            for e in bm.edges:
                if flat:
                    e.smooth = True
                else:
                    a = e.calc_face_angle(None)
                    e.smooth = a is not None and a <= thr
        with_bm(o, fn)
        clear_custom(o)

bpy.ops.export_scene.gltf(filepath=dst, export_format='GLB')
print('FIXRESULT ' + json.dumps({'done': done, 'before': before, 'tris': tris()}))
`;

const sessions = new Map();          // sid → { src, steps: [{ op, file, tris, done }] }
const fixRoot = () => path.join(ws(), 'runs', 'fix');
const rel = (abs) => path.relative(ws(), abs).split(path.sep).join('/');

// Модель — только из out/ рабочей папки или шаг своей же правки.
function source(relPath) {
  const abs = path.resolve(ws(), relPath || '');
  const inside = path.relative(ws(), abs).split(path.sep);
  if (!['out', 'runs'].includes(inside[0]) || !abs.startsWith(ws() + path.sep) || !/\.(glb|gltf|fbx|obj)$/i.test(abs) || !fs.existsSync(abs)) {
    throw new UserError('noModel');
  }
  return abs;
}

// Брошенные правки (программу закрыли посреди) — убрать, если старше суток.
function sweep() {
  let dirs = [];
  try { dirs = fs.readdirSync(fixRoot()); } catch { return; }
  for (const d of dirs) {
    const p = path.join(fixRoot(), d);
    try { if (!sessions.has(d) && Date.now() - fs.statSync(p).mtimeMs > 864e5) fs.rmSync(p, { recursive: true, force: true }); } catch { /* занято — в другой раз */ }
  }
}

// Шаг улучшения. Без sid — новая правка от модели src.
export async function runFix({ sid, src, op, params = {} }) {
  if (!FIX_OPS.includes(op)) throw new UserError('fixUnknown');
  let s = sid && sessions.get(sid);
  if (!s) {
    sweep();
    sid = crypto.randomBytes(6).toString('hex');
    s = { src: rel(source(src)), steps: [] };
    sessions.set(sid, s);
  }
  const cur = s.steps.length ? s.steps[s.steps.length - 1].file : s.src;
  const dir = path.join(fixRoot(), sid);
  fs.mkdirSync(dir, { recursive: true });
  const dst = path.join(dir, `step${s.steps.length + 1}.glb`);
  const out = await runPy(FIX_PY, [source(cur), dst, op, JSON.stringify(params)], op === 'check' ? null : dst, { timeout: 600000 });
  const m = /FIXRESULT (\{.*\})/.exec(out);
  if (!m) throw new UserError('fixFail', { msg: 'нет ответа Blender' });
  const res = JSON.parse(m[1]);
  if (op === 'check') return { sid, report: res.report, steps: s.steps };
  s.steps.push({ op, file: rel(dst), tris: res.tris, before: res.before, done: res.done });
  return { sid, steps: s.steps };
}

export function undoFix(sid) {
  const s = sessions.get(sid);
  if (!s) throw new UserError('fixGone');
  const last = s.steps.pop();
  if (last) fs.rmSync(path.join(ws(), last.file), { force: true });
  return { sid, steps: s.steps };
}

export function dropFix(sid) {
  sessions.delete(sid);
  if (/^[0-9a-f]{12}$/.test(sid || '')) fs.rmSync(path.join(fixRoot(), sid), { recursive: true, force: true });
}

// Последний шаг — новой готовой моделью: out/<имя>/<имя>.glb (+ превью из окна).
export function saveFix({ sid, name, thumb }) {
  const s = sessions.get(sid);
  if (!s || !s.steps.length) throw new UserError('fixGone');
  let slug = String(name || '').trim().toLowerCase().replace(/[^\p{L}\p{N}_-]+/gu, '_').replace(/^_+|_+$/g, '').slice(0, 60);
  if (!slug) throw new UserError('fixName');
  const base = slug;
  for (let n = 2; fs.existsSync(path.join(ws(), 'out', slug)); n++) slug = `${base}_${n}`;
  const dir = path.join(ws(), 'out', slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(path.join(ws(), s.steps[s.steps.length - 1].file), path.join(dir, `${slug}.glb`));
  const png = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(thumb || '');
  if (png) {
    fs.mkdirSync(path.join(ws(), 'renders', slug), { recursive: true });
    fs.writeFileSync(path.join(ws(), 'renders', slug, 'preview.png'), Buffer.from(png[1], 'base64'));
  }
  dropFix(sid);
  return { name: slug, file: `out/${slug}/${slug}.glb` };
}
