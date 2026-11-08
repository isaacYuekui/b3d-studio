"""An original angular supercar for B3D Studio scene scripts.

Not modelled on any real brand. Built from hard-edged cross-sections lofted along
the car (flat shading keeps every crease crisp), a separate faceted glass canopy,
tucked-in wheel arches, and five-spoke wheels on steerable hubs.

Car space (Blender conventions): +X forward, +Y left, Z up, metres. Origin on the
ground under the middle of the car. Length 4.55 m, width 2.0 m, height 1.13 m.

    from supercar import build_car
    build_car(add, parent="car", paint="#a50f12")
"""

import math

# ---------------------------------------------------------------- body sections
# Each station: x, then the half-profile parameters
#   zb  underbody height        wl  lower-side half width     zr  rocker/arch-liner top
#   ws  shoulder half width     zs  shoulder crease height
#   wd  deck edge half width    zd  deck edge height          zc  centreline top height
FIELDS = ("zb", "wl", "zr", "ws", "zs", "wd", "zd", "zc")
STATIONS = [
    # tail
    (-2.27, 0.30, 0.80, 0.38, 0.92, 0.74, 0.84, 0.86, 0.88),
    (-2.17, 0.20, 0.88, 0.32, 0.98, 0.79, 0.88, 0.91, 0.93),
    (-1.96, 0.13, 0.92, 0.24, 1.00, 0.82, 0.88, 0.93, 0.96),
    # rear wheel arch (lower side tucks in behind the wheel)
    (-1.80, 0.12, 0.92, 0.24, 1.00, 0.85, 0.87, 0.95, 0.97),
    (-1.76, 0.12, 0.62, 0.55, 1.00, 0.86, 0.87, 0.95, 0.97),
    (-1.38, 0.12, 0.62, 0.58, 1.00, 0.88, 0.86, 0.95, 0.97),
    (-1.00, 0.12, 0.62, 0.55, 1.00, 0.86, 0.86, 0.94, 0.96),
    # side intake scallop
    (-0.96, 0.12, 0.78, 0.26, 1.00, 0.84, 0.86, 0.93, 0.95),
    (-0.55, 0.12, 0.80, 0.26, 0.99, 0.80, 0.84, 0.88, 0.90),
    # doors (cabin sits on this deck)
    (-0.20, 0.12, 0.92, 0.24, 0.98, 0.77, 0.82, 0.84, 0.86),
    (0.45, 0.12, 0.92, 0.24, 0.98, 0.75, 0.82, 0.80, 0.82),
    (0.95, 0.12, 0.92, 0.24, 0.98, 0.74, 0.84, 0.76, 0.76),
    # front wheel arch; fenders stand proud of a lower bonnet
    (1.08, 0.12, 0.92, 0.24, 0.98, 0.75, 0.86, 0.75, 0.72),
    (1.12, 0.12, 0.62, 0.52, 0.98, 0.76, 0.86, 0.75, 0.70),
    (1.42, 0.12, 0.62, 0.55, 0.98, 0.76, 0.86, 0.72, 0.65),
    (1.76, 0.13, 0.62, 0.50, 0.96, 0.68, 0.84, 0.64, 0.57),
    # nose
    (1.80, 0.14, 0.86, 0.22, 0.95, 0.64, 0.82, 0.61, 0.55),
    (2.08, 0.16, 0.84, 0.21, 0.88, 0.48, 0.76, 0.48, 0.45),
    (2.28, 0.21, 0.70, 0.24, 0.72, 0.33, 0.62, 0.36, 0.35),
]


def _half_profile(st):
    """Half cross-section from underbody centre round to the top centre (y >= 0)."""
    p = dict(zip(FIELDS, st[1:]))
    zc_mid = p["zd"] + (p["zc"] - p["zd"]) * 0.9
    return [
        (0.0, p["zb"]),
        (p["wl"], p["zb"]),
        (p["wl"] + 0.02, p["zr"]),
        (p["ws"], p["zs"]),
        (p["wd"], p["zd"]),
        (p["wd"] * 0.45, zc_mid),
        (0.0, p["zc"]),
    ]


def _ring(st):
    """Full closed ring, counter-clockwise when viewed from the front (+X)."""
    half = _half_profile(st)
    x = st[0]
    right = [(x, -y, z) for (y, z) in half]               # bottom centre -> top centre, right side
    left = [(x, y, z) for (y, z) in reversed(half[1:-1])]  # top -> bottom, left side (skip shared centre points)
    return [list(map(lambda v: round(v, 4), pt)) for pt in right + left]


