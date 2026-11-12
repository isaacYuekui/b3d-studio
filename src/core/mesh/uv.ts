// UV maps (Blender's UV Editor / Unwrap). A mesh can carry `uv`: for each face, one [u, v] per
// corner, in 0..1 image space. Without it, textures are box-projected in metres (the default).
//
// Smart UV Project, like Blender's: faces are grouped by the direction they face (within an
// angle limit), each connected group is an island projected flat along that direction at its
// true size, and the islands are packed into the unit square with a small margin.

import type { MeshData, Vec3 } from '../types';
import { faceNormal } from './topology';

export type UV = [number, number];

/** The UVs are usable: one list per face, one point per corner. */
export const validUv = (m: MeshData): boolean =>
  !!m.uv && m.uv.length === m.faces.length && m.uv.every((f, i) => f.length === m.faces[i].length);

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: Vec3): Vec3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

function faceArea(vs: Vec3[], f: number[]): number {
  let a: Vec3 = [0, 0, 0];
  for (let i = 1; i + 1 < f.length; i++) {
    const p = vs[f[0]], q = vs[f[i]], r = vs[f[i + 1]];
    const c = cross([q[0] - p[0], q[1] - p[1], q[2] - p[2]], [r[0] - p[0], r[1] - p[1], r[2] - p[2]]);
    a = [a[0] + c[0], a[1] + c[1], a[2] + c[2]];
  }
  return Math.hypot(...a) / 2;
}

/** Two axes spanning the plane facing `n` (u right, v up as seen from the front of the face). */
function basis(n: Vec3): [Vec3, Vec3] {
  const up: Vec3 = Math.abs(n[2]) > 0.9 ? [0, 1, 0] : [0, 0, 1];
  const u = norm(cross(up, n));
  const v = norm(cross(n, u));
  return [u, v];
}

export interface UnwrapOptions {
  /** Faces bending more than this (degrees) from an island's direction start a new island. */
  angle: number;
  /** Space between islands, as a fraction of the square. */
  margin: number;
}

export const DEFAULT_UNWRAP: UnwrapOptions = { angle: 66, margin: 0.02 };

