// More edit-mode operators, after Blender's Mesh menu: Dissolve (X → Dissolve), Connect Vertex
// Path (J), Bridge Edge Loops, Smooth Vertices, Shrink/Fatten (Alt+S), To Sphere (Shift+Alt+S),
// Triangulate (Ctrl+T), Tris to Quads (Alt+J) and Poke Faces. Pure, like ops.ts.

import type { MeshData } from '../types';
import type { MeshSelection, SelectMode } from './select';
import { EMPTY_SEL, flush } from './select';
import type { V } from './topology';
import { add, centroid, cross, dist, dot, edgeMap, ek, ekParse, len, lerp, newell, norm, runs, scale, sub, triangulate } from './topology';
import { MeshOpError } from './ops';
import type { OpResult } from './ops';
import { vertexNormals } from './sculpt';

const copyMesh = (m: MeshData): MeshData => ({ vertices: m.vertices.map((v) => [...v] as V), faces: m.faces.map((f) => [...f]), smooth: m.smooth });
const finish = (mesh: MeshData, mode: SelectMode, primary: Partial<MeshSelection>): OpResult => ({ mesh, mode, sel: flush(mesh, mode, { ...EMPTY_SEL, ...primary }) });

/** Drop degenerate faces and unused vertices, carrying a list of faces (by index) through. */
function compactKeeping(mesh: MeshData, keep: number[]): { mesh: MeshData; faces: number[] } {
  const keepSet = new Set(keep);
  const faces: number[][] = [];
  const kept: number[] = [];
  mesh.faces.forEach((f, i) => {
    const g: number[] = [];
    for (const v of f) if (g[g.length - 1] !== v) g.push(v);
    while (g.length > 1 && g[0] === g[g.length - 1]) g.pop();
    if (new Set(g).size < 3) return;
    if (keepSet.has(i)) kept.push(faces.length);
    faces.push(g);
  });
  const used = new Array<boolean>(mesh.vertices.length).fill(false);
  for (const f of faces) for (const v of f) used[v] = true;
  const map: number[] = [];
  const vertices: V[] = [];
  mesh.vertices.forEach((p, i) => {
    map[i] = used[i] ? vertices.push(p) - 1 : -1;
  });
  return { mesh: { vertices, faces: faces.map((f) => f.map((v) => map[v])), smooth: mesh.smooth }, faces: kept };
}

// ---------------------------------------------------------------- regions

/** Connected groups of faces, joined where `link(faceA, faceB, edgeKey)` says so. */
function groups(mesh: MeshData, faces: number[], link: (k: string) => boolean): number[][] {
  const inSet = new Set(faces);
  const em = edgeMap(mesh);
  const parent = new Map<number, number>(faces.map((f) => [f, f]));
  const find = (f: number): number => {
    let r = f;
    while (parent.get(r) !== r) r = parent.get(r)!;
    parent.set(f, r);
    return r;
  };
  for (const [k, e] of em) {
    if (!link(k)) continue;
    const fs = e.faces.filter((f) => inSet.has(f));
    for (let i = 1; i < fs.length; i++) parent.set(find(fs[i]), find(fs[0]));
  }
  const out = new Map<number, number[]>();
  for (const f of faces) {
    const r = find(f);
    out.set(r, [...(out.get(r) ?? []), f]);
  }
  return [...out.values()];
}

/** The single outline of a face region, in the region's winding; null if it has holes or pinches. */
function regionLoop(mesh: MeshData, region: number[]): number[] | null {
  const inR = new Set(region);
  const em = edgeMap(mesh);
  const next = new Map<number, number>();
  let count = 0;
  for (const f of region) {
    const face = mesh.faces[f];
    for (let i = 0; i < face.length; i++) {
      const a = face[i], b = face[(i + 1) % face.length];
      const owners = em.get(ek(a, b))!.faces.filter((g) => inR.has(g));
      if (owners.length !== 1) continue;
      if (next.has(a)) return null; // pinch: the outline visits a vertex twice
      next.set(a, b);
      count++;
    }
  }
  if (count < 3) return null;
  const start = next.keys().next().value as number;
  const loop = [start];
  let cur = next.get(start)!;
  while (cur !== start) {
    if (loop.length > count) return null;
    loop.push(cur);
    const n = next.get(cur);
    if (n === undefined) return null;
    cur = n;
  }
  return loop.length === count ? loop : null; // more than one loop = a hole
}

