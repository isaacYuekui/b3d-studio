"""Generates examples/forest-supercar.b3d-script.json.

An original wedge-shaped supercar (not modelled on any real brand) built from
lofted cross-sections, posed on a gravel track in a young pine forest.
Run: python3 examples/generators/forest_supercar.py
"""
import json
import math
import random
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
catalog = json.loads((ROOT / "public/library/catalog.json").read_text())
SIZE = {m["id"]: m for m in catalog["models"]}
random.seed(11)


def lift(asset, z=0.0, s=1.0):
    """Ground models whose origin isn't at their base (catalog 'bottom' is negative)."""
    return round(z - SIZE[asset]["bottom"] * s, 3)


# ----------------------------------------------------------------- car body
L, X0, X1 = 4.5, -2.25, 2.25  # length along +X (front at +X)


def interp(pts, x):
    for (xa, va), (xb, vb) in zip(pts, pts[1:]):
        if xa <= x <= xb:
            t = (x - xa) / (xb - xa)
            t = t * t * (3 - 2 * t)  # smoothstep for soft transitions
            return va + (vb - va) * t
    return pts[0][1] if x < pts[0][0] else pts[-1][1]


TOP = [(-2.25, 0.86), (-1.85, 0.93), (-0.75, 1.13), (-0.05, 1.16), (0.9, 0.80), (1.7, 0.62), (2.1, 0.50), (2.25, 0.42)]
BOTTOM = [(-2.25, 0.30), (-1.9, 0.20), (1.95, 0.21), (2.25, 0.30)]
WIDTH = [(-2.25, 1.80), (-1.3, 2.02), (0.0, 1.96), (1.3, 1.94), (2.0, 1.78), (2.25, 1.42)]
# How much the upper part narrows (cabin tumblehome): strong over the cabin, light elsewhere.
TAPER = [(-2.25, 0.12), (-1.0, 0.18), (-0.6, 0.42), (0.6, 0.42), (1.0, 0.16), (2.25, 0.10)]

SECTIONS, RING = 44, 28


def section(x, inflate=0.0, zmin_frac=0.0):
    top, bot, w, k = interp(TOP, x), interp(BOTTOM, x), interp(WIDTH, x), interp(TAPER, x)
    cz, hz, hw = (top + bot) / 2, (top - bot) / 2 + inflate, w / 2 + inflate
    pts = []
    n = 3.2  # superellipse exponent: boxy but rounded
    for i in range(RING):
        a = -math.pi / 2 + math.pi * 2 * i / RING
        c, s = math.cos(a), math.sin(a)
        y = hw * math.copysign(abs(c) ** (2 / n), c)
        z = hz * math.copysign(abs(s) ** (2 / n), s)
        frac = max(0.0, z / hz)
        y *= 1 - k * frac ** 1.6
        pts.append([round(x, 4), round(y, 4), round(cz + z, 4)])
    return pts


def loft(xs, sect):
    verts, faces = [], []
    for x in xs:
        verts += sect(x)
    for j in range(len(xs) - 1):
        for i in range(RING):
            a, b = j * RING + i, j * RING + (i + 1) % RING
            # CCW seen from outside (verified by the normal check in the test suite)
            faces.append([a, b, b + RING, a + RING])
    # caps
    rear_c, front_c = len(verts), len(verts) + 1
    verts.append([xs[0], 0, sum(v[2] for v in verts[:RING]) / RING])
    last = (len(xs) - 1) * RING
    verts.append([xs[-1], 0, sum(v[2] for v in verts[last:last + RING]) / RING])
    for i in range(RING):
        faces.append([rear_c, i, (i + 1) % RING])
        faces.append([front_c, last + (i + 1) % RING, last + i])
    return {"vertices": verts, "faces": faces, "smooth": True}


xs = [X0 + L * (j / (SECTIONS - 1)) for j in range(SECTIONS)]
body = loft(xs, section)

# Glasshouse: the upper band of the cabin, slightly inflated so it sits over the paint.
gx = [-0.78 + (0.95 + 0.78) * j / 15 for j in range(16)]


def glass_section(x):
    pts = section(x, inflate=0.012)
    top, bot = interp(TOP, x), interp(BOTTOM, x)
    sill = bot + (top - bot) * 0.62
    return [[p[0], p[1], max(p[2], sill)] for p in pts]


glass = loft(gx, glass_section)

C = []


def add(**kw):
    C.append({"type": "add", **kw})


