// Edit-mode selection: vertices, edges and faces kept consistent ("flushed") the way
// Blender does it for the active select mode.

import type { MeshData } from '../types';
import { edgeMap, ek, ekParse, faceEdges, vertexFaces } from './topology';

export const SELECT_MODES = ['vert', 'edge', 'face'] as const;
export type SelectMode = (typeof SELECT_MODES)[number];

export interface MeshSelection {
  verts: number[];
  /** Undirected edge keys "a_b" with a < b. */
  edges: string[];
  faces: number[];
}

export const EMPTY_SEL: MeshSelection = { verts: [], edges: [], faces: [] };

/** Make all three sets agree with the primary set of the given mode. Drops invalid indices. */
export function flush(mesh: MeshData, mode: SelectMode, sel: MeshSelection): MeshSelection {
  const nv = mesh.vertices.length;
  const nf = mesh.faces.length;
  if (mode === 'face') {
    const faces = [...new Set(sel.faces.filter((f) => f >= 0 && f < nf))].sort((a, b) => a - b);
    const verts = new Set<number>();
    const edges = new Set<string>();
    for (const f of faces) {
      mesh.faces[f].forEach((v) => verts.add(v));
      faceEdges(mesh.faces[f]).forEach((e) => edges.add(e));
    }
    return { verts: [...verts].sort((a, b) => a - b), edges: [...edges].sort(), faces };
  }
  const em = edgeMap(mesh);
  if (mode === 'edge') {
    const edges = [...new Set(sel.edges.filter((e) => em.has(e)))].sort();
    const es = new Set(edges);
    const verts = new Set<number>();
    for (const e of edges) ekParse(e).forEach((v) => verts.add(v));
    const faces: number[] = [];
    mesh.faces.forEach((f, fi) => faceEdges(f).every((e) => es.has(e)) && faces.push(fi));
    return { verts: [...verts].sort((a, b) => a - b), edges, faces };
  }
  const verts = [...new Set(sel.verts.filter((v) => v >= 0 && v < nv))].sort((a, b) => a - b);
  const vs = new Set(verts);
  const edges: string[] = [];
  for (const [k, e] of em) if (vs.has(e.a) && vs.has(e.b)) edges.push(k);
  const faces: number[] = [];
  mesh.faces.forEach((f, fi) => f.every((v) => vs.has(v)) && faces.push(fi));
  return { verts, edges: edges.sort(), faces };
}

/** Switch select mode, converting the selection like Blender. */
export function convertMode(mesh: MeshData, from: SelectMode, to: SelectMode, sel: MeshSelection): MeshSelection {
  if (from === to) return flush(mesh, to, sel);
  const full = flush(mesh, from, sel);
  return flush(mesh, to, full);
}

export function selectAll(mesh: MeshData, mode: SelectMode): MeshSelection {
  return flush(mesh, mode, {
    verts: mesh.vertices.map((_, i) => i),
    edges: [...edgeMap(mesh).keys()],
    faces: mesh.faces.map((_, i) => i),
  });
}

export function invert(mesh: MeshData, mode: SelectMode, sel: MeshSelection): MeshSelection {
  if (mode === 'face') {
    const s = new Set(sel.faces);
    return flush(mesh, mode, { ...EMPTY_SEL, faces: mesh.faces.map((_, i) => i).filter((i) => !s.has(i)) });
  }
  if (mode === 'edge') {
    const s = new Set(sel.edges);
    return flush(mesh, mode, { ...EMPTY_SEL, edges: [...edgeMap(mesh).keys()].filter((e) => !s.has(e)) });
  }
  const s = new Set(sel.verts);
  return flush(mesh, mode, { ...EMPTY_SEL, verts: mesh.vertices.map((_, i) => i).filter((i) => !s.has(i)) });
}

