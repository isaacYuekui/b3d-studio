// Non-destructive modifiers, evaluated in a fixed order like a typical Blender stack:
// Mirror → Array → Solidify → Bevel → Subdivision Surface (Catmull–Clark, with creases on sharp
// edges) → Displace. The editable mesh (the "cage") stays as it is.

import type { MeshData, Modifiers } from '../types';
import type { V } from './topology';
import { add, compact, ek, edgeMap, newell, scale } from './topology';
import { bevel as bevelOp } from './ops';
import { transferMaterialIndex, usesSlots, withMaterialIndex } from './materialIndex';
import { validUv } from './uv';
import { DEFAULT_CURVE, curveTube } from '../curve';
import { vertexNormals } from './sculpt';

export const MAX_SUBDIV_FACES = 400_000;

export function hasModifiers(m?: Modifiers): boolean {
  return (
    !!m &&
    (!!(m.mirror && (m.mirror.x || m.mirror.y || m.mirror.z)) ||
      (m.subdivision?.levels ?? 0) > 0 ||
      (m.bevel?.width ?? 0) > 0 ||
      (m.array?.count ?? 1) > 1 ||
      !!m.solidify?.thickness ||
      !!m.displace?.strength ||
      !!m.curve)
  );
}

export function applyModifiers(mesh: MeshData, mods?: Modifiers): MeshData {
  if (!hasModifiers(mods)) return mesh;
  let out = mesh;
  // A curve object's points become a tube first; the other modifiers then work on the tube.
  if (mods!.curve) out = curveTube(out.vertices, { ...DEFAULT_CURVE, ...mods!.curve });
  if (mods!.mirror) {
    const { x, y, z, merge = 0.001 } = mods!.mirror;
    ([x, y, z] as (boolean | undefined)[]).forEach((on, axis) => {
      if (on) out = mirror(out, axis as 0 | 1 | 2, merge);
    });
  }
  if (mods!.array && mods!.array.count > 1) {
    const a = mods!.array;
    out = arrayModifier(out, a.count, a.relative, a.constant, a.merge !== false);
  }
  if (mods!.solidify?.thickness) {
    const so = mods!.solidify;
    out = solidify(out, so.thickness, so.offset ?? -1, so.rim !== false);
  }
  if (mods!.bevel && mods!.bevel.width > 0) {
    const edges = sharpEdges(out, mods!.bevel.angle);
    if (edges.size) {
      try {
        const before = out;
        out = bevelOp(out, { verts: [], edges: [...edges], faces: [] }, mods!.bevel.width, Math.max(1, Math.min(6, Math.round(mods!.bevel.segments)))).mesh;
        if (usesSlots(before)) out = withMaterialIndex(out, transferMaterialIndex(before, out));
      } catch {
        /* geometry the bevel can't handle (e.g. non-manifold): leave it unbevelled */
      }
    }
  }
  let levels = Math.max(0, Math.min(4, Math.round(mods!.subdivision?.levels ?? 0)));
  const sharpAngle = mods!.subdivision?.sharpAngle;
  let creases = levels > 0 && sharpAngle !== undefined ? sharpEdges(out, sharpAngle) : undefined;
  while (levels > 0 && estimateFaces(out) * 4 <= MAX_SUBDIV_FACES) {
    const r = catmullClarkCreased(out, creases);
    out = r.mesh;
    creases = r.creases;
    levels--;
  }
  if (mods!.displace?.strength) {
    const d = mods!.displace;
    out = displace(out, d.strength, d.scale, d.seed ?? 0);
  }
  return out;
}

const bounds = (vs: V[]) => {
  const lo: V = [Infinity, Infinity, Infinity], hi: V = [-Infinity, -Infinity, -Infinity];
  for (const v of vs)
    for (let k = 0; k < 3; k++) {
      if (v[k] < lo[k]) lo[k] = v[k];
      if (v[k] > hi[k]) hi[k] = v[k];
    }
  return { lo, hi, size: [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]] as V };
};

/**
 * Array modifier: `count` copies, each shifted by relative × size + constant. With `merge`, a
 * vertex that lands on the previous copy's vertex is welded to it and the faces the two copies
 * share (back to back) are removed, so touching copies become one clean solid.
 */
