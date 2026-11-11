"""An original heavy scout mech ("Kestrel"): graphite armour with safety-orange panels, a single
round visor, a shoulder missile pod and a carbine. Hard-surface parts are chamfered hexahedra
(bevelled edges catch highlights like real armour), arranged in a jointed hierarchy (empties at
hip, knee, ankle, shoulder, elbow, wrist, waist, neck) so it can be posed or animated.
Writes examples/scout-mech.b3d-script.json. Height ≈ 4.6 m, feet at z = 0, facing −Y."""
import json
import math
from pathlib import Path

C = []

# ---------------------------------------------------------------- materials
GRAPHITE = {"baseColor": "#6e7782", "metallic": 0.12, "roughness": 0.5}
GRAPHITE_D = {"baseColor": "#4a525b", "metallic": 0.15, "roughness": 0.55}
ORANGE = {"baseColor": "#ff6a13", "metallic": 0.05, "roughness": 0.38}
JOINT = {"baseColor": "#17191c", "metallic": 0.85, "roughness": 0.32}
STEEL = {"baseColor": "#8d949c", "metallic": 1.0, "roughness": 0.28}
VISOR = {"baseColor": "#0b1418", "metallic": 0.2, "roughness": 0.08, "emission": "#62e3ff", "emissionStrength": 3.5}
LAMP = {"baseColor": "#202020", "roughness": 0.3, "emission": "#ffb347", "emissionStrength": 4}
DECAL = {"baseColor": "#e8e3d6", "roughness": 0.5}


# ---------------------------------------------------------------- chamfered hexahedron
def chamfer_hex(corners, r):
    """Bevel every edge of a convex hexahedron by r. corners: 8 points, bottom 0-3 then top 4-7,
    each ring counter-clockwise seen from above. Returns (vertices, faces), outward-facing."""
    faces = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]]
    sub = lambda a, b: [a[i] - b[i] for i in range(3)]
    norm = lambda a: (lambda l: [x / l for x in a])(math.sqrt(sum(x * x for x in a)) or 1)
    verts, key = [], {}
    # A vertex per (face, corner): pulled in along both of the face's edges at that corner.
    for fi, f in enumerate(faces):
        for k, c in enumerate(f):
            p, q1, q2 = corners[c], corners[f[k - 1]], corners[f[(k + 1) % 4]]
            u1, u2 = norm(sub(q1, p)), norm(sub(q2, p))
            key[(fi, c)] = len(verts)
            verts.append([round(p[i] + r * (u1[i] + u2[i]), 4) for i in range(3)])
    out = [[key[(fi, c)] for c in f] for fi, f in enumerate(faces)]
    # Edge bevels: for each edge shared by faces A and B.
    edges = {}
    for fi, f in enumerate(faces):
        for k in range(4):
            a, b = f[k], f[(k + 1) % 4]
            edges.setdefault(frozenset((a, b)), []).append((fi, a, b))
    for (fa, a, b), (fb, _, _) in [v for v in edges.values()]:
        out.append([key[(fa, b)], key[(fa, a)], key[(fb, a)], key[(fb, b)]])
    # Corner triangles.
    for c in range(8):
        fs = [fi for fi, f in enumerate(faces) if c in f]
        # order the three face-points around the corner (outward): use the edge cycle
        a, b, d = fs
        out.append([key[(a, c)], key[(b, c)], key[(d, c)]])
    # The solid is convex: orient every face away from the centre.
    cen = [sum(v[i] for v in verts) / len(verts) for i in range(3)]
    for k, face in enumerate(out):
        P = [verts[i] for i in face]
        n = [0.0, 0.0, 0.0]
        for j in range(len(P)):
            a_, b_ = P[j], P[(j + 1) % len(P)]
            n[0] += (a_[1] - b_[1]) * (a_[2] + b_[2])
            n[1] += (a_[2] - b_[2]) * (a_[0] + b_[0])
            n[2] += (a_[0] - b_[0]) * (a_[1] + b_[1])
        fc = [sum(q[i] for q in P) / len(P) for i in range(3)]
        if sum(n[i] * (fc[i] - cen[i]) for i in range(3)) < 0:
            out[k] = face[::-1]
    return verts, out


