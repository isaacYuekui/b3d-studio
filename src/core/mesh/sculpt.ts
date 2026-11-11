// Sculpt brushes (Blender's Sculpt Mode basics): Draw, Smooth, Inflate, Grab, Flatten, each
// with a smooth falloff and optional X symmetry. Pure: a step takes the current vertices and
// returns new ones; the stroke context (start shape, neighbours) is computed once per stroke.

import type { MeshData } from '../types';
import type { V } from './topology';
import { newell } from './topology';

export const BRUSHES = ['draw', 'smooth', 'inflate', 'grab', 'flatten'] as const;
export type SculptBrush = (typeof BRUSHES)[number];

export interface StrokeContext {
  /** Vertices at the start of the stroke (Grab moves from here). */
  base: V[];
  neighbors: number[][];
}

export interface BrushOptions {
  brush: SculptBrush;
  /** Brush centre on the surface and its radius, in the mesh's local space. */
  center: V;
  radius: number;
  /** 0..1 */
  strength: number;
  invert?: boolean;
  symmetryX?: boolean;
  /** Grab: how far the brush has moved since the stroke started (local space). */
  grabDelta?: V;
  /** Grab: where the stroke started. */
  grabStart?: V;
}

export function strokeContext(mesh: MeshData): StrokeContext {
  const neighbors: Set<number>[] = mesh.vertices.map(() => new Set());
  for (const f of mesh.faces)
    for (let i = 0; i < f.length; i++) {
      const a = f[i], b = f[(i + 1) % f.length];
      neighbors[a].add(b);
      neighbors[b].add(a);
    }
  return { base: mesh.vertices.map((v) => [...v] as V), neighbors: neighbors.map((s) => [...s]) };
}

/** Area-weighted vertex normals. */
export function vertexNormals(vertices: V[], faces: number[][]): V[] {
  const n: V[] = vertices.map(() => [0, 0, 0]);
  for (const f of faces) {
    const fn = newell(vertices, f);
    for (const i of f) {
      n[i][0] += fn[0];
      n[i][1] += fn[1];
      n[i][2] += fn[2];
    }
  }
  return n.map((v) => {
    const l = Math.hypot(v[0], v[1], v[2]) || 1;
    return [v[0] / l, v[1] / l, v[2] / l];
  });
}

const falloff = (d: number, r: number) => {
  if (d >= r) return 0;
  const t = d / r;
  return (1 - t * t) * (1 - t * t);
};

/** One brush dab (or, for Grab, the stroke so far). Returns new vertex positions. */
export function brushStep(vertices: V[], faces: number[][], ctx: StrokeContext, o: BrushOptions): V[] {
  const out = vertices.map((v) => [...v] as V);
  const centers: { c: V; mirror: boolean }[] = [{ c: o.center, mirror: false }];
  if (o.symmetryX && Math.abs(o.center[0]) > o.radius * 0.05) centers.push({ c: [-o.center[0], o.center[1], o.center[2]], mirror: true });
  const sign = o.invert ? -1 : 1;
  const normals = o.brush === 'draw' || o.brush === 'inflate' || o.brush === 'flatten' ? vertexNormals(vertices, faces) : null;

  for (const { c, mirror } of centers) {
    const ref = o.brush === 'grab' ? (mirror ? [-o.grabStart![0], o.grabStart![1], o.grabStart![2]] as V : o.grabStart!) : c;
    const src = o.brush === 'grab' ? ctx.base : vertices;
    // Vertices under the brush and their weights.
    const hit: [number, number][] = [];
    for (let i = 0; i < src.length; i++) {
      const p = src[i];
      const d = Math.hypot(p[0] - ref[0], p[1] - ref[1], p[2] - ref[2]);
      const w = falloff(d, o.radius);
      if (w > 0) hit.push([i, w]);
    }
    if (!hit.length) continue;
    // Average normal and centre of the area under the brush (Draw / Flatten work along it).
    let an: V = [0, 0, 0], ac: V = [0, 0, 0], wsum = 0;
    if (normals)
      for (const [i, w] of hit) {
        for (let k = 0; k < 3; k++) {
          an[k] += normals[i][k] * w;
          ac[k] += vertices[i][k] * w;
        }
        wsum += w;
      }
    const al = Math.hypot(an[0], an[1], an[2]) || 1;
    an = [an[0] / al, an[1] / al, an[2] / al];
    if (wsum) ac = [ac[0] / wsum, ac[1] / wsum, ac[2] / wsum];
    const step = o.radius * 0.12 * o.strength;

    for (const [i, w] of hit) {
      const p = out[i];
      switch (o.brush) {
        case 'draw':
          for (let k = 0; k < 3; k++) p[k] += an[k] * step * w * sign;
          break;
        case 'inflate':
          for (let k = 0; k < 3; k++) p[k] += normals![i][k] * step * w * sign;
          break;
        case 'smooth': {
          const nb = ctx.neighbors[i];
          if (!nb.length) break;
          const avg: V = [0, 0, 0];
          for (const j of nb) for (let k = 0; k < 3; k++) avg[k] += vertices[j][k] / nb.length;
          const a = Math.min(1, o.strength * w * 0.9);
          for (let k = 0; k < 3; k++) p[k] += (avg[k] - vertices[i][k]) * a;
          break;
        }
        case 'flatten': {
          // Pull towards the plane through the area's centre, along its normal.
          const d = (vertices[i][0] - ac[0]) * an[0] + (vertices[i][1] - ac[1]) * an[1] + (vertices[i][2] - ac[2]) * an[2];
          const a = Math.min(1, o.strength * w * 0.5) * sign;
          for (let k = 0; k < 3; k++) p[k] -= an[k] * d * a;
          break;
        }
        case 'grab': {
          const dl = mirror ? ([-o.grabDelta![0], o.grabDelta![1], o.grabDelta![2]] as V) : o.grabDelta!;
          const b = ctx.base[i];
          for (let k = 0; k < 3; k++) p[k] = b[k] + dl[k] * w;
          break;
        }
      }
    }
  }
  return out;
}
