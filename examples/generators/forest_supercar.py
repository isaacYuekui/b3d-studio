"""Generates examples/forest-supercar.b3d-script.json.

The original angular supercar from supercar.py (not modelled on any real brand),
posed on a gravel track in a young pine forest.
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


import sys
sys.path.insert(0, str(Path(__file__).parent))
from supercar import build_car  # noqa: E402

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
add(primitive="empty", id="car", name="Supercar", transform={"position": [0.5, round(1.6 * math.sin(0.5 / 9), 3), 0], "rotation": [0, 0, round(heading, 2)]})
build_car(add, "car", paint="#a50f12")

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