export function arrayModifier(mesh: MeshData, count: number, relative: V, constant: V = [0, 0, 0], merge = true, distance = 0.001): MeshData {
  const corners = Math.max(1, estimateFaces(mesh));
  const n = Math.max(1, Math.min(Math.round(count), 1000, Math.floor(MAX_SUBDIV_FACES / corners)));
  if (n <= 1 || !mesh.vertices.length) return mesh;
  const { size } = bounds(mesh.vertices);
  const off: V = [0, 1, 2].map((k) => relative[k] * size[k] + constant[k]) as V;
  const nv = mesh.vertices.length;
  // match[i] = j when vertex i of a copy sits on vertex j of the copy before it.
  const match = new Array<number>(nv).fill(-1);
  if (merge) {
    const cell = Math.max(distance, 1e-9) * 2;
    const key = (p: V) => `${Math.floor(p[0] / cell)},${Math.floor(p[1] / cell)},${Math.floor(p[2] / cell)}`;
    const grid = new Map<string, number[]>();
    mesh.vertices.forEach((p, j) => {
      const k = key(p);
      const list = grid.get(k);
      if (list) list.push(j);
      else grid.set(k, [j]);
    });
    mesh.vertices.forEach((p, i) => {
      const q: V = [p[0] + off[0], p[1] + off[1], p[2] + off[2]];
      const c = [0, 1, 2].map((k) => Math.floor(q[k] / cell));
      for (let dx = -1; dx <= 1 && match[i] < 0; dx++)
        for (let dy = -1; dy <= 1 && match[i] < 0; dy++)
          for (let dz = -1; dz <= 1 && match[i] < 0; dz++)
            for (const j of grid.get(`${c[0] + dx},${c[1] + dy},${c[2] + dz}`) ?? [])
              if (Math.hypot(mesh.vertices[j][0] - q[0], mesh.vertices[j][1] - q[1], mesh.vertices[j][2] - q[2]) <= distance) {
                match[i] = j;
                break;
              }
    });
  }
  const vertices: V[] = [];
  const target: number[] = [];
  for (let c = 0; c < n; c++)
    mesh.vertices.forEach((v, i) => {
      vertices.push([v[0] + off[0] * c, v[1] + off[1] * c, v[2] + off[2] * c]);
      target.push(c > 0 && match[i] >= 0 ? target[(c - 1) * nv + match[i]] : c * nv + i);
    });
  let faces: number[][] = [];
  let index: number[] | undefined = usesSlots(mesh) ? [] : undefined;
  for (let c = 0; c < n; c++)
    mesh.faces.forEach((f, fi) => {
      faces.push(f.map((v) => target[c * nv + v]));
      index?.push(mesh.materialIndex![fi]);
    });
  if (merge) {
    // Faces where two copies touch now use the same corners: drop both.
    const seen = new Map<string, number>();
    const keyOf = (f: number[]) => [...f].sort((a, b) => a - b).join(',');
    for (const f of faces) {
      const k = keyOf(f);
      seen.set(k, (seen.get(k) ?? 0) + 1);
    }
    const keep = faces.map((f) => seen.get(keyOf(f)) === 1);
    faces = faces.filter((_, i) => keep[i]);
    index = index?.filter((_, i) => keep[i]);
  }
  return compact({ vertices, faces, smooth: mesh.smooth }, index).mesh;
}

/**
 * Solidify modifier: a second, inward-facing copy of the surface `thickness` metres away along
 * the vertex normals, joined to the first along open edges (the rim).
 */
export function solidify(mesh: MeshData, thickness: number, offset = -1, rim = true): MeshData {
  if (!thickness || !mesh.faces.length) return mesh;
  const normals = vertexNormals(mesh.vertices, mesh.faces);
  const a = (thickness * (offset + 1)) / 2;
  const b = (thickness * (offset - 1)) / 2;
  const nv = mesh.vertices.length;
  const vertices: V[] = [
    ...mesh.vertices.map((v, i) => [v[0] + normals[i][0] * a, v[1] + normals[i][1] * a, v[2] + normals[i][2] * a] as V),
    ...mesh.vertices.map((v, i) => [v[0] + normals[i][0] * b, v[1] + normals[i][1] * b, v[2] + normals[i][2] * b] as V),
  ];
  // A negative thickness puts the copy outside: flip both shells so normals still face out.
  const flip = thickness < 0;
  const outer = mesh.faces.map((f) => (flip ? [...f].reverse() : [...f]));
  const inner = mesh.faces.map((f) => (flip ? f.map((v) => v + nv) : [...f].reverse().map((v) => v + nv)));
  const faces = [...outer, ...inner];
  const mi = usesSlots(mesh) ? mesh.materialIndex! : null;
  const index = mi ? [...mi, ...mi] : null;
  if (rim)
    for (const e of edgeMap(mesh).values()) {
      if (e.faces.length !== 1) continue;
      // The edge's direction in its face, so the rim quad runs the other way (consistent winding).
      const f = mesh.faces[e.faces[0]];
      const i = f.indexOf(e.a);
      const [p, q] = f[(i + 1) % f.length] === e.b ? [e.a, e.b] : [e.b, e.a];
      const quad = [q, p, p + nv, q + nv];
      faces.push(flip ? quad.reverse() : quad);
      index?.push(mi![e.faces[0]]);
    }
  return withMaterialIndex({ vertices, faces, smooth: mesh.smooth }, index ?? undefined);
}

