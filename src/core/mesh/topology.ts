// Polygon-mesh helpers shared by the editing operators. Pure functions on MeshData
// (Blender coordinates, faces counter-clockwise seen from outside).

import type { MeshData, Vec3 } from '../types';

export type V = Vec3;

export const add = (a: V, b: V): V => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: V, b: V): V => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: V, k: number): V => [a[0] * k, a[1] * k, a[2] * k];
export const dot = (a: V, b: V) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: V, b: V): V => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const len = (a: V) => Math.hypot(a[0], a[1], a[2]);
export const norm = (a: V): V => {
  const l = len(a);
  return l > 1e-12 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0];
};
export const lerp = (a: V, b: V, t: number): V => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
export const dist = (a: V, b: V) => len(sub(a, b));

/** Undirected edge key. */
export const ek = (a: number, b: number) => (a < b ? `${a}_${b}` : `${b}_${a}`);
export const ekParse = (k: string): [number, number] => k.split('_').map(Number) as [number, number];

/** Newell normal (unnormalised; length = 2 × area). Robust for non-planar / concave polygons. */
export function newell(vs: V[], face: number[]): V {
  let x = 0, y = 0, z = 0;
  for (let i = 0; i < face.length; i++) {
    const a = vs[face[i]], b = vs[face[(i + 1) % face.length]];
    x += (a[1] - b[1]) * (a[2] + b[2]);
    y += (a[2] - b[2]) * (a[0] + b[0]);
    z += (a[0] - b[0]) * (a[1] + b[1]);
  }
  return [x, y, z];
}

export const faceNormal = (vs: V[], face: number[]) => norm(newell(vs, face));
export const faceArea = (vs: V[], face: number[]) => len(newell(vs, face)) / 2;

export function centroid(vs: V[], idx: Iterable<number>): V {
  let x = 0, y = 0, z = 0, n = 0;
  for (const i of idx) {
    x += vs[i][0];
    y += vs[i][1];
    z += vs[i][2];
    n++;
  }
  return n ? [x / n, y / n, z / n] : [0, 0, 0];
}

/** Each undirected edge with the faces that use it (and whether that face runs a→b with a<b). */
export interface EdgeInfo {
  a: number;
  b: number;
  faces: number[];
}

export function edgeMap(mesh: MeshData): Map<string, EdgeInfo> {
  const m = new Map<string, EdgeInfo>();
  mesh.faces.forEach((f, fi) => {
    for (let i = 0; i < f.length; i++) {
      const a = f[i], b = f[(i + 1) % f.length];
      const k = ek(a, b);
      let e = m.get(k);
      if (!e) m.set(k, (e = { a: Math.min(a, b), b: Math.max(a, b), faces: [] }));
      e.faces.push(fi);
    }
  });
  return m;
}

export function faceEdges(face: number[]): string[] {
  return face.map((a, i) => ek(a, face[(i + 1) % face.length]));
}

/** Faces around each vertex. */
export function vertexFaces(mesh: MeshData): number[][] {
  const out: number[][] = mesh.vertices.map(() => []);
  mesh.faces.forEach((f, fi) => f.forEach((v) => out[v].push(fi)));
  return out;
}

/** Does face run a → b (in that order)? */
export function runs(face: number[], a: number, b: number): boolean {
  const i = face.indexOf(a);
  return i >= 0 && face[(i + 1) % face.length] === b;
}

/**
 * Remove degenerate faces (fewer than 3 distinct corners after merging), repeated
 * consecutive indices, and unused vertices. Returns the cleaned mesh and an old→new
 * vertex index map (-1 = removed).
 */
export function compact(mesh: MeshData, index?: number[]): { mesh: MeshData; map: number[] } {
  const faces: number[][] = [];
  const kept: number[] = [];
  const seen = new Set<string>();
  for (const [fi, f] of mesh.faces.entries()) {
    const g: number[] = [];
    for (const v of f) if (g[g.length - 1] !== v) g.push(v);
    while (g.length > 1 && g[0] === g[g.length - 1]) g.pop();
    if (new Set(g).size < 3 || g.length < 3) continue;
    const key = [...g].sort((a, b) => a - b).join(',');
    if (seen.has(key)) continue; // exact duplicate face (e.g. after merging)
    seen.add(key);
    faces.push(g);
    kept.push(index?.[fi] ?? 0);
  }
  const used = new Array(mesh.vertices.length).fill(false);
  for (const f of faces) for (const v of f) used[v] = true;
  const map: number[] = [];
  const vertices: V[] = [];
  mesh.vertices.forEach((p, i) => {
    if (used[i]) {
      map[i] = vertices.length;
      vertices.push(p);
    } else map[i] = -1;
  });
  const out: MeshData = { vertices, faces: faces.map((f) => f.map((v) => map[v])), smooth: mesh.smooth };
  // Material slots per face, when given (aligned with mesh.faces), follow the faces that are kept.
  if (index && kept.some((s) => s > 0)) out.materialIndex = kept;
  return { mesh: out, map };
}

/**
 * Faces ordered around a vertex (a fan). Works for interior and boundary vertices of a
 * manifold mesh; returns null where the neighbourhood is not a single fan.
 * Each entry: face index, the corner position in that face, and its previous / next neighbours.
 */
export interface FanItem {
  f: number;
  prev: number; // vertex before v in face f
  next: number; // vertex after v in face f
}

