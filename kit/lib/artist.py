# -*- coding: utf-8 -*-
"""
artist.py — библиотека хелперов 3D-художника, исполняется ВНУТРИ Blender.

Подключается автоматически: `tools/bl` подмешивает этот файл прелюдией
к каждому скрипту, поэтому в скриптах сцены всё ниже доступно без импорта.
Проверено на Blender 5.2 LTS.
"""

import math
import os
import re

import bpy
import mathutils
from mathutils import Vector

PI = math.pi
TAU = math.tau


def rad(deg):
    """Градусы -> радианы (в bpy все углы в радианах)."""
    return math.radians(deg)


# ─────────────────────────────────────────── сцена

def reset_scene(keep_world=False):
    """Полная очистка сцены: объекты + осиротевшие данные.

    Вызывать в начале каждой модели — иначе остатки прошлой сборки
    молча попадут в рендер и в .blend.
    """
    for obj in list(bpy.data.objects):
        bpy.data.objects.remove(obj, do_unlink=True)
    for coll in list(bpy.data.collections):
        bpy.data.collections.remove(coll)
    purge(keep_world=keep_world)
    return scene_stats()


def purge(keep_world=False, rounds=4):
    """Выгрести осиротевшие датаблоки (меши, материалы, текстуры)."""
    blocks = [bpy.data.meshes, bpy.data.materials, bpy.data.curves,
              bpy.data.images, bpy.data.node_groups, bpy.data.armatures,
              bpy.data.lights, bpy.data.cameras, bpy.data.textures]
    if not keep_world:
        blocks.append(bpy.data.worlds)
    for _ in range(rounds):
        removed = 0
        for coll in blocks:
            for block in list(coll):
                if block.users == 0:
                    coll.remove(block)
                    removed += 1
        if not removed:
            break


def collection(name, parent=None):
    """Получить (или создать) коллекцию и подключить её к сцене."""
    coll = bpy.data.collections.get(name)
    if coll is None:
        coll = bpy.data.collections.new(name)
        (parent or bpy.context.scene.collection).children.link(coll)
    return coll


def move_to(obj, coll):
    """Перенести объект в коллекцию, отвязав от всех прочих."""
    for existing in list(obj.users_collection):
        existing.objects.unlink(obj)
    coll.objects.link(obj)
    return obj


def scene_stats():
    """Сводка по сцене: объекты, полигонаж, материалы."""
    deps = bpy.context.evaluated_depsgraph_get()
    tris = 0
    for obj in bpy.data.objects:
        if obj.type != "MESH":
            continue
        try:
            mesh = obj.evaluated_get(deps).to_mesh()
            mesh.calc_loop_triangles()
            tris += len(mesh.loop_triangles)
            obj.evaluated_get(deps).to_mesh_clear()
        except Exception:
            pass
    return {
        "objects": [o.name for o in bpy.data.objects],
        "meshes": sum(1 for o in bpy.data.objects if o.type == "MESH"),
        "tris_evaluated": tris,
        "materials": [m.name for m in bpy.data.materials],
    }


# ─────────────────────────────────────────── примитивы и трансформации

def _last(name=None, coll=None):
    """Забрать только что созданный объект, при желании переименовать."""
    obj = bpy.context.active_object
    if name:
        obj.name = name
        if obj.data and hasattr(obj.data, "name"):
            obj.data.name = name
    if coll is not None:
        move_to(obj, coll)
    return obj


def cube(name=None, size=2.0, location=(0, 0, 0), rotation=(0, 0, 0), scale=None, coll=None):
    bpy.ops.mesh.primitive_cube_add(size=size, location=location, rotation=rotation)
    obj = _last(name, coll)
    if scale:
        obj.scale = scale
    return obj


def sphere(name=None, radius=1.0, segments=48, rings=24, location=(0, 0, 0), coll=None):
    bpy.ops.mesh.primitive_uv_sphere_add(
        radius=radius, segments=segments, ring_count=rings, location=location)
    obj = _last(name, coll)
    smooth(obj)
    return obj


def ico(name=None, radius=1.0, subdiv=3, location=(0, 0, 0), coll=None):
    bpy.ops.mesh.primitive_ico_sphere_add(radius=radius, subdivisions=subdiv, location=location)
    obj = _last(name, coll)
    smooth(obj)
    return obj


def cylinder(name=None, radius=1.0, depth=2.0, verts=48, location=(0, 0, 0), rotation=(0, 0, 0), coll=None):
    bpy.ops.mesh.primitive_cylinder_add(
        radius=radius, depth=depth, vertices=verts, location=location, rotation=rotation)
    obj = _last(name, coll)
    smooth(obj, angle=40)
    return obj


def cone(name=None, radius1=1.0, radius2=0.0, depth=2.0, verts=48, location=(0, 0, 0), coll=None):
    bpy.ops.mesh.primitive_cone_add(
        radius1=radius1, radius2=radius2, depth=depth, vertices=verts, location=location)
    obj = _last(name, coll)
    smooth(obj, angle=40)
    return obj


def torus(name=None, major=1.0, minor=0.25, major_seg=64, minor_seg=24, location=(0, 0, 0), coll=None):
    bpy.ops.mesh.primitive_torus_add(
        major_radius=major, minor_radius=minor,
        major_segments=major_seg, minor_segments=minor_seg, location=location)
    obj = _last(name, coll)
    smooth(obj)
    return obj


def plane(name=None, size=2.0, location=(0, 0, 0), coll=None):
    bpy.ops.mesh.primitive_plane_add(size=size, location=location)
    return _last(name, coll)


def text(body, name=None, size=1.0, extrude=0.05, bevel=0.01, align="CENTER", location=(0, 0, 0), coll=None):
    """3D-текст. Сразу выдавленный и со скруглённой фаской — плоские буквы читаются дёшево."""
    bpy.ops.object.text_add(location=location)
    obj = _last(name or "Text", coll)
    obj.data.body = body
    obj.data.size = size
    obj.data.extrude = extrude
    obj.data.bevel_depth = bevel
    obj.data.align_x = align
    obj.data.align_y = "CENTER"
    return obj


def dup(obj, name=None, location=None, linked=False):
    """Копия объекта. linked=True — общий меш (дешевле по памяти)."""
    new = obj.copy()
    new.data = obj.data if linked else obj.data.copy()
    if name:
        new.name = name
    for coll in obj.users_collection:
        coll.objects.link(new)
    if location is not None:
        new.location = location
    return new


def join(objects, name=None):
    """Слить объекты в один (первый в списке — приёмник)."""
    bpy.ops.object.select_all(action="DESELECT")
    for obj in objects:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = objects[0]
    bpy.ops.object.join()
    result_obj = bpy.context.active_object
    if name:
        result_obj.name = name
    return result_obj


def set_origin(obj, mode="ORIGIN_GEOMETRY", center="MEDIAN"):
    """Пересчитать точку опоры. Делать ДО расстановки — иначе объект прыгает."""
    select_only(obj)
    bpy.ops.object.origin_set(type=mode, center=center)
    return obj


def select_only(obj):
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    return obj


def apply_transform(obj, location=False, rotation=True, scale=True):
    """Применить трансформ. Обязательно перед bevel/solidify при неравном масштабе."""
    select_only(obj)
    bpy.ops.object.transform_apply(location=location, rotation=rotation, scale=scale)
    return obj


def bbox(obj):
    """Габариты объекта в мировых координатах."""
    corners = [obj.matrix_world @ Vector(c) for c in obj.bound_box]
    mins = Vector((min(c.x for c in corners), min(c.y for c in corners), min(c.z for c in corners)))
    maxs = Vector((max(c.x for c in corners), max(c.y for c in corners), max(c.z for c in corners)))
    return {
        "min": tuple(mins), "max": tuple(maxs),
        "size": tuple(maxs - mins), "center": tuple((mins + maxs) / 2.0),
    }


def scene_bbox(objects=None):
    """Общий габарит набора объектов (по умолчанию — всех мешей сцены)."""
    objects = objects or [o for o in bpy.data.objects if o.type in {"MESH", "CURVE", "FONT"}]
    if not objects:
        return None
    corners = []
    for obj in objects:
        corners += [obj.matrix_world @ Vector(c) for c in obj.bound_box]
    mins = Vector((min(c.x for c in corners), min(c.y for c in corners), min(c.z for c in corners)))
    maxs = Vector((max(c.x for c in corners), max(c.y for c in corners), max(c.z for c in corners)))
    return {"min": tuple(mins), "max": tuple(maxs),
            "size": tuple(maxs - mins), "center": tuple((mins + maxs) / 2.0)}


def on_floor(obj, z=0.0):
    """Посадить объект на пол — низ габарита на отметку z."""
    obj.location.z += z - bbox(obj)["min"][2]
    return obj


