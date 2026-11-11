"""Modifier garden: every shape here is a few simple pieces plus non-destructive modifiers, the way
you'd build it in Blender. Stairs = one step + Array; fence = one post + Array; vase = a lathed
profile + Solidify + Subdivision; boulder = a sphere + Subdivision + Displace; colonnade = one
column + Array + Bevel. Select any of them and look at Shape in Properties to see (and change) how.
Writes examples/modifier-garden.b3d-script.json. Ground at z = 0."""
import json
import math
from pathlib import Path

C = []


def box_mesh(sx, sy, sz, x0=0.0, y0=0.0, z0=0.0):
    """Axis-aligned box from (x0, y0, z0) to (x0 + sx, y0 + sy, z0 + sz), faces outward."""
    v = [[x0 + x, y0 + y, z0 + z] for z in (0, sz) for y in (0, sy) for x in (0, sx)]
    f = [[0, 2, 3, 1], [4, 5, 7, 6], [0, 1, 5, 4], [1, 3, 7, 5], [3, 2, 6, 7], [2, 0, 4, 6]]
    return {"vertices": [[round(c, 4) for c in p] for p in v], "faces": f, "smooth": False}


def lathe(profile, segments=28, smooth=True):
    """Revolve (radius, height) points around Z. A first point with radius 0 closes the bottom."""
    v, f = [], []
    rings = []
    for r, z in profile:
        if r == 0:
            rings.append([len(v)])
            v.append([0, 0, z])
            continue
        ring = []
        for s in range(segments):
            a = 2 * math.pi * s / segments
            ring.append(len(v))
            v.append([round(r * math.cos(a), 4), round(r * math.sin(a), 4), z])
        rings.append(ring)
    for lo, hi in zip(rings, rings[1:]):
        for s in range(segments):
            t = (s + 1) % segments
            if len(lo) == 1:  # bottom cap, facing down
                f.append([lo[0], hi[t], hi[s]])
            elif len(hi) == 1:  # top cap, facing up
                f.append([lo[s], lo[t], hi[0]])
            else:  # side, facing out
                f.append([lo[s], lo[t], hi[t], hi[s]])
    return {"vertices": v, "faces": f, "smooth": smooth}


def add(i, name, mesh, mat, pos=(0, 0, 0), rot=(0, 0, 0), scale=(1, 1, 1), mods=None, primitive="mesh", params=None):
    cmd = {"type": "add", "primitive": primitive, "id": i, "name": name, "material": mat, "transform": {"position": list(pos), "rotation": list(rot), "scale": list(scale)}}
    if mesh is not None:
        cmd["mesh"] = mesh
    if params:
        cmd["params"] = params
    C.append(cmd)
    if mods:
        C.append({"type": "setModifiers", "id": i, "modifiers": mods})


# ---------------------------------------------------------------- world
C.append({"type": "setWorld", "world": {"hdri": "photo_studio_loft_hall", "strength": 0.9, "background": "blurred", "exposure": 1.0, "bloom": 0.04, "ao": True}})
add("ground", "Ground", box_mesh(16, 10, 0.1, -8, -5, -0.1), {"baseColor": "#c9c2b4", "roughness": 0.9, "pattern": {"type": "noise", "colorA": "#b9b1a2", "colorB": "#d6d0c4", "scale": 2, "bump": 0.3}})

WOOD = {"baseColor": "#a8743f", "roughness": 0.55, "pattern": {"type": "wood", "colorA": "#7a4b24", "colorB": "#b98552", "scale": 1.5, "bump": 0.2}}
PAINT = {"baseColor": "#f1efe8", "roughness": 0.45}
STONE = {"baseColor": "#8d8b86", "roughness": 0.85, "pattern": {"type": "noise", "colorA": "#6f6d69", "colorB": "#a19e98", "scale": 3, "bump": 0.5}}
GLAZE = {"baseColor": "#1f6f78", "roughness": 0.35, "clearcoat": 1, "clearcoatRoughness": 0.08}
MARBLE = {"baseColor": "#e9e6e0", "roughness": 0.3, "pattern": {"type": "marble", "colorA": "#d8d4cc", "colorB": "#f6f4ef", "scale": 1, "bump": 0}}