export function fanAround(mesh: MeshData, v: number, faces: number[]): { items: FanItem[]; closed: boolean } | null {
  const items: FanItem[] = faces.map((f) => {
    const face = mesh.faces[f];
    const i = face.indexOf(v);
    return { f, prev: face[(i - 1 + face.length) % face.length], next: face[(i + 1) % face.length] };
  });
  if (items.length === 0) return null;
  // Walking order: from item X, the next face is the one whose `next` equals X.prev
  // (they share edge v–X.prev with opposite direction).
  const byNext = new Map<number, FanItem[]>();
  for (const it of items) byNext.set(it.next, [...(byNext.get(it.next) ?? []), it]);
  // A boundary start: an item whose `next` edge has no partner (no item with prev === it.next).
  const prevs = new Set(items.map((it) => it.prev));
  let start = items.find((it) => !prevs.has(it.next)) ?? items[0];
  // Walk backwards to the true start for boundary fans: we want the order where each step crosses edge v-prev.
  // Simplest: start at the item whose `next` is unshared, then repeatedly step to the item with next === cur.prev.
  const out: FanItem[] = [];
  const used = new Set<FanItem>();
  let cur: FanItem | undefined = start;
  while (cur && !used.has(cur)) {
    out.push(cur);
    used.add(cur);
    const cands: FanItem[] = (byNext.get(cur.prev) ?? []).filter((c) => !used.has(c));
    cur = cands[0];
  }
  if (out.length !== items.length) return null;
  const closed = out.length > 1 && out[out.length - 1].prev === out[0].next;
  start = out[0];
  return { items: out, closed };
}

/** True when every edge is used by exactly two faces in opposite directions (closed, consistently oriented). */
export function isWatertight(mesh: MeshData): boolean {
  const dir = new Map<string, number>();
  for (const f of mesh.faces)
    for (let i = 0; i < f.length; i++) {
      const k = `${f[i]}>${f[(i + 1) % f.length]}`;
      dir.set(k, (dir.get(k) ?? 0) + 1);
    }
  for (const [k, n] of dir) {
    if (n !== 1) return false;
    const [a, b] = k.split('>');
    if (dir.get(`${b}>${a}`) !== 1) return false;
  }
  return true;
}

/** Signed volume (positive when faces point outwards). */
export function signedVolume(mesh: MeshData): number {
  let vol = 0;
  const vs = mesh.vertices;
  for (const f of mesh.faces)
    for (let i = 1; i < f.length - 1; i++) vol += dot(vs[f[0]], cross(vs[f[i]], vs[f[i + 1]])) / 6;
  return vol;
}

/** Triangulate a polygon (ear clipping in its own plane). Returns index triples into `face`'s vertex ids. */
export function triangulate(vs: V[], face: number[]): number[][] {
  if (face.length === 3) return [[face[0], face[1], face[2]]];
  const n = newell(vs, face);
  // Fast path: convex polygons fan fine.
  const nn = norm(n);
  let convex = true;
  for (let i = 0; i < face.length && convex; i++) {
    const a = vs[face[i]], b = vs[face[(i + 1) % face.length]], c = vs[face[(i + 2) % face.length]];
    if (dot(cross(sub(b, a), sub(c, b)), nn) < -1e-12) convex = false;
  }
  if (convex) {
    const out: number[][] = [];
    for (let i = 1; i < face.length - 1; i++) out.push([face[0], face[i], face[i + 1]]);
    return out;
  }
  // Project to 2D on the dominant axis plane.
  const ax = Math.abs(n[0]), ay = Math.abs(n[1]), az = Math.abs(n[2]);
  const [u, w] = az >= ax && az >= ay ? [0, 1] : ax >= ay ? [1, 2] : [2, 0];
  const flip = (az >= ax && az >= ay ? n[2] : ax >= ay ? n[0] : n[1]) < 0;
  const p = (i: number) => [vs[i][u], vs[i][w]] as const;
  const area2 = (a: number, b: number, c: number) => {
    const [ax2, ay2] = p(a), [bx, by] = p(b), [cx, cy] = p(c);
    const s = (bx - ax2) * (cy - ay2) - (by - ay2) * (cx - ax2);
    return flip ? -s : s;
  };
  const inTri = (pt: number, a: number, b: number, c: number) => area2(a, b, pt) >= 0 && area2(b, c, pt) >= 0 && area2(c, a, pt) >= 0;
  const idx = [...face];
  const out: number[][] = [];
  let guard = 0;
  while (idx.length > 3 && guard++ < 10000) {
    let clipped = false;
    for (let i = 0; i < idx.length; i++) {
      const a = idx[(i - 1 + idx.length) % idx.length], b = idx[i], c = idx[(i + 1) % idx.length];
      if (area2(a, b, c) <= 1e-14) continue;
      if (idx.some((q) => q !== a && q !== b && q !== c && inTri(q, a, b, c))) continue;
      out.push([a, b, c]);
      idx.splice(i, 1);
      clipped = true;
      break;
    }
    if (!clipped) break;
  }
  if (idx.length === 3) out.push([idx[0], idx[1], idx[2]]);
  else for (let i = 1; i < idx.length - 1; i++) out.push([idx[0], idx[i], idx[i + 1]]); // degenerate leftovers
  return out;
}
