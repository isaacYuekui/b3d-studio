"""An original posable character ("Mannequin"): box-modelled body (editMesh), subdivided,
skinned to a humanoid armature, with a walk cycle. Writes examples/character-walk.b3d-script.json.
Height ≈ 1.75 m, feet at z = 0, facing -Y (Blender front view)."""
import json
import math
from pathlib import Path

C = []
add = lambda **kw: C.append({"type": "add", **kw})
E = lambda *steps: C.append({"type": "editMesh", "id": "body", "steps": list(steps)})

# ---------------------------------------------------------------- body (box modelling)
W, D = 0.165, 0.12          # half width / half depth of the torso
Z0, Z1 = 0.92, 1.47          # hip line → shoulder line
add(primitive="cube", id="body", name="Body", material={"baseColor": "#c9b8a6", "roughness": 0.45})
E(
    {"op": "scale", "select": {"all": True}, "by": [W, D, (Z1 - Z0) / 2], "about": [0, 0, 0]},
    {"op": "move", "select": {"all": True}, "by": [0, 0, (Z0 + Z1) / 2]},
    # Centre line (left / right halves) and three horizontal rings: belly, waist, chest.
    {"op": "loopcut", "select": {"mode": "edge", "nearest": [0, -D, Z0]}, "cuts": 1},
    {"op": "loopcut", "select": {"mode": "edge", "nearest": [W, -D, (Z0 + Z1) / 2]}, "cuts": 3},
    # Front / back split for rounder sides.
    {"op": "loopcut", "select": {"mode": "edge", "nearest": [W, 0, Z1]}, "cuts": 1},
    # Shape the torso: narrow waist, broad chest, slimmer pelvis bottom.
    {"op": "scale", "select": {"mode": "vert", "box": {"min": [-1, -1, 1.05], "max": [1, 1, 1.1]}}, "by": [0.84, 0.88, 1]},
    {"op": "scale", "select": {"mode": "vert", "box": {"min": [-1, -1, 1.32], "max": [1, 1, 1.34]}}, "by": [1.08, 1.12, 1]},
    {"op": "scale", "select": {"mode": "vert", "box": {"min": [-1, -1, 1.46], "max": [1, 1, 1.48]}}, "by": [0.92, 0.75, 1]},
    {"op": "move", "select": {"mode": "vert", "box": {"min": [-1, -1, 1.46], "max": [1, 1, 1.48]}}, "by": [0, 0, 0.0]},
    # Round the front/back mid-ring outward (chest and belly volume).
    {"op": "scale", "select": {"mode": "vert", "box": {"min": [-0.01, -1, 1.0], "max": [0.01, 1, 1.45]}}, "by": [1, 1.12, 1]},
    # Legs: per side, inset the two bottom faces as one region, then extrude: hip, thigh, knee, shin, ankle.
)
for sx in (1, -1):
    side_box = {"min": [min(0, sx * 0.4), -1, Z0 - 0.01], "max": [max(0, sx * 0.4), 1, Z0 + 0.01]}
    E(
        {"op": "inset", "select": {"mode": "face", "normal": [0, 0, -1], "angle": 10, "box": side_box}, "thickness": 0.016},
        {"op": "extrude", "select": {"last": True}, "offset": 0.06},
        {"op": "extrude", "select": {"last": True}, "offset": 0.36},
        {"op": "scale", "select": {"last": True}, "by": [0.8, 0.86, 1]},
        {"op": "extrude", "select": {"last": True}, "offset": 0.07},
        {"op": "extrude", "select": {"last": True}, "offset": 0.33},
        {"op": "scale", "select": {"last": True}, "by": [0.78, 0.8, 1]},
        {"op": "extrude", "select": {"last": True}, "offset": 0.04},
    )
# Feet: the ankle bottoms are now at z ≈ 0.06; extrude down, then the front faces forward.
for sx in (1, -1):
    E(
        {"op": "extrude", "select": {"mode": "face", "normal": [0, 0, -1], "angle": 10, "box": {"min": [min(0, sx * 0.3), -1, 0], "max": [max(0, sx * 0.3), 1, 0.12]}}, "offset": 0.055},
        {"op": "extrude", "select": {"mode": "face", "normal": [0, -1, 0], "angle": 20, "box": {"min": [min(0, sx * 0.3), -1, -0.1], "max": [max(0, sx * 0.3), 1, 0.07]}}, "offset": 0.13},
        {"op": "scale", "select": {"last": True}, "by": [1.1, 1, 0.6]},
        {"op": "move", "select": {"last": True}, "by": [0, 0, -0.012]},
    )
