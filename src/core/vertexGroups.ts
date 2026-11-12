// Vertex groups and weight painting (Blender's Object Data → Vertex Groups, Weight Paint mode).
// A group is a weight 0..1 per mesh vertex. Groups named like an armature's bones say how much
// each bone moves each vertex; when a skinned mesh has them, they replace the automatic weights.

import type { Bone, MeshData, Vec3 } from './types';
import type { Weights } from './rig';

export interface VertexGroup {
  name: string;
  /** One weight per mesh vertex, 0..1. */
  w: number[];
}

export interface VertexGroups {
  active: number;
  groups: VertexGroup[];
}

export const MAX_GROUPS = 128;
export const WEIGHT_MODES = ['draw', 'add', 'subtract', 'blur'] as const;
export type WeightMode = (typeof WEIGHT_MODES)[number];

const r3 = (x: number) => Math.round(x * 1000) / 1000;

export function uniqueGroupName(vg: VertexGroups | undefined, want?: string): string {
  const used = new Set(vg?.groups.map((g) => g.name) ?? []);
  if (want && !used.has(want)) return want;
  const base = want || 'Group';
  if (!used.has(base)) return base;
  for (let i = 1; ; i++) if (!used.has(`${base}.${String(i).padStart(3, '0')}`)) return `${base}.${String(i).padStart(3, '0')}`;
}

/** Skinning weights from groups named after deforming bones (top 4 per vertex, normalised). */
export function groupsToWeights(vg: VertexGroups | undefined, bones: Bone[], vertexCount: number): Weights | null {
  if (!vg) return null;
  const def = new Set(bones.filter((b) => b.deform !== false).map((b) => b.name));
  const used = vg.groups.filter((g) => def.has(g.name) && g.w.length === vertexCount);
  if (!used.length) return null;
  const names = used.map((g) => g.name);
  const w: [number, number][][] = [];
  for (let v = 0; v < vertexCount; v++) {
    const pairs: [number, number][] = [];
    for (let i = 0; i < used.length; i++) if (used[i].w[v] > 0) pairs.push([i, used[i].w[v]]);
    pairs.sort((a, b) => b[1] - a[1]);
    const top = pairs.slice(0, 4);
    const sum = top.reduce((s, p) => s + p[1], 0);
    w.push(sum > 0 ? top.map(([i, x]) => [i, x / sum] as [number, number]) : []);
  }
  return { bones: names, w };
}

/** Groups from (automatic) skinning weights: one per bone (Blender: Parent → With Automatic Weights). */
export function weightsToGroups(weights: Weights, vertexCount: number): VertexGroups {
  const groups: VertexGroup[] = weights.bones.map((name) => ({ name, w: new Array(vertexCount).fill(0) }));
  weights.w.forEach((pairs, v) => {
    for (const [i, x] of pairs) if (groups[i]) groups[i].w[v] = r3(x);
  });
  return { active: 0, groups: groups.filter((g) => g.w.some((x) => x > 0)) };
}

const falloff = (d: number, r: number) => {
  if (d >= r) return 0;
  const t = d / r;
  return (1 - t * t) * (1 - t * t);
};

export interface WeightBrush {
  mode: WeightMode;
  /** The weight Draw paints towards (Add / Subtract move by strength). */
  weight: number;
  strength: number;
  /** Local-space radius. */
  radius: number;
  center: Vec3;
  /** Mirror across the object's X axis. */
  symmetryX?: boolean;
}

/** One weight-brush dab. `neighbors` (from the mesh's edges) is needed for Blur. */
export function paintWeights(verts: Vec3[], w: number[], b: WeightBrush, neighbors?: number[][]): number[] {
  const out = [...w];
  const centers: Vec3[] = [b.center];
  if (b.symmetryX && Math.abs(b.center[0]) > b.radius * 0.05) centers.push([-b.center[0], b.center[1], b.center[2]]);
  const touched = new Map<number, number>();
  for (const c of centers)
    for (let i = 0; i < verts.length; i++) {
      const v = verts[i];
      const f = falloff(Math.hypot(v[0] - c[0], v[1] - c[1], v[2] - c[2]), b.radius);
      if (f > 0) touched.set(i, Math.max(touched.get(i) ?? 0, f));
    }
  for (const [i, f] of touched) {
    const k = Math.min(1, f * b.strength);
    let target: number;
    if (b.mode === 'draw') target = b.weight;
    else if (b.mode === 'add') target = 1;
    else if (b.mode === 'subtract') target = 0;
    else {
      const nb = neighbors?.[i] ?? [];
      target = nb.length ? nb.reduce((s, j) => s + w[j], 0) / nb.length : w[i];
    }
    out[i] = r3(Math.max(0, Math.min(1, w[i] + (target - w[i]) * k)));
  }
  return out;
}

/** Weight → colour, like Blender's weight display (blue 0 → green → yellow → red 1). */
export function weightColor(x: number): [number, number, number] {
  const t = Math.max(0, Math.min(1, x));
  if (t < 0.25) return [0, (t / 0.25), 1];
  if (t < 0.5) return [0, 1, 1 - (t - 0.25) / 0.25];
  if (t < 0.75) return [(t - 0.5) / 0.25, 1, 0];
  return [1, 1 - (t - 0.75) / 0.25, 0];
}

/**
 * Keep the groups when a tool changed the mesh: same number of points → same weights;
 * otherwise each new point takes the weight of the old point at the same place (or nearest).
 */
export function carryGroups(before: MeshData, after: MeshData, vg: VertexGroups): VertexGroups {
  if (before.vertices.length === after.vertices.length) return vg;
  const key = (v: Vec3) => `${Math.round(v[0] * 1e4)},${Math.round(v[1] * 1e4)},${Math.round(v[2] * 1e4)}`;
  const at = new Map<string, number>();
  before.vertices.forEach((v, i) => at.set(key(v), i));
  const brute = before.vertices.length * after.vertices.length <= 4_000_000;
  const src = after.vertices.map((v) => {
    const hit = at.get(key(v));
    if (hit !== undefined) return hit;
    if (!brute) return -1;
    let best = -1, bd = Infinity;
    before.vertices.forEach((p, i) => {
      const d = (p[0] - v[0]) ** 2 + (p[1] - v[1]) ** 2 + (p[2] - v[2]) ** 2;
      if (d < bd) (bd = d), (best = i);
    });
    return best;
  });
  return { ...vg, groups: vg.groups.map((g) => ({ ...g, w: src.map((i) => (i >= 0 ? g.w[i] ?? 0 : 0)) })) };
}

export function validGroups(vg: VertexGroups, vertexCount: number): string | null {
  if (!Array.isArray(vg.groups) || vg.groups.length < 1 || vg.groups.length > MAX_GROUPS) return `vertexGroups.groups must hold 1..${MAX_GROUPS} groups`;
  if (!Number.isInteger(vg.active) || vg.active < 0 || vg.active >= vg.groups.length) return 'vertexGroups.active invalid';
  const names = new Set<string>();
  for (const g of vg.groups) {
    if (typeof g.name !== 'string' || !g.name || g.name.length > 64 || names.has(g.name)) return 'vertex group names must be unique, 1..64 characters';
    names.add(g.name);
    if (!Array.isArray(g.w) || g.w.length !== vertexCount || !g.w.every((x) => typeof x === 'number' && x >= 0 && x <= 1)) return `vertex group "${g.name}" needs ${vertexCount} weights 0..1`;
  }
  return null;
}
