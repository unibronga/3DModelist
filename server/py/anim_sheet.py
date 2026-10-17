# Лист кадров движения — глаза агента-аниматора. Модель с движением
# (GLB, одна анимация) снимается в нескольких кадрах с трёх сторон: строки —
# кадры, столбцы — спереди, сбоку (правый бок персонажа), сзади. Пол —
# серая плоскость: видно, где стопа стоит, а где проваливается.
#
#   blender --background --factory-startup --python-expr <код> -- anim.glb out.png frames
#   frames — номера кадров через запятую.

import sys
import math
import bpy
import numpy as np
from mathutils import Vector

src, out, frames = sys.argv[sys.argv.index('--') + 1:][:3]
frames = [int(x) for x in frames.split(',') if x.strip()]
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=src)
sc = bpy.context.scene
arm = next((o for o in sc.objects if o.type == 'ARMATURE'), None)
# Импорт glTF кладёт служебную сферу — фигуру костей; в кадр и габариты её не брать.
shapes = {pb.custom_shape for pb in arm.pose.bones if pb.custom_shape} if arm else set()
for o in shapes:
    o.hide_render = True
meshes = [o for o in sc.objects if o.type == 'MESH' and o not in shapes]
if arm and arm.animation_data and not arm.animation_data.action and bpy.data.actions:
    arm.animation_data.action = bpy.data.actions[0]

# Габариты в покое — кадр по ним одинаковый для всех кадров движения.
sc.frame_set(0)
dg = bpy.context.evaluated_depsgraph_get()
pts = []
for o in meshes:
    e = o.evaluated_get(dg)
    m = e.to_mesh()
    pts += [e.matrix_world @ v.co for v in m.vertices]
    e.to_mesh_clear()
lo = Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts)))
hi = Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
center = (lo + hi) / 2
H = hi.z - lo.z

bpy.ops.mesh.primitive_plane_add(size=H * 40, location=(center.x, center.y, lo.z))
floor = bpy.context.active_object
mat = bpy.data.materials.new('floor')
mat.diffuse_color = (0.55, 0.55, 0.58, 1)
floor.data.materials.append(mat)

sc.render.engine = 'BLENDER_WORKBENCH'
sc.display.shading.light = 'STUDIO'
sc.display.shading.color_type = 'TEXTURE'
sc.display.shading.show_shadows = True
sc.render.film_transparent = False
sc.world = bpy.data.worlds.new('w')
sc.world.color = (0.12, 0.13, 0.15)
S = 360
sc.render.resolution_x = S
sc.render.resolution_y = S
cam = bpy.data.objects.new('cam', bpy.data.cameras.new('cam'))
sc.collection.objects.link(cam)
sc.camera = cam
cam.data.type = 'ORTHO'
cam.data.ortho_scale = H * 1.18

# Blender: лицо персонажа — на −Y, левая сторона — +X.
views = [('front', Vector((0, -1, 0))), ('side', Vector((-1, 0, 0))), ('back', Vector((0, 1, 0)))]
tiles = []
for f in frames:
    sc.frame_set(f)
    row = []
    for _, d in views:
        # Чуть сверху (≈8°): виден пол под стопами.
        aim = Vector((center.x, center.y, lo.z + H * 0.5))
        cam.location = aim + d * H * 3 + Vector((0, 0, H * 3 * 0.14))
        cam.rotation_euler = (aim - cam.location).to_track_quat('-Z', 'Y').to_euler()
        sc.render.filepath = out + '.tile.png'
        bpy.ops.render.render(write_still=True)
        img = bpy.data.images.load(sc.render.filepath)
        row.append(np.array(img.pixels[:]).reshape(S, S, 4))
        bpy.data.images.remove(img)
    tiles.append(np.concatenate(row, axis=1))
# Пиксели Blender идут снизу вверх: первый кадр — верхней строкой.
sheet = np.concatenate(tiles[::-1], axis=0)
h, w = sheet.shape[:2]
# Тонкие разделители между клетками.
for k in range(1, len(views)):
    sheet[:, k * S - 1:k * S + 1, :3] = 0.35
for k in range(1, len(frames)):
    sheet[k * S - 1:k * S + 1, :, :3] = 0.35
im = bpy.data.images.new('sheet', w, h)
im.pixels = sheet.ravel()
im.filepath_raw = out
im.file_format = 'PNG'
im.save()
