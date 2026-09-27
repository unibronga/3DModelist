# Demo scene for the README screenshots (docs/screenshot*.png).
# Run in a workspace: tools/bl scenes/captain_chest.py --peek; STAGE 1-4 gives the four versions.
# Сундук капитана: корпус из досок, железные полосы, выпуклая крышка на петлях,
# внутри золото с камнями, монеты рассыпаны по песку. STAGE — шаг постройки.
STAGE = 4
import bmesh
import random

reset_scene()
rnd = random.Random(7)


def M(name, hexc):
    return pbr(name, base_color=srgb(hexc), roughness=1.0)


BLOCK = M("Block", "#b8b2a8")
WOOD = [M("Wood_A", "#8a5a2c"), M("Wood_B", "#7b4f27"), M("Wood_C", "#98663a")] if STAGE >= 2 else [BLOCK]
DARK = M("Wood_Inner", "#3a2616") if STAGE >= 2 else BLOCK
IRON = M("Iron", "#4b4f58") if STAGE >= 2 else BLOCK
GOLD, GOLD2 = M("Gold", "#e8b73c"), M("Gold_Dark", "#c8942a")
RUBY, SAPH, EMER = M("Ruby", "#d23b4b"), M("Sapphire", "#3b6fd6"), M("Emerald", "#2fa36b")
SAND, STONE, GRASS = M("Sand", "#dcc594"), M("Stone", "#8e8a82"), M("Grass", "#7fae45")

W, D, H = 0.90, 0.56, 0.42      # корпус: ширина X, глубина Y, высота Z
R = D / 2                        # радиус выпуклой крышки
T = 0.03                         # толщина досок
LIFT = 0.04 if STAGE >= 4 else 0.0   # сундук стоит на песке


def box(name, sx, sy, sz, x, y, z, mat, rot=(0, 0, 0)):
    o = cube(name, size=1, location=(x, y, z + LIFT), rotation=rot, scale=(sx, sy, sz))
    assign(o, mat)
    return o


def half_disc(name, x, thick, mat, segs=6):
    """Торец крышки: полукруг в плоскости YZ толщиной thick по X."""
    me = bpy.data.meshes.new(name)
    bm = bmesh.new()
    arc = [(R * math.cos(math.pi * i / segs), H + LIFT + R * math.sin(math.pi * i / segs)) for i in range(segs + 1)]
    a = [bm.verts.new((x - thick / 2, y, z)) for y, z in arc]
    b = [bm.verts.new((x + thick / 2, y, z)) for y, z in arc]
    bm.faces.new(a[::-1])
    bm.faces.new(b)
    for i in range(segs):
        bm.faces.new((a[i], a[i + 1], b[i + 1], b[i]))
    bm.faces.new((a[segs], a[0], b[0], b[segs]))
    bm.normal_update()
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(me)
    bm.free()
    o = bpy.data.objects.new(name, me)
    bpy.context.collection.objects.link(o)
    assign(o, mat)
    return o


def group(parts, name):
    """Слить части в один объект с прямыми осями: иначе габариты берутся с рамки первой части."""
    o = join(parts, name)
    apply_transform(o, rotation=True, scale=True)
    return o


# ── корпус ────────────────────────────────────────────────────────────────
if STAGE == 1:
    body = [box("Body", W, D, H, 0, 0, H / 2, BLOCK)]
else:
    body = []
    ph = H / 3
    for i in range(3):
        z = ph * i + ph / 2
        for side, y in (("F", -D / 2 + T / 2), ("B", D / 2 - T / 2)):
            body.append(box(f"Plank_{side}{i}", W - 0.004, T, ph - 0.012, rnd.uniform(-0.003, 0.003), y, z, rnd.choice(WOOD)))
        for side, x in (("L", -W / 2 + T / 2), ("R", W / 2 - T / 2)):
            body.append(box(f"Plank_{side}{i}", T, D - 2 * T, ph - 0.012, x, 0, z, rnd.choice(WOOD)))
    body.append(box("Inner", W - 2 * T - 0.002, D - 2 * T - 0.002, H - 0.02, 0, 0, (H - 0.02) / 2, DARK))
group(body, "Body")

# ── железо корпуса: полосы, уголки, обод ──────────────────────────────────
if STAGE >= 2:
    iron = []
    for x in (-0.28, 0.28):
        for y in (-D / 2 - 0.006, D / 2 + 0.006):
            iron.append(box("Band", 0.06, 0.012, H, x, y, H / 2, IRON))
    for sx in (-1, 1):
        for sy in (-1, 1):
            iron.append(box("Corner", 0.05, 0.05, H + 0.004, sx * (W / 2 - 0.02), sy * (D / 2 - 0.02), H / 2, IRON))
    for y in (-D / 2 - 0.007, D / 2 + 0.007):
        iron.append(box("Rim", W + 0.012, 0.014, 0.035, 0, y, H - 0.0175, IRON))
    for x in (-W / 2 - 0.007, W / 2 + 0.007):
        iron.append(box("Rim", 0.014, D + 0.012, 0.035, x, 0, H - 0.0175, IRON))
    group(iron, "Iron_Bands")

# ── крышка: доски по дуге, торцы, полосы; петли сзади ─────────────────────
lid = []
if STAGE == 1:
    c = cylinder("Lid", radius=R, depth=W, verts=12, location=(0, 0, H + LIFT), rotation=(0, math.pi / 2, 0))
    assign(c, BLOCK)
    lid.append(c)