def parent_to(child, parent, keep_transform=True):
    child.parent = parent
    if keep_transform:
        child.matrix_parent_inverse = parent.matrix_world.inverted()
    return child


# ─────────────────────────────────────────── сглаживание и модификаторы

def smooth(obj, angle=30):
    """Shade Smooth с порогом по углу — плавные бока, чёткие рёбра."""
    select_only(obj)
    try:
        bpy.ops.object.shade_smooth_by_angle(angle=rad(angle))
    except Exception:
        bpy.ops.object.shade_smooth()
    return obj


def flat(obj):
    select_only(obj)
    bpy.ops.object.shade_flat()
    return obj


def mod(obj, mtype, name=None, **props):
    """Добавить модификатор и проставить свойства. Неизвестные ключи — ошибка, не тишина."""
    modifier = obj.modifiers.new(name=name or mtype.title(), type=mtype)
    for key, value in props.items():
        if not hasattr(modifier, key):
            raise AttributeError(f"{mtype}: нет свойства '{key}'")
        setattr(modifier, key, value)
    return modifier


def bevel(obj, amount=0.02, segments=3, angle=30, harden_normals=False):
    """Фаска по углу — главный приём «дорогого» вида: рёбра ловят блик."""
    return mod(obj, "BEVEL", "Bevel", width=amount, segments=segments,
               limit_method="ANGLE", angle_limit=rad(angle),
               miter_outer="MITER_ARC", harden_normals=harden_normals)


def subsurf(obj, levels=2, render=None, catmull=True):
    return mod(obj, "SUBSURF", "Subdiv", levels=levels,
               render_levels=render if render is not None else levels,
               subdivision_type="CATMULL_CLARK" if catmull else "SIMPLE")


def solidify(obj, thickness=0.02, offset=-1.0):
    return mod(obj, "SOLIDIFY", "Solidify", thickness=thickness, offset=offset)


def mirror(obj, axis=(True, False, False), bisect=True, mirror_object=None):
    modifier = mod(obj, "MIRROR", "Mirror", use_axis=axis)
    modifier.use_bisect_axis = axis if bisect else (False, False, False)
    if mirror_object:
        modifier.mirror_object = mirror_object
    return modifier


def array(obj, count=3, offset=(1.1, 0, 0), relative=True):
    modifier = mod(obj, "ARRAY", "Array", count=count)
    modifier.use_relative_offset = relative
    modifier.use_constant_offset = not relative
    if relative:
        modifier.relative_offset_displace = offset
    else:
        modifier.constant_offset_displace = offset
    return modifier


def screw(obj, angle=360, steps=32, axis="Z"):
    return mod(obj, "SCREW", "Screw", angle=rad(angle), steps=steps,
               render_steps=steps, axis=axis)


def boolean(obj, cutter, operation="DIFFERENCE", solver="EXACT", apply=True, hide=True):
    """Булева операция. apply=True сразу запекает — иначе стек модификаторов растёт."""
    modifier = mod(obj, "BOOLEAN", "Bool", object=cutter, operation=operation, solver=solver)
    if hide:
        cutter.hide_viewport = True
        cutter.hide_render = True
    if apply:
        select_only(obj)
        bpy.ops.object.modifier_apply(modifier=modifier.name)
        bpy.data.objects.remove(cutter, do_unlink=True)
        return obj
    return modifier


def weld(obj, distance=0.0001):
    return mod(obj, "WELD", "Weld", merge_threshold=distance)


def apply_mods(obj):
    """Запечь весь стек модификаторов."""
    select_only(obj)
    for modifier in list(obj.modifiers):
        bpy.ops.object.modifier_apply(modifier=modifier.name)
    return obj


# ─────────────────────────────────────────── материалы

def pbr(name, base_color=(0.8, 0.8, 0.8), metallic=0.0, roughness=0.5,
        ior=1.45, alpha=1.0, emission=None, emission_strength=0.0,
        coat=0.0, coat_roughness=0.03, transmission=0.0, sheen=0.0):
    """PBR-материал на Principled BSDF.

    base_color — RGB 0..1 (линейный!) либо RGBA. Металл: metallic=1 и
    base_color = цвет самого металла; у диэлектриков metallic=0.
    """
    mat = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    if bsdf is None:
        mat.node_tree.nodes.clear()
        bsdf = mat.node_tree.nodes.new("ShaderNodeBsdfPrincipled")
        out = mat.node_tree.nodes.new("ShaderNodeOutputMaterial")
        mat.node_tree.links.new(bsdf.outputs[0], out.inputs[0])

    rgba = tuple(base_color) + (1.0,) if len(base_color) == 3 else tuple(base_color)

    def put(socket, value):
        if socket in bsdf.inputs:
            bsdf.inputs[socket].default_value = value

    put("Base Color", rgba)
    put("Metallic", metallic)
    put("Roughness", roughness)
    put("IOR", ior)
    put("Alpha", alpha)
    put("Coat Weight", coat)
    put("Coat Roughness", coat_roughness)
    put("Transmission Weight", transmission)
    put("Sheen Weight", sheen)
    if emission is not None:
        put("Emission Color", tuple(emission) + (1.0,) if len(emission) == 3 else tuple(emission))
        put("Emission Strength", emission_strength or 1.0)

    if alpha < 1.0 or transmission > 0.0:
        mat.blend_method = "BLEND" if hasattr(mat, "blend_method") else mat.blend_method
    return mat


def emissive(name, color=(1, 1, 1), strength=5.0):
    """Самосветящийся материал — для экранов, ламп, неона."""
    return pbr(name, base_color=(0, 0, 0), roughness=1.0,
               emission=color, emission_strength=strength)


def glass(name, color=(1, 1, 1), roughness=0.0, ior=1.45):
    return pbr(name, base_color=color, roughness=roughness, ior=ior,
               transmission=1.0, metallic=0.0)


def metal(name, color=(0.7, 0.7, 0.72), roughness=0.25):
    return pbr(name, base_color=color, metallic=1.0, roughness=roughness)


def assign(obj, mat, slot=None):
    """Назначить материал. slot=None — заменить все слоты одним."""
    if slot is None:
        obj.data.materials.clear()
        obj.data.materials.append(mat)
    else:
        while len(obj.data.materials) <= slot:
            obj.data.materials.append(None)
        obj.data.materials[slot] = mat
    return obj


def assign_faces(obj, mat, predicate):
    """Материал на часть полигонов: predicate(face_center_vector) -> bool."""
    if mat.name not in [m.name for m in obj.data.materials if m]:
        obj.data.materials.append(mat)
    index = [i for i, m in enumerate(obj.data.materials) if m and m.name == mat.name][0]
    for face in obj.data.polygons:
        if predicate(face.center):
            face.material_index = index
    return obj


def smart_uv(obj, angle=66, margin=0.02):
    """Быстрая развёртка. Нужна перед любой текстурой из файла/генератора."""
    select_only(obj)
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.smart_project(angle_limit=rad(angle), island_margin=margin)
    bpy.ops.object.mode_set(mode="OBJECT")
    return obj


# ─────────────────────────────────────────── свет, мир, камера

def world_color(color=(0.05, 0.05, 0.06), strength=1.0):
    """Ровный фон-заливка. Дешёвая замена HDRI, даёт мягкую подсветку."""
    world = bpy.context.scene.world or bpy.data.worlds.new("World")
    bpy.context.scene.world = world
    world.use_nodes = True
    bg = world.node_tree.nodes.get("Background")
    if bg is None:
        bg = world.node_tree.nodes.new("ShaderNodeBackground")
        out = world.node_tree.nodes.new("ShaderNodeOutputWorld")
        world.node_tree.links.new(bg.outputs[0], out.inputs[0])
    bg.inputs[0].default_value = tuple(color) + (1.0,) if len(color) == 3 else tuple(color)
    bg.inputs[1].default_value = strength
    return world


def light(name, ltype="AREA", energy=200.0, location=(0, 0, 3), rotation=(0, 0, 0),
          size=2.0, color=(1, 1, 1)):
    data = bpy.data.lights.new(name, type=ltype)
    data.energy = energy
    data.color = color
    if ltype == "AREA":
        data.size = size
    elif ltype in {"POINT", "SPOT"}:
        data.shadow_soft_size = size
    elif ltype == "SUN":
        data.angle = rad(size)
    obj = bpy.data.objects.new(name, data)
    bpy.context.scene.collection.objects.link(obj)
    obj.location = location
    obj.rotation_euler = rotation
    return obj


def aim(obj, target):
    """Развернуть объект (свет/камеру) на точку или объект."""
    point = Vector(target.location) if hasattr(target, "location") else Vector(target)
    direction = point - obj.location
    obj.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()
    return obj