paint = {"baseColor": "#c4320a", "metallic": 0.85, "roughness": 0.22}
carbon = {"baseColor": "#141516", "metallic": 0.4, "roughness": 0.45}
rubber = {"baseColor": "#151515", "roughness": 0.85}
alloy = {"baseColor": "#4d525a", "metallic": 1, "roughness": 0.32}

# ----------------------------------------------------------------- world
C.append({"type": "setWorld", "world": {"hdri": "kloofendal_48d_partly_cloudy_puresky", "strength": 1.0, "rotation": 120,
                                       "background": "hdri", "exposure": 1.0, "bloom": 0.1, "ao": True}})

# Ground and a gently curving gravel track (custom meshes: box UVs give real-world texture scale).
G = 90
add(primitive="mesh", name="Forest Floor", mesh={"vertices": [[-G, -G, 0], [G, -G, 0], [G, G, 0], [-G, G, 0]], "faces": [[0, 1, 2, 3]], "smooth": True},
    material={"texture": "forest_ground_04", "textureScale": 0.32, "baseColor": "#ffffff"})
road_v, road_f = [], []
N = 40
for i in range(N + 1):
    x = -45 + 90 * i / N
    yc = 1.6 * math.sin(x / 9)
    for side in (-1, 1):
        road_v.append([round(x, 3), round(yc + side * 2.4, 3), 0.012])
for i in range(N):
    a = 2 * i
    road_f.append([a, a + 2, a + 3, a + 1])
add(primitive="mesh", name="Gravel Track", mesh={"vertices": road_v, "faces": road_f, "smooth": True},
    material={"texture": "gravel", "textureScale": 0.45, "baseColor": "#e8e2d8"})

# ----------------------------------------------------------------- the car
heading = math.degrees(math.atan(1.6 / 9 * math.cos(0.5 / 9)))  # follow the track's tangent near x=0.5
add(primitive="empty", id="car", name="Supercar", transform={"position": [0.5, 1.6 * math.sin(0.5 / 9), 0], "rotation": [0, 0, round(heading, 2)]})
add(primitive="mesh", id="car_body", name="Body", parentId="car", mesh=body, material=paint)
add(primitive="mesh", name="Glass", parentId="car", mesh=glass, material={"baseColor": "#0c1116", "metallic": 0.3, "roughness": 0.04, "alpha": 0.92})
for wx, wy, tag in ((1.42, 1, "FL"), (1.42, -1, "FR"), (-1.38, 1, "RL"), (-1.38, -1, "RR")):
    r = 0.37 if wx > 0 else 0.38
    w = 0.27 if wx > 0 else 0.33
    y = wy * (0.9 - w / 2 + 0.06)
    steer = 6 if wx > 0 else 0
    add(primitive="cylinder", name=f"Tyre.{tag}", parentId="car", params={"segments": 40},
        transform={"position": [wx, y, r], "rotation": [90, 0, steer], "scale": [r, r, w / 2]}, material=rubber)
    add(primitive="cylinder", name=f"Rim.{tag}", parentId="car", params={"segments": 10},
        transform={"position": [wx, y + wy * 0.012, r], "rotation": [90, 0, steer], "scale": [r * 0.68, r * 0.68, w / 2 + 0.01]}, material=alloy)
    add(primitive="cylinder", name=f"Hub.{tag}", parentId="car", params={"segments": 6},
        transform={"position": [wx, y + wy * (w / 2 + 0.012), r], "rotation": [90, 0, steer], "scale": [0.07, 0.07, 0.012]}, material=carbon)
# lights: thin blades, emissive
for side in (-1, 1):
    add(primitive="cube", name=f"Headlight.{'L' if side > 0 else 'R'}", parentId="car",
        transform={"position": [1.98, side * 0.6, 0.58], "rotation": [0, -22, side * -18], "scale": [0.03, 0.2, 0.014]},
        material={"baseColor": "#ffffff", "emission": "#e9f2ff", "emissionStrength": 9})
add(primitive="cube", name="Taillight", parentId="car", transform={"position": [-2.255, 0, 0.74], "scale": [0.012, 0.78, 0.018]},
    material={"baseColor": "#ff2a1a", "emission": "#ff1a0a", "emissionStrength": 7})
add(primitive="cube", name="Rear Wing", parentId="car", transform={"position": [-1.95, 0, 1.03], "rotation": [0, 6, 0], "scale": [0.16, 0.86, 0.016]}, material=carbon)
for side in (-1, 1):
    add(primitive="cube", name=f"Wing Stand.{'L' if side > 0 else 'R'}", parentId="car", transform={"position": [-1.93, side * 0.55, 0.96], "scale": [0.06, 0.012, 0.06]}, material=carbon)
