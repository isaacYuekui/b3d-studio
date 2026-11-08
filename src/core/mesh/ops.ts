// Edit-mode mesh operators (extrude, inset, bevel, loop cut, subdivide, delete, merge,
// fill, normals, duplicate). Pure: each returns a new mesh and the selection afterwards.

import type { MeshData } from '../types';
import type { MeshSelection, SelectMode } from './select';
import { EMPTY_SEL, flush } from './select';
import type { V } from './topology';
import { add, centroid, compact, cross, dist, dot, edgeMap, ek, ekParse, fanAround, faceEdges, faceNormal, len, lerp, newell, norm, runs, scale, signedVolume, sub, vertexFaces } from './topology';

export interface OpResult {
  mesh: MeshData;
  sel: MeshSelection;
  /** The select mode the result is meant to be shown in (operators may switch, like Blender). */
  mode: SelectMode;
}

export class MeshOpError extends Error {}

const copyMesh = (m: MeshData): MeshData => ({ vertices: m.vertices.map((v) => [...v] as V), faces: m.faces.map((f) => [...f]), smooth: m.smooth });

/** Faces / edges an operator works on, from a flushed selection. */
export const selFaces = (sel: MeshSelection) => sel.faces;
export const selEdges = (sel: MeshSelection) => sel.edges;

function finish(mesh: MeshData, mode: SelectMode, primary: Partial<MeshSelection>): OpResult {
  return { mesh, mode, sel: flush(mesh, mode, { ...EMPTY_SEL, ...primary }) };
}

/** After compacting, carry a selection of vertices through the index map. */
function remapVerts(vs: number[], map: number[]) {
  return vs.map((v) => map[v]).filter((v) => v >= 0);
}

// ---------------------------------------------------------------- transform

/** Apply a function to selected vertex positions (gizmo moves, median edits). */
export function transformVerts(mesh: MeshData, verts: number[], fn: (p: V, i: number) => V): MeshData {
  const out = copyMesh(mesh);
  for (const v of verts) out.vertices[v] = fn(mesh.vertices[v], v);
  return out;
}

// ---------------------------------------------------------------- extrude

/** Average (area-weighted) normal of a set of faces. */
export function regionNormal(mesh: MeshData, faces: number[]): V {
  let n: V = [0, 0, 0];
  for (const f of faces) n = add(n, newell(mesh.vertices, mesh.faces[f]));
  return norm(n);
}

/** Boundary edges of a face region, directed as in the region face that owns them. */
function regionBoundary(mesh: MeshData, faces: number[]): [number, number][] {
  const inR = new Set(faces);
  const em = edgeMap(mesh);
  const out: [number, number][] = [];
  for (const f of faces) {
    const face = mesh.faces[f];
    for (let i = 0; i < face.length; i++) {
      const a = face[i], b = face[(i + 1) % face.length];
      const e = em.get(ek(a, b))!;
      if (e.faces.filter((g) => inR.has(g)).length === 1) out.push([a, b]);
    }
  }
  return out;
}

/**
 * Extrude (E). Faces: region extrude along the region's average normal. Edges (no faces
 * selected): boundary edges grow outwards in their face's plane; other edges move along
 * their faces' normal. Vertices alone cannot be extruded (meshes here have no loose edges).
 */