def three_point(target=(0, 0, 0), distance=6.0, height=4.0, key=800.0, fill=200.0, rim=500.0):
    """Классическая трёхточка: ключ, заполняющий, контровой.

    Ключ греет форму, заполняющий гасит провалы в тенях, контровой
    отделяет объект от фона. Без контрового модель «влипает» в задник.
    """
    center = Vector(target)
    lights = {
        "Key":  light("Key",  "AREA", key,  (center.x - distance * 0.8, center.y - distance * 0.8, center.z + height), size=distance * 0.7),
        "Fill": light("Fill", "AREA", fill, (center.x + distance,       center.y - distance * 0.6, center.z + height * 0.4), size=distance),
        "Rim":  light("Rim",  "AREA", rim,  (center.x + distance * 0.3, center.y + distance,       center.z + height * 1.1), size=distance * 0.4),
    }
    for obj in lights.values():
        aim(obj, center)
    return lights


def studio_floor(size=40.0, color=(0.18, 0.18, 0.2), roughness=0.55, z=0.0):
    """Бесшовный пол-подложка. Ловит тень — без неё объект висит в пустоте."""
    floor = plane("StudioFloor", size=size, location=(0, 0, z))
    assign(floor, pbr("FloorMat", base_color=color, roughness=roughness))
    return floor


def camera(name="Camera", location=(7, -7, 5), target=(0, 0, 0), lens=50.0, ortho=False):
    data = bpy.data.cameras.new(name)
    data.lens = lens
    if ortho:
        data.type = "ORTHO"
    obj = bpy.data.objects.new(name, data)
    bpy.context.scene.collection.objects.link(obj)
    obj.location = location
    aim(obj, target)
    bpy.context.scene.camera = obj
    return obj


def frame_objects(cam=None, objects=None, margin=1.25):
    """Отодвинуть камеру так, чтобы объекты целиком влезли в кадр."""
    cam = cam or bpy.context.scene.camera
    box = scene_bbox(objects)
    if not box or cam is None:
        return cam
    center = Vector(box["center"])
    radius = max(Vector(box["size"]).length / 2.0, 1e-4)
    fov = cam.data.angle
    dist = (radius * margin) / math.tan(fov / 2.0)
    direction = (Vector(cam.location) - center).normalized()
    cam.location = center + direction * dist
    aim(cam, center)
    return cam


def orbit_camera(angle_deg=45, elevation_deg=25, distance=None, target=None, lens=50.0):
    """Камера на орбите вокруг цели — удобно снимать один объект с разных сторон."""
    box = scene_bbox()
    center = Vector(target) if target else Vector(box["center"] if box else (0, 0, 0))
    if distance is None:
        distance = (Vector(box["size"]).length if box else 4.0) * 1.8
    theta, phi = rad(angle_deg), rad(elevation_deg)
    loc = center + Vector((
        math.cos(phi) * math.sin(theta) * distance,
        -math.cos(phi) * math.cos(theta) * distance,
        math.sin(phi) * distance,
    ))
    cam = bpy.context.scene.camera or camera(location=tuple(loc), target=tuple(center), lens=lens)
    cam.location = loc
    cam.data.lens = lens
    aim(cam, center)
    return cam


# ─────────────────────────────────────────── рендер и вывод

def setup_render(engine="BLENDER_EEVEE", samples=64, res=(1600, 1200), transparent=False,
                 denoise=True, gpu=True, film_exposure=1.0, view_transform="AgX"):
    """Настройка движка. EEVEE — быстрые превью, CYCLES — финал."""
    scn = bpy.context.scene
    scn.render.engine = engine
    scn.render.resolution_x, scn.render.resolution_y = res
    scn.render.resolution_percentage = 100
    scn.render.film_transparent = transparent
    scn.view_settings.view_transform = view_transform
    scn.view_settings.exposure = math.log2(film_exposure) if film_exposure > 0 else 0.0

    if engine == "CYCLES":
        scn.cycles.samples = samples
        scn.cycles.use_denoising = denoise
        if gpu:
            prefs = bpy.context.preferences.addons["cycles"].preferences
            for backend in ("METAL", "OPTIX", "CUDA", "HIP", "ONEAPI"):
                try:
                    prefs.compute_device_type = backend
                    break
                except Exception:
                    continue
            try:
                prefs.get_devices()
                for device in prefs.devices:
                    device.use = True
            except Exception:
                pass
            scn.cycles.device = "GPU"
    else:
        scn.eevee.taa_render_samples = samples
        if hasattr(scn.eevee, "use_raytracing"):
            scn.eevee.use_raytracing = True
    return scn


def render(path, engine=None, samples=None, res=None, transparent=False):
    """Отрендерить кадр в PNG. Возвращает абсолютный путь и размер файла."""
    scn = bpy.context.scene
    if engine or samples or res:
        setup_render(engine=engine or scn.render.engine,
                     samples=samples or 64,
                     res=res or (scn.render.resolution_x, scn.render.resolution_y),
                     transparent=transparent)
    path = os.path.abspath(os.path.expanduser(path))
    os.makedirs(os.path.dirname(path), exist_ok=True)
    scn.render.filepath = path
    scn.render.image_settings.file_format = "PNG"
    scn.render.image_settings.color_mode = "RGBA" if transparent else "RGB"
    bpy.ops.render.render(write_still=True)
    return {"path": path, "bytes": os.path.getsize(path) if os.path.exists(path) else 0}


def turntable(path_dir, frames=4, elevation=25, **kw):
    """Серия ракурсов по кругу — быстрая самопроверка формы со всех сторон."""
    out = []
    for i in range(frames):
        orbit_camera(angle_deg=360.0 * i / frames, elevation_deg=elevation)
        out.append(render(os.path.join(path_dir, f"view_{i:02d}.png"), **kw))
    return out


# Ракурсы листа peek(): (азимут, возвышение). Азимут 0 — камера со стороны -Y,
# то есть классический вид спереди; 90 — справа (+X); 180 — со спины.
PEEK_VIEWS = {
    "front": (0, 4),
    "q34":   (35, 18),
    "side":  (90, 4),
    "back":  (180, 10),
    "top":   (0, 80),
    "below": (30, -25),
}


def _peek_objects():
    """Что снимать: видимые меши/кривые без пола-подложки и плоских задников."""
    out = []
    for o in bpy.context.scene.objects:
        if o.type not in {"MESH", "CURVE", "FONT"} or o.hide_render or o.hide_get():
            continue
        if o.name.startswith(("StudioFloor", "Floor", "Backdrop")):
            continue
        if min(o.dimensions) < 1e-5 and max(o.dimensions) > 5.0:   # плоскость-пол
            continue
        out.append(o)
    return out


