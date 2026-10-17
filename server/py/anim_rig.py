# Скелет → привязка к модели: base.glb + rig.json → skin.glb + отчёт.
# Blender без окна, пустая сцена.
#
#   blender --background --factory-startup --python-expr <этот код> -- base rig dst report
#
# rig.json: joints — точки скелета в координатах glTF (Y вверх, как их видит
# страница), bones — [{name, parent, head, tail}], head/tail — имена точек.
# Привязка — «Автоматические веса» Blender (тепловые). Сетки генератора
# разрезаны по швам, и на них веса не находятся — тогда считаем на копии
# (см. ниже) и переносим. Вершины, что всё равно остались без кости, берёт
# ближайшая кость.

import sys
import json
import bpy
import bmesh
from mathutils import Vector
from mathutils.geometry import intersect_point_line
from mathutils.kdtree import KDTree

base, rig_path, dst, report_path = sys.argv[sys.argv.index('--') + 1:][:4]
rig = json.load(open(rig_path, encoding='utf-8'))

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=base)
scene = bpy.context.scene
view = bpy.context.view_layer
meshes = [o for o in scene.objects if o.type == 'MESH']

bpy.ops.object.select_all(action='DESELECT')
for o in meshes:
    o.select_set(True)
view.objects.active = meshes[0]
bpy.ops.object.parent_clear(type='CLEAR_KEEP_TRANSFORM')
bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
for o in list(scene.objects):
    if o.type != 'MESH':
        bpy.data.objects.remove(o, do_unlink=True)


def gl2bl(p):
    return Vector((p[0], -p[2], p[1]))


# ── арматура ────────────────────────────────────────────────────────────────
data = bpy.data.armatures.new('Armature')
arm = bpy.data.objects.new('Armature', data)
scene.collection.objects.link(arm)
bpy.ops.object.select_all(action='DESELECT')
arm.select_set(True)
view.objects.active = arm
bpy.ops.object.mode_set(mode='EDIT')
joints = rig['joints']
for b in rig['bones']:
    eb = data.edit_bones.new(b['name'])
    eb.head = gl2bl(joints[b['head']])
    eb.tail = gl2bl(joints[b['tail']])
    # Ось Z кости — вперёд (у ступней, что сами смотрят вперёд, — вверх):
    # у левой и правой стороны оси зеркальные, повороты читаются одинаково.
    d = (eb.tail - eb.head).normalized()
    eb.roll = 0
    eb.align_roll(Vector((0, 0, 1)) if abs(d.y) > 0.9 else Vector((0, -1, 0)))
for b in rig['bones']:
    if b.get('parent'):
        eb = data.edit_bones[b['name']]
        eb.parent = data.edit_bones[b['parent']]
        eb.use_connect = (eb.parent.tail - eb.head).length < 1e-5
bpy.ops.object.mode_set(mode='OBJECT')
bone_names = [b['name'] for b in rig['bones']]


def unweighted(o):
    idx = {g.index for g in o.vertex_groups if g.name in bone_names}
    return [v for v in o.data.vertices if sum(g.weight for g in v.groups if g.group in idx) < 1e-6]


def clear_skin(o):
    for md in list(o.modifiers):
        if md.type == 'ARMATURE':
            o.modifiers.remove(md)
    o.vertex_groups.clear()


def auto_weights(objs):
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs:
        o.select_set(True)
    arm.select_set(True)
    view.objects.active = arm
    bpy.ops.object.parent_set(type='ARMATURE_AUTO')


total = sum(len(o.data.vertices) for o in meshes)
auto_weights(meshes)
missed = sum(len(unweighted(o)) for o in meshes)
method = 'auto'
voxel = None