def frustum(w0, d0, w1, d1, h, dx=0.0, dy=0.0, z0=0.0):
    """Box from a w0×d0 bottom to a w1×d1 top (full sizes), top shifted by dx, dy."""
    b = [[-w0 / 2, -d0 / 2, z0], [w0 / 2, -d0 / 2, z0], [w0 / 2, d0 / 2, z0], [-w0 / 2, d0 / 2, z0]]
    t = [[x + dx, y + dy, z0 + h] for x, y, _ in [[-w1 / 2, -d1 / 2, 0], [w1 / 2, -d1 / 2, 0], [w1 / 2, d1 / 2, 0], [-w1 / 2, d1 / 2, 0]]]
    return b + t


n_ids = {}


def uid(base):
    n_ids[base] = n_ids.get(base, 0) + 1
    return base if n_ids[base] == 1 else f"{base}{n_ids[base]}"


SOFT = True  # v2: armour rounded by subdivision (bevel strips round off, main faces stay flat-ish)


def part(name, parent, corners, mat, pos=(0, 0, 0), rot=(0, 0, 0), bevel=0.03, pid=None):
    v, f = chamfer_hex(corners, bevel)
    i = pid or uid(name.lower().replace(" ", "-"))
    C.append({"type": "add", "primitive": "mesh", "id": i, "name": name, "parentId": parent, "mesh": {"vertices": v, "faces": f, "smooth": SOFT}, "material": mat, "transform": {"position": list(pos), "rotation": list(rot)}})
    if SOFT and mat is not JOINT:
        C.append({"type": "setModifiers", "id": i, "modifiers": {"subdivision": {"levels": 1, "sharpAngle": 60}}})
    return i


def groove(target, parent, pos, size, rot=(0, 0, 0)):
    """Cut a panel line into `target` with a thin box (boolean difference)."""
    c = uid("groove")
    w, d, h = size
    C.append({"type": "add", "primitive": "cube", "id": c, "name": "Groove cutter", "parentId": parent, "transform": {"position": list(pos), "rotation": list(rot), "scale": [w / 2, d / 2, h / 2]}})
    C.append({"type": "boolean", "id": target, "cutter": c, "op": "difference"})


def box(name, parent, size, mat, pos=(0, 0, 0), rot=(0, 0, 0), bevel=0.03, taper=(1, 1), shift=(0, 0)):
    w, d, h = size
    return part(name, parent, frustum(w, d, w * taper[0], d * taper[1], h, shift[0], shift[1], -h / 2), mat, pos, rot, min(bevel, w / 3, d / 3, h / 3))


def joint(name, parent, pos, rot=(0, 0, 0), scale=1.0):
    i = uid(name.lower().replace(" ", "-").replace(".", "-"))
    C.append({"type": "add", "primitive": "empty", "id": i, "name": name, "parentId": parent, "transform": {"position": list(pos), "rotation": list(rot), "scale": [scale] * 3}})
    return i


def cyl(name, parent, r, length, mat, pos=(0, 0, 0), rot=(0, 0, 0), seg=20, r2=None):
    i = uid(name.lower().replace(" ", "-"))
    C.append({"type": "add", "primitive": "cylinder", "id": i, "name": name, "parentId": parent, "params": {"radiusTop": r2 if r2 is not None else r, "radiusBottom": r, "segments": seg}, "material": mat, "transform": {"position": list(pos), "rotation": list(rot), "scale": [1, 1, length / 2]}})
    return i


# ---------------------------------------------------------------- body
root = joint("Kestrel", None, (0, 0, 0))
hips = joint("Hips", root, (0, 0, 2.32))
box("Pelvis", hips, (0.62, 0.46, 0.34), GRAPHITE_D, (0, 0, 0), taper=(0.85, 0.9))
box("Crotch plate", hips, (0.26, 0.1, 0.3), ORANGE, (0, -0.25, -0.08), (8, 0, 0), taper=(0.7, 1))
for sx in (1, -1):
    box("Hip skirt", hips, (0.3, 0.42, 0.42), GRAPHITE, (sx * 0.4, 0, -0.08), (0, sx * -10, 0), taper=(0.75, 0.9))
    box("Hip stripe", hips, (0.04, 0.3, 0.28), ORANGE, (sx * 0.56, -0.02, -0.07), (0, sx * -10, 0), bevel=0.01)
waist = joint("Waist", hips, (0, 0, 0.2), (0, 0, 8))
cyl("Abdomen joint", waist, 0.2, 0.3, JOINT, (0, 0, 0.12))
for k in range(3):
    box("Ab plate", waist, (0.36 - k * 0.02, 0.1, 0.1), GRAPHITE, (0, -0.2, 0.04 + k * 0.1), (-6, 0, 0), bevel=0.02)