def peek(path, views=("front", "q34", "side", "back"), ref=None, objects=None,
         engine="BLENDER_WORKBENCH", tile=512, lens=85.0, samples=16, cols=None,
         center=None, radius=None):
    """Лист ракурсов одним PNG — визуальный чек после КАЖДОЙ правки.

    Снимает объекты с нескольких сторон своей временной камерой и склеивает
    плитки в сетку; если задан `ref` — референс идёт первой плиткой, чтобы
    сверка шла глазами на одном листе. Порядок плиток: [ref], затем views.

    По умолчанию Workbench (секунды на лист, цвет из материалов + кэвити) —
    это чтение формы. Для чтения света и палитры — engine="BLENDER_EEVEE".
    Сцену не меняет: камера, движок и настройки вывода возвращаются.
    `center` + `radius` (м) — крупный план зоны: голова, кисть, пряжка.
    """
    import numpy as np

    scn = bpy.context.scene
    objs = objects or _peek_objects()
    box = scene_bbox(objs)
    if not box:
        return {"path": None, "error": "в сцене нечего снимать"}
    center = Vector(center) if center is not None else Vector(box["center"])
    radius = radius or max(Vector(box["size"]).length / 2.0, 1e-3)

    # ── запомнить состояние сцены
    shading = scn.display.shading
    saved = {
        "camera": scn.camera, "engine": scn.render.engine,
        "res": (scn.render.resolution_x, scn.render.resolution_y, scn.render.resolution_percentage),
        "filepath": scn.render.filepath, "transparent": scn.render.film_transparent,
        "fmt": scn.render.image_settings.file_format, "mode": scn.render.image_settings.color_mode,
        "light": shading.light, "color": shading.color_type,
        "cavity": shading.show_cavity, "outline": shading.show_object_outline,
        "eevee": scn.eevee.taa_render_samples,
    }
    # каталог — ДО камеры: упавший makedirs (относительный путь в GUI, где
    # cwd = «/») оставлял в сцене осиротевшую _peek_cam
    path = os.path.abspath(os.path.expanduser(path))
    tmp_dir = os.path.join(os.path.dirname(path), "_peek_tiles")
    os.makedirs(tmp_dir, exist_ok=True)
    cam_data = bpy.data.cameras.new("_peek_cam")
    cam_data.lens = lens
    cam = bpy.data.objects.new("_peek_cam", cam_data)
    scn.collection.objects.link(cam)
    tiles, names, loaded, saved_mats = [], [], [], []
    use_texture = False
    try:
        scn.camera = cam
        scn.render.engine = engine
        scn.render.resolution_x = scn.render.resolution_y = tile
        scn.render.resolution_percentage = 100
        scn.render.film_transparent = False
        scn.render.image_settings.file_format = "PNG"
        scn.render.image_settings.color_mode = "RGB"
        if engine == "BLENDER_WORKBENCH":
            # Workbench не читает ноды: цвет берёт из текстуры активной
            # image-ноды (режим TEXTURE), а без неё — из viewport-цвета
            # материала. Поэтому base color Principled временно копируется
            # во viewport-цвет, а активной делается нода цветовой карты.
            for m in {s.material for o in objs for s in getattr(o, "material_slots", []) if s.material}:
                if not (m.use_nodes and m.node_tree):
                    continue
                nodes = m.node_tree.nodes
                bsdf = next((n for n in nodes if n.type == "BSDF_PRINCIPLED"), None)
                if bsdf and not bsdf.inputs["Base Color"].is_linked:
                    saved_mats.append((m, tuple(m.diffuse_color), nodes.active))
                    m.diffuse_color = tuple(bsdf.inputs["Base Color"].default_value)
                    continue
                img_nodes = [n for n in nodes if n.type == "TEX_IMAGE" and n.image
                             and n.image.colorspace_settings.name != "Non-Color"]
                if img_nodes:
                    saved_mats.append((m, tuple(m.diffuse_color), nodes.active))
                    nodes.active = img_nodes[0]
                    use_texture = True
            shading.light = "STUDIO"
            shading.color_type = "TEXTURE" if use_texture else "MATERIAL"
            shading.show_cavity = True
            shading.show_object_outline = False
        else:
            scn.eevee.taa_render_samples = samples

        # дистанция: описанная сфера целиком в кадре с запасом 12%
        dist = radius * 1.12 / math.tan(cam_data.angle / 2.0)
        cam_data.clip_start = max(dist - radius * 3, 0.001)
        cam_data.clip_end = dist + radius * 3
        for view in views:
            az, el = PEEK_VIEWS[view] if isinstance(view, str) else view
            th, ph = rad(az), rad(el)
            cam.location = center + Vector((math.cos(ph) * math.sin(th) * dist,
                                            -math.cos(ph) * math.cos(th) * dist,
                                            math.sin(ph) * dist))
            aim(cam, center)
            fp = os.path.join(tmp_dir, f"{len(tiles):02d}.png")
            scn.render.filepath = fp
            bpy.ops.render.render(write_still=True)
            tiles.append(fp)
            names.append(view if isinstance(view, str) else f"{az}/{el}")

        # ── склейка: плитки в сетку, фон серый
        sources = ([os.path.abspath(ref)] if ref else []) + tiles
        labels = (["REF"] if ref else []) + names
        n = len(sources)
        cols = cols or (2 if n <= 4 else 3)
        rows = math.ceil(n / cols)
        gap = 6
        W, H = cols * tile + (cols - 1) * gap, rows * tile + (rows - 1) * gap
        sheet = np.full((H, W, 4), 0.35, dtype=np.float32)
        sheet[..., 3] = 1.0
        for i, src in enumerate(sources):
            img = bpy.data.images.load(src, check_existing=False)
            loaded.append(img)
            w, h = img.size
            k = tile / max(w, h)
            nw, nh = max(1, int(w * k)), max(1, int(h * k))
            if (nw, nh) != (w, h):
                img.scale(nw, nh)
            px = np.empty(nw * nh * 4, dtype=np.float32)
            img.pixels.foreach_get(px)
            px = px.reshape(nh, nw, 4)
            r, c = divmod(i, cols)
            # в numpy строка 0 — низ картинки (так хранит Blender)
            y0 = (rows - 1 - r) * (tile + gap) + (tile - nh) // 2
            x0 = c * (tile + gap) + (tile - nw) // 2
            a = px[..., 3:4]   # прозрачный фон референса ложится на серый
            sheet[y0:y0 + nh, x0:x0 + nw, :3] = px[..., :3] * a + 0.35 * (1.0 - a)
        out = bpy.data.images.new("_peek_sheet", W, H, alpha=False)
        loaded.append(out)
        out.pixels.foreach_set(sheet.ravel())
        out.filepath_raw = path
        out.file_format = "PNG"
        out.save()
    finally:
        for img in loaded:
            bpy.data.images.remove(img)
        bpy.data.objects.remove(cam)
        bpy.data.cameras.remove(cam_data)
        scn.camera = saved["camera"]
        scn.render.engine = saved["engine"]
        (scn.render.resolution_x, scn.render.resolution_y,
         scn.render.resolution_percentage) = saved["res"]
        scn.render.filepath = saved["filepath"]
        scn.render.film_transparent = saved["transparent"]
        scn.render.image_settings.file_format = saved["fmt"]
        scn.render.image_settings.color_mode = saved["mode"]
        shading.light, shading.color_type = saved["light"], saved["color"]
        shading.show_cavity, shading.show_object_outline = saved["cavity"], saved["outline"]
        scn.eevee.taa_render_samples = saved["eevee"]
        for m, color, active in saved_mats:
            m.diffuse_color = color
            m.node_tree.nodes.active = active
        for fp in tiles:
            if os.path.exists(fp):
                os.remove(fp)
        if os.path.isdir(tmp_dir) and not os.listdir(tmp_dir):
            os.rmdir(tmp_dir)

    tris = 0
    dg = bpy.context.evaluated_depsgraph_get()
    for o in objs:
        if o.type == "MESH":
            me = o.evaluated_get(dg).to_mesh()
            me.calc_loop_triangles()
            tris += len(me.loop_triangles)
            o.evaluated_get(dg).to_mesh_clear()
    return {"path": path, "tiles": labels, "grid": f"{cols}x{rows}",
            "size_m": tuple(round(v, 3) for v in box["size"]), "tris": tris,
            "objects": len(objs)}


def save(path):
    """Сохранить .blend."""
    path = os.path.abspath(os.path.expanduser(path))
    os.makedirs(os.path.dirname(path), exist_ok=True)
    bpy.ops.wm.save_as_mainfile(filepath=path)
    return {"path": path, "bytes": os.path.getsize(path)}


def export(path, fmt=None, selected_only=False):
    """Экспорт: .glb/.gltf, .fbx, .obj, .stl. Формат — по расширению."""
    path = os.path.abspath(os.path.expanduser(path))
    os.makedirs(os.path.dirname(path), exist_ok=True)
    ext = (fmt or os.path.splitext(path)[1].lstrip(".")).lower()
    if ext in {"glb", "gltf"}:
        bpy.ops.export_scene.gltf(filepath=path, use_selection=selected_only,
                                  export_format="GLB" if ext == "glb" else "GLTF_SEPARATE")
    elif ext == "fbx":
        bpy.ops.export_scene.fbx(filepath=path, use_selection=selected_only)
    elif ext == "obj":
        bpy.ops.wm.obj_export(filepath=path, export_selected_objects=selected_only)
    elif ext == "stl":
        bpy.ops.wm.stl_export(filepath=path, export_selected_objects=selected_only)
    else:
        raise ValueError(f"неизвестный формат экспорта: {ext}")
    return {"path": path, "bytes": os.path.getsize(path)}


def rod(p1, p2, radius=0.02, name=None, verts=32, coll=None):
    """Цилиндр между двумя точками — рычаги, трубы, стойки, каркасы.

    Считает длину и разворот сам: избавляет от ручной тригонометрии,
    из-за которой сочленения обычно не сходятся.
    """
    a, b = Vector(p1), Vector(p2)
    vec = b - a
    length = vec.length
    obj = cylinder(name, radius=radius, depth=length, verts=verts, coll=coll)
    obj.location = (a + b) / 2.0
    obj.rotation_euler = vec.to_track_quat("Z", "Y").to_euler()
    return obj


