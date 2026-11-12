"""What if a meteor hit a town: a burning meteor streaks in (moving fire + smoke emitter, carrying
its own light) and lands in a generated town with lit windows at dusk; an explosion force field
(v3.9) with a light flash (v3.13) blows the nearest blocks apart, with a fireball, a dust cloud
and camera shake. Writes examples/meteor-strike.b3d-script.json. 6 s at 24 fps."""
import json
from pathlib import Path

C = []
IMPACT = 60
HIT = [-8, 8, 0.6]


def box(sx, sy, sz):
    hx, hy, hz = sx / 2, sy / 2, sz / 2
    v = [[x, y, z] for z in (-hz, hz) for y in (-hy, hy) for x in (-hx, hx)]
    f = [[0, 2, 3, 1], [4, 5, 7, 6], [0, 1, 5, 4], [1, 3, 7, 5], [3, 2, 6, 7], [2, 0, 4, 6]]
    return {"vertices": [[round(c, 4) for c in p] for p in v], "faces": f, "smooth": False}


def add(i, name, prim, mat, pos, scale=(1, 1, 1), rot=(0, 0, 0), mesh=None, params=None):
    cmd = {"type": "add", "primitive": prim, "id": i, "name": name, "material": mat, "transform": {"position": list(pos), "rotation": list(rot), "scale": list(scale)}}
    if mesh:
        cmd["mesh"] = mesh
    if params:
        cmd["params"] = params
    C.append(cmd)


C.append({"type": "setTimeOfDay", "time": "dusk", "fog": 220})
C.append({"type": "setAnimation", "fps": 24, "start": 1, "end": 144})

add("ground", "Ground", "mesh", {"baseColor": "#5b5a50", "roughness": 0.95, "pattern": {"type": "noise", "colorA": "#4a4940", "colorB": "#6a675b", "scale": 4, "bump": 0.4}}, (0, 0, -0.5), mesh=box(200, 200, 1))
C.append({"type": "setRigidBody", "id": "ground", "rigid": {"type": "passive", "friction": 0.7}})

# A town (v3.12 generator: buildings with windows on a street grid). The four blocks nearest the
# impact are broken into pieces and made rigid, with their roofs, ready for the blast.
C.append({"type": "addTown", "prefix": "town", "style": "town", "center": [0, 8], "size": [64, 64], "seed": 5, "ground": False, "lights": 2.5})
for i, b in enumerate(["town-b4", "town-b3", "town-b1", "town-b7"]):
    C.append({"type": "setRigidBody", "id": b, "rigid": {"mass": 400}})
    C.append({"type": "fracture", "id": b, "pieces": 16, "seed": 3 + i})
    C.append({"type": "setRigidBody", "id": f"{b}-roof", "rigid": {"mass": 60, "shape": "box"}})

# The meteor: keyframed in from the sky, leaving fire and smoke behind it.
ROCK = {"baseColor": "#2a2420", "roughness": 0.8, "emission": "#ff6a1a", "emissionStrength": 3}
add("meteor", "Meteor", "sphere", ROCK, (-70, 90, 75), scale=(1.4, 1.4, 1.4), params={"segments": 24})
C.append({"type": "setModifiers", "id": "meteor", "modifiers": {"subdivision": {"levels": 1}, "displace": {"strength": 0.25, "scale": 0.5, "seed": 9}}})
C.append({"type": "setKeyframe", "id": "meteor", "frame": 1, "easing": "linear", "transform": {"position": [-70, 90, 75], "rotation": [0, 0, 0], "scale": [1.4, 1.4, 1.4]}})
C.append({"type": "setKeyframe", "id": "meteor", "frame": IMPACT, "easing": "constant", "transform": {"position": HIT, "rotation": [200, 90, 40], "scale": [1.4, 1.4, 1.4]}})
# After the impact it drops far below ground (taking its light with it).
C.append({"type": "setKeyframe", "id": "meteor", "frame": IMPACT + 1, "easing": "constant", "transform": {"position": [HIT[0], HIT[1], -80], "rotation": [200, 90, 40], "scale": [0.01, 0.01, 0.01]}})
C.append({"type": "add", "primitive": "light", "id": "meteor-light", "name": "Meteor glow", "parentId": "meteor", "light": {"type": "point", "power": 12000, "color": "#ff8a3a", "shadows": False}, "transform": {"position": [0, 0, 0]}})
C.append({"type": "setParticles", "id": "meteor", "particles": {"count": 3200, "start": 1, "end": IMPACT, "lifetime": 22, "speed": 0.3, "random": 0.8, "gravity": -0.05, "size": 2.4, "sizeRandom": 0.4, "shape": "fire", "color": "#ff7a1a", "glow": 1, "ground": "none"}})

# Hidden emitters at the impact: fireball and dust (they burst at the impact frame).
add("fireball", "Fireball emitter", "sphere", {"baseColor": "#000000"}, [HIT[0], HIT[1], 3], scale=(2.5, 2.5, 2.5))
C.append({"type": "setParticles", "id": "fireball", "particles": {"count": 2400, "start": IMPACT, "end": IMPACT + 4, "lifetime": 40, "speed": 10, "random": 9, "gravity": 0.15, "size": 4.0, "sizeRandom": 0.5, "shape": "fire", "color": "#ff8a2a", "glow": 1, "ground": "none", "hideEmitter": True}})
add("dust", "Dust emitter", "sphere", {"baseColor": "#000000"}, HIT, scale=(2, 2, 1))
C.append({"type": "setParticles", "id": "dust", "particles": {"count": 700, "start": IMPACT, "end": IMPACT + 5, "lifetime": 140, "speed": 5, "random": 4, "gravity": -0.03, "size": 3.2, "sizeRandom": 0.5, "shape": "smoke", "color": "#7d7266", "glow": 0, "ground": "none", "wind": [0.6, 0, 0], "hideEmitter": True}})

# The blast: a force field for two frames, then bake the falling pieces.
C.append({"type": "add", "primitive": "empty", "id": "blast", "name": "Blast", "transform": {"position": HIT}})
C.append({"type": "setField", "id": "blast", "field": {"type": "force", "strength": 650, "radius": 32, "start": IMPACT, "end": IMPACT + 1, "flash": 400000, "flashColor": "#ff9a45"}})
C.append({"type": "addCameraShake", "start": IMPACT, "end": IMPACT + 60, "strength": 0.9, "frequency": 11})
C.append({"type": "bakePhysics"})

C.append({"type": "setLens", "lens": {"focal": 24}})
C.append({"type": "setCameraKey", "frame": 1, "position": [34, -46, 16], "target": [-12, 14, 16], "easing": "ease"})
C.append({"type": "setCameraKey", "frame": IMPACT, "position": [32, -44, 14], "target": [-8, 8, 7], "easing": "ease"})
C.append({"type": "setCameraKey", "frame": 144, "position": [28, -40, 16], "target": [-8, 8, 9], "easing": "ease"})

out = {"format": "b3d-studio-script", "version": 1, "title": "Meteor strike", "commands": C}
Path(__file__).resolve().parents[1].joinpath("meteor-strike.b3d-script.json").write_text(json.dumps(out, separators=(",", ":")))
print(len(C), "commands")
