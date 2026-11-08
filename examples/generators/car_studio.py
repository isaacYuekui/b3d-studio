"""Studio test scene for the supercar: examples/car-studio.b3d-script.json"""
import json
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent))
from supercar import build_car

C = []
add = lambda **kw: C.append({"type": "add", **kw})
C.append({"type": "setWorld", "world": {"hdri": "studio_small_09", "strength": 0.8, "background": "color", "color": "#1d1f22", "exposure": 1.0, "bloom": 0.06, "ao": True}})
add(primitive="mesh", name="Studio Floor", mesh={"vertices": [[-12, -12, 0], [12, -12, 0], [12, 12, 0], [-12, 12, 0]], "faces": [[0, 1, 2, 3]], "smooth": True},
    material={"baseColor": "#2a2c30", "roughness": 0.55, "metallic": 0})
add(primitive="empty", id="car", name="Supercar")
build_car(add, "car")
add(primitive="light", name="Key", light={"type": "sun", "power": 1.6, "color": "#ffffff"}, transform={"position": [4, -4, 8], "rotation": [50, 0, 40]})
C.append({"type": "setCamera", "position": [5.6, -4.4, 1.5], "target": [0, 0, 0.55]})
out = Path(__file__).resolve().parents[1] / "car-studio.b3d-script.json"
out.write_text(json.dumps({"format": "b3d-studio-script", "version": 1, "title": "Supercar studio", "commands": C}, separators=(",", ":")))
print(len(C), "commands")