# Arms: upper side faces (between the chest ring and the shoulder line) → shoulder, upper arm,
# elbow, forearm, wrist, hand. T-pose along ±X.
for sx in (1, -1):
    E(
        {"op": "extrude", "select": {"mode": "face", "normal": [sx, 0, 0], "angle": 25, "box": {"min": [-1, -1, 1.3], "max": [1, 1, 1.48]}}, "offset": 0.05},
        # Flatten the end so the arm runs straight out along X.
        {"op": "scale", "select": {"last": True}, "by": [0, 0.5, 0.88]},
        {"op": "extrude", "select": {"last": True}, "offset": 0.26},
        {"op": "scale", "select": {"last": True}, "by": [1, 0.86, 0.86]},
        {"op": "extrude", "select": {"last": True}, "offset": 0.05},
        {"op": "extrude", "select": {"last": True}, "offset": 0.22},
        {"op": "scale", "select": {"last": True}, "by": [1, 0.86, 0.84]},
        {"op": "extrude", "select": {"last": True}, "offset": 0.03},
        {"op": "extrude", "select": {"last": True}, "offset": 0.1},
        {"op": "scale", "select": {"last": True}, "by": [1, 1.3, 0.6]},
        {"op": "extrude", "select": {"last": True}, "offset": 0.07},
        {"op": "scale", "select": {"last": True}, "by": [1, 0.8, 0.75]},
    )
# Neck and head from the top.
E(
    {"op": "inset", "select": {"normal": [0, 0, 1], "angle": 10, "box": {"min": [-0.17, -1, 1.45], "max": [0.17, 1, 1.5]}}, "thickness": 0.05},
    {"op": "extrude", "select": {"last": True}, "offset": 0.03},
    {"op": "scale", "select": {"last": True}, "by": [0.55, 1.6, 1]},
    {"op": "extrude", "select": {"last": True}, "offset": 0.07},
    {"op": "extrude", "select": {"last": True}, "offset": 0.03},
    {"op": "scale", "select": {"last": True}, "by": [1.45, 1.55, 1]},
    {"op": "extrude", "select": {"last": True}, "offset": 0.1},
    {"op": "scale", "select": {"last": True}, "by": [1.08, 1.08, 1]},
    {"op": "extrude", "select": {"last": True}, "offset": 0.08},
    {"op": "scale", "select": {"last": True}, "by": [0.7, 0.72, 1]},
    {"op": "smooth"},
)
C.append({"type": "setModifiers", "id": "body", "modifiers": {"subdivision": {"levels": 2}}})

# ---------------------------------------------------------------- armature
def bone(name, parent, head, tail):
    return {"name": name, "parent": parent, "head": head, "tail": tail}

B = [
    bone("hips", None, [0, 0, 0.95], [0, 0, 1.1]),
    bone("spine", "hips", [0, 0, 1.1], [0, 0, 1.3]),
    bone("chest", "spine", [0, 0, 1.3], [0, 0, 1.47]),
    bone("neck", "chest", [0, 0, 1.47], [0, 0, 1.57]),
    bone("head", "neck", [0, 0, 1.57], [0, 0, 1.78]),
]
for side, sx in (("L", 1), ("R", -1)):
    B += [
        bone(f"shoulder.{side}", "chest", [sx * 0.05, 0, 1.42], [sx * 0.19, 0, 1.4]),
        bone(f"upper_arm.{side}", f"shoulder.{side}", [sx * 0.19, 0, 1.4], [sx * 0.47, 0, 1.4]),
        bone(f"forearm.{side}", f"upper_arm.{side}", [sx * 0.47, 0, 1.4], [sx * 0.73, 0, 1.4]),
        bone(f"hand.{side}", f"forearm.{side}", [sx * 0.73, 0, 1.4], [sx * 0.93, 0, 1.4]),
        bone(f"thigh.{side}", "hips", [sx * 0.085, 0, 0.9], [sx * 0.085, 0, 0.5]),
        bone(f"shin.{side}", f"thigh.{side}", [sx * 0.085, 0, 0.5], [sx * 0.085, 0, 0.09]),
        bone(f"foot.{side}", f"shin.{side}", [sx * 0.085, 0, 0.09], [sx * 0.085, -0.15, 0.03]),
    ]