def _loft(rings, cap_ends=True):
    n = len(rings[0])
    verts = [v for r in rings for v in r]
    faces = []
    for j in range(len(rings) - 1):
        for i in range(n):
            a, b = j * n + i, j * n + (i + 1) % n
            faces.append([a, a + n, b + n, b])
    if cap_ends:
        last = (len(rings) - 1) * n
        faces.append(list(range(n))[::-1])
        faces.append([last + i for i in range(n)])
    return {"vertices": verts, "faces": faces, "smooth": False}


def body_mesh():
    return _loft([_ring(st) for st in STATIONS])


def surface_z(x, y):
    """Height of the top surface at (x, |y|), for placing details on the body."""
    for a, b in zip(STATIONS, STATIONS[1:]):
        if a[0] <= x <= b[0]:
            t = (x - a[0]) / (b[0] - a[0])
            st = (x,) + tuple(av + (bv - av) * t for av, bv in zip(a[1:], b[1:]))
            break
    else:
        st = STATIONS[0] if x < STATIONS[0][0] else STATIONS[-1]
    top = _half_profile(st)[3:]  # shoulder -> deck edge -> crown -> centre
    y = abs(y)
    for (y0, z0), (y1, z1) in zip(top, top[1:]):
        if y1 <= y <= y0:
            return z0 + (z1 - z0) * (y0 - y) / (y0 - y1)
    return top[-1][1]


# ---------------------------------------------------------------- canopy
# x, bottom half width, top half width, top height (bottom follows the deck edge)
CANOPY = [
    (-0.92, 0.80, 0.62, 0.955),
    (-0.62, 0.80, 0.55, 1.05),
    (-0.25, 0.79, 0.50, 1.13),
    (0.10, 0.79, 0.50, 1.12),
    (0.50, 0.80, 0.56, 0.99),
    (0.98, 0.82, 0.70, 0.80),
]


def canopy_mesh():
    rings = []
    for x, wb, wt, zt in CANOPY:
        zbot = surface_z(x, wb) - 0.03  # tuck just under the deck
        rings.append([
            [x, -wb, round(zbot, 4)],
            [x, -wt, zt],
            [x, -wt * 0.4, zt + 0.012],
            [x, wt * 0.4, zt + 0.012],
            [x, wt, zt],
            [x, wb, round(zbot, 4)],
        ])
    return _loft(rings)