chest = joint("Chest", waist, (0, 0, 0.3))
chest_id = box("Chest", chest, (0.9, 0.62, 0.66), GRAPHITE, (0, 0.02, 0.33), taper=(1.42, 1.12), shift=(0, 0.04))
for sx in (1, -1):
    box("Chest plate", chest, (0.4, 0.12, 0.46), ORANGE, (sx * 0.23, -0.33, 0.4), (-8, 0, sx * -12), taper=(1.15, 1), bevel=0.035)
groove(chest_id, chest, (0, -0.02, 0.5), (1.4, 0.8, 0.014))
box("Chest ridge", chest, (0.1, 0.16, 0.5), GRAPHITE_D, (0, -0.36, 0.38), (-8, 0, 0), bevel=0.03, taper=(0.7, 1))
for sx in (1, -1):
    for k in range(3):
        box("Side vent", chest, (0.03, 0.22, 0.03), JOINT, (sx * 0.63, -0.05, 0.25 + k * 0.07), bevel=0.008)
box("Collar", chest, (0.6, 0.48, 0.14), GRAPHITE_D, (0, 0.04, 0.68), taper=(0.85, 0.9))
for sx in (1, -1):
    C.append({"type": "add", "primitive": "sphere", "id": uid("collar-lamp"), "name": "Collar lamp", "parentId": chest, "params": {"segments": 12}, "material": LAMP, "transform": {"position": [sx * 0.24, -0.22, 0.7], "rotation": [0, 0, 0], "scale": [0.03, 0.03, 0.03]}})
box("Unit number", chest, (0.16, 0.02, 0.06), DECAL, (0.26, -0.425, 0.28), (-8, 0, -12), bevel=0.004)
# Backpack with two thrusters
box("Backpack", chest, (0.7, 0.36, 0.7), GRAPHITE_D, (0, 0.5, 0.35), taper=(0.9, 0.85))
for sx in (1, -1):
    cyl("Thruster", chest, 0.12, 0.3, JOINT, (sx * 0.2, 0.62, 0.0), (0, 0, 0), r2=0.09)
    cyl("Thruster ring", chest, 0.13, 0.05, STEEL, (sx * 0.2, 0.62, -0.13))
    box("Fin", chest, (0.04, 0.3, 0.42), ORANGE, (sx * 0.38, 0.55, 0.55), (0, 0, sx * 8), bevel=0.012, taper=(1, 0.6))

# Head: compact helmet, one round visor, offset sensor mast
neck = joint("Neck", chest, (0, -0.02, 0.76))
cyl("Neck", neck, 0.1, 0.14, JOINT, (0, 0, 0.05))
head = joint("Head", neck, (0, 0, 0.14), (6, 0, -14), scale=0.98)
box("Helmet", head, (0.38, 0.44, 0.32), GRAPHITE, (0, 0.0, 0.16), taper=(0.8, 0.86), shift=(0, 0.02))
for sx in (1, -1):
    box("Cheek guard", head, (0.06, 0.24, 0.2), GRAPHITE_D, (sx * 0.2, -0.04, 0.1), (0, 0, sx * 10), bevel=0.02, taper=(1, 0.8))
box("Brow", head, (0.36, 0.12, 0.08), ORANGE, (0, -0.17, 0.26), (-12, 0, 0), taper=(0.8, 1), bevel=0.015)
box("Jaw", head, (0.26, 0.14, 0.1), GRAPHITE_D, (0, -0.17, 0.04), (10, 0, 0), taper=(1.1, 1), bevel=0.015)
cyl("Visor rim", head, 0.085, 0.05, JOINT, (0, -0.2, 0.15), (90, 0, 0), seg=28)
cyl("Visor", head, 0.065, 0.03, VISOR, (0, -0.225, 0.15), (90, 0, 0), seg=28)
cyl("Sensor mast", head, 0.012, 0.32, STEEL, (0.14, 0.08, 0.42), (0, -12, 0), seg=8)
C.append({"type": "add", "primitive": "sphere", "id": uid("mast-tip"), "name": "Mast tip", "parentId": head, "params": {"segments": 10}, "material": LAMP, "transform": {"position": [0.173, 0.08, 0.58], "rotation": [0, 0, 0], "scale": [0.02, 0.02, 0.02]}})

