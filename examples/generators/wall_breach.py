"""Wall breach: a brick wall broken into pieces with Cell Fracture, then smashed by a wrecking
ball — rigid body physics baked to keyframes. Writes examples/wall-breach.b3d-script.json.
Ground top at z = 0. 4 s at 24 fps."""
import json
from pathlib import Path

C = []
C.append({"type": "setWorld", "world": {"hdri": "photo_studio_loft_hall", "strength": 0.85, "background": "blurred", "exposure": 1.0, "bloom": 0.03, "ao": True}})
C.append({"type": "setAnimation", "fps": 24, "start": 1, "end": 96})
C.append({"type": "add", "primitive": "cube", "id": "ground", "name": "Ground", "material": {"baseColor": "#9a968e", "roughness": 0.85, "pattern": {"type": "noise", "colorA": "#88847c", "colorB": "#aca89f", "scale": 2, "bump": 0.3}}, "transform": {"position": [0, 0, -1], "scale": [20, 14, 1]}})
C.append({"type": "setRigidBody", "id": "ground", "rigid": {"type": "passive", "friction": 0.7}})
BRICK = {"baseColor": "#a4553a", "roughness": 0.8, "pattern": {"type": "bricks", "colorA": "#8c4430", "colorB": "#b8674a", "scale": 3, "bump": 0.4}}
C.append({"type": "add", "primitive": "cube", "id": "wall", "name": "Wall", "material": BRICK, "transform": {"position": [0, 0, 1.4], "scale": [2.4, 0.18, 1.4]}})
C.append({"type": "setRigidBody", "id": "wall", "rigid": {"mass": 400, "friction": 0.7}})
C.append({"type": "fracture", "id": "wall", "pieces": 28, "seed": 4})
C.append({"type": "add", "primitive": "sphere", "id": "ball", "name": "Wrecking ball", "material": {"baseColor": "#25282d", "metallic": 1, "roughness": 0.3}, "transform": {"position": [0.3, -4.5, 1.3], "scale": [0.55, 0.55, 0.55]}})
C.append({"type": "setRigidBody", "id": "ball", "rigid": {"mass": 60, "velocity": [0, 11, 1.2], "friction": 0.4}})
C.append({"type": "add", "primitive": "light", "id": "sun", "name": "Sun", "light": {"type": "sun", "power": 3.0, "shadows": True, "color": "#fff1dc"}, "transform": {"position": [0, 0, 10], "rotation": [45, 0, -35]}})
C.append({"type": "setCamera", "position": [6.5, -7.5, 3.0], "target": [0, 0.6, 1.1]})
C.append({"type": "setLens", "lens": {"focal": 35}})
C.append({"type": "bakePhysics"})
out = {"format": "b3d-studio-script", "version": 1, "title": "Wall breach", "commands": C}
Path(__file__).resolve().parents[1].joinpath("wall-breach.b3d-script.json").write_text(json.dumps(out, separators=(",", ":")))
print(len(C), "commands")
