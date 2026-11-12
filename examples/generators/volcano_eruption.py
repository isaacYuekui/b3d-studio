"""What if a volcano erupted next to a village, at night: a smoking volcano with glowing lava
channels (one mesh, two material slots — v3.15), a tremor, then the eruption — a blast with a
light flash (v3.13), a fire fountain, glowing lava bombs and a towering ash plume — while the
village at its foot has its windows lit. Videos get rumble, boom and fire sounds by themselves
(v3.16). Writes examples/volcano-eruption.b3d-script.json. 7 s at 24 fps."""
import json
import math
from pathlib import Path

C = []
ERUPT = 60
R, H = 120.0, 70.0          # base radius and height of the cone (m)
RIM, DEPTH = 15.0, 12.0     # crater radius and depth
TOP = [0, 0, H - 2]          # where the eruption comes out


def hash2(i, j, s=0):
    h = (i * 374761393 + j * 668265263 + s * 2147483647) & 0xFFFFFFFF
    h = ((h ^ (h >> 13)) * 1274126177) & 0xFFFFFFFF
    return ((h ^ (h >> 16)) & 0xFFFFFFFF) / 4294967296


def vnoise(x, y, s=0):
    ix, iy = math.floor(x), math.floor(y)
    fx, fy = x - ix, y - iy
    fx, fy = fx * fx * (3 - 2 * fx), fy * fy * (3 - 2 * fy)
    a, b = hash2(ix, iy, s), hash2(ix + 1, iy, s)
    c, d = hash2(ix, iy + 1, s), hash2(ix + 1, iy + 1, s)
    return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy


def fbm(x, y, s=0):
    return sum(vnoise(x * 2 ** o, y * 2 ** o, s + o) / 2 ** o for o in range(4)) / 1.875


# --- the cone: rings of points from the crater floor out to the base, gullies and noise
RINGS, SEG = 34, 96
CHANNELS = [-100.0, -78.0, 205.0]   # lava runs down these directions (degrees)


def height(r, a):
    if r <= RIM:
        return H - DEPTH + (DEPTH * 0.35) * (r / RIM) ** 2  # crater floor rising to the inner wall
    t = (r - RIM) / (R - RIM)
    h = H * (1 - t) ** 1.55 + 1.5 * (1 - t)
    # gullies down the slope, and lumpy rock
    h -= 2.2 * max(0.0, math.sin(a * 9 + 1.3 * fbm(r / 30, a, 3))) ** 6 * min(1.0, t * 3)
    h += 3.2 * (fbm(math.cos(a) * r / 18 + 50, math.sin(a) * r / 18 + 50, 7) - 0.5) * min(1.0, r / 25)
    return max(0.0, h)


radii = [RIM * 0.15] + [RIM * (k / 6) for k in range(1, 7)] + [RIM + (R - RIM) * ((k / (RINGS - 7)) ** 1.25) for k in range(1, RINGS - 6)]
verts, faces, slot = [[0, 0, round(H - DEPTH, 3)]], [], []
for r in radii:
    for s in range(SEG):
        a = 2 * math.pi * s / SEG
        rr = r * (1 + 0.06 * (fbm(math.cos(a) * 2 + 9, math.sin(a) * 2 + 9, 2) - 0.5)) if r > RIM else r
        z = height(r, a)
        verts.append([round(math.cos(a) * rr, 3), round(math.sin(a) * rr, 3), round(z + (1.8 if abs(r - RIM) < 0.5 else 0), 3)])


def vid(ring, s):
    return 1 + ring * SEG + (s % SEG)


def is_lava(ring, s):
    r = radii[ring]
    if r <= RIM * 0.85:
        return True  # lava lake in the crater
    a = 360 * (s + 0.5) / SEG
    t = (r - RIM) / (R - RIM)
    for c in CHANNELS:
        d = abs((a - c + 180) % 360 - 180)
        # a channel narrowing and ending part-way down, wiggling a little
        width = 5.5 * (1 - t) + 1.5
        if t < 0.72 + 0.12 * math.sin(c) and d < width + 2.5 * math.sin(t * 9 + c):
            return True
    return False


for s in range(SEG):  # crater centre fan
    faces.append([0, vid(0, s), vid(0, s + 1)])
    slot.append(1)
for ring in range(len(radii) - 1):
    for s in range(SEG):
        faces.append([vid(ring, s), vid(ring + 1, s), vid(ring + 1, s + 1), vid(ring, s + 1)])
        slot.append(1 if is_lava(ring, s) else 0)

ROCK = {"baseColor": "#4a4440", "roughness": 0.95, "texture": "rock_face", "textureScale": 0.08}
LAVA = {"baseColor": "#ff6a10", "roughness": 0.9, "pattern": {"type": "noise", "colorA": "#ff7a18", "colorB": "#1c1210", "scale": 0.12, "bump": 0.5, "glow": 7, "glowColor": "#ff6a14"}}

C.append({"type": "setTimeOfDay", "time": "night", "fog": 900})
C.append({"type": "setAnimation", "fps": 24, "start": 1, "end": 168})