export function extrude(mesh: MeshData, sel: MeshSelection, offset: number): OpResult {
  const out = copyMesh(mesh);
  const vs = out.vertices;
  if (sel.faces.length) {
    const region = sel.faces;
    const n = regionNormal(mesh, region);
    const regionVerts = [...new Set(region.flatMap((f) => mesh.faces[f]))];
    const dup = new Map<number, number>();
    for (const v of regionVerts) {
      dup.set(v, vs.length);
      vs.push(add(mesh.vertices[v], scale(n, offset)));
    }
    for (const [a, b] of regionBoundary(mesh, region)) out.faces.push([a, b, dup.get(b)!, dup.get(a)!]);
    for (const f of region) out.faces[f] = mesh.faces[f].map((v) => dup.get(v)!);
    const { mesh: m, map } = compact(out);
    // Region faces kept their indices before compaction; find them again by their new vertices.
    const newVerts = new Set(remapVerts([...dup.values()], map));
    const faces: number[] = [];
    m.faces.forEach((f, i) => f.every((v) => newVerts.has(v)) && faces.push(i));
    return finish(m, 'face', { faces });
  }
  if (!sel.edges.length) throw new MeshOpError('Select edges or faces to extrude');
  const em = edgeMap(mesh);
  const dirs = new Map<number, V>();
  const pushDir = (v: number, d: V) => dirs.set(v, add(dirs.get(v) ?? [0, 0, 0], d));
  const edges = sel.edges.map(ekParse);
  const oriented: [number, number][] = [];
  for (const [a, b] of edges) {
    const e = em.get(ek(a, b))!;
    if (e.faces.length === 1) {
      const f = e.faces[0];
      const face = mesh.faces[f];
      const [p, q] = runs(face, a, b) ? [a, b] : [b, a];
      oriented.push([q, p]); // new face must run against the existing one
      const fn = faceNormal(mesh.vertices, face);
      const outward = norm(cross(sub(mesh.vertices[q], mesh.vertices[p]), fn));
      pushDir(a, outward);
      pushDir(b, outward);
    } else {
      oriented.push([a, b]);
      const n = norm(e.faces.reduce<V>((s, f) => add(s, faceNormal(mesh.vertices, mesh.faces[f])), [0, 0, 0]));
      pushDir(a, n);
      pushDir(b, n);
    }
  }
  const dup = new Map<number, number>();
  for (const [v, d] of dirs) {
    dup.set(v, vs.length);
    vs.push(add(mesh.vertices[v], scale(norm(d), offset)));
  }
  const newEdges: string[] = [];
  for (const [p, q] of oriented) {
    out.faces.push([p, q, dup.get(q)!, dup.get(p)!]);
    newEdges.push(ek(dup.get(p)!, dup.get(q)!));
  }
  return finish(out, 'edge', { edges: newEdges });
}

/** A sensible default extrude / inset size: half the average edge length of the selection. */
export function selectionScale(mesh: MeshData, sel: MeshSelection): number {
  const edges = sel.edges.length ? sel.edges : [...edgeMap(mesh).keys()];
  if (!edges.length) return 0.5;
  let s = 0;
  for (const e of edges) {
    const [a, b] = ekParse(e);
    s += dist(mesh.vertices[a], mesh.vertices[b]);
  }
  return s / edges.length;
}

// ---------------------------------------------------------------- inset

/** Inset faces (I): as one region, or each face on its own. `depth` pushes the inner faces along the normal. */
export function inset(mesh: MeshData, sel: MeshSelection, thickness: number, depth = 0, individual = false): OpResult {
  if (!sel.faces.length) throw new MeshOpError('Select faces to inset');
  let cur = copyMesh(mesh);
  const groups = individual ? sel.faces.map((f) => [f]) : [sel.faces];
  const innerVerts = new Set<number>();
  for (const group of groups) {
    const res = insetRegion(cur, group, thickness, depth);
    cur = res.mesh;
    res.inner.forEach((v) => innerVerts.add(v));
  }
  const { mesh: m, map } = compact(cur);
  const iv = new Set(remapVerts([...innerVerts], map));
  const faces: number[] = [];
  m.faces.forEach((f, i) => f.every((v) => iv.has(v)) && faces.push(i));
  return finish(m, 'face', { faces });
}