add(primitive="armature", id="rig", name="Rig", armature={"bones": B})
# The rig carries the body: move the armature first in the script and parent the body to it.
rig = C.pop()
C.insert(0, rig)
next(c for c in C if c.get("id") == "body" and c["type"] == "add")["parentId"] = "rig"
C.append({"type": "setSkin", "id": "body", "armature": "rig"})

# ---------------------------------------------------------------- walk cycle (24 frames, loops)
# Bone axes (Blender convention, see docs/CHARACTERS.md): legs swing on X (negative = forward),
# knees bend with +X, hanging arms swing on Y, elbows bend on Z, the spine twists on Y.
FPS, CYCLE, CYCLES = 24, 24, 3
C.append({"type": "setAnimation", "fps": FPS, "start": 1, "end": CYCLE * CYCLES + 1})

def key(bone, frame, rot, loc=None):
    k = {"type": "setPoseKey", "id": "rig", "bone": bone, "frame": frame, "rotation": [round(r, 2) for r in rot], "easing": "linear"}
    if loc:
        k["location"] = [round(x, 4) for x in loc]
    C.append(k)

for f in range(1, CYCLE * CYCLES + 2, 2):
    p = (f - 1) / CYCLE
    for side, sgn, off in (("L", 1, 0.0), ("R", -1, 0.5)):
        ph = 2 * math.pi * (p + off)
        fwd = 24 * math.sin(ph)                      # leg forward angle
        knee = 6 + 52 * max(0.0, math.cos(ph)) ** 2   # bends most while the leg swings through
        key(f"thigh.{side}", f, [-fwd, 0, 0])
        key(f"shin.{side}", f, [knee, 0, 0])
        key(f"foot.{side}", f, [fwd - knee + 4, 0, 0])  # keep the foot roughly level
        arm = -0.8 * fwd                              # arms swing against the legs
        key(f"upper_arm.{side}", f, [-76, -sgn * arm, 0])
        key(f"forearm.{side}", f, [0, 0, -sgn * (14 + 12 * max(0.0, arm) / 20)])
    ph = 2 * math.pi * p
    key("hips", f, [0, 7 * math.sin(ph), 0], [0, 0.022 * math.cos(2 * ph), 0])
    key("chest", f, [5, -10 * math.sin(ph), 0])
    key("head", f, [-4, 3 * math.sin(ph), 0])

# Root motion: the rig walks towards -Y, 1.35 m per cycle.
for i in range(CYCLES + 1):
    f = 1 + i * CYCLE
    y = 1.9 - i * 1.35
    C.append({"type": "setKeyframe", "id": "rig", "frame": f, "easing": "linear", "transform": {"position": [0, y, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}})
    # Tracking camera, three-quarter front view at chest height.
    C.append({"type": "setCameraKey", "frame": f, "easing": "linear", "position": [2.3, y - 2.2, 1.25], "target": [0, y - 0.15, 0.92]})

# ---------------------------------------------------------------- stage
C.append({"type": "setWorld", "world": {"hdri": "photo_studio_loft_hall", "strength": 0.9, "background": "blurred", "exposure": 1.0, "bloom": 0.03, "ao": True}})
add(primitive="plane", name="Floor", transform={"scale": [8, 8, 1]}, material={"texture": "concrete_floor_02", "textureScale": 0.6, "roughness": 0.7})
add(primitive="light", name="Key", light={"type": "sun", "power": 2.0, "color": "#fff4e8", "shadows": True}, transform={"position": [2, -3, 5], "rotation": [50, 0, 30]})
C.append({"type": "setCamera", "position": [2.3, -0.3, 1.25], "target": [0, 1.75, 0.92]})

out = Path(__file__).resolve().parents[1] / "character-walk.b3d-script.json"
out.write_text(json.dumps({"format": "b3d-studio-script", "version": 1, "title": "Character walk cycle", "commands": C}, separators=(",", ":")))
print(len(C), "commands")