# ── привязка через копию ───────────────────────────────────────────────────
# Модель генератора — не одна оболочка, а десятки кусков: куртка, рубашка,
# ремень, шлёвки, брюки, да ещё разрезанные по швам. Тепловые веса Blender
# считает каждый кусок сам по себе: соседние куски (ремень и брюки под ним)
# получают разные веса и при сгибе расходятся — дыры у пояса, оторванные
# шлёвки (замер на Kian 13.10: 7 900 пар соседних точек расходились больше
# чем на 1 см, до 11 см). Поэтому у такой модели веса считаются на одной
# сплошной оболочке всего тела (Remesh вокселями), переносятся на каждую
# деталь по ближайшей точке оболочки и сглаживаются между соседними
# деталями — после этого расхождений больше 1 см нет (худшее 4 мм).
# Цельная модель (один кусок) привязывается напрямую, как раньше.
def proxy_copy():
    parts = []
    for o in meshes:
        d = o.copy()
        d.data = o.data.copy()
        d.parent = None
        d.matrix_world = o.matrix_world.copy()
        scene.collection.objects.link(d)
        clear_skin(d)
        parts.append(d)
    bpy.ops.object.select_all(action='DESELECT')
    for d in parts:
        d.select_set(True)
    view.objects.active = parts[0]
    if len(parts) > 1:
        bpy.ops.object.join()
    return view.objects.active


def weld(o):
    bm = bmesh.new()
    bm.from_mesh(o.data)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=max(max(o.dimensions) * 1e-5, 1e-6))
    bm.to_mesh(o.data)
    bm.free()


def pieces(o):
    bm = bmesh.new()
    bm.from_mesh(o.data)
    seen = set()
    n = 0
    for v in bm.verts:
        if v.index in seen:
            continue
        n += 1
        stack = [v]
        seen.add(v.index)
        while stack:
            for e in stack.pop().link_edges:
                for u in e.verts:
                    if u.index not in seen:
                        seen.add(u.index)
                        stack.append(u)
    bm.free()
    return n


def shell(o, div):
    md = o.modifiers.new('Shell', 'REMESH')
    md.mode = 'VOXEL'
    md.voxel_size = max(max(o.dimensions) / div, 0.002)
    md.adaptivity = 0
    with bpy.context.temp_override(object=o, active_object=o, selected_objects=[o]):
        bpy.ops.object.modifier_apply(modifier=md.name)


def transfer(src, mapping):
    for o in meshes:
        clear_skin(o)
        dt = o.modifiers.new('Weights', 'DATA_TRANSFER')
        dt.object = src
        dt.use_object_transform = True
        dt.use_vert_data = True
        dt.data_types_verts = {'VGROUP_WEIGHTS'}
        dt.vert_mapping = mapping
        dt.layers_vgroup_select_src = 'ALL'
        dt.layers_vgroup_select_dst = 'NAME'
        with bpy.context.temp_override(object=o, active_object=o, selected_objects=[o]):
            bpy.ops.object.datalayout_transfer(modifier=dt.name)
            bpy.ops.object.modifier_apply(modifier=dt.name)
        am = o.modifiers.new('Armature', 'ARMATURE')
        am.object = arm
        if o.parent != arm:
            mw = o.matrix_world.copy()
            o.parent = arm
            o.matrix_world = mw


# Веса соседних точек разных деталей — к общему среднему (радиус ~1,4 см на
# человека 1,7 м): слои одежды и пряжки двигаются вместе с тем, на чём лежат.
def smooth_across(radius, rounds=2):
    pts = [(o, v.index, o.matrix_world @ v.co) for o in meshes for v in o.data.vertices]
    kd = KDTree(len(pts))
    for i, (_, _, p) in enumerate(pts):
        kd.insert(p, i)
    kd.balance()

    def read(o, vi):
        groups = o.vertex_groups
        return {groups[g.group].name: g.weight for g in o.data.vertices[vi].groups if groups[g.group].name in bone_names}
    cur = [read(o, vi) for (o, vi, _) in pts]
    # Точка без весов (на оболочке там пусто) — веса ближайшей точки с весами,
    # а не ближайшей кости целиком: жёсткая кость рвала деталь на 20 см.
    have = [i for i, w in enumerate(cur) if w]
    if have and len(have) < len(cur):
        kw = KDTree(len(have))
        for n, i in enumerate(have):
            kw.insert(pts[i][2], n)
        kw.balance()
        for i, w in enumerate(cur):
            if not w:
                cur[i] = dict(cur[have[kw.find(pts[i][2])[1]]])
    for _ in range(rounds):
        nxt = []
        for i, (_, _, p) in enumerate(pts):
            acc = {}
            tot = 0.0
            for (_, j, d) in kd.find_range(p, radius):
                w = 1.0 - d / radius
                tot += w
                for k, x in cur[j].items():
                    acc[k] = acc.get(k, 0.0) + x * w
            nxt.append({k: x / tot for k, x in acc.items()} if tot else cur[i])
        cur = nxt
    for (o, vi, _), w in zip(pts, cur):
        for k in bone_names:
            g = o.vertex_groups.get(k) or o.vertex_groups.new(name=k)
            if w.get(k, 0.0) > 1e-4:
                g.add([vi], w[k], 'REPLACE')
            else:
                g.remove([vi])