/** Replace each region by one n-gon (its outline); not compacted. Regions that can't become one face are left as they are. */
function mergeRegions(mesh: MeshData, regions: number[][], dropVerts = new Set<number>()): { mesh: MeshData; faces: number[]; skipped: number } {
  const out = copyMesh(mesh);
  const remove = new Set<number>();
  const added: number[][] = [];
  let skipped = 0;
  for (const r of regions) {
    if (r.length < 2 && !r.some((f) => mesh.faces[f].some((v) => dropVerts.has(v)))) continue;
    let loop = regionLoop(mesh, r);
    if (!loop) {
      skipped++;
      continue;
    }
    if (dropVerts.size) {
      const kept = loop.filter((v) => !dropVerts.has(v));
      if (kept.length >= 3) loop = kept;
    }
    r.forEach((f) => remove.add(f));
    added.push(loop);
  }
  out.faces = out.faces.filter((_, i) => !remove.has(i));
  const first = out.faces.length;
  out.faces.push(...added);
  return { mesh: out, faces: added.map((_, i) => first + i), skipped };
}

/** Take out vertices that only sit in the middle of a straight edge (same face count; not compacted). */
function dissolveTwoValence(mesh: MeshData, candidates: Set<number>): MeshData {
  if (!candidates.size) return mesh;
  const em = edgeMap(mesh);
  const nb = new Map<number, Set<number>>();
  for (const e of em.values()) {
    if (candidates.has(e.a)) nb.set(e.a, (nb.get(e.a) ?? new Set()).add(e.b));
    if (candidates.has(e.b)) nb.set(e.b, (nb.get(e.b) ?? new Set()).add(e.a));
  }
  const drop = new Set<number>();
  for (const v of candidates) {
    const n = nb.get(v);
    if (!n || n.size !== 2) continue;
    const [a, b] = [...n];
    // Only if the two edges are (nearly) in line, so the outline keeps its shape.
    const d1 = norm(sub(mesh.vertices[v], mesh.vertices[a]));
    const d2 = norm(sub(mesh.vertices[b], mesh.vertices[v]));
    if (dot(d1, d2) > 0.999) drop.add(v);
  }
  if (!drop.size) return mesh;
  const faces = mesh.faces.map((f) => {
    const g = f.filter((v) => !drop.has(v));
    return g.length >= 3 ? g : f;
  });
  return { ...mesh, faces };
}

/**
 * Dissolve (X → Dissolve): remove the selection without leaving a hole. Faces: each connected
 * patch becomes one face. Edges: the faces on both sides merge. Vertices: the faces around each
 * vertex merge and the vertex goes away.
 */
export function dissolve(mesh: MeshData, mode: SelectMode, sel: MeshSelection): OpResult {
  const em = edgeMap(mesh);
  if (mode === 'face') {
    if (sel.faces.length < 2) throw new MeshOpError('Select two or more touching faces to dissolve into one');
    const r = mergeRegions(mesh, groups(mesh, sel.faces, () => true));
    if (!r.faces.length) throw new MeshOpError("Those faces can't become one face (it would have a hole)");
    const res = compactKeeping(r.mesh, r.faces);
    return finish(res.mesh, 'face', { faces: res.faces });
  }
  if (mode === 'edge') {
    const inner = sel.edges.filter((k) => em.get(k)?.faces.length === 2);
    if (!inner.length) throw new MeshOpError('Select edges between two faces to dissolve');
    const ks = new Set(inner);
    const faces = [...new Set(inner.flatMap((k) => em.get(k)!.faces))];
    const r = mergeRegions(mesh, groups(mesh, faces, (k) => ks.has(k)));
    if (!r.faces.length) throw new MeshOpError("Those edges can't be dissolved (the faces would have a hole)");
    // Vertices left in the middle of a straight edge go too (Blender's "Dissolve Vertices").
    const cleaned = dissolveTwoValence(r.mesh, new Set(inner.flatMap((k) => ekParse(k))));
    const res = compactKeeping(cleaned, r.faces);
    return finish(res.mesh, 'face', { faces: res.faces });
  }
  if (!sel.verts.length) throw new MeshOpError('Select vertices to dissolve');
  const vs = new Set(sel.verts);
  const faces = mesh.faces.map((_, i) => i).filter((i) => mesh.faces[i].some((v) => vs.has(v)));
  // Faces around the same selected vertex merge.
  const r = mergeRegions(
    mesh,
    groups(mesh, faces, (k) => {
      const [a, b] = ekParse(k);
      return vs.has(a) || vs.has(b);
    }),
    vs,
  );
  if (!r.faces.length) throw new MeshOpError("Those vertices can't be dissolved here");
  const res = compactKeeping(r.mesh, r.faces);
  return finish(res.mesh, 'face', { faces: res.faces });
}

