"""Storm at the lighthouse: ocean waves (v3.6), rain particles, a rocky island and a lighthouse
whose lamp sweeps the sea. Writes examples/storm-lighthouse.b3d-script.json. 6 s at 24 fps."""
import json
from pathlib import Path

C = []


def box(sx, sy, sz):
    """Box mesh centred on its origin, faces outward."""
    hx, hy, hz = sx / 2, sy / 2, sz / 2
    v = [[x, y, z] for z in (-hz, hz) for y in (-hy, hy) for x in (-hx, hx)]
    f = [[0, 2, 3, 1], [4, 5, 7, 6], [0, 1, 5, 4], [1, 3, 7, 5], [3, 2, 6, 7], [2, 0, 4, 6]]
    return {"vertices": [[round(c, 4) for c in p] for p in v], "faces": f, "smooth": False}


def add(i, name, prim, mat, pos, scale=(1, 1, 1), rot=(0, 0, 0), mods=None, params=None, mesh=None, parent=None):
    cmd = {"type": "add", "primitive": prim, "id": i, "name": name, "material": mat, "transform": {"position": list(pos), "rotation": list(rot), "scale": list(scale)}}
    if params:
        cmd["params"] = params
    if mesh:
        cmd["mesh"] = mesh
    if parent:
        cmd["parentId"] = parent
    C.append(cmd)
    if mods:
        C.append({"type": "setModifiers", "id": i, "modifiers": mods})


C.append({"type": "setTimeOfDay", "time": "overcast", "fog": 140})
C.append({"type": "setAnimation", "fps": 24, "start": 1, "end": 144})

# The sea: rough swells rolling towards the island.
C.append({"type": "addWater", "id": "sea", "name": "Stormy sea", "size": [150, 150], "level": 0, "position": [0, 10], "color": "#1c3a42", "clarity": 0.15, "waves": 5.5, "height": 3.0, "direction": 70})

ROCK = {"baseColor": "#3b3a37", "roughness": 0.92, "pattern": {"type": "noise", "colorA": "#2c2b29", "colorB": "#4d4a45", "scale": 2, "bump": 0.6}}
WHITE = {"baseColor": "#e9e6df", "roughness": 0.5}
RED = {"baseColor": "#b3241e", "roughness": 0.45}
DARK = {"baseColor": "#1e2226", "metallic": 0.8, "roughness": 0.35}
LAMP = {"baseColor": "#fff2c4", "roughness": 0.2, "emission": "#ffd77a", "emissionStrength": 6}

# Rocky island (a sphere, subdivided and displaced like Blender's Displace modifier).
add("island", "Rock island", "sphere", ROCK, (6, 26, -2.2), scale=(11, 8, 5), mods={"subdivision": {"levels": 2}, "displace": {"strength": 0.14, "scale": 0.3, "seed": 7}}, params={"segments": 32})
add("rock2", "Rock", "sphere", ROCK, (-6, 21, -0.6), scale=(3.2, 2.6, 1.8), mods={"subdivision": {"levels": 2}, "displace": {"strength": 0.2, "scale": 0.35, "seed": 3}}, params={"segments": 24})

# Lighthouse: red and white bands, gallery, lantern, roof.
BASE = 2.4
for k in range(6):
    r = 1.45 - k * 0.1
    add(f"band{k}", f"Tower band {k + 1}", "cylinder", RED if k % 2 else WHITE, (6, 26, BASE + 0.65 + k * 1.3), scale=(r, r, 0.65))
TOP = BASE + 6 * 1.3
add("gallery", "Gallery", "cylinder", DARK, (6, 26, TOP + 0.08), scale=(1.45, 1.45, 0.08))
add("lantern", "Lantern", "cylinder", LAMP, (6, 26, TOP + 0.75), scale=(0.75, 0.75, 0.6))
add("roof", "Roof", "cone", RED, (6, 26, TOP + 1.75), scale=(0.95, 0.95, 0.45))

# The lamp: a glow plus a spot that sweeps round (two turns over the shot).
C.append({"type": "add", "primitive": "light", "id": "glow", "name": "Lamp glow", "light": {"type": "point", "power": 2500, "color": "#ffd27a", "shadows": False}, "transform": {"position": [6, 26, TOP + 0.75]}})
C.append({"type": "add", "primitive": "light", "id": "beam", "name": "Lamp beam", "light": {"type": "spot", "power": 60000, "color": "#ffe2a0", "shadows": False, "spotAngle": 18}, "transform": {"position": [6, 26, TOP + 0.75], "rotation": [84, 0, 0]}})
for f, z in ((1, 0), (73, 360), (144, 710)):
    C.append({"type": "setKeyframe", "id": "beam", "frame": f, "easing": "linear", "transform": {"position": [6, 26, TOP + 0.75], "rotation": [84, 0, z], "scale": [1, 1, 1]}})

# A small boat riding the swell (Float on water); cabin and mast are parented to the hull.
add("boat", "Boat hull", "mesh", {"baseColor": "#d9d4c7", "roughness": 0.5}, (-5.5, 3, 0), rot=(0, 0, 28), mesh=box(4.2, 1.6, 0.9), mods={"bevel": {"width": 0.08, "segments": 2, "angle": 30}})
C.append({"type": "setFloat", "id": "boat", "float": {"offset": -0.2}})
add("cabin", "Cabin", "mesh", {"baseColor": "#8f2a22", "roughness": 0.5}, (-0.5, 0, 0.85), mesh=box(1.5, 1.1, 0.8), parent="boat")
add("mast", "Mast", "cylinder", DARK, (0.9, 0, 1.6), scale=(0.05, 0.05, 1.3), parent="boat")

# Rain from a hidden sheet above the shot, blown sideways.
add("rain", "Rain cloud", "plane", {"baseColor": "#888888"}, (0, 8, 22), scale=(30, 26, 1))
C.append({"type": "setParticles", "id": "rain", "particles": {"count": 5000, "start": -40, "end": 144, "lifetime": 40, "speed": 0, "random": 0.3, "gravity": 1.4, "size": 0.035, "sizeRandom": 0.2, "shape": "drop", "color": "#c9d6e3", "glow": 0, "ground": "none", "hideEmitter": True, "wind": [-3.5, 0, 0]}})

# Low camera near the waves, slowly pushing in.
C.append({"type": "setLens", "lens": {"focal": 35}})
C.append({"type": "setCameraKey", "frame": 1, "position": [-16, -14, 3.2], "target": [5, 24, 6.5], "easing": "ease"})
C.append({"type": "setCameraKey", "frame": 144, "position": [-9, -4, 3.8], "target": [6, 25, 7.5], "easing": "ease"})

out = {"format": "b3d-studio-script", "version": 1, "title": "Storm at the lighthouse", "commands": C}
Path(__file__).resolve().parents[1].joinpath("storm-lighthouse.b3d-script.json").write_text(json.dumps(out, separators=(",", ":")))
print(len(C), "commands")