function insetRegion(mesh: MeshData, region: number[], t: number, depth: number): { mesh: MeshData; inner: number[] } {
  const out = copyMesh(mesh);
  const vs = out.vertices;
  const boundary = regionBoundary(mesh, region);
  const n = regionNormal(mesh, region);
  // Per boundary vertex: incoming and outgoing boundary edge (region orientation).
  const inc = new Map<number, number>(), outg = new Map<number, number>();
  for (const [a, b] of boundary) {
    outg.set(a, b);
    inc.set(b, a);
  }
  const moved = new Map<number, number>();
  for (const v of outg.keys()) {
    const u = inc.get(v), w = outg.get(v);
    if (u === undefined || w === undefined) continue;
    const P = mesh.vertices[v];
    const d1 = norm(sub(P, mesh.vertices[u]));
    const d2 = norm(sub(mesh.vertices[w], P));
    const p1 = norm(cross(n, d1));
    const p2 = norm(cross(n, d2));
    let m = norm(add(p1, p2));
    if (len(m) < 1e-9) m = p1;
    const k = Math.max(dot(m, p1), 0.2); // limit the miter on very sharp corners
    moved.set(v, vs.length);
    vs.push(add(P, scale(m, t / k)));
  }
  const regionVerts = new Set(region.flatMap((f) => mesh.faces[f]));
  for (const [a, b] of boundary) if (moved.has(a) && moved.has(b)) out.faces.push([a, b, moved.get(b)!, moved.get(a)!]);
  for (const f of region) out.faces[f] = mesh.faces[f].map((v) => moved.get(v) ?? v);
  const inner = [...regionVerts].map((v) => moved.get(v) ?? v);
  if (depth) for (const v of inner) vs[v] = add(vs[v], scale(n, depth));
  return { mesh: out, inner };
}

// ---------------------------------------------------------------- bevel

/**
 * Bevel edges (Ctrl+B). Each selected edge (shared by two faces) becomes a strip of
 * `segments` faces of the given width; corners where several bevelled edges meet get a
 * patch. Profiles are quadratic arcs through the original corner, so more segments round
 * the edge off.
 */