/** Smart UV Project: per-face corner UVs, islands packed into 0..1. */
export function smartUvProject(mesh: MeshData, o: Partial<UnwrapOptions> = {}): UV[][] {
  const { angle, margin } = { ...DEFAULT_UNWRAP, ...o };
  const vs = mesh.vertices, F = mesh.faces;
  const normals = F.map((f) => faceNormal(vs, f));
  const area = F.map((f) => faceArea(vs, f));
  const limit = Math.cos((angle * Math.PI) / 180);
  // Projection directions: biggest faces first, a new direction when none is close enough.
  const axes: Vec3[] = [];
  for (const fi of F.map((_, i) => i).sort((a, b) => area[b] - area[a])) {
    if (!axes.some((a) => dot(a, normals[fi]) >= limit)) axes.push(normals[fi]);
  }
  if (!axes.length) axes.push([0, 0, 1]);
  const axisOf = normals.map((n) => {
    let best = 0, bd = -Infinity;
    axes.forEach((a, i) => {
      const d = dot(a, n);
      if (d > bd) {
        bd = d;
        best = i;
      }
    });
    return best;
  });
  // Islands: faces sharing an edge and a direction.
  const edgeFaces = new Map<string, number[]>();
  F.forEach((f, fi) =>
    f.forEach((a, i) => {
      const b = f[(i + 1) % f.length];
      const k = a < b ? `${a},${b}` : `${b},${a}`;
      const l = edgeFaces.get(k);
      if (l) l.push(fi);
      else edgeFaces.set(k, [fi]);
    }),
  );
  const island = new Array<number>(F.length).fill(-1);
  const islands: number[][] = [];
  for (let s = 0; s < F.length; s++) {
    if (island[s] >= 0) continue;
    const id = islands.length;
    const list: number[] = [];
    const stack = [s];
    island[s] = id;
    while (stack.length) {
      const fi = stack.pop()!;
      list.push(fi);
      const f = F[fi];
      f.forEach((a, i) => {
        const b = f[(i + 1) % f.length];
        for (const g of edgeFaces.get(a < b ? `${a},${b}` : `${b},${a}`) ?? []) {
          if (island[g] < 0 && axisOf[g] === axisOf[fi]) {
            island[g] = id;
            stack.push(g);
          }
        }
      });
    }
    islands.push(list);
  }
  // Project each island flat at true size.
  const out: UV[][] = F.map((f) => f.map(() => [0, 0] as UV));
  const boxes = islands.map((list) => {
    const [u, v] = basis(axes[axisOf[list[0]]]);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const fi of list)
      F[fi].forEach((vi, c) => {
        const p = vs[vi];
        const uv: UV = [dot(p, u), dot(p, v)];
        out[fi][c] = uv;
        x0 = Math.min(x0, uv[0]);
        y0 = Math.min(y0, uv[1]);
        x1 = Math.max(x1, uv[0]);
        y1 = Math.max(y1, uv[1]);
      });
    return { list, x0, y0, w: Math.max(1e-6, x1 - x0), h: Math.max(1e-6, y1 - y0) };
  });
  // Shelf packing (tallest first) into a square about the size of the total island area.
  const total = boxes.reduce((s, b) => s + b.w * b.h, 0);
  const pad = margin * Math.sqrt(total) * 1.2;
  const width = Math.max(Math.sqrt(total) * 1.15, ...boxes.map((b) => b.w + 2 * pad));
  const placed: { x: number; y: number }[] = new Array(boxes.length);
  let x = 0, y = 0, row = 0;
  for (const i of boxes.map((_, i) => i).sort((a, b) => boxes[b].h - boxes[a].h)) {
    const b = boxes[i];
    if (x + b.w + 2 * pad > width && x > 0) {
      x = 0;
      y += row;
      row = 0;
    }
    placed[i] = { x: x + pad, y: y + pad };
    x += b.w + 2 * pad;
    row = Math.max(row, b.h + 2 * pad);
  }
  const size = Math.max(width, y + row);
  boxes.forEach((b, i) => {
    for (const fi of b.list) out[fi] = out[fi].map(([u, v]) => [round((u - b.x0 + placed[i].x) / size), round((v - b.y0 + placed[i].y) / size)] as UV);
  });
  return out;
}

const round = (x: number) => Math.round(x * 1e5) / 1e5;

/**
 * UVs after an edit: kept when every face still has the same corners in the same places (a face
 * moved as a whole keeps its UVs too, like Blender — they stretch); otherwise dropped, and the
 * mesh goes back to box projection until it's unwrapped again.
 */
export function carryUv(before: MeshData, after: MeshData): UV[][] | undefined {
  if (!validUv(before)) return undefined;
  if (after.faces === before.faces) return before.uv;
  // Same faces by vertex index (tools that moved vertices but rebuilt the face list): keep.
  if (after.faces.length === before.faces.length && after.faces.every((f, i) => f.length === before.faces[i].length && f.every((v, k) => v === before.faces[i][k]))) return before.uv;
  const key = (f: number[], vs: Vec3[]) => f.map((v) => vs[v].map((x) => Math.round(x * 1e4)).join(',')).sort().join('|');
  const old = new Map<string, number>();
  before.faces.forEach((f, i) => old.set(key(f, before.vertices), i));
  const out: UV[][] = [];
  for (const f of after.faces) {
    const i = old.get(key(f, after.vertices));
    if (i === undefined) return undefined;
    const byPos = new Map<string, UV>();
    before.faces[i].forEach((v, c) => byPos.set(before.vertices[v].map((x) => Math.round(x * 1e4)).join(','), before.uv![i][c]));
    out.push(f.map((v) => byPos.get(after.vertices[v].map((x) => Math.round(x * 1e4)).join(','))!));
  }
  return out;
}
