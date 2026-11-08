// Non-destructive modifiers, evaluated in order: Mirror, then Subdivision Surface
// (Catmull–Clark), like Blender's stack. The editable mesh (the "cage") stays as it is.

import type { MeshData, Modifiers } from '../types';
import type { V } from './topology';
import { add, compact, ek, scale } from './topology';

export const MAX_SUBDIV_FACES = 400_000;

export function hasModifiers(m?: Modifiers): boolean {
  return !!m && (!!(m.mirror && (m.mirror.x || m.mirror.y || m.mirror.z)) || (m.subdivision?.levels ?? 0) > 0);
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
  let levels = Math.max(0, Math.min(4, Math.round(mods!.subdivision?.levels ?? 0)));
  while (levels > 0 && estimateFaces(out) * 4 <= MAX_SUBDIV_FACES) {
    out = catmullClark(out);
    levels--;
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
    const p = e.faces.length === 2 ? scale(add(add(vs[e.a], vs[e.b]), add(fp[e.faces[0]], fp[e.faces[1]])), 0.25) : mid;
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
    const boundary = es.filter((k) => edges.get(k)!.faces.length === 1);
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
  return { vertices: out, faces, smooth: mesh.smooth };
}
