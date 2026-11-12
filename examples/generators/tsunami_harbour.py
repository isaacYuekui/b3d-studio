"""What if a tsunami hit a harbour: a calm sea, then a giant wave (v3.8 surge) rolls in, lifts the
boats and carries them towards the shore while the camera shakes. Writes
examples/tsunami-harbour.b3d-script.json. 8 s at 24 fps. Sea level z = 0, shore top z = 1.5."""
import json
from pathlib import Path

C = []


def box(sx, sy, sz):
    hx, hy, hz = sx / 2, sy / 2, sz / 2
    v = [[x, y, z] for z in (-hz, hz) for y in (-hy, hy) for x in (-hx, hx)]
    f = [[0, 2, 3, 1], [4, 5, 7, 6], [0, 1, 5, 4], [1, 3, 7, 5], [3, 2, 6, 7], [2, 0, 4, 6]]
    return {"vertices": [[round(c, 4) for c in p] for p in v], "faces": f, "smooth": False}


def add(i, name, prim, mat, pos, scale=(1, 1, 1), rot=(0, 0, 0), mesh=None, parent=None, params=None):
    cmd = {"type": "add", "primitive": prim, "id": i, "name": name, "material": mat, "transform": {"position": list(pos), "rotation": list(rot), "scale": list(scale)}}
    if mesh:
        cmd["mesh"] = mesh
    if parent:
        cmd["parentId"] = parent
    if params:
        cmd["params"] = params
    C.append(cmd)


C.append({"type": "setTimeOfDay", "time": "afternoon", "fog": 260})
C.append({"type": "setAnimation", "fps": 24, "start": 1, "end": 192})

# Sea: gentle swell, then the surge from far out (direction +Y, towards the shore). The water runs on
# under the town, hidden below the shore until the wave lifts it over the quay: that's the flood.
C.append({"type": "addWater", "id": "sea", "name": "Harbour sea", "size": [140, 150], "level": 0, "position": [0, -15], "color": "#1f4e5a", "clarity": 0.25, "waves": 1.6, "height": 0.35, "direction": 90})
C.append({"type": "setWater", "id": "sea", "water": {"surge": {"height": 8, "start": 24, "speed": 14, "width": 15, "from": -60}}})

SAND = {"baseColor": "#b9a882", "roughness": 0.95}
CONCRETE = {"baseColor": "#9a9a95", "roughness": 0.85}
WOOD = {"baseColor": "#7a5634", "roughness": 0.7, "pattern": {"type": "wood", "colorA": "#5e3f22", "colorB": "#8f6a43", "scale": 1.5, "bump": 0.2}}
WALLS = ["#e8dcc5", "#d9e4ea", "#f0d7c4", "#dfe8d3", "#eadfd0"]
ROOF = {"baseColor": "#9c3b2e", "roughness": 0.6}

# Shore and quay.
add("shore", "Shore", "mesh", SAND, (0, 45, 0.75), mesh=box(160, 50, 1.5))
add("quay", "Quay wall", "mesh", CONCRETE, (0, 20.5, 0.6), mesh=box(160, 1.2, 2.6))
# Pier out into the water on posts.
add("pier", "Pier deck", "mesh", WOOD, (-14, 8, 1.3), mesh=box(4, 26, 0.3))
for k in range(6):
    add(f"post{k}", f"Pier post {k + 1}", "cylinder", WOOD, (-15.6 + (k % 2) * 3.2, -3 + (k // 2) * 9, 0.2), scale=(0.18, 0.18, 1.2))

# Houses along the front: a generated village standing on the shore (base 1.5 m).
C.append({"type": "addTown", "prefix": "village", "style": "village", "center": [0, 42], "size": [96, 36], "base": 1.5, "seed": 11, "ground": False})

# Boats moored in the harbour: hull + cabin, floating.
BOATS = [(-4, -6, 15, "#d8d2c4", "#2f5d8a"), (6, -12, -20, "#c94f3d", "#f0ece2"), (14, -4, 5, "#e7e2d4", "#3d7a4f"), (-22, -14, 30, "#2e3f5c", "#e9e4d6")]
for i, (x, y, yaw, hull, cab) in enumerate(BOATS):
    add(f"boat{i}", f"Boat {i + 1}", "mesh", {"baseColor": hull, "roughness": 0.5}, (x, y, 0), rot=(0, 0, yaw), mesh=box(4.6, 1.8, 1.0))
    C.append({"type": "setModifiers", "id": f"boat{i}", "modifiers": {"bevel": {"width": 0.1, "segments": 2, "angle": 30}}})
    C.append({"type": "setFloat", "id": f"boat{i}", "float": {"offset": -0.25}})
    add(f"cabin{i}", f"Cabin {i + 1}", "mesh", {"baseColor": cab, "roughness": 0.5}, (-0.6, 0, 0.9), mesh=box(1.7, 1.3, 0.9), parent=f"boat{i}")

# Camera on the quay looking out to sea; it shakes as the wave arrives.
C.append({"type": "setLens", "lens": {"focal": 28}})
C.append({"type": "setCameraKey", "frame": 1, "position": [14, 24.5, 15], "target": [-3, -30, 1], "easing": "ease"})
C.append({"type": "setCameraKey", "frame": 192, "position": [10, 24.5, 18], "target": [-3, -10, 3], "easing": "ease"})
C.append({"type": "addCameraShake", "start": 128, "end": 192, "strength": 0.45, "frequency": 3.5})

out = {"format": "b3d-studio-script", "version": 1, "title": "Tsunami harbour", "commands": C}
Path(__file__).resolve().parents[1].joinpath("tsunami-harbour.b3d-script.json").write_text(json.dumps(out, separators=(",", ":")))
print(len(C), "commands")