def hollow_cone(name=None, r_bottom=0.09, r_top=0.04, height=0.12, thickness=0.002,
                verts=64, location=(0, 0, 0), coll=None):
    """Открытый усечённый конус со стенкой — абажуры, раструбы, стаканы.

    Торцы срезаются через bmesh: операторы edit-mode с ручной пометкой
    `polygon.select` работают ненадёжно (селект не синхронизируется с режимом
    выделения по вершинам и удаляет лишнее).
    """
    import bmesh

    obj = cone(name, radius1=r_bottom, radius2=r_top, depth=height, verts=verts,
               location=location, coll=coll)
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    caps = [f for f in bm.faces if abs(f.normal.z) > 0.9]
    bmesh.ops.delete(bm, geom=caps, context="FACES")
    bm.to_mesh(obj.data)
    bm.free()
    obj.data.update()
    solidify(obj, thickness=thickness, offset=0.0)
    smooth(obj, angle=40)
    return obj


def snap_to(obj, target, offset=(0, 0, 0)):
    """Посадить объект в локальные координаты другого объекта.

    Надёжнее ручного пересчёта позиции по синусам: наследует и поворот,
    и смещение цели одной матрицей. Так ободки садятся точно на кромку,
    а накладки — точно на грань.
    """
    obj.matrix_world = target.matrix_world @ mathutils.Matrix.Translation(Vector(offset))
    return obj


def glare(kind="BLOOM", threshold=1.0, size=8.0, strength=1.0, quality="HIGH"):
    """Свечение вокруг ярких мест через компоновщик.

    В EEVEE 5.x встроенного bloom нет — ореол вокруг лампы, экрана или неона
    делается только здесь. Без него источник света на рендере выглядит
    наклейкой, а не светом.

    🔴 Грабли Blender 5.x, стоившие чёрного кадра: компоновщик переехал с
    `scene.node_tree` на `scene.compositing_node_group` (обычная node-группа).
    Внутри неё **источником кадра остаётся нода Render Layers**, а приёмником
    стал Group Output — ноды Composite в 5.x больше нет, а Group Input кадр
    НЕ несёт (группа с перемычкой вход→выход рендерит чистый чёрный).
    Плюс у ноды Glare тип/качество/порог стали входными сокетами.
    """
    scn = bpy.context.scene
    group = scn.compositing_node_group
    rebuild = group is None or not any(n.bl_idname == "CompositorNodeRLayers" for n in group.nodes)
    if rebuild:
        group = bpy.data.node_groups.new("Compositing", "CompositorNodeTree")
        group.interface.new_socket("Image", in_out="OUTPUT", socket_type="NodeSocketColor")
        rlayers = group.nodes.new("CompositorNodeRLayers")
        rlayers.scene = scn
        rlayers.location = (-400, 0)
        group.nodes.new("NodeGroupOutput").location = (400, 0)
        scn.compositing_node_group = group
    scn.use_nodes = True

    for node in list(group.nodes):
        if node.bl_idname == "CompositorNodeGlare":
            group.nodes.remove(node)

    rlayers = next(n for n in group.nodes if n.bl_idname == "CompositorNodeRLayers")
    node_out = next(n for n in group.nodes if n.bl_idname == "NodeGroupOutput")
    node = group.nodes.new("CompositorNodeGlare")
    node.location = (0, 0)

    def set_menu(socket_name, wanted):
        """MENU-сокеты в 5.x принимают человекочитаемые подписи ('Fog Glow'),
        а не идентификаторы старого API ('FOG_GLOW'). Список допустимых значений
        динамический и через RNA пуст — вытаскиваем его из текста исключения."""
        socket = node.inputs[socket_name]
        try:
            socket.default_value = wanted
            return
        except Exception as ex:
            allowed = re.findall(r"'([^']+)'", str(ex).split("not found in")[-1])
        key = str(wanted).replace("_", " ").strip().lower()
        match = next((a for a in allowed if a.lower() == key), None)
        if match is None:
            raise ValueError(f"{socket_name}: '{wanted}' — доступны {allowed}") from None
        socket.default_value = match

    set_menu("Type", kind)
    set_menu("Quality", quality)
    for socket_name, value in (("Threshold", threshold), ("Size", size), ("Strength", strength)):
        if socket_name in node.inputs:
            node.inputs[socket_name].default_value = value

    group.links.new(rlayers.outputs["Image"], node.inputs["Image"])
    group.links.new(node.outputs["Image"], node_out.inputs[0])
    return node


def no_glare():
    """Снять компоновщик со сцены (вернуть чистый рендер)."""
    scn = bpy.context.scene
    scn.compositing_node_group = None
    scn.use_nodes = False


# ─────────────────────────────────────────── цвет и приёмка сетки

def srgb(color):
    """sRGB → линейное пространство, которое и ждёт Principled BSDF.

    Принимает '#RRGGBB', (r, g, b) в 0..255 или в 0..1. Подбирать цвет
    «на глаз» в линейных числах невозможно — оттуда и вымытые тона:
    srgb('#C8783C') даёт ровно тот цвет, что видит глаз в палитре.
    """
    if isinstance(color, str):
        h = color.lstrip("#")
        vals = [int(h[i:i + 2], 16) / 255.0 for i in (0, 2, 4)]
    else:
        vals = [c / 255.0 if c > 1.0 else float(c) for c in color[:3]]
    return tuple(v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4 for v in vals)


def mesh_check(obj):
    """Приёмка одной сетки: всё, что ломает экспорт и рендер, одним вызовом."""
    import bmesh
    me = obj.data
    me.calc_loop_triangles()
    bm = bmesh.new()
    bm.from_mesh(me)

    non_manifold = sum(1 for e in bm.edges if not e.is_manifold)
    loose_v = sum(1 for v in bm.verts if not v.link_edges)
    loose_e = sum(1 for e in bm.edges if not e.link_faces)
    ngons = sum(1 for f in bm.faces if len(f.verts) > 4)
    tris = len(me.loop_triangles)
    bm.free()

    dims = tuple(round(d, 4) for d in obj.dimensions)
    scale_ok = all(abs(s - 1.0) < 1e-4 for s in obj.scale)
    report = {
        "объект": obj.name,
        "трис": tris,
        "n_gon": ngons,
        "не_манифолд_рёбер": non_manifold,
        "висячих_вершин": loose_v,
        "висячих_рёбер": loose_e,
        "габарит_м": dims,
        "трансформ_применён": scale_ok,
        "материалов": [m.name if m else "(пусто)" for m in me.materials],
        "uv": [l.name for l in me.uv_layers],
    }
    report["чисто"] = (non_manifold == 0 and loose_v == 0 and loose_e == 0 and scale_ok)
    return report


def clean_mesh(obj, merge=0.0002):
    """Штатная последовательность чистки: сварить дубли, убрать висячее,
    пересчитать нормали наружу. Гонять перед UV и перед экспортом."""
    select_only(obj)
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.mesh.remove_doubles(threshold=merge)
    bpy.ops.mesh.delete_loose(use_verts=True, use_edges=True, use_faces=False)
    bpy.ops.mesh.normals_make_consistent(inside=False)
    bpy.ops.object.mode_set(mode="OBJECT")
    return obj


POLY_TIERS = {
    "мелкий пропс": (150, 500),          # кружка, ключ, монета
    "средний пропс": (600, 2500),        # сундук, бочка, ящик
    "крупный объект": (2500, 8000),      # мебель, телега, станок
    "окружение": (8000, 25000),          # строение, скала, дерево
    "герой крупным планом": (25000, 60000),
}


def poly_budget(objs, tier="средний пропс"):
    """Не жёсткий лимит, а предупреждение: сколько вышло и попадает ли в тир."""
    lo, hi = POLY_TIERS[tier]
    total = 0
    for o in objs:
        o.data.calc_loop_triangles()
        total += len(o.data.loop_triangles)
    if total < lo:
        verdict = f"ниже тира ({lo}-{hi}) — силуэт, возможно, беднее нужного"
    elif total > hi:
        verdict = f"выше тира ({lo}-{hi}) — есть что упростить"
    else:
        verdict = f"в тире {tier} ({lo}-{hi})"
    return {"трис": total, "тир": tier, "вердикт": verdict}


# ─────────────────────────────────────────── гипертрофия формы