export function bevel(mesh: MeshData, sel: MeshSelection, width: number, segments = 1): OpResult {
  const em = edgeMap(mesh);
  const selected = new Set(sel.edges.filter((e) => em.get(e)?.faces.length === 2));
  if (!selected.size) throw new MeshOpError('Select edges shared by two faces to bevel');
  const vs = mesh.vertices;
  const vf = vertexFaces(mesh);
  const outV: V[] = vs.map((v) => [...v] as V);
  const newV = (p: V) => (outV.push(p), outV.length - 1);
  const segs = Math.max(1, Math.min(16, Math.round(segments)));

  // Vertices touched by a bevelled edge.
  const involved = new Set<number>();
  for (const e of selected) ekParse(e).forEach((v) => involved.add(v));

  // corner[f][v] = list of vertex ids replacing v in face f (in face order).
  const corner = new Map<string, number[]>();
  const ckey = (f: number, v: number) => `${f}:${v}`;
  // Shared slide point per (v, unselected edge).
  const slide = new Map<string, number>();
  const slideT = new Map<string, number[]>();

  // First pass: slide distances along unselected edges (averaged over both faces).
  for (const v of involved) {
    for (const f of vf[v]) {
      const face = mesh.faces[f];
      const i = face.indexOf(v);
      const prev = face[(i - 1 + face.length) % face.length], next = face[(i + 1) % face.length];
      const ePrev = ek(prev, v), eNext = ek(v, next);
      const sPrev = selected.has(ePrev), sNext = selected.has(eNext);
      if (sPrev === sNext) continue;
      const [selN, unselN] = sPrev ? [prev, next] : [next, prev];
      const us = norm(sub(vs[selN], vs[v]));
      const uu = norm(sub(vs[unselN], vs[v]));
      const sin = len(cross(us, uu));
      const t = width / Math.max(sin, 0.1);
      const k = `${v}|${ek(v, unselN)}`;
      slideT.set(k, [...(slideT.get(k) ?? []), t]);
    }
  }
  const slidePoint = (v: number, other: number): number => {
    const k = `${v}|${ek(v, other)}`;
    let id = slide.get(k);
    if (id === undefined) {
      const ts = slideT.get(k) ?? [width];
      const t = ts.reduce((a, b) => a + b, 0) / ts.length;
      const L = dist(vs[v], vs[other]);
      id = newV(lerp(vs[v], vs[other], Math.min(t / Math.max(L, 1e-9), 0.95)));
      slide.set(k, id);
    }
    return id;
  };

  for (const v of involved) {
    for (const f of vf[v]) {
      const face = mesh.faces[f];
      const i = face.indexOf(v);
      const prev = face[(i - 1 + face.length) % face.length], next = face[(i + 1) % face.length];
      const sPrev = selected.has(ek(prev, v)), sNext = selected.has(ek(v, next));
      if (sPrev && sNext) {
        const u1 = norm(sub(vs[prev], vs[v]));
        const u2 = norm(sub(vs[next], vs[v]));
        const sin = Math.max(len(cross(u1, u2)), 0.1);
        corner.set(ckey(f, v), [newV(add(vs[v], scale(add(u1, u2), width / sin)))]);
      } else if (sPrev || sNext) {
        corner.set(ckey(f, v), [slidePoint(v, sPrev ? next : prev)]);
      } else {
        // Both edges unselected but the vertex is bevelled elsewhere: cut the corner.
        corner.set(ckey(f, v), [slidePoint(v, prev), slidePoint(v, next)]);
      }
    }
  }

  // Profile between two corner points around original vertex v (excluding endpoints).
  const profileCache = new Map<string, number[]>();
  const profile = (v: number, p: number, q: number): number[] => {
    if (segs === 1 || p === q) return [];
    const key = `${v}|${p}|${q}`;
    const rev = profileCache.get(`${v}|${q}|${p}`);
    if (rev) return [...rev].reverse();
    let pts = profileCache.get(key);
    if (!pts) {
      pts = [];
      for (let s = 1; s < segs; s++) {
        const t = s / segs;
        const a = lerp(outV[p], vs[v], t), b = lerp(vs[v], outV[q], t);
        pts.push(newV(lerp(a, b, t)));
      }
      profileCache.set(key, pts);
    }
    return pts;
  };

  const faces: number[][] = [];
  const stripFaces: number[] = [];
  // Rebuilt original faces.
  mesh.faces.forEach((face, f) => {
    const g: number[] = [];
    for (const v of face) g.push(...(corner.get(ckey(f, v)) ?? [v]));
    faces.push(g);
  });
  // Strips along bevelled edges.
  for (const e of selected) {
    const info = em.get(e)!;
    const [f1, f2] = info.faces;
    // Orient by f1: it runs a → b.
    const [a, b] = runs(mesh.faces[f1], info.a, info.b) ? [info.a, info.b] : [info.b, info.a];
    const end = (f: number, v: number, first: boolean) => {
      const c = corner.get(ckey(f, v))!;
      return first ? c[0] : c[c.length - 1];
    };
    // In f1 the edge runs a→b; f1's corner at a is its last-at-a point, at b the first-at-b point.
    const a1 = end(f1, a, false), b1 = end(f1, b, true);
    // f2 runs b → a.
    const b2 = end(f2, b, false), a2 = end(f2, a, true);
    const railA = [a2, ...profile(a, a2, a1), a1];
    const railB = [b2, ...profile(b, b2, b1), b1];
    for (let s = 0; s < segs; s++) {
      stripFaces.push(faces.length);
      faces.push([railA[s + 1], railB[s + 1], railB[s], railA[s]].reverse());
    }
  }
  // Patches at vertices where the strips and cut corners leave a hole.
  for (const v of involved) {
    const fan = fanAround(mesh, v, vf[v]);
    if (!fan) continue;
    const ring: number[] = [];
    const items = fan.items;
    for (let k = 0; k < items.length; k++) {
      const it = items[k];
      const c = corner.get(ckey(it.f, v)) ?? [v];
      // Fan walks across edge v–prev; corner points listed in face order run prev-side → next-side.
      ring.push(...[...c].reverse());
      const nxt = items[(k + 1) % items.length];
      if (k === items.length - 1 && !fan.closed) break;
      if (selected.has(ek(v, it.prev))) {
        const cn = corner.get(ckey(nxt.f, v)) ?? [v];
        ring.push(...profile(v, c[0], cn[cn.length - 1]));
      }
    }
    const uniq: number[] = [];
    for (const id of ring) if (uniq[uniq.length - 1] !== id && id !== v) uniq.push(id);
    while (uniq.length > 1 && uniq[0] === uniq[uniq.length - 1]) uniq.pop();
    if (new Set(uniq).size < 3) continue;
    const area = len(newell(outV, uniq));
    if (area < 1e-10 * Math.max(1, width * width)) continue;
    // Orientation: patch normal points like the faces around the vertex.
    const around = vf[v].reduce<V>((s, f) => add(s, newell(vs, mesh.faces[f])), [0, 0, 0]);
    faces.push(dot(newell(outV, uniq), around) < 0 ? uniq.reverse() : uniq);
  }
  const { mesh: m, map } = compact({ vertices: outV, faces, smooth: mesh.smooth });
  // Select the new strip faces (found again by their vertices after compaction).
  const key = (f: number[]) => [...f].sort((x, y) => x - y).join(',');
  const stripKeys = new Set(stripFaces.map((s) => key(faces[s].map((v) => map[v]))));
  const sf: number[] = [];
  m.faces.forEach((f, i) => stripKeys.has(key(f)) && sf.push(i));
  return finish(m, 'face', { faces: sf });
}

