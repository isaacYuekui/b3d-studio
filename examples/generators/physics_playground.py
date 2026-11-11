"""Physics playground: a heavy ball knocks down a plank tower, crates tumble down a ramp and
bouncy balls drop — all rigid bodies, simulated once with bakePhysics and saved as keyframes.
Writes examples/physics-playground.b3d-script.json. Ground top at z = 0. 6 s at 24 fps."""
import json
import math
from pathlib import Path

C = []


def box(sx, sy, sz):
    """Box mesh centred on its origin, faces outward."""
    hx, hy, hz = sx / 2, sy / 2, sz / 2
    v = [[x, y, z] for z in (-hz, hz) for y in (-hy, hy) for x in (-hx, hx)]
    f = [[0, 2, 3, 1], [4, 5, 7, 6], [0, 1, 5, 4], [1, 3, 7, 5], [3, 2, 6, 7], [2, 0, 4, 6]]
    return {"vertices": [[round(c, 4) for c in p] for p in v], "faces": f, "smooth": False}


def add(i, name, mesh, mat, pos, rot=(0, 0, 0), rigid=None, primitive="mesh", scale=(1, 1, 1), mods=None):
    cmd = {"type": "add", "primitive": primitive, "id": i, "name": name, "material": mat, "transform": {"position": [round(p, 4) for p in pos], "rotation": list(rot), "scale": list(scale)}}
    if mesh is not None:
        cmd["mesh"] = mesh
    C.append(cmd)
    if mods:
        C.append({"type": "setModifiers", "id": i, "modifiers": mods})
    if rigid is not None:
        C.append({"type": "setRigidBody", "id": i, "rigid": rigid})


C.append({"type": "setWorld", "world": {"hdri": "photo_studio_loft_hall", "strength": 0.9, "background": "blurred", "exposure": 1.0, "bloom": 0.04, "ao": True}})
C.append({"type": "setAnimation", "fps": 24, "start": 1, "end": 144})

GROUND = {"baseColor": "#bfc3c7", "roughness": 0.8, "pattern": {"type": "checker", "colorA": "#9da2a8", "colorB": "#c9cdd1", "scale": 3, "bump": 0}}
WOOD = {"baseColor": "#b07a45", "roughness": 0.55, "pattern": {"type": "wood", "colorA": "#8a5a2e", "colorB": "#c48d58", "scale": 1.2, "bump": 0.15}}
STEEL = {"baseColor": "#2b2f36", "metallic": 1, "roughness": 0.25}
DOMINO = {"baseColor": "#f4f1ea", "roughness": 0.35, "clearcoat": 0.6}
BALLS = ["#e63946", "#f4a261", "#2a9d8f", "#4361ee"]

add("ground", "Ground", box(40, 30, 0.5), GROUND, (0, 0, -0.25), rigid={"type": "passive", "friction": 0.6, "bounce": 0.9})

# Plank tower: 7 layers of 3 planks, each layer turned 90°.
PL, PW, PH = 1.5, 0.48, 0.3
for layer in range(7):
    for k in range(3):
        off = (k - 1) * (PW + 0.02)
        z = PH / 2 + layer * PH
        if layer % 2 == 0:
            pos, rot = (2.6 + off, 0, z), (0, 0, 0)
        else:
            pos, rot = (2.6, off, z), (0, 0, 90)
        add(f"plank{layer}_{k}", f"Plank {layer + 1}.{k + 1}", box(PW, PL, PH), WOOD, pos, rot, rigid={"mass": 2, "friction": 0.6})

# Wrecking ball, thrown at the tower.
add("ball", "Wrecking ball", None, STEEL, (-3.2, 0, 1.0), primitive="sphere", scale=(0.45, 0.45, 0.45), rigid={"mass": 15, "velocity": [12, 0, 2.5], "friction": 0.4})

# A ramp (passive, tilted) with crates dropped onto it: they land, tumble and slide down.
add("ramp", "Ramp", box(2.4, 5.0, 0.2), {"baseColor": "#5b6770", "roughness": 0.6}, (-4.6, 0.6, 1.3), (30, 0, 0), rigid={"type": "passive", "friction": 0.2})
for i in range(5):
    add(f"crate{i}", f"Crate {i + 1}", box(0.5, 0.5, 0.5), WOOD, (-4.9 + (i % 2) * 0.6, 1.4 + i * 0.25, 2.6 + i * 0.7), (i * 17, i * 11, i * 23), rigid={"mass": 1.5, "friction": 0.2})

# Bouncy balls dropped from different heights.
for i, c in enumerate(BALLS):
    add(f"bouncy{i}", f"Bouncy ball {i + 1}", None, {"baseColor": c, "roughness": 0.3, "clearcoat": 1}, (-0.8 + i * 0.9, 2.6, 2.5 + i * 0.8), primitive="sphere", scale=(0.28, 0.28, 0.28), rigid={"bounce": 0.85, "mass": 0.3})

C.append({"type": "add", "primitive": "light", "id": "sun", "name": "Sun", "light": {"type": "sun", "power": 3.0, "shadows": True, "color": "#fff1dc"}, "transform": {"position": [0, 0, 10], "rotation": [42, 0, 28]}})
C.append({"type": "setCamera", "position": [0.9, -12.8, 4.6], "target": [0.9, 0.4, 0.9]})
C.append({"type": "setLens", "lens": {"focal": 35}})
C.append({"type": "bakePhysics"})

out = {"format": "b3d-studio-script", "version": 1, "title": "Physics playground", "commands": C}
Path(__file__).resolve().parents[1].joinpath("physics-playground.b3d-script.json").write_text(json.dumps(out, separators=(",", ":")))
print(len(C), "commands")