// ---------------------------------------------------------------- connect

/** Connect Vertex Path (J): split faces between selected vertices that share a face. */
export function connectVerts(mesh: MeshData, sel: MeshSelection): OpResult {
  const vs = new Set(sel.verts);
  if (vs.size < 2) throw new MeshOpError('Select two vertices on the same face, then Connect (J)');
  const out = copyMesh(mesh);
  const newEdges: string[] = [];
  let changed = true;
  // Repeat: a split face may still hold another selected pair.
  for (let guard = 0; changed && guard < 1000; guard++) {
    changed = false;
    for (let fi = 0; fi < out.faces.length; fi++) {
      const f = out.faces[fi];
      const idx = f.map((v, i) => (vs.has(v) ? i : -1)).filter((i) => i >= 0);
      if (idx.length < 2) continue;
      let pair: [number, number] | null = null;
      for (let x = 0; x < idx.length && !pair; x++)
        for (let y = x + 1; y < idx.length && !pair; y++) {
          const i = idx[x], j = idx[y];
          const gap = j - i;
          if (gap > 1 && gap < f.length - 1) pair = [i, j];
        }
      if (!pair) continue;
      const [i, j] = pair;
      out.faces[fi] = f.slice(i, j + 1);
      out.faces.push([...f.slice(j), ...f.slice(0, i + 1)]);
      newEdges.push(ek(f[i], f[j]));
      changed = true;
    }
  }
  if (!newEdges.length) throw new MeshOpError('The selected vertices are already joined by an edge, or share no face');
  return finish(out, 'edge', { edges: newEdges });
}

// ---------------------------------------------------------------- bridge

/** Chains of selected boundary edges, each directed as its face runs it. */
function boundaryChains(mesh: MeshData, edges: string[]): { verts: number[]; closed: boolean }[] {
  const em = edgeMap(mesh);
  const next = new Map<number, number>();
  const prev = new Map<number, number>();
  for (const k of edges) {
    const e = em.get(k);
    if (!e || e.faces.length !== 1) throw new MeshOpError('Bridge works on open edges (holes): select two edge loops around holes, or two faces to replace');
    const face = mesh.faces[e.faces[0]];
    const [a, b] = runs(face, e.a, e.b) ? [e.a, e.b] : [e.b, e.a];
    if (next.has(a) || prev.has(b)) throw new MeshOpError('The selected edges branch; select two simple loops');
    next.set(a, b);
    prev.set(b, a);
  }
  const seen = new Set<number>();
  const chains: { verts: number[]; closed: boolean }[] = [];
  for (const s0 of next.keys()) {
    if (seen.has(s0)) continue;
    // Walk back to the chain's first vertex; if we come round to s0, it's a closed loop.
    let s = s0;
    let loops = false;
    while (prev.has(s)) {
      s = prev.get(s)!;
      if (s === s0) {
        loops = true;
        break;
      }
    }
    const start = loops ? s0 : s;
    const verts = [start];
    seen.add(start);
    let cur = next.get(start);
    while (cur !== undefined && cur !== start) {
      verts.push(cur);
      seen.add(cur);
      cur = next.get(cur);
    }
    chains.push({ verts, closed: cur === start });
  }
  return chains;
}

/**
 * Bridge Edge Loops: join two loops of open edges with a band of faces. With faces selected, the
 * two face patches are removed first and their outlines bridged (making a tunnel or a handle).
 */