// ---------------------------------------------------------------- loop cut

/** The ring of quads crossed by a loop cut through `edge`: ordered ring edges (consistently oriented). */
export function edgeRing(mesh: MeshData, edge: string): { edges: [number, number][]; faces: number[]; closed: boolean } | null {
  const em = edgeMap(mesh);
  const start = em.get(edge);
  if (!start) return null;
  const opposite = (f: number, a: number, b: number): [number, number] | null => {
    const face = mesh.faces[f];
    if (face.length !== 4) return null;
    const i = face.indexOf(a), j = face.indexOf(b);
    // a–b is an edge of the quad; the opposite edge is the other two vertices, oriented parallel (a→d, b→c).
    if ((i + 1) % 4 === j) return [face[(i + 3) % 4], face[(j + 1) % 4]];
    if ((j + 1) % 4 === i) return [face[(i + 1) % 4], face[(j + 3) % 4]];
    return null;
  };
  const walk = (a: number, b: number, from: number) => {
    const edges: [number, number][] = [];
    const faces: number[] = [];
    let cur: [number, number] = [a, b];
    let fromFace = from;
    for (let guard = 0; guard < 100000; guard++) {
      const info = em.get(ek(cur[0], cur[1]))!;
      const f = info.faces.find((x) => x !== fromFace);
      if (f === undefined || mesh.faces[f].length !== 4) break;
      const opp = opposite(f, cur[0], cur[1]);
      if (!opp) break;
      faces.push(f);
      if (ek(opp[0], opp[1]) === edge) return { edges, faces, closed: true };
      edges.push(opp);
      cur = opp;
      fromFace = f;
    }
    return { edges, faces, closed: false };
  };
  const [f0, f1 = -1] = start.faces;
  const fwd = walk(start.a, start.b, f1); // into f0
  if (fwd.closed) return { edges: [[start.a, start.b], ...fwd.edges], faces: fwd.faces, closed: true };
  const back = f1 >= 0 ? walk(start.a, start.b, f0) : { edges: [], faces: [], closed: false }; // into f1
  const edges = [...back.edges.reverse(), [start.a, start.b] as [number, number], ...fwd.edges];
  const faces = [...back.faces.reverse(), ...fwd.faces];
  if (!faces.length) return null;
  return { edges, faces, closed: false };
}