# ---------------------------------------------------------------- assembly
def build_car(add, parent, paint="#a50f12", prefix=""):
    """Add the car's parts as children of `parent` (an existing object id)."""
    P = {"baseColor": paint, "metallic": 0.82, "roughness": 0.24}
    carbon = {"baseColor": "#121314", "metallic": 0.5, "roughness": 0.38}
    matte = {"baseColor": "#0d0e0f", "metallic": 0, "roughness": 0.75}
    glass = {"baseColor": "#07090c", "metallic": 0.35, "roughness": 0.05}
    rubber = {"baseColor": "#141414", "roughness": 0.88}
    rim = {"baseColor": "#2b2e33", "metallic": 1, "roughness": 0.3}
    spoke_mat = {"baseColor": "#9aa0a8", "metallic": 1, "roughness": 0.22}
    caliper = {"baseColor": "#d4a017", "metallic": 0.3, "roughness": 0.4}
    n = lambda s: f"{prefix}{s}"

    add(primitive="mesh", id=n("body"), name=n("Body"), parentId=parent, mesh=body_mesh(), material=P)
    add(primitive="mesh", name=n("Canopy"), parentId=parent, mesh=canopy_mesh(), material=glass)

    # Engine cover slats behind the canopy
    for i, x in enumerate([-1.05, -1.2, -1.35, -1.5, -1.65]):
        z = surface_z(x, 0) + 0.004
        add(primitive="cube", name=n(f"Slat.{i}"), parentId=parent,
            transform={"position": [x, 0, round(z, 3)], "scale": [0.025, 0.42, 0.006]}, material=matte)

    # Lights: slim blades on the nose and a full-width tail bar
    for side, tag in ((1, "L"), (-1, "R")):
        x, y = 1.98, side * 0.6
        z = surface_z(x, y)
        add(primitive="cube", name=n(f"Headlight.{tag}"), parentId=parent,
            transform={"position": [x, y, round(z + 0.004, 3)], "rotation": [side * -8, -24, side * -22], "scale": [0.17, 0.035, 0.008]},
            material={"baseColor": "#ffffff", "emission": "#eef4ff", "emissionStrength": 10})
        add(primitive="cube", name=n(f"Front Intake.{tag}"), parentId=parent,
            transform={"position": [2.2, side * 0.42, 0.29], "rotation": [0, -14, 0], "scale": [0.04, 0.24, 0.05]}, material=carbon)
    add(primitive="cube", name=n("Taillight"), parentId=parent, transform={"position": [-2.278, 0, 0.7], "scale": [0.01, 0.82, 0.016]},
        material={"baseColor": "#ff2418", "emission": "#ff1508", "emissionStrength": 8})

    # Aero
    add(primitive="cube", name=n("Splitter"), parentId=parent, transform={"position": [2.15, 0, 0.17], "scale": [0.1, 0.74, 0.01]}, material=matte)
    add(primitive="cube", name=n("Diffuser"), parentId=parent, transform={"position": [-2.15, 0, 0.24], "scale": [0.14, 0.72, 0.06]}, material=carbon)
    for side in (-1, 1):
        add(primitive="cylinder", name=n(f"Exhaust.{'L' if side > 0 else 'R'}"), parentId=parent, params={"segments": 20},
            transform={"position": [-2.22, side * 0.13, 0.36], "rotation": [0, 90, 0], "scale": [0.055, 0.055, 0.08]},
            material={"baseColor": "#3a3a3a", "metallic": 1, "roughness": 0.35})
    add(primitive="cube", name=n("Wing"), parentId=parent, transform={"position": [-2.0, 0, 1.08], "rotation": [0, 7, 0], "scale": [0.17, 0.9, 0.014]}, material=carbon)
    for side in (-1, 1):
        add(primitive="cube", name=n(f"Wing Strut.{'L' if side > 0 else 'R'}"), parentId=parent,
            transform={"position": [-2.0, side * 0.5, 1.0], "rotation": [0, 15, 0], "scale": [0.06, 0.01, 0.08]}, material=carbon)

    # Mirrors on short stalks at the base of the canopy
    for side, tag in ((1, "L"), (-1, "R")):
        z = surface_z(0.62, 0.85)
        add(primitive="cube", name=n(f"Mirror.{tag}"), parentId=parent,
            transform={"position": [0.62, side * 0.95, round(z + 0.07, 3)], "rotation": [0, 0, side * 8], "scale": [0.07, 0.09, 0.04]}, material=P)

    # Wheels: tyre, gunmetal rim face, five machined spokes, centre lock, caliper
    for wx, side, tag, steer in ((1.42, 1, "FL", 8), (1.42, -1, "FR", 8), (-1.38, 1, "RL", 0), (-1.38, -1, "RR", 0)):
        front = wx > 0
        r = 0.355 if front else 0.365
        w = 0.27 if front else 0.33
        hub = n(f"wheel_{tag}")
        add(primitive="empty", id=hub, name=n(f"Wheel.{tag}"), parentId=parent,
            transform={"position": [wx, side * (0.985 - w / 2), r], "rotation": [0, 0, steer]})
        out = side * (w / 2)
        add(primitive="cylinder", name=n(f"Tyre.{tag}"), parentId=hub, params={"segments": 48},
            transform={"rotation": [90, 0, 0], "scale": [r, r, w / 2]}, material=rubber)
        add(primitive="cylinder", name=n(f"Rim.{tag}"), parentId=hub, params={"segments": 40},
            transform={"position": [0, out + side * 0.004, 0], "rotation": [90, 0, 0], "scale": [r * 0.74, r * 0.74, 0.004]}, material=rim)
        # tyre sidewall lip, so the rim reads as set into the tyre
        add(primitive="torus", name=n(f"Sidewall.{tag}"), parentId=hub, params={"majorRadius": 1, "minorRadius": 0.07, "segments": 40},
            transform={"position": [0, out, 0], "rotation": [90, 0, 0], "scale": [r * 0.86, r * 0.86, r * 0.86]}, material=rubber)
        add(primitive="cube", name=n(f"Caliper.{tag}"), parentId=hub,
            transform={"position": [-0.1 if front else 0.1, out + side * 0.012, 0.1], "rotation": [0, -35 if front else 35, 0], "scale": [0.05, 0.006, 0.075]}, material=caliper)
        for k in range(5):
            th = 2 * math.pi * k / 5 + 0.3
            rm = r * 0.4
            add(primitive="cube", name=n(f"Spoke.{tag}.{k}"), parentId=hub,
                transform={"position": [round(rm * math.cos(th), 4), out + side * 0.02, round(-rm * math.sin(th), 4)],
                           "rotation": [0, round(math.degrees(th), 2), 0], "scale": [r * 0.36, 0.012, 0.028]}, material=spoke_mat)
        add(primitive="cylinder", name=n(f"Centre Lock.{tag}"), parentId=hub, params={"segments": 6},
            transform={"position": [0, out + side * 0.03, 0], "rotation": [90, 0, 0], "scale": [0.05, 0.05, 0.015]}, material=spoke_mat)
