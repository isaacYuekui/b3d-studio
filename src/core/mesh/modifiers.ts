// Non-destructive modifiers, evaluated in order: Mirror, Bevel, then Subdivision Surface
// (Catmull–Clark, with creases on sharp edges), like Blender's stack. The editable mesh (the
// "cage") stays as it is.

import type { MeshData, Modifiers } from '../types';
import type { V } from './topology';
import { add, compact, ek, edgeMap, newell, scale } from './topology';
import { bevel as bevelOp } from './ops';

export const MAX_SUBDIV_FACES = 400_000;

export function hasModifiers(m?: Modifiers): boolean {
  return !!m && (!!(m.mirror && (m.mirror.x || m.mirror.y || m.mirror.z)) || (m.subdivision?.levels ?? 0) > 0 || (m.bevel?.width ?? 0) > 0);
}

export function applyModifiers(mesh: MeshData, mods?: Modifiers): MeshData {
  if (!hasModifiers(mods)) return mesh;
  let out = mesh;
  if (mods!.mirror) {
    const { x, y, z, merge = 0.001 } = mods!.mirror;
    ([x, y, z] as (boolean | undefined)[]).forEach((on, axis) => {
      if (on) out = mirror(out, axis as 0 | 1 | 2, merge);
    });
  }
  if (mods!.bevel && mods!.bevel.width > 0) {
    const edges = sharpEdges(out, mods!.bevel.angle);
    if (edges.size) {
      try {
        out = bevelOp(out, { verts: [], edges: [...edges], faces: [] }, mods!.bevel.width, Math.max(1, Math.min(6, Math.round(mods!.bevel.segments)))).mesh;
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
  return out;
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
  return compact({ vertices, faces, smooth: mesh.smooth }).mesh;
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
  mesh.faces.forEach((f, fi) => {
    for (let i = 0; i < f.length; i++) {
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
  return { mesh: { vertices: out, faces, smooth: mesh.smooth }, creases: next };
}