/** Loop cut (Ctrl+R) through the ring of quads crossing `edge`; `factor` -1..1 slides a single cut. */
export function loopCut(mesh: MeshData, edge: string, cuts = 1, factor = 0): OpResult {
  const ring = edgeRing(mesh, edge);
  if (!ring) throw new MeshOpError('Loop cut needs an edge between quads');
  const n = Math.max(1, Math.min(32, Math.round(cuts)));
  const out = copyMesh(mesh);
  const vs = out.vertices;
  // Split points per ring edge, from its first to its second vertex.
  const pts = new Map<string, { a: number; ids: number[] }>();
  for (const [a, b] of ring.edges) {
    const ids: number[] = [];
    for (let k = 1; k <= n; k++) {
      // A single cut can slide along the ring (factor -1..1); several cuts are evenly spaced.
      const t = n === 1 ? 0.5 + Math.max(-0.96, Math.min(0.96, factor)) / 2 : k / (n + 1);
      ids.push(vs.length);
      vs.push(lerp(mesh.vertices[a], mesh.vertices[b], t));
    }
    pts.set(ek(a, b), { a, ids });
  }
  const along = (a: number, b: number): number[] => {
    const p = pts.get(ek(a, b));
    if (!p) return [];
    return p.a === a ? p.ids : [...p.ids].reverse();
  };
  const ringFaces = new Set(ring.faces);
  const newLoopEdges: string[] = [];
  const faces: number[][] = [];
  mesh.faces.forEach((face, f) => {
    if (!ringFaces.has(f)) {
      // Faces next to the ring's open ends gain the split points along the shared edge.
      const g: number[] = [];
      for (let i = 0; i < face.length; i++) {
        const a = face[i], b = face[(i + 1) % face.length];
        g.push(a, ...along(a, b));
      }
      faces.push(g);
      return;
    }
    // Quad crossed by the ring: its two ring edges are opposite sides.
    let i = 0;
    while (i < 4 && !pts.has(ek(face[i], face[(i + 1) % 4]))) i++;
    const a = face[i], b = face[(i + 1) % 4], c = face[(i + 2) % 4], d = face[(i + 3) % 4];
    const ab = [a, ...along(a, b), b]; // side 1
    const dc = [d, ...along(d, c), c]; // side 2, same direction
    for (let k = 0; k < ab.length - 1; k++) {
      faces.push([ab[k], ab[k + 1], dc[k + 1], dc[k]]);
      if (k > 0) newLoopEdges.push(ek(ab[k], dc[k]));
    }
  });
  out.faces = faces;
  return finish(out, 'edge', { edges: newLoopEdges });
}

// ---------------------------------------------------------------- subdivide

/** Subdivide selected faces once (edges split at midpoints; quads into 4, triangles into 4, n-gons into quads). */
export function subdivide(mesh: MeshData, sel: MeshSelection): OpResult {
  if (!sel.faces.length) throw new MeshOpError('Select faces to subdivide');
  const out = copyMesh(mesh);
  const vs = out.vertices;
  const fs = new Set(sel.faces);
  const mid = new Map<string, number>();
  const midOf = (a: number, b: number) => {
    const k = ek(a, b);
    let id = mid.get(k);
    if (id === undefined) {
      id = vs.length;
      vs.push(lerp(mesh.vertices[a], mesh.vertices[b], 0.5));
      mid.set(k, id);
    }
    return id;
  };
  for (const f of sel.faces) faceEdges(mesh.faces[f]).forEach((e) => {
    const [a, b] = ekParse(e);
    midOf(a, b);
  });
  const newFaces: number[] = [];
  const faces: number[][] = [];
  mesh.faces.forEach((face, f) => {
    if (!fs.has(f)) {
      const g: number[] = [];
      for (let i = 0; i < face.length; i++) {
        const a = face[i], b = face[(i + 1) % face.length];
        g.push(a);
        const m = mid.get(ek(a, b));
        if (m !== undefined) g.push(m);
      }
      faces.push(g);
      return;
    }
    const ms = face.map((a, i) => midOf(a, face[(i + 1) % face.length]));
    if (face.length === 3) {
      newFaces.push(faces.length, faces.length + 1, faces.length + 2, faces.length + 3);
      faces.push([face[0], ms[0], ms[2]], [ms[0], face[1], ms[1]], [ms[2], ms[1], face[2]], [ms[0], ms[1], ms[2]]);
      return;
    }
    const c = vs.length;
    vs.push(centroid(mesh.vertices, face));
    for (let i = 0; i < face.length; i++) {
      newFaces.push(faces.length);
      faces.push([face[i], ms[i], c, ms[(i - 1 + face.length) % face.length]]);
    }
  });
  out.faces = faces;
  return finish(out, 'face', { faces: newFaces });
}

// ---------------------------------------------------------------- delete / merge / fill