C.append({"type": "add", "primitive": "mesh", "id": "ground", "name": "Ground", "mesh": {"vertices": [[-600, -600, -0.2], [600, -600, -0.2], [600, 600, -0.2], [-600, 600, -0.2]], "faces": [[0, 1, 2, 3]], "smooth": False},
          "material": {"baseColor": "#3b3a30", "roughness": 0.95, "pattern": {"type": "noise", "colorA": "#2c2d24", "colorB": "#4a4636", "scale": 0.05, "bump": 0.3}}})
C.append({"type": "add", "primitive": "mesh", "id": "volcano", "name": "Volcano", "mesh": {"vertices": verts, "faces": faces, "smooth": True, "materialIndex": slot}, "material": ROCK, "materialSlots": [LAVA]})

# The village at its foot (v3.12 generator) with lit windows.
C.append({"type": "addTown", "prefix": "village", "style": "village", "center": [-30, -175], "size": [110, 60], "seed": 21, "ground": False, "lights": 3})

# Before: smoke drifting from the crater, and the crater glow lighting the plume from below.
add_smoke = {"type": "add", "primitive": "sphere", "id": "vent", "name": "Vent", "transform": {"position": TOP, "scale": [5, 5, 2]}}
C.append(add_smoke)
C.append({"type": "setParticles", "id": "vent", "particles": {"count": 900, "start": -120, "end": 168, "lifetime": 150, "speed": 2, "random": 1.5, "gravity": -0.06, "size": 7, "sizeRandom": 0.5, "shape": "smoke", "color": "#4d4744", "glow": 0, "ground": "none", "wind": [1.2, 0.4, 0], "hideEmitter": True, "seed": 3}})
C.append({"type": "add", "primitive": "light", "id": "crater-glow", "name": "Crater glow", "light": {"type": "point", "power": 90000, "color": "#ff6a20", "shadows": False}, "transform": {"position": [0, 0, H + 6]}})

# The eruption: a blast with a flash, a fire fountain, lava bombs and an ash column.
C.append({"type": "add", "primitive": "empty", "id": "blast", "name": "Eruption", "transform": {"position": TOP}})
C.append({"type": "setField", "id": "blast", "field": {"type": "force", "strength": 300, "radius": 40, "start": ERUPT, "end": ERUPT + 1, "flash": 900000, "flashColor": "#ff8a3a"}})
C.append({"type": "add", "primitive": "sphere", "id": "fountain", "name": "Fire fountain", "transform": {"position": TOP, "scale": [4, 4, 1]}})
C.append({"type": "setParticles", "id": "fountain", "particles": {"count": 5000, "start": ERUPT, "end": 168, "lifetime": 34, "speed": 26, "random": 7, "gravity": 0.9, "size": 4.5, "sizeRandom": 0.5, "shape": "fire", "color": "#ff7a1a", "glow": 1, "ground": "none", "hideEmitter": True, "seed": 5}})
C.append({"type": "add", "primitive": "sphere", "id": "bombs", "name": "Lava bombs", "transform": {"position": TOP, "scale": [3, 3, 1]}})
C.append({"type": "setParticles", "id": "bombs", "particles": {"count": 700, "start": ERUPT, "end": ERUPT + 40, "lifetime": 110, "speed": 30, "random": 16, "gravity": 1, "size": 1.4, "sizeRandom": 0.6, "shape": "sphere", "color": "#ff5a10", "glow": 1, "ground": "stop", "hideEmitter": True, "seed": 8}})
C.append({"type": "add", "primitive": "sphere", "id": "ash", "name": "Ash column", "transform": {"position": [0, 0, H + 4], "scale": [8, 8, 3]}})
C.append({"type": "setParticles", "id": "ash", "particles": {"count": 2600, "start": ERUPT, "end": 168, "lifetime": 160, "speed": 14, "random": 4, "gravity": -0.12, "size": 13, "sizeRandom": 0.5, "shape": "smoke", "color": "#3d3836", "glow": 0, "ground": "none", "wind": [2.2, 0.6, 0], "hideEmitter": True, "seed": 11}})

# The ground shakes: a tremor first, then the blast.
C.append({"type": "addCameraShake", "start": 18, "end": 44, "strength": 0.25, "frequency": 9})
C.append({"type": "addCameraShake", "start": ERUPT, "end": ERUPT + 72, "strength": 0.85, "frequency": 11})

# Camera: from the edge of the village looking up at the volcano, slowly pushing in, tilting up with the plume.
C.append({"type": "setLens", "lens": {"focal": 28}})
C.append({"type": "setCameraKey", "frame": 1, "position": [36, -255, 9], "target": [0, 0, 40], "easing": "ease"})
C.append({"type": "setCameraKey", "frame": ERUPT, "position": [32, -240, 9], "target": [0, 0, 48], "easing": "ease"})
C.append({"type": "setCameraKey", "frame": 168, "position": [26, -222, 10], "target": [0, 0, 78], "easing": "ease"})

out = {"format": "b3d-studio-script", "version": 1, "title": "Volcano eruption", "commands": C}
Path(__file__).resolve().parents[1].joinpath("volcano-eruption.b3d-script.json").write_text(json.dumps(out, separators=(",", ":")))
print(len(C), "commands", len(verts), "verts", len(faces), "faces", sum(slot), "lava faces")
