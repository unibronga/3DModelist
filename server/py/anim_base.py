# Основа для анимации: готовая модель → anim/<модель>/base.glb.
# Blender без окна, пустая сцена. Родители и повороты применяются, всё, кроме
# мешей, убирается (в том числе старая арматура — скелет строится заново).
# По base.glb человек ставит точки скелета, и по нему же Blender считает
# привязку: координаты у страницы и у Blender — одни и те же (glTF, Y вверх).
# Персонаж должен смотреть вперёд (в Blender на -Y, в glTF на +Z) — так его
# ждут Godot и Unity, и по оси X идёт зеркало скелета. turn — поворот вокруг
# вертикали в градусах; auto — найти, где у модели лево и право: зеркалим
# вершины через середину по X и по Y и смотрим, где отражение ложится на
# модель точнее. Лево-право вдоль Y — модель стоит боком, поворачиваем на 90°.
# Спиной к зрителю — человек разворачивает на 180° кнопкой.
#
#   blender --background --factory-startup --python-expr <этот код> -- src dst turn report

import sys
import json
import math
import bpy
from mathutils import Matrix
from mathutils.kdtree import KDTree

src, dst, turn, report = sys.argv[sys.argv.index('--') + 1:][:4]
bpy.ops.wm.read_factory_settings(use_empty=True)

ext = src.rsplit('.', 1)[1].lower()
if ext in ('glb', 'gltf'):
    bpy.ops.import_scene.gltf(filepath=src)
elif ext == 'fbx':
    bpy.ops.import_scene.fbx(filepath=src)
elif ext == 'obj':
    bpy.ops.wm.obj_import(filepath=src)

scene = bpy.context.scene
meshes = [o for o in scene.objects if o.type == 'MESH']
if not meshes:
    raise SystemExit('в модели нет сеток')

# Позу старой арматуры не запекаем: берём сетку как есть, без её модификаторов.
for o in meshes:
    for md in list(o.modifiers):
        if md.type == 'ARMATURE':
            o.modifiers.remove(md)
    o.vertex_groups.clear()

bpy.ops.object.select_all(action='DESELECT')
for o in meshes:
    o.select_set(True)
bpy.context.view_layer.objects.active = meshes[0]
bpy.ops.object.parent_clear(type='CLEAR_KEEP_TRANSFORM')
bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)

if turn == 'auto':
    pts = [o.matrix_world @ v.co for o in meshes for v in o.data.vertices]
    kd = KDTree(len(pts))
    for i, p in enumerate(pts):
        kd.insert(p, i)
    kd.balance()
    step = max(1, len(pts) // 2000)

    def mirror_error(axis):
        c = (max(p[axis] for p in pts) + min(p[axis] for p in pts)) / 2
        total = 0.0
        for p in pts[::step]:
            q = p.copy()
            q[axis] = 2 * c - q[axis]
            total += kd.find(q)[2]
        return total

    turn = 270 if mirror_error(1) < mirror_error(0) * 0.8 else 0
turn = int(turn) % 360
if turn:
    rot = Matrix.Rotation(math.radians(turn), 4, 'Z')
    for o in meshes:
        o.matrix_world = rot @ o.matrix_world
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)

for o in list(scene.objects):
    if o.type != 'MESH':
        bpy.data.objects.remove(o, do_unlink=True)

bpy.ops.export_scene.gltf(filepath=dst, export_format='GLB', export_yup=True,
                          export_animations=False, export_skins=False)
json.dump({'turn': turn, 'v': 2}, open(report, 'w'))