export function bridgeLoops(mesh: MeshData, sel: MeshSelection, mode: SelectMode): OpResult {
  let m = mesh;
  let edges = sel.edges;
  if (mode === 'face' && sel.faces.length) {
    const regions = groups(mesh, sel.faces, () => true);
    if (regions.length !== 2) throw new MeshOpError('Select two separate face patches (or two edge loops) to bridge');
    const outline: string[] = [];
    for (const r of regions) {
      const loop = regionLoop(mesh, r);
      if (!loop) throw new MeshOpError("A selected patch has a hole or a pinch; can't bridge it");
      loop.forEach((v, i) => outline.push(ek(v, loop[(i + 1) % loop.length])));
    }
    const drop = new Set(sel.faces);
    m = { ...copyMesh(mesh), faces: mesh.faces.filter((_, i) => !drop.has(i)).map((f) => [...f]) };
    edges = outline;
  }
  const chains = boundaryChains(m, edges);
  if (chains.length !== 2) throw new MeshOpError(`Select exactly two edge loops to bridge (found ${chains.length})`);
  const [A, B] = chains;
  if (A.closed !== B.closed) throw new MeshOpError('Bridge two closed loops or two open edge chains, not one of each');
  if (A.verts.length !== B.verts.length) throw new MeshOpError(`The loops need the same number of vertices (${A.verts.length} and ${B.verts.length}); add or remove a loop cut`);
  const n = A.verts.length;
  const vs = m.vertices;
  const a = A.verts, b = B.verts;
  // a[i] pairs with b[(s − i) mod n]: B runs the other way so the band's winding matches both sides.
  let best = 0, bestCost = Infinity;
  const shifts = A.closed ? n : 1;
  for (let s = 0; s < shifts; s++) {
    const shift = A.closed ? s : n - 1;
    let cost = 0;
    for (let i = 0; i < n; i++) cost += dist(vs[a[i]], vs[b[(((shift - i) % n) + n) % n]]) ** 2;
    if (cost < bestCost) {
      bestCost = cost;
      best = shift;
    }
  }
  const pb = (i: number) => b[(((best - i) % n) + n) % n];
  const out = copyMesh(m);
  const created: number[] = [];
  const segs = A.closed ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const i1 = (i + 1) % n;
    created.push(out.faces.length);
    out.faces.push([a[i1], a[i], pb(i), pb(i1)]);
  }
  const res = compactKeeping(out, created);
  return finish(res.mesh, 'face', { faces: res.faces });
}

// ---------------------------------------------------------------- deform

function neighbors(mesh: MeshData): number[][] {
  const nb: Set<number>[] = mesh.vertices.map(() => new Set());
  for (const f of mesh.faces)
    for (let i = 0; i < f.length; i++) {
      const a = f[i], b = f[(i + 1) % f.length];
      nb[a].add(b);
      nb[b].add(a);
    }
  return nb.map((s) => [...s]);
}

/** Smooth Vertices: move each selected vertex towards the average of its neighbours. */
export function smoothVerts(mesh: MeshData, sel: MeshSelection, mode: SelectMode, factor = 0.5, repeat = 1): OpResult {
  if (!sel.verts.length) throw new MeshOpError('Select vertices to smooth');
  const nb = neighbors(mesh);
  let vs = mesh.vertices.map((v) => [...v] as V);
  for (let r = 0; r < Math.max(1, Math.min(100, Math.round(repeat))); r++) {
    const next = vs.map((v) => [...v] as V);
    for (const i of sel.verts) {
      if (!nb[i].length) continue;
      const avg = scale(nb[i].reduce<V>((s, j) => add(s, vs[j]), [0, 0, 0]), 1 / nb[i].length);
      next[i] = lerp(vs[i], avg, factor);
    }
    vs = next;
  }
  const out = { vertices: vs, faces: mesh.faces.map((f) => [...f]), smooth: mesh.smooth };
  return { mesh: out, mode, sel: flush(out, mode, sel) };
}

/** Shrink/Fatten (Alt+S): move selected vertices along their normals. */
export function shrinkFatten(mesh: MeshData, sel: MeshSelection, mode: SelectMode, offset: number): OpResult {
  if (!sel.verts.length) throw new MeshOpError('Select vertices to shrink or fatten');
  const n = vertexNormals(mesh.vertices, mesh.faces);
  const out = copyMesh(mesh);
  for (const i of sel.verts) out.vertices[i] = add(mesh.vertices[i], scale(n[i], offset));
  return { mesh: out, mode, sel: flush(out, mode, sel) };
}

/** To Sphere (Shift+Alt+S): push the selection towards a sphere around its centre. */
export function toSphere(mesh: MeshData, sel: MeshSelection, mode: SelectMode, factor = 1): OpResult {
  if (sel.verts.length < 3) throw new MeshOpError('Select three or more vertices for To Sphere');
  const c = centroid(mesh.vertices, sel.verts);
  const r = sel.verts.reduce((s, i) => s + dist(mesh.vertices[i], c), 0) / sel.verts.length;
  const out = copyMesh(mesh);
  for (const i of sel.verts) {
    const d = sub(mesh.vertices[i], c);
    if (len(d) < 1e-12) continue;
    out.vertices[i] = lerp(mesh.vertices[i], add(c, scale(norm(d), r)), factor);
  }
  return { mesh: out, mode, sel: flush(out, mode, sel) };
}

// ---------------------------------------------------------------- triangles and quads