else:
    n = 6
    for i in range(n):
        a0, a1 = math.pi * i / n, math.pi * (i + 1) / n
        am = (a0 + a1) / 2
        w = 2 * R * math.sin((a1 - a0) / 2)
        r = R * math.cos((a1 - a0) / 2) - T / 2
        lid.append(box(f"LidPlank{i}", W - 0.004, w + 0.004, T, 0, r * math.cos(am), H + r * math.sin(am), rnd.choice(WOOD), rot=(am - math.pi / 2, 0, 0)))
    for x in (-W / 2 + T / 2, W / 2 - T / 2):
        lid.append(half_disc("LidEnd", x, T, rnd.choice(WOOD)))
    for x in (-0.28, 0.28):
        pts = [(x, (R + 0.006) * math.cos(math.pi * i / 12), H + LIFT + (R + 0.006) * math.sin(math.pi * i / 12)) for i in range(13)]
        t_ = tube("LidBand", pts, 0.013, sides=4)
        assign(t_, IRON)
        lid.append(t_)
    if STAGE >= 4:
        lid.append(box("Hasp", 0.09, 0.012, 0.11, 0, -R - 0.008, H - 0.03, GOLD))
lid_obj = group(lid, "Lid")
bpy.context.scene.cursor.location = (0, D / 2, H + LIFT)
set_origin(lid_obj, "ORIGIN_CURSOR")
if STAGE >= 3:
    lid_obj.rotation_euler.x = math.radians(-108)

# ── сокровище: золото горкой, монеты, камни ───────────────────────────────
if STAGE >= 3:
    pile = ico("Treasure", radius=1.0, subdiv=2, location=(0, 0, H - 0.05 + LIFT))
    pile.scale = (W / 2 - 0.06, D / 2 - 0.06, 0.13)
    assign(pile, GOLD)
    coins = []

    def coin(x, y, z, tilt=25):
        c = cylinder("Coin", radius=0.032, depth=0.007, verts=8, location=(x, y, z),
                     rotation=(math.radians(rnd.uniform(-tilt, tilt)), math.radians(rnd.uniform(-tilt, tilt)), rnd.uniform(0, 6.3)))
        assign(c, GOLD if rnd.random() < 0.6 else GOLD2)
        coins.append(c)

    rx, ry = W / 2 - 0.08, D / 2 - 0.08
    for _ in range(46):
        u, v = rnd.uniform(-1, 1), rnd.uniform(-1, 1)
        if u * u + v * v > 0.9:
            continue
        coin(u * rx, v * ry, H - 0.05 + 0.13 * math.sqrt(max(0.0, 1 - u * u - v * v)) + 0.004 + LIFT)
    if STAGE >= 4:
        for _ in range(16):                          # рассыпались перед сундуком
            coin(rnd.uniform(-0.55, 0.45), rnd.uniform(-0.75, -0.36), LIFT + 0.004, tilt=6)
        for sx, sy, k in ((0.38, -0.52, 5), (-0.44, -0.46, 3)):   # стопки
            for j in range(k):
                coin(sx + rnd.uniform(-0.004, 0.004), sy + rnd.uniform(-0.004, 0.004), LIFT + 0.004 + j * 0.0075, tilt=3)
    group(coins, "Coins")
    for name, mat, (x, y) in (("Ruby", RUBY, (-0.12, -0.04)), ("Sapphire", SAPH, (0.16, 0.05)), ("Emerald", EMER, (0.02, 0.1))):
        g = ico(name, radius=0.04, subdiv=1, location=(x, y, H + 0.07 + LIFT))
        assign(g, mat)

# ── замок, ручки, песок и камни ───────────────────────────────────────────
if STAGE >= 4:
    lock = [box("Lock", 0.11, 0.022, 0.09, 0, -D / 2 - 0.013, H - 0.075, GOLD),
            box("Keyhole", 0.016, 0.004, 0.036, 0, -D / 2 - 0.026, H - 0.075, DARK)]
    group(lock, "Lock")
    handles = []
    for sx in (-1, 1):
        ring = torus("Handle", major=0.055, minor=0.01, major_seg=10, minor_seg=5, location=(sx * (W / 2 + 0.03), 0, H * 0.58 + LIFT))
        ring.rotation_euler.y = math.pi / 2
        assign(ring, IRON)
        handles += [ring, box("HandleMount", 0.02, 0.09, 0.04, sx * (W / 2 + 0.008), 0, H * 0.58 + 0.05, IRON)]
    group(handles, "Handles")

    sand = cylinder("Sand", radius=1.0, depth=0.04, verts=11, location=(0, -0.08, 0.02))
    sand.scale = (1.05, 0.82, 1.0)
    apply_transform(sand)
    wobble(sand, amount=0.012, seed=4)
    assign(sand, SAND)
    rocks = []
    for i, (size, x, y) in enumerate((((0.24, 0.2, 0.15), 0.72, 0.18), ((0.14, 0.12, 0.09), 0.62, 0.42), ((0.18, 0.15, 0.1), -0.78, -0.12))):
        rk = rock(f"Rock_{i}", size=size, seed=11 + i, mat=STONE)
        rk.location = (x, y, 0.035)
        rocks.append(rk)
    group(rocks, "Rocks")
    tufts = [blade for i, (h, x, y) in enumerate(((0.18, -0.66, 0.34), (0.14, 0.86, -0.12), (0.12, -0.52, -0.62)))
             for blade in grass_tuft(f"Grass_{i}", n=7, height=h, seed=20 + i, mat=GRASS, loc=(x, y, 0.035))]
    group(tufts, "Grass")

result = scene_stats()