# Arms (T-ish rest pose relaxed down; sx = +1 is the mech's left = +X)
def arm(sx, shoulder_rot, elbow_rot):
    sh = joint(f"Shoulder.{'L' if sx > 0 else 'R'}", chest, (sx * 0.76, 0.02, 0.52), shoulder_rot)
    cyl("Shoulder joint", sh, 0.15, 0.24, JOINT, (sx * 0.02, 0, 0), (0, 90, 0))
    box("Pauldron", sh, (0.46, 0.56, 0.4), ORANGE, (sx * 0.12, 0, 0.12), (0, sx * -14, 0), taper=(0.75, 0.85), bevel=0.05)
    box("Pauldron trim", sh, (0.48, 0.58, 0.06), GRAPHITE_D, (sx * 0.12, 0, -0.1), (0, sx * -14, 0), bevel=0.02)
    box("Upper arm", sh, (0.3, 0.32, 0.58), GRAPHITE, (sx * 0.08, 0, -0.42), taper=(0.92, 0.92))
    el = joint("Elbow", sh, (sx * 0.08, 0, -0.76), elbow_rot)
    cyl("Elbow joint", el, 0.11, 0.26, JOINT, (0, 0, 0), (0, 90, 0))
    fa = box("Forearm", el, (0.38, 0.42, 0.64), GRAPHITE, (0, -0.02, -0.35), taper=(0.84, 0.8))
    groove(fa, el, (0, -0.23, -0.35), (0.42, 0.06, 0.014))
    box("Forearm plate", el, (0.07, 0.34, 0.46), ORANGE, (sx * 0.2, -0.02, -0.3), (0, sx * 4, 0), bevel=0.018)
    wr = joint("Wrist", el, (0, -0.02, -0.71))
    box("Hand", wr, (0.24, 0.28, 0.22), JOINT, (0, 0, -0.09), bevel=0.035)
    box("Knuckles", wr, (0.2, 0.08, 0.14), GRAPHITE_D, (0, -0.13, -0.12), (20, 0, 0), bevel=0.02)
    return sh, el, wr


sh_l, el_l, wr_l = arm(1, (4, 16, -4), (-20, 0, 0))
sh_r, el_r, wr_r = arm(-1, (-14, -12, 10), (-48, 0, 14))

# Missile pod on the left shoulder
pod = joint("Missile pod", sh_l, (0.14, 0.12, 0.42), (0, 0, 0))
box("Pod", pod, (0.34, 0.5, 0.28), GRAPHITE_D, (0, 0, 0), taper=(1, 0.95), bevel=0.03)
for i in range(2):
    for j in range(3):
        cyl("Tube", pod, 0.045, 0.06, JOINT, (-0.08 + i * 0.16, -0.25, -0.07 + j * 0.07), (90, 0, 0), seg=12)
box("Pod stripe", pod, (0.36, 0.06, 0.04), ORANGE, (0, 0.12, 0.15), bevel=0.01)

# Carbine in the right hand
gun = joint("Carbine", wr_r, (0, -0.05, -0.12), (90, 0, 0))
box("Receiver", gun, (0.14, 0.7, 0.2), GRAPHITE_D, (0, -0.05, 0), bevel=0.025)
box("Barrel shroud", gun, (0.1, 0.5, 0.12), JOINT, (0, -0.6, 0.02), bevel=0.02)
cyl("Muzzle", gun, 0.035, 0.18, STEEL, (0, -0.92, 0.02), (90, 0, 0), seg=14)
box("Magazine", gun, (0.09, 0.14, 0.3), GRAPHITE, (0, 0.05, -0.2), (12, 0, 0), bevel=0.015)
box("Stock", gun, (0.1, 0.32, 0.16), GRAPHITE, (0, 0.45, -0.03), taper=(1, 0.8), bevel=0.02)
box("Scope", gun, (0.07, 0.24, 0.07), ORANGE, (0, -0.15, 0.15), bevel=0.012)