def pillow(obj, amount=0.05, cuts=6, axis_scale=(1.0, 1.0, 1.0)):
    """«Надуть» объект изнутри: центры граней выпучиваются наружу, рёбра остаются.

    Это ключ к мультяшной игровой форме. Реальный предмет — коробка с плоскими
    гранями; игровой стилизованный — подушка. Смещение максимально в центре
    грани и падает к рёбрам как (1-u²)(1-v²), поэтому силуэт становится
    округлым, а конструкция не разъезжается.

    amount — насколько выпучить в метрах, cuts — плотность сетки под изгиб.
    """
    import bmesh
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    if cuts:
        bmesh.ops.subdivide_edges(bm, edges=list(bm.edges), cuts=cuts, use_grid_fill=True)

    xs = [v.co.x for v in bm.verts]
    ys = [v.co.y for v in bm.verts]
    zs = [v.co.z for v in bm.verts]
    cx, cy, cz = (max(xs) + min(xs)) / 2, (max(ys) + min(ys)) / 2, (max(zs) + min(zs)) / 2
    hx = max((max(xs) - min(xs)) / 2, 1e-6)
    hy = max((max(ys) - min(ys)) / 2, 1e-6)
    hz = max((max(zs) - min(zs)) / 2, 1e-6)

    for v in bm.verts:
        u = (v.co.x - cx) / hx
        w = (v.co.y - cy) / hy
        t = (v.co.z - cz) / hz
        a = (abs(u), abs(w), abs(t))
        m = max(a)
        if m < 1e-6:
            continue
        # доминирующая ось = нормаль грани; две другие дают координаты внутри грани
        if a[0] == m:
            f = (1 - w * w) * (1 - t * t)
            v.co.x += math.copysign(amount * f * axis_scale[0], u)
        elif a[1] == m:
            f = (1 - u * u) * (1 - t * t)
            v.co.y += math.copysign(amount * f * axis_scale[1], w)
        else:
            f = (1 - u * u) * (1 - w * w)
            v.co.z += math.copysign(amount * f * axis_scale[2], t)

    bm.to_mesh(obj.data)
    bm.free()
    obj.data.update()
    return obj


def barrel(obj, amount=0.04, axis="X", cuts=0):
    """Раздуть вдоль одной оси — для сводов и бочек: середина полнее торцов."""
    import bmesh
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    if cuts:
        bmesh.ops.subdivide_edges(bm, edges=list(bm.edges), cuts=cuts, use_grid_fill=True)
    idx = {"X": 0, "Y": 1, "Z": 2}[axis]
    vals = [v.co[idx] for v in bm.verts]
    c = (max(vals) + min(vals)) / 2
    h = max((max(vals) - min(vals)) / 2, 1e-6)
    for v in bm.verts:
        k = 1.0 - ((v.co[idx] - c) / h) ** 2       # полнее всего в середине
        for j in range(3):
            if j != idx:
                v.co[j] *= 1.0 + amount * k
    bm.to_mesh(obj.data)
    bm.free()
    obj.data.update()
    return obj


def taper(obj, amount=0.12, axis="Z", pivot="min"):
    """Сузить к одному концу. Доски и стойки в стилизации не бывают ровными
    призмами — они сходят на конус, это и читается как «нарисовано руками»."""
    import bmesh
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    i = {"X": 0, "Y": 1, "Z": 2}[axis]
    vals = [v.co[i] for v in bm.verts]
    lo, hi = min(vals), max(vals)
    rng = max(hi - lo, 1e-6)
    for v in bm.verts:
        t = (v.co[i] - lo) / rng
        if pivot == "max":
            t = 1.0 - t
        k = 1.0 - amount * t
        for j in range(3):
            if j != i:
                v.co[j] *= k
    bm.to_mesh(obj.data)
    bm.free()
    obj.data.update()
    return obj


def skew(obj, amount=0.02, axis="X", along="Z"):
    """Увести форму от прямого угла: чем выше, тем сильнее сдвиг вбок.
    Идеальный прямой угол — главный признак «компьютерной» геометрии."""
    import bmesh
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    i, j = {"X": 0, "Y": 1, "Z": 2}[axis], {"X": 0, "Y": 1, "Z": 2}[along]
    vals = [v.co[j] for v in bm.verts]
    lo, hi = min(vals), max(vals)
    rng = max(hi - lo, 1e-6)
    for v in bm.verts:
        v.co[i] += amount * ((v.co[j] - lo) / rng - 0.5) * 2.0
    bm.to_mesh(obj.data)
    bm.free()
    obj.data.update()
    return obj


def wobble(obj, amount=0.004, seed=1):
    """Сбить машинную ровность: мелкое смещение вершин по нормали.
    Величина — доли миллиметра на предмете в метр, глаз читает её как
    рукотворность, а не как брак."""
    import bmesh
    import random
    rnd = random.Random(seed)
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bm.normal_update()
    for v in bm.verts:
        v.co += v.normal * rnd.uniform(-amount, amount)
    bm.to_mesh(obj.data)
    bm.free()
    obj.data.update()
    return obj


# ─────────────────────────────────────────── конструктор пропсов (26.09.2026, ряд refs/scene-2)

def mesh_obj(name, verts, faces, coll=None):
    """Меш из списков вершин и граней, объект подключён к сцене."""
    me = bpy.data.meshes.new(name)
    me.from_pydata([tuple(v) for v in verts], [], faces)
    me.update()
    ob = bpy.data.objects.new(name, me)
    (coll or bpy.context.scene.collection).objects.link(ob)
    return ob


def lathe(name, profile, segs=12, phase=0.0, loop=False):
    """Тело вращения вокруг Z без n-gon'ов. profile — [(r, z), ...] снизу вверх.
    Точка с r=0 — полюс; открытый конец с r>0 закрывается веером к центру.
    loop=True — профиль замкнут (обруч, кольцо), полюсов нет."""
    verts, faces, rings = [], [], []
    for r, z in profile:
        if r <= 1e-6:
            rings.append(("pole", len(verts)))
            verts.append((0.0, 0.0, z))
        else:
            rings.append(("ring", len(verts)))
            for i in range(segs):
                a = phase + TAU * i / segs
                verts.append((r * math.cos(a), r * math.sin(a), z))
    if not loop:
        if rings[0][0] == "ring":
            rings.insert(0, ("pole", len(verts)))
            verts.append((0.0, 0.0, profile[0][1]))
        if rings[-1][0] == "ring":
            rings.append(("pole", len(verts)))
            verts.append((0.0, 0.0, profile[-1][1]))
    pairs = list(zip(rings, rings[1:]))
    if loop:
        pairs.append((rings[-1], rings[0]))
    for (ka, a), (kb, b) in pairs:
        for i in range(segs):
            j = (i + 1) % segs
            if ka == "ring" and kb == "ring":
                faces.append((a + i, a + j, b + j, b + i))
            elif ka == "pole" and kb == "ring":
                faces.append((a, b + j, b + i))
            elif ka == "ring" and kb == "pole":
                faces.append((a + i, a + j, b))
    return mesh_obj(name, verts, faces)


def tube(name, pts, radius, sides=6, radius_fn=None):
    """Трубка по ломаной (канат, дуга, лоза): кольца в рамке параллельного переноса,
    торцы веером. radius_fn(i) — радиус по индексу точки (витки каната)."""
    pts = [Vector(p) for p in pts]
    n = len(pts)
    tans = []
    for i in range(n):
        t = (pts[1] - pts[0]) if i == 0 else (pts[-1] - pts[-2]) if i == n - 1 else (pts[i + 1] - pts[i - 1])
        tans.append(t.normalized())
    t0 = tans[0]
    ref = Vector((0, 0, 1)) if abs(t0.z) < 0.9 else Vector((1, 0, 0))
    nrm = (ref - t0 * ref.dot(t0)).normalized()
    verts, faces = [], []
    for i, (p, t) in enumerate(zip(pts, tans)):
        if i:
            nrm = (nrm - t * nrm.dot(t)).normalized()
        bn = t.cross(nrm)
        r = radius if radius_fn is None else radius_fn(i)
        for k in range(sides):
            a = TAU * k / sides
            verts.append(p + nrm * (r * math.cos(a)) + bn * (r * math.sin(a)))
    for i in range(n - 1):
        a, b = i * sides, (i + 1) * sides
        for k in range(sides):
            j = (k + 1) % sides
            faces.append((a + k, a + j, b + j, b + k))
    c0 = len(verts); verts.append(pts[0])
    c1 = len(verts); verts.append(pts[-1])
    base = (n - 1) * sides
    for k in range(sides):
        j = (k + 1) % sides
        faces.append((c0, j, k))
        faces.append((c1, base + k, base + j))
    return mesh_obj(name, verts, faces)


def helix(cx, cy, r, z0, z1, turns, spt=12, phase=0.0):
    n = int(turns * spt) + 1
    return [(cx + r * math.cos(phase + TAU * turns * i / (n - 1)),
             cy + r * math.sin(phase + TAU * turns * i / (n - 1)),
             z0 + (z1 - z0) * i / (n - 1)) for i in range(n)]


def box(name, size, loc=(0, 0, 0), rot=(0, 0, 0), mat=None, chamfer=0.008):
    """Брусок с применённым масштабом и фаской в 1 сегмент (доски, балки, пластины)."""
    ob = cube(name, size=1.0, location=loc, rotation=rot, scale=size)
    apply_transform(ob, location=False, rotation=False, scale=True)
    if chamfer:
        bevel(ob, chamfer, 1, angle=30)
        apply_mods(ob)
    if mat:
        assign(ob, mat)
    return ob


