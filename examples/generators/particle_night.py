"""Particle night: a fountain, a welding spark shower and falling snow at dusk — three particle
systems (no baking). Writes examples/particle-night.b3d-script.json. Ground top at z = 0. 5 s."""
import json
from pathlib import Path

C = []
C.append({"type": "setTimeOfDay", "time": "dusk"})
C.append({"type": "setAnimation", "fps": 24, "start": 1, "end": 120})
C.append({"type": "add", "primitive": "cube", "id": "ground", "name": "Ground", "material": {"baseColor": "#3b3f45", "roughness": 0.9, "pattern": {"type": "noise", "colorA": "#30343a", "colorB": "#464b52", "scale": 2, "bump": 0.3}}, "transform": {"position": [0, 0, -0.5], "scale": [14, 10, 0.5]}})

# Fountain: a stone basin and a nozzle that shoots water up.
C.append({"type": "add", "primitive": "cylinder", "id": "basin", "name": "Basin", "material": {"baseColor": "#9a958c", "roughness": 0.7}, "transform": {"position": [-2.2, 0.5, 0.25], "scale": [1.3, 1.3, 0.25]}})
C.append({"type": "add", "primitive": "cylinder", "id": "pool", "name": "Water", "material": {"baseColor": "#1f4f6b", "roughness": 0.05, "metallic": 0.2}, "transform": {"position": [-2.2, 0.5, 0.51], "scale": [1.15, 1.15, 0.01]}})
C.append({"type": "add", "primitive": "sphere", "id": "nozzle", "name": "Nozzle", "material": {"baseColor": "#6f6a62", "roughness": 0.5}, "transform": {"position": [-2.2, 0.5, 0.65], "scale": [0.08, 0.08, 0.08]}})
# A tiny plane facing up is the jet: every drop leaves upwards.
C.append({"type": "add", "primitive": "plane", "id": "jet", "name": "Jet", "material": {"baseColor": "#6f6a62"}, "transform": {"position": [-2.2, 0.5, 0.7], "scale": [0.05, 0.05, 1]}})
C.append({"type": "setParticles", "id": "jet", "particles": {"count": 2500, "start": -40, "end": 120, "lifetime": 36, "speed": 5.5, "random": 0.6, "gravity": 1, "size": 0.035, "sizeRandom": 0.3, "shape": "drop", "color": "#a8dcff", "glow": 0.15, "ground": "none", "hideEmitter": True, "seed": 5}})

# Welding sparks from a steel beam.
C.append({"type": "add", "primitive": "cube", "id": "beam", "name": "Steel beam", "material": {"baseColor": "#52565c", "metallic": 1, "roughness": 0.35}, "transform": {"position": [2.4, 0.2, 1.4], "scale": [1.2, 0.08, 0.08]}})
C.append({"type": "add", "primitive": "sphere", "id": "torch", "name": "Weld point", "material": {"baseColor": "#ffffff", "emission": "#ffd27a", "emissionStrength": 8}, "transform": {"position": [2.2, 0.1, 1.4], "scale": [0.04, 0.04, 0.04]}})
C.append({"type": "setParticles", "id": "torch", "particles": {"count": 1800, "start": -20, "end": 120, "lifetime": 26, "speed": 1.5, "random": 3.2, "gravity": 1, "size": 0.018, "sizeRandom": 0.6, "shape": "sphere", "color": "#ffb347", "glow": 1, "ground": "stop", "seed": 9}})
C.append({"type": "add", "primitive": "light", "id": "weldlight", "name": "Weld glow", "light": {"type": "point", "power": 300, "color": "#ffb85c", "shadows": False}, "transform": {"position": [2.2, -0.1, 1.4]}})

# Snow from a big plane high above (hidden).
C.append({"type": "add", "primitive": "plane", "id": "sky", "name": "Snow cloud", "transform": {"position": [0, 0, 7], "scale": [9, 6, 1]}})
C.append({"type": "setParticles", "id": "sky", "particles": {"count": 2500, "start": -160, "end": 120, "lifetime": 200, "speed": 0, "random": 0.25, "gravity": 0.05, "size": 0.035, "sizeRandom": 0.5, "shape": "flake", "color": "#ffffff", "glow": 0.1, "ground": "stop", "hideEmitter": True, "seed": 2}})

C.append({"type": "setCamera", "position": [0.4, -9.5, 2.6], "target": [0.1, 0.4, 1.3]})
C.append({"type": "setLens", "lens": {"focal": 32}})
out = {"format": "b3d-studio-script", "version": 1, "title": "Particle night", "commands": C}
Path(__file__).resolve().parents[1].joinpath("particle-night.b3d-script.json").write_text(json.dumps(out, separators=(",", ":")))
print(len(C), "commands")