// Value noise on a lattice, hashed from integer coordinates (deterministic, no tables).
const hash3 = (x: number, y: number, z: number, seed: number) => {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(z, 2147483647) + Math.imul(seed, 1442695041)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return ((h >>> 0) / 4294967295) * 2 - 1;
};
const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** Smooth 3D value noise, about −1..1. */
export function noise3(x: number, y: number, z: number, seed = 0): number {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const u = fade(x - xi), v = fade(y - yi), w = fade(z - zi);
  const c = (dx: number, dy: number, dz: number) => hash3(xi + dx, yi + dy, zi + dz, seed);
  return lerp(
    lerp(lerp(c(0, 0, 0), c(1, 0, 0), u), lerp(c(0, 1, 0), c(1, 1, 0), u), v),
    lerp(lerp(c(0, 0, 1), c(1, 0, 1), u), lerp(c(0, 1, 1), c(1, 1, 1), u), v),
    w,
  );
}

/** Fractal noise (4 octaves), about −1..1. */
export function fbm3(x: number, y: number, z: number, seed = 0): number {
  let sum = 0, amp = 0.5, f = 1, norm = 0;
  for (let o = 0; o < 4; o++) {
    sum += noise3(x * f, y * f, z * f, seed + o * 101) * amp;
    norm += amp;
    amp *= 0.5;
    f *= 2.03;
  }
  return sum / norm;
}

/** Displace modifier: move every vertex along its normal by strength × noise(position / scale). */
export function displace(mesh: MeshData, strength: number, scale: number, seed = 0): MeshData {
  if (!strength) return mesh;
  const normals = vertexNormals(mesh.vertices, mesh.faces);
  const s = 1 / Math.max(scale, 1e-3);
  const vertices = mesh.vertices.map((v, i) => {
    const d = fbm3(v[0] * s, v[1] * s, v[2] * s, seed) * strength;
    return [v[0] + normals[i][0] * d, v[1] + normals[i][1] * d, v[2] + normals[i][2] * d] as V;
  });
  return { ...mesh, vertices };
}

/** Edges whose two faces meet at more than `angle` degrees (0 = every edge between two faces). */
export function sharpEdges(mesh: MeshData, angle: number): Set<string> {
  const normals = mesh.faces.map((f) => {
    const n = newell(mesh.vertices, f);
    const l = Math.hypot(n[0], n[1], n[2]) || 1;
    return [n[0] / l, n[1] / l, n[2] / l];
  });
  const lim = Math.cos((angle * Math.PI) / 180);
  const out = new Set<string>();
  for (const [k, e] of edgeMap(mesh)) {
    if (e.faces.length !== 2) continue;
    const [a, b] = e.faces.map((f) => normals[f]);
    if (a[0] * b[0] + a[1] * b[1] + a[2] * b[2] < lim - 1e-9) out.add(k);
  }
  return out;
}

const estimateFaces = (m: MeshData) => m.faces.reduce((s, f) => s + f.length, 0);

/** Mirror across a local axis plane, welding vertices that lie on the plane. */
export function mirror(mesh: MeshData, axis: 0 | 1 | 2, merge = 0.001): MeshData {
  const vertices: V[] = mesh.vertices.map((v) => [...v] as V);
  const map: number[] = [];
  mesh.vertices.forEach((v, i) => {
    if (Math.abs(v[axis]) <= merge) {
      map[i] = i; // on the plane: shared
      vertices[i][axis] = 0;
    } else {
      const m = [...v] as V;
      m[axis] = -m[axis];
      map[i] = vertices.length;
      vertices.push(m);
    }
  });
  const faces = [...mesh.faces, ...mesh.faces.map((f) => [...f].reverse().map((v) => map[v]))];
  const index = usesSlots(mesh) ? [...mesh.materialIndex!, ...mesh.materialIndex!] : undefined;
  return compact({ vertices, faces, smooth: mesh.smooth }, index).mesh;
}

/** One Catmull–Clark step. Boundary edges and vertices use the standard crease rules. */
export function catmullClark(mesh: MeshData): MeshData {
  return catmullClarkCreased(mesh).mesh;
}

/**
 * Catmull–Clark with sharp (creased) edges: a crease edge's new point is its midpoint; a vertex on
 * two crease edges follows the crease curve (6P + a + b) / 8; on three or more it stays a corner.
 * Returns the creases of the refined mesh (the two halves of every crease edge).
 */
