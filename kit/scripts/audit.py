# -*- coding: utf-8 -*-
"""Аудит сцены перед сдачей. Запуск: tools/bl scripts/audit.py"""

import re

issues = []
report = []

SANE_MIN, SANE_MAX = 0.001, 200.0          # разумные габариты в метрах
GENERIC = re.compile(r"^(Cube|Sphere|Plane|Cylinder|Cone|Torus|Icosphere|Circle|Text|Empty)(\.\d+)?$")

deps = bpy.context.evaluated_depsgraph_get()
total_tris = 0

for obj in bpy.data.objects:
    if obj.type != "MESH":
        continue

    mesh = obj.data
    row = {"name": obj.name}

    # полигонаж с учётом модификаторов
    try:
        ev = obj.evaluated_get(deps).to_mesh()
        ev.calc_loop_triangles()
        row["tris"] = len(ev.loop_triangles)
        total_tris += row["tris"]
        obj.evaluated_get(deps).to_mesh_clear()
    except Exception:
        row["tris"] = len(mesh.polygons) * 2

    # неприменённый масштаб
    sx, sy, sz = obj.scale
    if abs(sx - 1) > 1e-4 or abs(sy - 1) > 1e-4 or abs(sz - 1) > 1e-4:
        row["scale"] = (round(sx, 4), round(sy, 4), round(sz, 4))
        issues.append(f"{obj.name}: масштаб не применён {row['scale']} — apply_transform(obj)")

    # n-gon'ы
    ngons = sum(1 for p in mesh.polygons if len(p.vertices) > 4)
    if ngons:
        row["ngons"] = ngons
        issues.append(f"{obj.name}: {ngons} n-gon'ов — порвутся при subsurf/деформации")

    # свободные (несшитые) рёбра — признак дырявой сетки
    loose = sum(1 for e in mesh.edges if e.is_loose)
    open_edges = sum(1 for e in mesh.edges if len([p for p in mesh.polygons if e.key[0] in p.vertices and e.key[1] in p.vertices]) < 2) if len(mesh.polygons) < 4000 else None
    if loose:
        row["loose_edges"] = loose
        issues.append(f"{obj.name}: {loose} висячих рёбер")

    # дубли вершин
    coords = {}
    dups = 0
    for v in mesh.vertices:
        key = (round(v.co.x, 5), round(v.co.y, 5), round(v.co.z, 5))
        if key in coords:
            dups += 1
        coords[key] = 1
    if dups:
        row["dup_verts"] = dups
        issues.append(f"{obj.name}: {dups} совпадающих вершин — weld(obj) или Merge by Distance")

    # габариты и масштаб
    box = bbox(obj)
    size = tuple(round(v, 4) for v in box["size"])
    row["size_m"] = size
    biggest = max(size)
    if biggest > SANE_MAX:
        issues.append(f"{obj.name}: габарит {biggest:.1f} м — модель размером с здание, проверь масштаб")
    elif biggest < SANE_MIN:
        issues.append(f"{obj.name}: габарит {biggest:.5f} м — модель микроскопическая, проверь масштаб")

    # утоплен ниже пола
    if box["min"][2] < -0.001:
        row["below_floor"] = round(box["min"][2], 4)
        issues.append(f"{obj.name}: уходит под пол на {abs(box['min'][2]):.3f} м — on_floor(obj)?")

    # генерическое имя
    if GENERIC.match(obj.name):
        issues.append(f"{obj.name}: имя по умолчанию — переименуй по смыслу")

    # материалы
    mats = [m.name for m in mesh.materials if m]
    row["materials"] = mats
    if not mats:
        issues.append(f"{obj.name}: без материала — на рендере будет серый дефолт")

    report.append(row)

# осиротевшие датаблоки
orphans = {}
for label, coll in (("meshes", bpy.data.meshes), ("materials", bpy.data.materials),
                    ("images", bpy.data.images), ("node_groups", bpy.data.node_groups)):
    n = sum(1 for b in coll if b.users == 0)
    if n:
        orphans[label] = n
if orphans:
    issues.append(f"осиротевшие датаблоки {orphans} — purge()")

# сцена целиком
scn = bpy.context.scene
if scn.camera is None:
    issues.append("в сцене нет камеры — рендерить нечем")
if not any(o.type == "LIGHT" for o in bpy.data.objects):
    issues.append("в сцене нет источников света — рендер будет чёрным")

print(f"объектов-мешей: {len(report)}, треугольников (с модификаторами): {total_tris}")
if issues:
    print(f"\nЗАМЕЧАНИЙ: {len(issues)}")
    for i in issues:
        print("  •", i)
else:
    print("\nзамечаний нет — сцена к сдаче готова")

result = {"total_tris": total_tris, "objects": report, "issues": issues,
          "engine": scn.render.engine, "camera": scn.camera.name if scn.camera else None}