def rock(name, size=(1.0, 0.8, 0.7), seed=0, n=14, jitter=0.15, shape="ellipsoid", extra=4,
         flat_bottom=True, top_pinch=0.0, facet=10.0, mat=None, mat_side=None, side_z=0.35,
         chamfer=(0.03, 0.18)):
    """Камень-чанк low-poly: выпуклая оболочка облака точек. shape="ellipsoid" — n точек
    на эллипсоиде (спираль Фибоначчи с разбросом, радиус 1-jitter..1) — округлый валун
    с крупными гранями; shape="block" — 8 углов бруска с разбросом + extra точек —
    плита, блок, обломок. Дно плоское на z=0 (кольцо точек в плоскости дна), origin в
    центре дна. top_pinch сводит верх (клин, шпиль). facet — угол, до которого соседние
    треугольники сливаются в одну грань. mat_side — второй материал на грани с нормалью
    ниже side_z: двухтонная покраска с листа (светлый верх, серый бок)."""
    import bmesh
    import random
    rnd = random.Random(seed)
    sx, sy, sz = size
    pts = []
    if shape == "block":
        # брусок со сколотыми углами: вместо угла — три точки, сдвинутые внутрь по рёбрам
        # на случайную фаску (3–18 % габарита); дно плоское — нижние углы без фаски по z
        for cx in (-1, 1):
            for cy in (-1, 1):
                for cz in (-1, 1):
                    jx = 1 + rnd.uniform(-jitter, jitter)
                    jy = 1 + rnd.uniform(-jitter, jitter)
                    jz = 1 + rnd.uniform(-jitter, jitter)
                    if cz < 0 and flat_bottom:
                        jz = 1.0
                    if cz > 0 and top_pinch:
                        jx *= (1 - top_pinch)
                        jy *= (1 - top_pinch)
                    X, Y, Z = cx * sx / 2 * jx, cy * sy / 2 * jy, cz * sz / 2 * jz
                    bx, by, bz = (rnd.uniform(*chamfer) * s for s in (sx, sy, sz))
                    if cz < 0 and flat_bottom:
                        bz = 0.0
                    pts.append(Vector((X - cx * bx, Y, Z)))
                    pts.append(Vector((X, Y - cy * by, Z)))
                    pts.append(Vector((X, Y, Z - cz * bz)))
        for _ in range(extra):
            d = Vector((rnd.uniform(-1, 1), rnd.uniform(-1, 1), rnd.uniform(-0.2, 1))).normalized()
            k = 1.0 + rnd.uniform(0.0, 0.10)
            pts.append(Vector((d.x * sx / 2 * k, d.y * sy / 2 * k, d.z * sz / 2 * k)))
    else:
        golden = math.pi * (3 - math.sqrt(5))
        for i in range(n):
            z = 1 - 2 * (i + 0.5) / n + rnd.uniform(-0.12, 0.12)
            z = max(-1.0, min(1.0, z))
            r = math.sqrt(max(0.0, 1 - z * z))
            a = golden * i + rnd.uniform(-0.45, 0.45)
            d = Vector((r * math.cos(a), r * math.sin(a), z))
            k = rnd.uniform(1 - jitter, 1.0)
            p = Vector((d.x * sx / 2 * k, d.y * sy / 2 * k, d.z * sz / 2 * k))
            if top_pinch and d.z > 0:
                p.x *= (1 - top_pinch * d.z)
                p.y *= (1 - top_pinch * d.z)
            pts.append(p)
    if flat_bottom:
        for p in pts:
            p.z = max(p.z, -sz / 2)
        for i in range(6):
            a = TAU * i / 6 + rnd.uniform(-0.25, 0.25)
            k = rnd.uniform(0.7, 0.9)
            pts.append(Vector((math.cos(a) * sx / 2 * k, math.sin(a) * sy / 2 * k, -sz / 2)))
    bm = bmesh.new()
    for p in pts:
        bm.verts.new(p)
    res = bmesh.ops.convex_hull(bm, input=bm.verts[:])
    gone = list(dict.fromkeys(g for key in ("geom_interior", "geom_unused") for g in res.get(key, [])
                              if isinstance(g, bmesh.types.BMVert) and g.is_valid))
    if gone:
        bmesh.ops.delete(bm, geom=gone, context="VERTS")
    bmesh.ops.dissolve_limit(bm, angle_limit=rad(facet), verts=bm.verts[:], edges=bm.edges[:])
    big = [f for f in bm.faces if len(f.verts) > 4]
    if big:
        bmesh.ops.triangulate(bm, faces=big)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    bm.normal_update()
    zmin = min(v.co.z for v in bm.verts)
    for v in bm.verts:
        v.co.z -= zmin
    if mat_side:
        for f in bm.faces:
            f.material_index = 1 if f.normal.z < side_z else 0
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    me.update()
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    if mat:
        me.materials.append(mat)
        if mat_side:
            me.materials.append(mat_side)
    return ob


def prop_finish(parts, name, x=0.0, y=0.0, coll=None, rot=None):
    """Слить части в один меш, origin в центр дна, поставить на z=0 в точку (x, y)."""
    import bmesh
    for p in parts:
        flat(p)
        apply_transform(p, location=False, rotation=True, scale=True)
    ob = join(parts, name=name) if len(parts) > 1 else parts[0]
    ob.name = name
    ob.data.name = name
    if rot is not None:
        ob.rotation_euler = rot
        apply_transform(ob, location=False, rotation=True, scale=True)
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    bm.to_mesh(ob.data)
    bm.free()
    b = bbox(ob)
    bpy.context.scene.cursor.location = (b["center"][0], b["center"][1], b["min"][2])
    set_origin(ob, mode="ORIGIN_CURSOR")
    ob.location = (x, y, 0.0)
    if coll is not None:
        move_to(ob, coll)
    return ob


def matte_world(bg="#d8d3cb", light=0.55, strength=0.40):
    """Мир для матовых превью: фон только для камеры (Light Path), свет — ровный серый."""
    w = bpy.data.worlds.get("World") or bpy.data.worlds.new("World")
    bpy.context.scene.world = w
    w.use_nodes = True
    nt = w.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputWorld")
    mix = nt.nodes.new("ShaderNodeMixShader")
    lp = nt.nodes.new("ShaderNodeLightPath")
    bc = nt.nodes.new("ShaderNodeBackground")
    bc.inputs[0].default_value = (*srgb(bg), 1.0)
    bc.inputs[1].default_value = 1.0
    ba = nt.nodes.new("ShaderNodeBackground")
    ba.inputs[0].default_value = (light, light, light, 1.0)
    ba.inputs[1].default_value = strength
    nt.links.new(lp.outputs["Is Camera Ray"], mix.inputs["Fac"])
    nt.links.new(ba.outputs[0], mix.inputs[1])
    nt.links.new(bc.outputs[0], mix.inputs[2])
    nt.links.new(mix.outputs[0], out.inputs["Surface"])
    return w


def _solo(props, ob):
    for o in props:
        o.hide_render = (o.name != ob.name)      # `is` для RNA-обёрток ненадёжен


def peek_each(props, out_dir, refs=None, views=("front", "q34", "side")):
    """Лист по каждому пропсу: [референс] + ракурсы, соседи на время кадра скрыты.
    refs — {имя объекта: путь к кусочку референса}. Возвращает строки со статистикой."""
    os.makedirs(out_dir, exist_ok=True)
    lines = []
    for ob in props:
        _solo(props, ob)
        ref = (refs or {}).get(ob.name)
        r = peek(os.path.join(out_dir, f"{ob.name}.png"), views=views, ref=ref, objects=[ob],
                 cols=len(views) + (1 if ref else 0))
        b = bbox(ob)
        lines.append("%-18s %5d трис  %.2f × %.2f × %.2f м" % (ob.name, r["tris"], *b["size"]))
    for o in props:
        o.hide_render = False
    return lines


def relight(center, d, key=420.0, fill=110.0, rim=320.0):
    """Трёхточка под предмет: энергии масштабируются квадратом дистанции от базовых 4.5 м."""
    for nm in ("Key", "Fill", "Rim"):
        o = bpy.data.objects.get(nm)
        if o:
            bpy.data.objects.remove(o, do_unlink=True)
    k = (d / 4.5) ** 2
    return three_point(target=tuple(center), distance=d, height=d * 0.65, key=key * k, fill=fill * k, rim=rim * k)