/** Triangulate Faces (Ctrl+T). */
export function triangulateFaces(mesh: MeshData, sel: MeshSelection): OpResult {
  const fs = new Set(sel.faces);
  if (!fs.size) throw new MeshOpError('Select faces to triangulate');
  const out = copyMesh(mesh);
  out.faces = [];
  const created: number[] = [];
  mesh.faces.forEach((f, i) => {
    if (!fs.has(i) || f.length === 3) {
      if (fs.has(i)) created.push(out.faces.length);
      out.faces.push([...f]);
      return;
    }
    for (const t of triangulate(mesh.vertices, f)) {
      created.push(out.faces.length);
      out.faces.push(t);
    }
  });
  return finish(out, 'face', { faces: created });
}

/** Tris to Quads (Alt+J): join pairs of selected triangles into quads where the result is flat and convex. */
export function trisToQuads(mesh: MeshData, sel: MeshSelection, maxAngle = 40): OpResult {
  const tris = sel.faces.filter((f) => mesh.faces[f].length === 3);
  if (tris.length < 2) throw new MeshOpError('Select two or more triangles to join');
  const inSet = new Set(tris);
  const em = edgeMap(mesh);
  const vs = mesh.vertices;
  const lim = Math.cos((maxAngle * Math.PI) / 180);
  const cands: { f: number; g: number; quad: number[]; score: number }[] = [];
  for (const [k, e] of em) {
    if (e.faces.length !== 2 || !e.faces.every((f) => inSet.has(f))) continue;
    const [f, g] = e.faces;
    const [a, b] = ekParse(k);
    const F = mesh.faces[f], G = mesh.faces[g];
    // F runs p → q along the shared edge; its third corner is r. G's third corner is s.
    const [p, q] = runs(F, a, b) ? [a, b] : [b, a];
    const r = F.find((v) => v !== a && v !== b)!;
    const s = G.find((v) => v !== a && v !== b)!;
    const quad = [r, p, s, q];
    const nf = norm(newell(vs, F)), ng = norm(newell(vs, G));
    if (dot(nf, ng) < lim) continue;
    // Convex: every corner turns the same way as the quad's normal.
    const nq = norm(newell(vs, quad));
    let convex = true;
    for (let i = 0; i < 4 && convex; i++) {
      const x = vs[quad[i]], y = vs[quad[(i + 1) % 4]], z = vs[quad[(i + 2) % 4]];
      if (dot(cross(sub(y, x), sub(z, y)), nq) <= 1e-12) convex = false;
    }
    if (!convex) continue;
    // Prefer flat quads joined across their longest edge (the old diagonal).
    cands.push({ f, g, quad, score: dot(nf, ng) + dist(vs[a], vs[b]) * 1e-3 });
  }
  cands.sort((x, y) => y.score - x.score);
  const used = new Set<number>();
  const quads: number[][] = [];
  for (const c of cands) {
    if (used.has(c.f) || used.has(c.g)) continue;
    used.add(c.f);
    used.add(c.g);
    quads.push(c.quad);
  }
  if (!quads.length) throw new MeshOpError('No pair of selected triangles makes a flat, convex quad');
  const out = copyMesh(mesh);
  out.faces = mesh.faces.filter((_, i) => !used.has(i)).map((f) => [...f]);
  const first = out.faces.length;
  out.faces.push(...quads);
  const left = tris.filter((f) => !used.has(f)).map((f) => mesh.faces[f]);
  const keep = [...quads.map((_, i) => first + i), ...out.faces.map((f, i) => (left.includes(f) ? i : -1)).filter((i) => i >= 0)];
  return finish(out, 'face', { faces: keep });
}

/** Poke Faces: a vertex in the middle of each selected face, fanned out to its corners. */
export function pokeFaces(mesh: MeshData, sel: MeshSelection, offset = 0): OpResult {
  const fs = new Set(sel.faces);
  if (!fs.size) throw new MeshOpError('Select faces to poke');
  const out = copyMesh(mesh);
  out.faces = [];
  const created: number[] = [];
  mesh.faces.forEach((f, i) => {
    if (!fs.has(i)) {
      out.faces.push([...f]);
      return;
    }
    const c = add(centroid(mesh.vertices, f), scale(norm(newell(mesh.vertices, f)), offset));
    const ci = out.vertices.length;
    out.vertices.push(c);
    for (let k = 0; k < f.length; k++) {
      created.push(out.faces.length);
      out.faces.push([f[k], f[(k + 1) % f.length], ci]);
    }
  });
  return finish(out, 'face', { faces: created });
}
