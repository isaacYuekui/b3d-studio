// Material slots (Blender: Material Properties → slots, Edit Mode → Assign): each face of a mesh
// can use one of the object's materials. `mesh.materialIndex[f]` is the slot of face f — 0 is the
// object's main material, 1.. are `materialSlots`. Missing = every face uses the main material.
//
// Mesh tools don't need to know about slots: after any edit, the slots are carried over to the new
// faces from the old ones they came from (same corners, or the same plane nearby).

import type { MeshData, Vec3 } from '../types';
import { faceNormal } from './topology';

/** Extra material slots an object can have (besides its main material). */
export const MAX_SLOTS = 8;

/** Slot of face f (0 = main material). */
export const slotOf = (mesh: MeshData, f: number): number => (validIndex(mesh) ? mesh.materialIndex![f] : 0);

/** The per-face slots are usable: one per face. */
export const validIndex = (mesh: MeshData): boolean => !!mesh.materialIndex && mesh.materialIndex.length === mesh.faces.length;

/** True when some face uses another slot than the main material. */
export const usesSlots = (mesh: MeshData): boolean => validIndex(mesh) && mesh.materialIndex!.some((s) => s > 0);

/** The mesh with these per-face slots (left out when every face is on the main material). */
export function withMaterialIndex(mesh: MeshData, index: number[] | undefined): MeshData {
  const out = { ...mesh };
  if (index && index.length === mesh.faces.length && index.some((s) => s > 0)) out.materialIndex = index;
  else delete out.materialIndex;
  return out;
}

const key = (p: Vec3) => `${Math.round(p[0] * 1e4)},${Math.round(p[1] * 1e4)},${Math.round(p[2] * 1e4)}`;
const centroid = (vs: Vec3[], f: number[]): Vec3 => {
  const c: Vec3 = [0, 0, 0];
  for (const i of f) for (let k = 0; k < 3; k++) c[k] += vs[i][k] / f.length;
  return c;
};
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const dist2 = (a: Vec3, b: Vec3) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;

/**
 * Per-face slots for an edited mesh, from the mesh before the edit: a face keeps the slot of the
 * old face it shares the most corners with (ties: the one facing the same way); a face with no
 * old corners (an extruded cap, a moved face) takes the nearest old face facing the same way.
 */
export function transferMaterialIndex(before: MeshData, after: MeshData): number[] | undefined {
  if (!usesSlots(before)) return undefined;
  const old = before.materialIndex!;
  const byPos = new Map<string, number[]>();
  before.faces.forEach((f, fi) => {
    for (const v of f) {
      const k = key(before.vertices[v]);
      const list = byPos.get(k);
      if (list) list.push(fi);
      else byPos.set(k, [fi]);
    }
  });
  const oldN = before.faces.map((f) => faceNormal(before.vertices, f));
  const oldC = before.faces.map((f) => centroid(before.vertices, f));
  const out = after.faces.map((f) => {
    const n = faceNormal(after.vertices, f);
    const counts = new Map<number, number>();
    for (const v of f) for (const fi of byPos.get(key(after.vertices[v])) ?? []) counts.set(fi, (counts.get(fi) ?? 0) + 1);
    let best = -1, bestScore = -Infinity;
    for (const [fi, c] of counts) {
      const score = c * 10 + dot(n, oldN[fi]);
      if (score > bestScore) {
        bestScore = score;
        best = fi;
      }
    }
    if (best >= 0 && (counts.get(best)! >= 2 || dot(n, oldN[best]) > 0.9)) return old[best];
    // Nothing shared: nearest old face facing (roughly) the same way, else just the nearest.
    const c = centroid(after.vertices, f);
    let near = 0, nearD = Infinity, any = 0, anyD = Infinity;
    oldC.forEach((oc, fi) => {
      const d = dist2(c, oc);
      if (d < anyD) {
        anyD = d;
        any = fi;
      }
      if (dot(n, oldN[fi]) > 0.7 && d < nearD) {
        nearD = d;
        near = fi;
      }
    });
    return old[nearD < Infinity ? near : any];
  });
  return out.some((s) => s > 0) ? out : undefined;
}

/**
 * Which face of `original` each face of `result` lies on (same plane, inside it), as that face's
 * slot; faces that lie on none (new cut surfaces of a boolean or a fracture) get `inside`.
 */
export function surfaceSlots(original: MeshData, result: MeshData, inside: number): number[] {
  const planes = original.faces.map((f) => {
    const n = faceNormal(original.vertices, f);
    const p = original.vertices[f[0]];
    // Project on the plane's dominant axis for the inside test.
    const ax = Math.abs(n[0]) > Math.abs(n[1]) ? (Math.abs(n[0]) > Math.abs(n[2]) ? 0 : 2) : Math.abs(n[1]) > Math.abs(n[2]) ? 1 : 2;
    const [u, v] = ax === 0 ? [1, 2] : ax === 1 ? [0, 2] : [0, 1];
    return { n, d: dot(n, p), poly: f.map((i) => [original.vertices[i][u], original.vertices[i][v]] as [number, number]), u, v };
  });
  let size = 0;
  for (const p of original.vertices) size = Math.max(size, Math.abs(p[0]), Math.abs(p[1]), Math.abs(p[2]));
  const eps = 1e-4 * Math.max(1, size);
  return result.faces.map((f) => {
    const n = faceNormal(result.vertices, f);
    const c = centroid(result.vertices, f);
    for (let i = 0; i < planes.length; i++) {
      const pl = planes[i];
      if (dot(n, pl.n) < 0.999 || Math.abs(dot(pl.n, c) - pl.d) > eps) continue;
      if (inPoly([c[pl.u], c[pl.v]], pl.poly)) return slotOf(original, i);
    }
    return inside;
  });
}

function inPoly(p: [number, number], poly: [number, number][]): boolean {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if (a[1] > p[1] !== b[1] > p[1] && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) hit = !hit;
  }
  return hit;
}