export function deleteSelected(mesh: MeshData, mode: SelectMode, sel: MeshSelection): OpResult {
  let keep: (f: number[], i: number) => boolean;
  if (mode === 'vert') {
    const s = new Set(sel.verts);
    keep = (f) => !f.some((v) => s.has(v));
  } else if (mode === 'edge') {
    const s = new Set(sel.edges);
    keep = (f) => !faceEdges(f).some((e) => s.has(e));
  } else {
    const s = new Set(sel.faces);
    keep = (_f, i) => !s.has(i);
  }
  const { mesh: m } = compact({ ...mesh, faces: mesh.faces.filter(keep) });
  return finish(m, mode, {});
}

/** Merge selected vertices at their centre (M). */
export function mergeAtCenter(mesh: MeshData, sel: MeshSelection): OpResult {
  if (sel.verts.length < 2) throw new MeshOpError('Select two or more vertices to merge');
  const out = copyMesh(mesh);
  const target = sel.verts[0];
  out.vertices[target] = centroid(mesh.vertices, sel.verts);
  const s = new Set(sel.verts);
  out.faces = out.faces.map((f) => f.map((v) => (s.has(v) ? target : v)));
  const { mesh: m, map } = compact(out);
  return finish(m, 'vert', { verts: map[target] >= 0 ? [map[target]] : [] });
}

/** Merge vertices closer than `distance` (Merge by Distance). */
export function mergeByDistance(mesh: MeshData, sel: MeshSelection, distance = 0.0001): OpResult & { removed: number } {
  const ids = sel.verts.length ? sel.verts : mesh.vertices.map((_, i) => i);
  const cell = Math.max(distance, 1e-9);
  const grid = new Map<string, number[]>();
  const keyOf = (p: V, dx = 0, dy = 0, dz = 0) => `${Math.floor(p[0] / cell) + dx},${Math.floor(p[1] / cell) + dy},${Math.floor(p[2] / cell) + dz}`;
  const target = mesh.vertices.map((_, i) => i);
  for (const i of ids) {
    const p = mesh.vertices[i];
    let found = -1;
    for (let dx = -1; dx <= 1 && found < 0; dx++)
      for (let dy = -1; dy <= 1 && found < 0; dy++)
        for (let dz = -1; dz <= 1 && found < 0; dz++)
          for (const j of grid.get(keyOf(p, dx, dy, dz)) ?? []) if (dist(p, mesh.vertices[j]) <= distance) (found = j);
    if (found >= 0) target[i] = found;
    else {
      const k = keyOf(p);
      grid.set(k, [...(grid.get(k) ?? []), i]);
    }
  }
  const out = { ...mesh, faces: mesh.faces.map((f) => f.map((v) => target[v])) };
  const { mesh: m, map } = compact(out);
  const removed = mesh.vertices.length - m.vertices.length;
  return { ...finish(m, 'vert', { verts: remapVerts(ids.map((i) => target[i]), map) }), removed };
}

/** Make a face from the selection (F): fills a selected boundary loop, or 3+ loose-ordered vertices. */
export function fill(mesh: MeshData, sel: MeshSelection): OpResult {
  const em = edgeMap(mesh);
  const vs = mesh.vertices;
  const s = new Set(sel.verts);
  if (s.size < 3) throw new MeshOpError('Select three or more vertices to make a face');
  // Boundary edges among the selection, directed as their (single) face runs them.
  const next = new Map<number, number>();
  for (const e of em.values()) {
    if (e.faces.length !== 1 || !s.has(e.a) || !s.has(e.b)) continue;
    const face = mesh.faces[e.faces[0]];
    const [p, q] = runs(face, e.a, e.b) ? [e.a, e.b] : [e.b, e.a];
    next.set(q, p); // the new face runs against the existing face: q → p
  }
  let loop: number[] | null = null;
  if (next.size === s.size) {
    const start = sel.verts[0];
    const l = [start];
    let cur = next.get(start);
    while (cur !== undefined && cur !== start && l.length <= s.size) {
      l.push(cur);
      cur = next.get(cur);
    }
    if (cur === start && l.length === s.size) loop = l;
  }
  if (!loop) {
    // Order around the centre in the best-fit plane.
    const ids = [...s];
    const c = centroid(vs, ids);
    let n: V = [0, 0, 0];
    for (let i = 0; i < ids.length; i++) n = add(n, cross(sub(vs[ids[i]], c), sub(vs[ids[(i + 1) % ids.length]], c)));
    if (len(n) < 1e-12) n = [0, 0, 1];
    n = norm(n);
    const u = norm(sub(vs[ids[0]], c));
    const w = cross(n, u);
    loop = ids.sort((a, b) => Math.atan2(dot(sub(vs[a], c), w), dot(sub(vs[a], c), u)) - Math.atan2(dot(sub(vs[b], c), w), dot(sub(vs[b], c), u)));
    // Respect existing neighbours: if any edge of the new face is already run the same way, flip.
    const clash = loop.some((a, i) => {
      const b = loop![(i + 1) % loop!.length];
      const e = em.get(ek(a, b));
      return e?.faces.some((f) => runs(mesh.faces[f], a, b));
    });
    if (clash) loop.reverse();
    else if (!loop.some((a, i) => em.has(ek(a, loop![(i + 1) % loop!.length])))) {
      // Free-floating face: point it away from the mesh centre.
      const mc = centroid(vs, vs.map((_, i) => i));
      if (dot(newell(vs, loop), sub(c, mc)) < 0) loop.reverse();
    }
  }
  const out = copyMesh(mesh);
  out.faces.push(loop);
  return finish(out, 'face', { faces: [out.faces.length - 1] });
}

