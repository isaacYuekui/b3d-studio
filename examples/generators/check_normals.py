"""Sanity check: are a mesh's faces pointing outwards? (fraction of faces whose normal
points away from the mesh's centre line)."""
import sys
sys.path.insert(0, 'examples/generators')
from supercar import body_mesh, canopy_mesh


def outward(mesh, axis_z):
    V, F = mesh["vertices"], mesh["faces"]
    ok = tot = 0
    for f in F:
        a, b, c = V[f[0]], V[f[1]], V[f[2]]
        u = [b[i] - a[i] for i in range(3)]
        v = [c[i] - a[i] for i in range(3)]
        nrm = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]]
        if sum(x * x for x in nrm) < 1e-12:
            continue
        cen = [sum(V[i][k] for i in f) / len(f) for k in range(3)]
        d = [0 if len(f) > 4 else 0, cen[1], cen[2] - axis_z]
        if len(f) > 4:
            d = [cen[0], 0, 0]  # end caps: outward along X
        tot += 1
        ok += sum(nrm[i] * d[i] for i in range(3)) > 0
    return ok, tot


for name, mesh, az in (("body", body_mesh(), 0.5), ("canopy", canopy_mesh(), 0.75)):
    ok, tot = outward(mesh, az)
    print(f"{name}: {ok}/{tot} faces outward")