/** Toggle / add one element. */
export function pickElement(mesh: MeshData, mode: SelectMode, sel: MeshSelection, el: number | string | null, extend: boolean): MeshSelection {
  if (el === null) return extend ? sel : flush(mesh, mode, EMPTY_SEL);
  if (mode === 'face') {
    const f = el as number;
    const faces = extend ? (sel.faces.includes(f) ? sel.faces.filter((x) => x !== f) : [...sel.faces, f]) : [f];
    return flush(mesh, mode, { ...EMPTY_SEL, faces });
  }
  if (mode === 'edge') {
    const e = el as string;
    const edges = extend ? (sel.edges.includes(e) ? sel.edges.filter((x) => x !== e) : [...sel.edges, e]) : [e];
    return flush(mesh, mode, { ...EMPTY_SEL, edges });
  }
  const v = el as number;
  const verts = extend ? (sel.verts.includes(v) ? sel.verts.filter((x) => x !== v) : [...sel.verts, v]) : [v];
  return flush(mesh, mode, { ...EMPTY_SEL, verts });
}

/** Grow the selection to whole connected pieces (Ctrl+L). */
export function selectLinked(mesh: MeshData, mode: SelectMode, sel: MeshSelection): MeshSelection {
  const vf = vertexFaces(mesh);
  const seenF = new Set<number>();
  const stack = [...sel.verts];
  const seenV = new Set<number>(stack);
  while (stack.length) {
    const v = stack.pop()!;
    for (const f of vf[v]) {
      if (seenF.has(f)) continue;
      seenF.add(f);
      for (const w of mesh.faces[f]) if (!seenV.has(w)) (seenV.add(w), stack.push(w));
    }
  }
  return flush(mesh, mode, { verts: [...seenV], edges: mesh.faces.length ? [...seenF].flatMap((f) => faceEdges(mesh.faces[f])) : [], faces: [...seenF] });
}

/**
 * Edge loop through an edge (Alt+click): continue straight across 4-valent vertices.
 * Boundary edges follow the boundary.
 */
export function edgeLoop(mesh: MeshData, edge: string): string[] {
  const em = edgeMap(mesh);
  const vf = vertexFaces(mesh);
  const start = em.get(edge);
  if (!start) return [];
  const out = new Set<string>([edge]);
  const boundary = start.faces.length === 1;
  const step = (from: number, at: number): string | null => {
    // Edges at `at`, excluding the one we came along.
    const cur = ek(from, at);
    const faces = vf[at];
    const edgesAt = new Set<string>();
    for (const f of faces) {
      const face = mesh.faces[f];
      const i = face.indexOf(at);
      edgesAt.add(ek(at, face[(i + 1) % face.length]));
      edgesAt.add(ek(at, face[(i - 1 + face.length) % face.length]));
    }
    edgesAt.delete(cur);
    if (boundary) {
      const b = [...edgesAt].filter((e) => em.get(e)!.faces.length === 1);
      return b.length === 1 ? b[0] : null;
    }
    if (edgesAt.size !== 3 || faces.length !== 4) return null; // only through regular quad-grid vertices
    // The opposite edge shares no face with the current edge.
    const curFaces = new Set(em.get(cur)!.faces);
    const opp = [...edgesAt].filter((e) => !em.get(e)!.faces.some((f) => curFaces.has(f)));
    return opp.length === 1 ? opp[0] : null;
  };
  for (const [a, b] of [[start.a, start.b], [start.b, start.a]] as [number, number][]) {
    let from = a, at = b;
    for (let guard = 0; guard < 100000; guard++) {
      const nxt = step(from, at);
      if (!nxt || out.has(nxt)) break;
      out.add(nxt);
      const [p, q] = ekParse(nxt);
      from = at;
      at = p === at ? q : p;
    }
  }
  return [...out];
}

/** Select the loop through each selected edge (keeps other selected edges). */
export function selectLoop(mesh: MeshData, mode: SelectMode, sel: MeshSelection, edge?: string): MeshSelection {
  const seeds = edge ? [edge] : sel.edges;
  const edges = new Set(edge ? [] : sel.edges);
  for (const e of seeds) edgeLoop(mesh, e).forEach((x) => edges.add(x));
  const full = flush(mesh, 'edge', { ...EMPTY_SEL, edges: [...edges] });
  return mode === 'edge' ? full : flush(mesh, mode, full);
}