probe = proxy_copy()
weld(probe)
parts = pieces(probe)
bpy.data.objects.remove(probe, do_unlink=True)

if parts > 1 or missed > total * 0.01:
    # Оболочка: подробная, пока тепловые веса на ней находятся (на слишком
    # подробной Blender решения не находит вовсе), иначе — грубее.
    for div in (100, 80, 64, 50, 40):
        proxy = proxy_copy()
        weld(proxy)
        shell(proxy, div)
        auto_weights([proxy])
        ok = len(unweighted(proxy)) <= len(proxy.data.vertices) * 0.01
        if ok:
            transfer(proxy, 'POLYINTERP_NEAREST')
            method, voxel = 'shell', div
        bpy.data.objects.remove(proxy, do_unlink=True)
        if ok:
            break
    if method == 'shell':
        smooth_across(max(max(o.dimensions) for o in meshes) / 120)
    else:
        # Оболочка не вышла — по-старому: склеенная копия, затем ближайшая кость.
        proxy = proxy_copy()
        weld(proxy)
        auto_weights([proxy])
        if len(unweighted(proxy)) < len(proxy.data.vertices) * 0.5:
            transfer(proxy, 'NEAREST')
            method = 'weld'
        bpy.data.objects.remove(proxy, do_unlink=True)
    missed = sum(len(unweighted(o)) for o in meshes)

# ── ничья вершина — ближайшей кости ────────────────────────────────────────
segs = [(b.name, arm.matrix_world @ b.head_local, arm.matrix_world @ b.tail_local) for b in data.bones]


def seg_dist(p, a, b):
    q, t = intersect_point_line(p, a, b)
    t = min(1.0, max(0.0, t))
    return (p - a.lerp(b, t)).length


fixed = 0
for o in meshes:
    for n in bone_names:
        if n not in o.vertex_groups:
            o.vertex_groups.new(name=n)
    for v in unweighted(o):
        p = o.matrix_world @ v.co
        name = min(segs, key=lambda s: seg_dist(p, s[1], s[2]))[0]
        o.vertex_groups[name].add([v.index], 1.0, 'REPLACE')
        fixed += 1
    # Не больше 4 костей на вершину и сумма 1 — так ждут Godot и Unity.
    with bpy.context.temp_override(object=o, active_object=o, selected_objects=[o]):
        bpy.ops.object.vertex_group_limit_total(group_select_mode='ALL', limit=4)
        bpy.ops.object.vertex_group_normalize_all(group_select_mode='ALL', lock_active=False)

bpy.ops.object.select_all(action='DESELECT')
arm.select_set(True)
for o in meshes:
    o.select_set(True)
view.objects.active = arm
bpy.ops.export_scene.gltf(filepath=dst, export_format='GLB', export_yup=True,
                          export_skins=True, export_animations=False)

json.dump({'method': method, 'voxel': voxel, 'parts': parts, 'verts': total, 'missed': missed, 'fixed': fixed,
           'bones': len(bone_names)}, open(report_path, 'w', encoding='utf-8'))