add(primitive="cube", name="Splitter", parentId="car", transform={"position": [2.05, 0, 0.21], "scale": [0.22, 0.82, 0.015]}, material=carbon)
add(primitive="cube", name="Diffuser", parentId="car", transform={"position": [-2.12, 0, 0.27], "scale": [0.16, 0.75, 0.05]}, material=carbon)

# ----------------------------------------------------------------- forest
CAM = [5.0, 5.6, 1.15]


def blocks_view(x, y):
    """True if a point lies near the line from the camera to the car (or behind the camera)."""
    cx, cy = CAM[0], CAM[1]
    tx, ty = 0.2, 0.0
    dx, dy = tx - cx, ty - cy
    t = ((x - cx) * dx + (y - cy) * dy) / (dx * dx + dy * dy)
    if t < -0.6:  # behind the camera
        return math.hypot(x - cx, y - cy) < 9
    px, py = cx + max(0, min(1, t)) * dx, cy + max(0, min(1, t)) * dy
    return math.hypot(x - px, y - py) < 3.5


def free(x, y):
    """Keep trees off the track, away from the car and out of the camera's view of it."""
    return abs(y - 1.6 * math.sin(x / 9)) > 4.2 and math.hypot(x - 0.5, y) > 5 and not blocks_view(x, y)


trees = []
while len(trees) < 16:
    x, y = random.uniform(-26, 26), random.uniform(-24, 24)
    if free(x, y) and all(math.hypot(x - a, y - b) > 4.5 for a, b, _ in trees):
        trees.append((x, y, random.choice(["pine_sapling_small", "fir_sapling"])))
for i, (x, y, asset) in enumerate(trees):
    s = random.uniform(3.6, 5.4)  # saplings scaled into young trees, 4.5-7 m tall
    add(primitive="model", asset=asset, name=f"Tree.{i:03d}",
        transform={"position": [round(x, 2), round(y, 2), lift(asset, 0, s)], "rotation": [0, 0, random.randint(0, 359)], "scale": [round(s, 2)] * 3})

props = [
    ("rock_moss_set_02", 0.55, (-9, 7)), ("rock_moss_set_01", 0.5, (11, -8)), ("root_cluster_01", 1.0, (7, 6.5)),
    ("dead_tree_trunk_02", 1.0, (-6, -6.5)), ("tree_stump_02", 1.0, (5.5, -5.8)), ("tree_stump_01", 0.9, (-12, -4.8)),
    ("boulder_01", 1.1, (-4.6, 5.2)), ("fern_02", 1.2, (3.2, 5.0)), ("fern_02", 1.0, (-2.4, -4.9)), ("fern_02", 1.1, (9.5, 4.4)),
    ("grass_medium_01", 1.0, (0.0, 4.3)), ("grass_medium_01", 1.0, (-7.5, -4.2)), ("grass_medium_02", 1.3, (6.4, 4.6)),
    ("grass_medium_02", 1.2, (-3.8, 4.4)), ("nettle_plant", 1.2, (1.8, -4.4)), ("celandine_01", 1.0, (-1.0, 5.6)),
    ("dry_branches_medium_01", 1.0, (4.6, -4.6)), ("rock_07", 3.0, (2.6, -3.6)), ("rock_07", 2.4, (-5.2, 3.7)),
]
for i, (asset, s, (x, y)) in enumerate(props):
    add(primitive="model", asset=asset, name=f"{SIZE[asset]['name']}.{i:02d}",
        transform={"position": [x, y, lift(asset, 0, s)], "rotation": [0, 0, random.randint(0, 359)], "scale": [s, s, s]})

# Late-afternoon sun, low and warm, raking through the trees.
add(primitive="light", name="Sun", light={"type": "sun", "power": 3.4, "color": "#ffe3bf", "shadows": True},
    transform={"position": [-12, -10, 9], "rotation": [62, 0, -50]})

# The composed shot: low front three-quarter view, slightly below eye level.
C.append({"type": "setCamera", "position": CAM, "target": [0.2, 0.0, 0.55]})

script = {"format": "b3d-studio-script", "version": 1, "title": "Supercar in the pines", "commands": C}
out = ROOT / "examples/forest-supercar.b3d-script.json"
out.write_text(json.dumps(script, separators=(",", ":")))
print(f"{len(C)} commands, {out.stat().st_size // 1024} KB")