export function catmullClarkCreased(mesh: MeshData, creases?: Set<string>): { mesh: MeshData; creases?: Set<string> } {
  const vs = mesh.vertices;
  const fp: V[] = mesh.faces.map((f) => scale(f.reduce<V>((s, v) => add(s, vs[v]), [0, 0, 0]), 1 / f.length));
  // Edge → adjacent faces
  const edges = new Map<string, { a: number; b: number; faces: number[] }>();
  mesh.faces.forEach((f, fi) => {
    for (let i = 0; i < f.length; i++) {
      const a = f[i], b = f[(i + 1) % f.length];
      const k = ek(a, b);
      let e = edges.get(k);
      if (!e) edges.set(k, (e = { a, b, faces: [] }));
      e.faces.push(fi);
    }
  });
  const nv = vs.length;
  const out: V[] = [];
  // Edge points
  const epIndex = new Map<string, number>();
  const epPos: V[] = [];
  for (const [k, e] of edges) {
    const mid = scale(add(vs[e.a], vs[e.b]), 0.5);
    const p = e.faces.length === 2 && !creases?.has(k) ? scale(add(add(vs[e.a], vs[e.b]), add(fp[e.faces[0]], fp[e.faces[1]])), 0.25) : mid;
    epIndex.set(k, epPos.length);
    epPos.push(p);
  }
  // Vertex points
  const vFaces: number[][] = vs.map(() => []);
  const vEdges: string[][] = vs.map(() => []);
  mesh.faces.forEach((f, fi) => f.forEach((v) => vFaces[v].push(fi)));
  for (const [k, e] of edges) {
    vEdges[e.a].push(k);
    vEdges[e.b].push(k);
  }
  for (let v = 0; v < nv; v++) {
    const P = vs[v];
    const es = vEdges[v];
    if (!es.length) {
      out.push(P);
      continue;
    }
    const boundary = es.filter((k) => edges.get(k)!.faces.length === 1 || creases?.has(k));
    if (boundary.length) {
      if (boundary.length === 2) {
        const mids = boundary.map((k) => {
          const e = edges.get(k)!;
          return scale(add(vs[e.a], vs[e.b]), 0.5);
        });
        out.push(add(scale(P, 0.5), scale(add(mids[0], mids[1]), 0.25)));
      } else out.push(P); // corner / non-manifold: keep
      continue;
    }
    const n = vFaces[v].length;
    const F = scale(vFaces[v].reduce<V>((s, f) => add(s, fp[f]), [0, 0, 0]), 1 / n);
    const R = scale(es.reduce<V>((s, k) => {
      const e = edges.get(k)!;
      return add(s, scale(add(vs[e.a], vs[e.b]), 0.5));
    }, [0, 0, 0]), 1 / es.length);
    const m = es.length;
    out.push(scale(add(add(F, scale(R, 2)), scale(P, m - 3)), 1 / m));
  }
  const epBase = out.length;
  out.push(...epPos);
  const fpBase = out.length;
  out.push(...fp);
  const faces: number[][] = [];
  const index: number[] | undefined = usesSlots(mesh) ? [] : undefined;
  // UV map: each new quad takes its corner, two edge midpoints and the face centre in UV space too.
  const uvIn = validUv(mesh) ? mesh.uv! : null;
  const uvOut: [number, number][][] | undefined = uvIn ? [] : undefined;
  mesh.faces.forEach((f, fi) => {
    const fu = uvIn?.[fi];
    const cu: [number, number] | null = fu ? [fu.reduce((a, p) => a + p[0], 0) / fu.length, fu.reduce((a, p) => a + p[1], 0) / fu.length] : null;
    for (let i = 0; i < f.length; i++) {
      index?.push(mesh.materialIndex![fi]);
      if (fu && cu) {
        const a = fu[i], b = fu[(i + 1) % f.length], c = fu[(i - 1 + f.length) % f.length];
        uvOut!.push([a, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], cu, [(a[0] + c[0]) / 2, (a[1] + c[1]) / 2]]);
      }
      const v = f[i];
      const next = f[(i + 1) % f.length];
      const prev = f[(i - 1 + f.length) % f.length];
      faces.push([v, epBase + epIndex.get(ek(v, next))!, fpBase + fi, epBase + epIndex.get(ek(prev, v))!]);
    }
  });
  let next: Set<string> | undefined;
  if (creases?.size) {
    next = new Set();
    for (const k of creases) {
      const e = edges.get(k);
      if (!e) continue;
      const ep = epBase + epIndex.get(k)!;
      next.add(ek(e.a, ep));
      next.add(ek(e.b, ep));
    }
  }
  const result = withMaterialIndex({ vertices: out, faces, smooth: mesh.smooth }, index);
  if (uvOut) result.uv = uvOut;
  return { mesh: result, creases: next };
}