// ---------------------------------------------------------------- normals / duplicate

export function flipNormals(mesh: MeshData, sel: MeshSelection, mode: SelectMode): OpResult {
  const fs = new Set(sel.faces.length ? sel.faces : mesh.faces.map((_, i) => i));
  const out = copyMesh(mesh);
  out.faces = out.faces.map((f, i) => (fs.has(i) ? [...f].reverse() : f));
  return { mesh: out, mode, sel: flush(out, mode, sel) };
}

/** Recalculate Outside (Shift+N): consistent winding per connected piece, pointing outwards. */
export function recalcNormals(mesh: MeshData, sel: MeshSelection, mode: SelectMode): OpResult {
  const out = copyMesh(mesh);
  const em = edgeMap(out);
  const visited = new Array(out.faces.length).fill(false);
  for (let s = 0; s < out.faces.length; s++) {
    if (visited[s]) continue;
    const piece: number[] = [];
    const queue = [s];
    visited[s] = true;
    while (queue.length) {
      const f = queue.shift()!;
      piece.push(f);
      const face = out.faces[f];
      for (let i = 0; i < face.length; i++) {
        const a = face[i], b = face[(i + 1) % face.length];
        for (const g of em.get(ek(a, b))!.faces) {
          if (g === f || visited[g]) continue;
          // Neighbour must run b → a; if it runs a → b, flip it.
          if (runs(out.faces[g], a, b)) out.faces[g] = [...out.faces[g]].reverse();
          visited[g] = true;
          queue.push(g);
        }
      }
    }
    const sub_ = { vertices: out.vertices, faces: piece.map((f) => out.faces[f]), smooth: false };
    // Signed volume around the piece's own centre (robust for open pieces too).
    const c = centroid(out.vertices, new Set(piece.flatMap((f) => out.faces[f])));
    let vol = 0;
    for (const face of sub_.faces) vol += dot(newell(out.vertices, face), sub(centroid(out.vertices, face), c));
    if (vol < 0) for (const f of piece) out.faces[f] = [...out.faces[f]].reverse();
  }
  return { mesh: out, mode, sel: flush(out, mode, sel) };
}

/** Duplicate selected faces (Shift+D in edit mode); the copies become the selection. */
export function duplicateFaces(mesh: MeshData, sel: MeshSelection): OpResult {
  if (!sel.faces.length) throw new MeshOpError('Select faces to duplicate');
  const out = copyMesh(mesh);
  const map = new Map<number, number>();
  const faces: number[] = [];
  for (const f of sel.faces) {
    const g = mesh.faces[f].map((v) => {
      if (!map.has(v)) {
        map.set(v, out.vertices.length);
        out.vertices.push([...mesh.vertices[v]] as V);
      }
      return map.get(v)!;
    });
    faces.push(out.faces.length);
    out.faces.push(g);
  }
  return finish(out, 'face', { faces });
}

export { signedVolume };
