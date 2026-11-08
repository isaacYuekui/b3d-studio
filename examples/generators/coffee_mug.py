"""Coffee mug on a saucer, modelled with editMesh (Edit Mode operators) + Subdivision.
Writes examples/coffee-mug.b3d-script.json. Real-world size: the mug is 8.4 cm wide, 10 cm tall."""
import json
from pathlib import Path

C = []
add = lambda **kw: C.append({"type": "add", **kw})
edit = lambda id, *steps: C.append({"type": "editMesh", "id": id, "steps": list(steps)})
mods = lambda id, **m: C.append({"type": "setModifiers", "id": id, "modifiers": m})

C.append({"type": "setWorld", "world": {"hdri": "brown_photostudio_02", "strength": 0.9, "background": "blurred", "rotation": 200, "exposure": 1.05, "bloom": 0.04, "ao": True}})
add(primitive="plane", id="table", name="Table", transform={"scale": [1.2, 1.2, 1]},
    material={"texture": "dark_planks", "textureScale": 2, "baseColor": "#ffffff", "roughness": 0.6})

# --- Mug: cylinder → real size → hollow it (inset + extrude down) → soften rim and base.
add(primitive="cylinder", id="mug", name="Mug", params={"segments": 32}, material={"baseColor": "#e9e4da", "roughness": 0.22, "metallic": 0})
edit("mug",
     {"op": "scale", "select": {"all": True}, "by": [0.042, 0.042, 0.05], "about": [0, 0, 0]},
     {"op": "move", "select": {"all": True}, "by": [0, 0, 0.05]},
     # Support loops keep the silhouette crisp under subdivision.
     {"op": "loopcut", "select": {"mode": "edge", "nearest": [0.042, 0, 0.05]}, "cuts": 2},
     {"op": "inset", "select": {"normal": [0, 0, 1], "angle": 5}, "thickness": 0.0045},
     {"op": "extrude", "select": {"last": True}, "offset": -0.088},
     {"op": "inset", "select": {"last": True}, "thickness": 0.01},
     {"op": "bevel", "select": {"mode": "edge", "box": {"min": [-1, -1, 0.0995], "max": [1, 1, 0.1005]}}, "width": 0.0012, "segments": 2},
     {"op": "bevel", "select": {"mode": "edge", "box": {"min": [-1, -1, -0.0005], "max": [1, 1, 0.0005]}, "sharp": 45}, "width": 0.003, "segments": 2},
     {"op": "smooth"})
mods("mug", subdivision={"levels": 2})

# Handle: half a torus, standing up, its open ends buried in the wall.
add(primitive="torus", id="handle", name="Handle", params={"segments": 48, "majorRadius": 1, "minorRadius": 0.24},
    transform={"position": [0.04, 0, 0.055], "rotation": [90, 0, 0], "scale": [0.026, 0.026, 0.026]},
    material={"baseColor": "#e9e4da", "roughness": 0.22})
edit("handle",
     {"op": "delete", "select": {"mode": "vert", "box": {"min": [-2, -2, -2], "max": [-0.001, 2, 2]}}},
     {"op": "scale", "select": {"all": True}, "by": [1, 1.18, 1], "about": [0, 0, 0]},
     {"op": "smooth"})
mods("handle", subdivision={"levels": 1})

# Coffee surface, just below the rim.
add(primitive="cylinder", id="coffee", name="Coffee", params={"segments": 32}, transform={"position": [0, 0, 0.088], "scale": [0.0378, 0.0378, 0.0006]},
    material={"baseColor": "#2b160b", "roughness": 0.08})

# --- Saucer: flat disc, a shallow well in the middle, rounded edge.
add(primitive="cylinder", id="saucer", name="Saucer", params={"segments": 40}, material={"baseColor": "#e9e4da", "roughness": 0.22})
edit("saucer",
     {"op": "scale", "select": {"all": True}, "by": [0.075, 0.075, 0.005], "about": [0, 0, 0]},
     {"op": "move", "select": {"all": True}, "by": [0, 0, 0.005]},
     {"op": "inset", "select": {"normal": [0, 0, 1], "angle": 5}, "thickness": 0.026, "depth": -0.003},
     {"op": "move", "select": {"mode": "vert", "box": {"min": [-1, -1, 0.0099], "max": [1, 1, 0.0101]}}, "by": [0, 0, 0.002]},
     {"op": "bevel", "select": {"mode": "edge", "sharp": 30, "box": {"min": [-1, -1, 0.004], "max": [1, 1, 0.02]}}, "width": 0.0015, "segments": 2},
     {"op": "smooth"})
mods("saucer", subdivision={"levels": 2})
# Lift the mug onto the saucer well.
for c in C:
    if c.get("type") == "add" and c.get("id") in ("mug",):
        c["transform"] = {"position": [0, 0, 0.0085]}
    if c.get("type") == "add" and c.get("id") in ("handle", "coffee"):
        c["transform"]["position"][2] += 0.0085

add(primitive="light", name="Window", light={"type": "sun", "power": 2.2, "color": "#fff1df", "shadows": True}, transform={"position": [1, -1, 2], "rotation": [55, 0, 35]})
C.append({"type": "setCamera", "position": [0.24, -0.27, 0.17], "target": [0.005, 0, 0.05]})

out = Path(__file__).resolve().parents[1] / "coffee-mug.b3d-script.json"
out.write_text(json.dumps({"format": "b3d-studio-script", "version": 1, "title": "Coffee mug (modelled in Edit Mode)", "commands": C}, separators=(",", ":")))
print(len(C), "commands")