# Legs
def leg(sx, hip_rot, knee_rot, ankle_rot):
    hp = joint(f"Hip.{'L' if sx > 0 else 'R'}", hips, (sx * 0.24, 0, -0.12), hip_rot)
    cyl("Hip joint", hp, 0.13, 0.22, JOINT, (0, 0, 0), (0, 90, 0))
    th = box("Thigh", hp, (0.38, 0.42, 0.78), GRAPHITE, (0, 0, -0.46), taper=(1.1, 1.06))
    groove(th, hp, (0, 0, -0.62), (0.5, 0.5, 0.014))
    box("Thigh plate", hp, (0.3, 0.08, 0.5), ORANGE, (0, -0.23, -0.42), (3, 0, 0), bevel=0.025, taper=(0.85, 1))
    kn = joint("Knee", hp, (0, 0, -0.92), knee_rot)
    cyl("Knee joint", kn, 0.13, 0.28, JOINT, (0, 0, 0), (0, 90, 0))
    box("Knee pad", kn, (0.34, 0.18, 0.34), ORANGE, (0, -0.21, 0.02), (-14, 0, 0), taper=(0.8, 1), bevel=0.045)
    shin = box("Shin", kn, (0.5, 0.56, 1.0), GRAPHITE, (0, 0.02, -0.54), taper=(0.74, 0.76))
    groove(shin, kn, (0, -0.25, -0.36), (0.6, 0.12, 0.016))
    groove(shin, kn, (0, -0.25, -0.36), (0.016, 0.12, 0.9))
    box("Shin vent", kn, (0.2, 0.05, 0.14), JOINT, (0, -0.3, -0.76), bevel=0.014)
    box("Calf thruster", kn, (0.24, 0.16, 0.46), GRAPHITE_D, (0, 0.33, -0.52), bevel=0.025, taper=(0.9, 0.8))
    an = joint("Ankle", kn, (0, 0.02, -1.06), ankle_rot)
    cyl("Ankle joint", an, 0.09, 0.26, JOINT, (0, 0, 0), (0, 90, 0))
    box("Foot", an, (0.5, 0.8, 0.22), GRAPHITE_D, (0, -0.12, -0.13), taper=(0.9, 0.88), bevel=0.045)
    box("Toe cap", an, (0.46, 0.24, 0.14), ORANGE, (0, -0.5, -0.15), (-10, 0, 0), bevel=0.035, taper=(0.9, 1))
    box("Heel", an, (0.3, 0.18, 0.18), GRAPHITE, (0, 0.28, -0.14), bevel=0.03)


# Wide, planted stance: left leg forward, right back.
leg(1, (-8, -7, -10), (14, 0, 0), (-6, 7, 10))
leg(-1, (10, 8, 12), (16, 0, 0), (-26, -8, -12))

# ---------------------------------------------------------------- stage
C.insert(0, {"type": "setWorld", "world": {"hdri": "photo_studio_loft_hall", "strength": 0.8, "background": "blurred", "exposure": 1.05, "bloom": 0.12, "ao": True}})
C.append({"type": "add", "primitive": "cylinder", "id": "plinth", "name": "Plinth", "params": {"segments": 64}, "material": {"baseColor": "#202326", "metallic": 0.2, "roughness": 0.55}, "transform": {"position": [0, 0, -0.08], "rotation": [0, 0, 0], "scale": [2.2, 2.2, 0.08]}})
C.append({"type": "add", "primitive": "cylinder", "id": "plinth-ring", "name": "Plinth ring", "params": {"segments": 64}, "material": {"baseColor": "#111111", "emission": "#ff6a13", "emissionStrength": 2.5}, "transform": {"position": [0, 0, -0.085], "rotation": [0, 0, 0], "scale": [2.24, 2.24, 0.06]}})
def aim(pos, target):
    """Euler XYZ so a light at pos points its local −Z at target."""
    d = [target[i] - pos[i] for i in range(3)]
    l = math.sqrt(sum(x * x for x in d))
    d = [x / l for x in d]
    a = math.acos(max(-1, min(1, -d[2])))
    c = math.atan2(-d[0], d[1])
    return [round(math.degrees(a), 2), 0, round(math.degrees(c), 2)]


for lid, name, pos, power, angle, shadows, color in [
    ("key", "Key light", (-4.5, -6, 7), 7000, 55, True, "#fff3e6"),
    ("fill", "Fill light", (5, -5, 3.5), 2500, 70, False, "#e8eeff"),
    ("rim", "Rim light", (5, 6, 6), 3500, 50, False, "#9fd8ff"),
]:
    C.append({"type": "add", "primitive": "light", "id": lid, "name": name, "light": {"type": "spot", "power": power, "spotAngle": angle, "shadows": shadows, "color": color}, "transform": {"position": list(pos), "rotation": aim(pos, (0, 0, 2.3))}})
C.append({"type": "setAnimation", "start": 1, "end": 240})
C.append({"type": "cameraMove", "move": "orbit", "target": [0, 0, 2.5], "start": 1, "end": 240, "distance": 6.4, "height": -1.5, "heading": 245, "degrees": 360, "smooth": False})

out = {"format": "b3d-studio-script", "version": 1, "title": "Scout mech (modelled)", "commands": C}
Path(__file__).resolve().parents[1].joinpath("scout-mech.b3d-script.json").write_text(json.dumps(out, separators=(",", ":")))
print(len(C), "commands")