# Stairs: one step, Array ×9 — each copy one step deeper and one step higher; Bevel softens edges.
add("stairs", "Stairs (Array)", box_mesh(1.4, 0.32, 0.17), WOOD, pos=(-6.4, -0.8, 0), mods={"array": {"count": 9, "relative": [0, 1, 1], "merge": False}, "bevel": {"width": 0.012, "segments": 2, "angle": 30}})

# Fence: one post Array ×10 along X; two rails each one box Array ×2 along Z.
add("posts", "Fence posts (Array)", box_mesh(0.09, 0.09, 1.0), PAINT, pos=(-4.2, -0.4, 0), mods={"array": {"count": 10, "relative": [0, 0, 0], "constant": [0.5, 0, 0]}, "bevel": {"width": 0.01, "segments": 2, "angle": 30}})
add("rails", "Fence rails (Array)", box_mesh(4.7, 0.04, 0.09, -0.05, 0.09, 0.3), PAINT, pos=(-4.2, -0.4, 0), mods={"array": {"count": 2, "relative": [0, 0, 0], "constant": [0, 0, 0.42]}})

# Vase: a lathed open profile, Solidify gives the wall thickness, Subdivision smooths it.
VASE = [(0, 0.0), (0.16, 0.0), (0.27, 0.07), (0.33, 0.26), (0.3, 0.46), (0.19, 0.64), (0.13, 0.76), (0.14, 0.86), (0.2, 0.94)]
add("vase", "Vase (Solidify)", lathe(VASE), GLAZE, pos=(-1.4, -2.6, 0), mods={"solidify": {"thickness": 0.03}, "subdivision": {"levels": 2}})

# Boulder: a sphere, Subdivision then Displace (3D noise) — change the seed for a different rock.
add("boulder", "Boulder (Displace)", None, STONE, pos=(2.6, -1.5, 0.55), scale=(1.2, 0.95, 0.75), primitive="sphere", params={"segments": 24}, mods={"subdivision": {"levels": 2}, "displace": {"strength": 0.22, "scale": 0.55, "seed": 4}})
add("pebble", "Pebble (Displace)", None, STONE, pos=(1.2, -2.8, 0.16), scale=(0.3, 0.24, 0.2), primitive="sphere", params={"segments": 16}, mods={"subdivision": {"levels": 2}, "displace": {"strength": 0.25, "scale": 0.6, "seed": 11}})

# Colonnade: one column (lathed), Array ×4 along X; a lintel on top.
COLUMN = [(0, 0.0), (0.3, 0.0), (0.3, 0.12), (0.22, 0.18), (0.2, 2.2), (0.24, 2.3), (0.3, 2.38), (0.3, 2.46), (0, 2.46)]
add("columns", "Columns (Array)", lathe(COLUMN, 24, smooth=True), MARBLE, pos=(1.0, 2.4, 0), mods={"array": {"count": 4, "relative": [0, 0, 0], "constant": [1.5, 0, 0]}})
add("lintel", "Lintel", box_mesh(5.3, 0.7, 0.32, -0.35, -0.35, 2.46), MARBLE, pos=(1.0, 2.4, 0), mods={"bevel": {"width": 0.02, "segments": 2, "angle": 30}})

C.append({"type": "add", "primitive": "light", "id": "sun", "name": "Sun", "light": {"type": "sun", "power": 3.2, "shadows": True, "color": "#fff1dc"}, "transform": {"position": [0, 0, 10], "rotation": [48, 0, 32]}})
C.append({"type": "setCamera", "position": [1.2, -11.5, 5.2], "target": [-0.6, 0.2, 0.9]})

out = {"format": "b3d-studio-script", "version": 1, "title": "Modifier garden", "commands": C}
Path(__file__).resolve().parents[1].joinpath("modifier-garden.b3d-script.json").write_text(json.dumps(out, separators=(",", ":")))
print(len(C), "commands")