def prop_previews(props, out_dir, prefix="look_", res=(900, 700), samples=32, low_elev=38, elev=22):
    """Матовые превью EEVEE по каждому пропсу (свет и камера по его радиусу)."""
    os.makedirs(out_dir, exist_ok=True)
    setup_render("BLENDER_EEVEE", samples=samples, res=res, view_transform="Standard")
    out = []
    for ob in props:
        _solo(props, ob)
        b = bbox(ob)
        c = Vector(b["center"])
        r = max(Vector(b["size"]).length / 2.0, 0.3)
        relight(c, r * 3.2 + 0.6)
        orbit_camera(35, low_elev if b["size"][2] < 0.3 else elev, distance=r * 3.9 + 0.2, target=tuple(c), lens=55.0)
        out.append(render(os.path.join(out_dir, f"{prefix}{ob.name}.png")))
    for o in props:
        o.hide_render = False
    return out


def prop_export(props, out_dir, all_name=None):
    """GLB по предмету (каждый в нуле координат, без Draco, под Godot 4) + все одним файлом."""
    os.makedirs(out_dir, exist_ok=True)
    kw = dict(export_format="GLB", export_draco_mesh_compression_enable=False, export_apply=True,
              export_yup=True, export_animations=False, export_skins=False)
    out = []
    for ob in props:
        loc = tuple(ob.location)
        ob.location = (0.0, 0.0, 0.0)
        select_only(ob)
        fp = os.path.join(out_dir, f"{ob.name.lower()}.glb")
        bpy.ops.export_scene.gltf(filepath=fp, use_selection=True, **kw)
        ob.location = loc
        out.append((os.path.basename(fp), os.path.getsize(fp)))
    if all_name:
        bpy.ops.object.select_all(action="DESELECT")
        for ob in props:
            ob.select_set(True)
        fp = os.path.join(out_dir, all_name)
        bpy.ops.export_scene.gltf(filepath=fp, use_selection=True, **kw)
        out.append((all_name, os.path.getsize(fp)))
    return out


# ─────────────────────────────────────────── растительность low-poly (26.09.2026)

def leaf(name, length=0.3, width=0.12, bend=0.25, thickness=0.012, tip=0.45, mat=None):
    """Лист: широкая пластина с продольным ребром, три станции ширины (25/55/85 % длины),
    округлый кончик, растёт от начала координат вдоль +Y. bend — прогиб: середина
    поднимается на bend·L, кончик опускается обратно. Замкнутая призма из треугольников
    и квадов, без n-gon'ов."""
    L, W = length, width
    stations = [(0.25, 0.72), (0.55, 1.0), (0.85, 0.62)]
    zs = lambda t: bend * L * math.sin(math.pi * min(1.0, t * 0.95))
    top = [(0, 0, 0)]
    for t, k in stations:
        w = W * k / 2
        top += [(-w, L * t, zs(t) * 0.85), (0, L * t, zs(t)), (w, L * t, zs(t) * 0.85)]
    top.append((0, L, zs(1.0) * 0.4))
    bot = [(x, y, z - thickness) for (x, y, z) in top]
    verts = top + bot
    m = len(top)
    faces = []
    # верх: веер от основания, полосы между станциями, веер к кончику
    faces += [(0, 1, 2), (0, 2, 3)]
    for s_ in range(2):
        a_, b_ = 1 + s_ * 3, 4 + s_ * 3
        faces += [(a_, b_, b_ + 1, a_ + 1), (a_ + 1, b_ + 1, b_ + 2, a_ + 2)]
    faces += [(7, 10, 8), (8, 10, 9)]
    # низ (обратный обход)
    faces += [(m, m + 2, m + 1), (m, m + 3, m + 2)]
    for s_ in range(2):
        a_, b_ = m + 1 + s_ * 3, m + 4 + s_ * 3
        faces += [(a_, a_ + 1, b_ + 1, b_), (a_ + 1, a_ + 2, b_ + 2, b_ + 1)]
    faces += [(m + 7, m + 8, m + 10), (m + 8, m + 9, m + 10)]
    # кромка
    left = [0, 1, 4, 7, 10]
    right = [0, 3, 6, 9, 10]
    for i in range(4):
        faces.append((left[i], m + left[i], m + left[i + 1], left[i + 1]))
        faces.append((right[i], right[i + 1], m + right[i + 1], m + right[i]))
    ob = mesh_obj(name, verts, faces)
    if mat:
        assign(ob, mat)
    return ob


def blade(name, height=0.4, width=0.05, lean=0.15, thickness=0.008, mat=None):
    """Лезвие травы: тонкая треугольная призма, кончик уведён вбок на lean."""
    verts = [(-width / 2, 0, 0), (width / 2, 0, 0), (lean * 0.3, 0, height * 0.55), (lean, 0.0, height),
             (-width / 2, -thickness, 0), (width / 2, -thickness, 0), (lean * 0.3, -thickness, height * 0.55), (lean, -thickness, height)]
    faces = [(0, 1, 2), (1, 3, 2), (0, 2, 3), (4, 6, 5), (5, 6, 7), (4, 7, 6),
             (0, 4, 5, 1), (1, 5, 7, 3), (3, 7, 4, 0)]
    ob = mesh_obj(name, verts, faces)
    if mat:
        assign(ob, mat)
    return ob


def grass_tuft(name, n=9, height=0.5, spread=0.12, seed=0, mat=None, loc=(0, 0, 0)):
    """Пучок травы: n лезвий из одной точки веером во все стороны, разной высоты."""
    import random
    rnd = random.Random(seed)
    parts = []
    for i in range(n):
        a = TAU * i / n + rnd.uniform(-0.3, 0.3)
        h = height * rnd.uniform(0.6, 1.0)
        b = blade(f"{name}_b{i}", h, width=0.05 + 0.08 * h, lean=rnd.uniform(0.1, 0.3) * h, mat=mat)
        b.location = (loc[0] + math.cos(a) * spread * rnd.uniform(0.2, 1.0),
                      loc[1] + math.sin(a) * spread * rnd.uniform(0.2, 1.0), loc[2])
        b.rotation_euler = (rad(rnd.uniform(-8, 8)), rad(-rnd.uniform(15, 40)), a)
        parts.append(b)
    return parts


def leaf_bush(name, n=12, length=0.3, width=0.12, tiers=2, seed=0, mat=None, loc=(0, 0, 0), spread=0.05, tilt0=18.0, tilt_span=52.0):
    """Куст куполом: tiers ярусов листьев веером от центра; нижний ярус лежит почти горизонтально,
    верхние короче, выше и круче (до ~70°), так что силуэт — полусфера."""
    import random
    rnd = random.Random(seed)
    parts = []
    per = max(1, n // tiers)
    for t in range(tiers):
        u = t / max(1, tiers - 1) if tiers > 1 else 0.0
        k = 1.0 - 0.3 * u
        tilt = tilt0 + tilt_span * u
        for i in range(per):
            a = TAU * i / per + rnd.uniform(-0.25, 0.25) + t * 0.5
            lf = leaf(f"{name}_l{t}{i}", length * k * rnd.uniform(0.85, 1.05), width * k, bend=0.22 + 0.1 * u, mat=mat)
            lf.location = (loc[0] + math.cos(a) * spread * (1 - 0.5 * u), loc[1] + math.sin(a) * spread * (1 - 0.5 * u), loc[2] + 0.22 * length * u)
            lf.rotation_euler = (rad(tilt + rnd.uniform(-8, 8)), 0, a - math.pi / 2)
            parts.append(lf)
    return parts


def vine(name, pts, radius=0.012, leaf_every=2, leaf_len=0.14, mat_stem=None, mat_leaf=None, seed=0, per_node=1):
    """Лоза: трубка по точкам + листья через каждые leaf_every точек. per_node=1 — лист
    попеременно по сторонам; per_node=2 — по листу с обеих сторон (пышный плющ)."""
    import random
    rnd = random.Random(seed)
    parts = [tube(f"{name}_stem", pts, radius, sides=5)]
    if mat_stem:
        assign(parts[0], mat_stem)
    P = [Vector(p) for p in pts]
    for i in range(1, len(P) - 1, leaf_every):
        d = (P[i + 1] - P[i - 1]).normalized()
        sides = (1, -1) if per_node == 2 else ((1,) if (i // leaf_every) % 2 == 0 else (-1,))
        for side in sides:
            lf = leaf(f"{name}_leaf{i}{side}", leaf_len * rnd.uniform(0.8, 1.1), leaf_len * 0.65, bend=0.2, mat=mat_leaf)
            lf.location = P[i]
            n = Vector((-d.y, d.x, 0)).normalized() * side
            ang = math.atan2(n.y, n.x) - math.pi / 2
            lf.rotation_euler = (rad(rnd.uniform(-15, 15)), rad(rnd.uniform(-20, 20)), ang)
            parts.append(lf)
    return parts
