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

# ── привязка через копию ───────────────────────────────────────────────────
# Сетка генератора разрезана по швам (плоские грани, развёртка): тысячи
# кусков, и тепловые веса Blender на них не находят решения. Веса считаются
# на копии — сначала со склеенными швами, если мало — на цельной оболочке
# (Remesh вокселями), — и переносятся на модель; её вид не меняется.
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


def shell(o):
    md = o.modifiers.new('Shell', 'REMESH')
    md.mode = 'VOXEL'
    md.voxel_size = max(max(o.dimensions) / 160, 0.002)
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


for step, mapping in (('weld', 'NEAREST'), ('shell', 'POLYINTERP_NEAREST')):
    if missed <= total * 0.01:
        break
    proxy = proxy_copy()
    weld(proxy)
    if step == 'shell':
        shell(proxy)
    auto_weights([proxy])
    left = len(unweighted(proxy))
    if left < len(proxy.data.vertices) * 0.5:
        transfer(proxy, mapping)
        method = step
        missed = sum(len(unweighted(o)) for o in meshes)
    bpy.data.objects.remove(proxy, do_unlink=True)

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

json.dump({'method': method, 'verts': total, 'missed': missed, 'fixed': fixed,
           'bones': len(bone_names)}, open(report_path, 'w', encoding='utf-8'))
