// Cell Fracture (Blender's Cell Fracture add-on): break an object into Voronoi pieces around
// random points inside it. Each piece is its own mesh, centred on itself, ready to be a rigid body.

import { fractureCells } from './mesh/boolean';
import { signedVolume } from './mesh/topology';
import type { V } from './mesh/topology';
import { triangulate } from './mesh/topology';
import type { MeshData } from './types';

/** Small seeded random generator (same seed → same pieces). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Is the point inside the closed mesh? (Counts crossings of a slightly tilted ray.) */
export function insideMesh(mesh: MeshData, p: V): boolean {
  const d: V = [1, 0.000123, 0.000457];
  let hits = 0;
  for (const f of mesh.faces)
    for (const [a, b, c] of triangulate(mesh.vertices, f)) {
      const A = mesh.vertices[a], B = mesh.vertices[b], C = mesh.vertices[c];
      // Möller–Trumbore
      const e1: V = [B[0] - A[0], B[1] - A[1], B[2] - A[2]], e2: V = [C[0] - A[0], C[1] - A[1], C[2] - A[2]];
      const h: V = [d[1] * e2[2] - d[2] * e2[1], d[2] * e2[0] - d[0] * e2[2], d[0] * e2[1] - d[1] * e2[0]];
      const det = e1[0] * h[0] + e1[1] * h[1] + e1[2] * h[2];
      if (Math.abs(det) < 1e-12) continue;
      const inv = 1 / det;
      const s: V = [p[0] - A[0], p[1] - A[1], p[2] - A[2]];
      const u = inv * (s[0] * h[0] + s[1] * h[1] + s[2] * h[2]);
      if (u < 0 || u > 1) continue;
      const q: V = [s[1] * e1[2] - s[2] * e1[1], s[2] * e1[0] - s[0] * e1[2], s[0] * e1[1] - s[1] * e1[0]];
      const v = inv * (d[0] * q[0] + d[1] * q[1] + d[2] * q[2]);
      if (v < 0 || u + v > 1) continue;
      if (inv * (e2[0] * q[0] + e2[1] * q[1] + e2[2] * q[2]) > 1e-9) hits++;
    }
  return hits % 2 === 1;
}

/** `n` random points inside the mesh (seeded). */
export function fractureSeeds(mesh: MeshData, n: number, seed: number): V[] {
  const rnd = mulberry32(seed);
  const lo: V = [Infinity, Infinity, Infinity], hi: V = [-Infinity, -Infinity, -Infinity];
  for (const v of mesh.vertices)
    for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k], v[k]);
      hi[k] = Math.max(hi[k], v[k]);
    }
  const out: V[] = [];
  for (let tries = 0; out.length < n && tries < n * 60; tries++) {
    const p: V = [0, 1, 2].map((k) => lo[k] + rnd() * (hi[k] - lo[k])) as V;
    if (insideMesh(mesh, p)) out.push(p);
  }
  return out;
}

export interface Piece {
  /** Piece geometry, centred on `center`. */
  mesh: MeshData;
  /** Where the piece's centre was in the original object's space. */
  center: V;
  /** Share of the original volume (0..1). */
  share: number;
}

/** Break a closed mesh into about `n` pieces (needs the boolean engine loaded). */
export function fracturePieces(mesh: MeshData, n: number, seed: number, name = 'Object'): Piece[] {
  const seeds = fractureSeeds(mesh, n, seed);
  if (seeds.length < 2) return [];
  const cells = fractureCells(mesh, seeds, name);
  const total = cells.reduce((s, c) => s + Math.abs(signedVolume(c)), 0) || 1;
  return cells.map((c) => {
    // The average corner lies inside a convex piece (a box's centre might not), so it can spin about it.
    const center: V = [0, 1, 2].map((k) => Math.round((c.vertices.reduce((a, v) => a + v[k], 0) / c.vertices.length) * 1e5) / 1e5) as V;
    return {
      mesh: { vertices: c.vertices.map((v) => [v[0] - center[0], v[1] - center[1], v[2] - center[2]].map((x) => Math.round(x * 1e5) / 1e5) as V), faces: c.faces, smooth: false },
      center,
      share: Math.abs(signedVolume(c)) / total,
    };
  });
}
