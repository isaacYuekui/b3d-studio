"""Two realistic people (MakeHuman CC0 presets) in a living room: he walks in and waves,
she sits down on the sofa. Writes examples/living-room.b3d-script.json."""
import json
from pathlib import Path

C = []
add = lambda **kw: C.append({"type": "add", **kw})

C.append({"type": "setWorld", "world": {"hdri": "photo_studio_loft_hall", "strength": 0.75, "background": "color", "color": "#20232a", "exposure": 1.3, "bloom": 0.03, "ao": True}})
add(primitive="plane", name="Floor", transform={"scale": [4, 3, 1]}, material={"texture": "brown_floor_tiles", "textureScale": 1.2, "roughness": 0.5})
add(primitive="plane", name="Back wall", transform={"position": [0, 2.2, 1.4], "rotation": [90, 0, 0], "scale": [4, 1.4, 1]}, material={"baseColor": "#d8cfc2", "roughness": 0.9})
add(primitive="plane", name="Side wall", transform={"position": [-3.2, 0, 1.4], "rotation": [90, 0, 90], "scale": [3, 1.4, 1]}, material={"baseColor": "#b9c3c7", "roughness": 0.9})
add(primitive="model", asset="sofa_02", name="Sofa", transform={"position": [-0.6, 1.25, 0], "rotation": [0, 0, 0]})
add(primitive="model", asset="potted_plant_02", name="Plant", transform={"position": [-2.6, 1.7, 0]})
add(primitive="model", asset="round_wooden_table_01", name="Table", transform={"position": [1.5, 1.35, 0]})

FPS, END = 24, 150
C.append({"type": "setAnimation", "fps": FPS, "start": 1, "end": END})

# She stands in front of the sofa, idles, then sits down onto it.
C.append({"type": "addHuman", "id": "she", "preset": "female", "name": "Maya", "transform": {"position": [-0.6, 0.62, 0]},
          "outfit": {"shirt": "#9b3b3b", "pants": "#2f3b55", "hair": "#4a2f1d", "skin": "#c98f6e", "shoes": "#e6e1d8"}})
C.append({"type": "playAction", "id": "she", "action": "idle", "start": 1, "cycles": 0.5})
C.append({"type": "playAction", "id": "she", "action": "sit", "start": 50})

# He walks in from the right, turns to her and waves.
C.append({"type": "addHuman", "id": "he", "preset": "male", "name": "Leo", "transform": {"position": [4.4, 0.2, 0], "rotation": [0, 0, -90]},
          "outfit": {"shirt": "#d8d4cb", "pants": "#3a3f47", "hair": "#1c1410", "skin": "#8d5a3b", "shoes": "#2a1d14"}})
C.append({"type": "playAction", "id": "he", "action": "walk", "start": 1, "cycles": 2})
# Turn towards her (frames 61 → 72), then wave.
C.append({"type": "setKeyframe", "id": "he", "frame": 72, "easing": "ease", "transform": {"position": [1.5, 0.2, 0], "rotation": [0, 0, -78], "scale": [1, 1, 1]}})
C.append({"type": "playAction", "id": "he", "action": "wave", "start": 76, "cycles": 3, "travel": False})

add(primitive="light", name="Window light", light={"type": "sun", "power": 3.2, "color": "#fff1df", "shadows": True}, transform={"position": [3, -2, 4], "rotation": [55, 0, 50]})
C.append({"type": "setCamera", "position": [2.9, -3.6, 1.55], "target": [0.4, 0.6, 0.9]})

out = Path(__file__).resolve().parents[1] / "living-room.b3d-script.json"
out.write_text(json.dumps({"format": "b3d-studio-script", "version": 1, "title": "Living room: walk, wave, sit", "commands": C}, separators=(",", ":")))
print(len(C), "commands")
