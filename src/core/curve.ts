// Curves (Blender's Bezier / NURBS path objects, simplified): a curve object is a mesh object
// whose vertices are the control points (no faces), with a `curve` modifier that turns them into
// a smooth path — auto-smooth handles, like Blender's Auto handles — and, with a Bevel depth, a
// round tube around it. Edit Mode moves the points; Convert (Apply) makes the tube a real mesh.
// Objects (and the camera) can Follow a curve over a range of frames.

import type { MeshData, Vec3 } from './types';

export interface CurveSettings {
  /** Tube radius in metres (Blender: Geometry → Bevel Depth). */
  bevel: number;
  /** Points per span between control points. */
  resolution: number;
  /** Closed loop. */
  cyclic: boolean;
  /** Sides around the tube. */
  sides: number;
}

export const DEFAULT_CURVE: CurveSettings = { bevel: 0.05, resolution: 12, cyclic: false, sides: 8 };

const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
const len = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
const norm = (a: Vec3): Vec3 => {
  const l = len(a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/**
 * The smooth path through the control points (centripetal Catmull–Rom: no loops or overshoot at
 * sharp turns), `resolution` points per span.
 */
export function curvePolyline(points: Vec3[], cyclic: boolean, resolution: number): Vec3[] {
  const n = points.length;
  if (n < 2) return points.map((p) => [...p] as Vec3);
  const res = Math.max(1, Math.round(resolution));
  const P = (i: number): Vec3 => {
    if (cyclic) return points[((i % n) + n) % n];
    if (i < 0) return add(points[0], sub(points[0], points[1]));
    if (i >= n) return add(points[n - 1], sub(points[n - 1], points[n - 2]));
    return points[i];
  };
  const out: Vec3[] = [];
  const spans = cyclic ? n : n - 1;
  for (let s = 0; s < spans; s++) {
    const p0 = P(s - 1), p1 = P(s), p2 = P(s + 1), p3 = P(s + 2);
    const t01 = Math.sqrt(len(sub(p1, p0))) || 1e-4, t12 = Math.sqrt(len(sub(p2, p1))) || 1e-4, t23 = Math.sqrt(len(sub(p3, p2))) || 1e-4;
    // Tangents at p1 and p2 (Barry–Goldman, scaled to the span).
    const m1 = mul(add(sub(mul(sub(p1, p0), 1 / t01), mul(sub(p2, p0), 1 / (t01 + t12))), mul(sub(p2, p1), 1 / t12)), t12);
    const m2 = mul(add(sub(mul(sub(p2, p1), 1 / t12), mul(sub(p3, p1), 1 / (t12 + t23))), mul(sub(p3, p2), 1 / t23)), t12);
    for (let k = 0; k < res; k++) {
      const t = k / res, t2 = t * t, t3 = t2 * t;
      const h00 = 2 * t3 - 3 * t2 + 1, h10 = t3 - 2 * t2 + t, h01 = -2 * t3 + 3 * t2, h11 = t3 - t2;
      out.push(add(add(mul(p1, h00), mul(m1, h10)), add(mul(p2, h01), mul(m2, h11))));
    }
  }
  if (!cyclic) out.push([...points[n - 1]] as Vec3);
  return out;
}

/** Cumulative lengths along a polyline. */
function lengths(poly: Vec3[], cyclic: boolean): number[] {
  const L = [0];
  for (let i = 1; i < poly.length; i++) L.push(L[i - 1] + len(sub(poly[i], poly[i - 1])));
  if (cyclic && poly.length > 1) L.push(L[L.length - 1] + len(sub(poly[0], poly[poly.length - 1])));
  return L;
}

/** Point and direction at a fraction 0..1 of the way along (by distance). */
export function pathAt(poly: Vec3[], cyclic: boolean, f: number): { p: Vec3; t: Vec3 } {
  if (poly.length === 0) return { p: [0, 0, 0], t: [0, 1, 0] };
  if (poly.length === 1) return { p: [...poly[0]] as Vec3, t: [0, 1, 0] };
  const pts = cyclic ? [...poly, poly[0]] : poly;
  const L = lengths(poly, cyclic);
  const total = L[L.length - 1] || 1;
  const d = (cyclic ? ((f % 1) + 1) % 1 : Math.max(0, Math.min(1, f))) * total;
  let i = 1;
  while (i < L.length - 1 && L[i] < d) i++;
  const a = pts[i - 1], b = pts[i];
  const seg = L[i] - L[i - 1] || 1;
  const k = (d - L[i - 1]) / seg;
  return { p: add(a, mul(sub(b, a), k)), t: norm(sub(b, a)) };
}

export const pathLength = (poly: Vec3[], cyclic: boolean) => lengths(poly, cyclic).at(-1) ?? 0;

/** A round tube along the curve (Bevel depth), with caps on open curves. */
export function curveTube(points: Vec3[], c: CurveSettings): MeshData {
  const poly = curvePolyline(points, c.cyclic, c.resolution);
  const r = Math.max(0.002, c.bevel);
  const sides = Math.max(3, Math.min(32, Math.round(c.sides)));
  const n = poly.length;
  if (n < 2) return { vertices: [], faces: [], smooth: true };
  // Parallel-transport frames: no twisting along the path.
  const T = poly.map((_, i) => norm(sub(poly[c.cyclic ? (i + 1) % n : Math.min(n - 1, i + 1)], poly[c.cyclic ? (i - 1 + n) % n : Math.max(0, i - 1)])));
  let N: Vec3 = Math.abs(T[0][2]) < 0.9 ? norm(cross(T[0], [0, 0, 1])) : norm(cross(T[0], [1, 0, 0]));
  const frames: { n: Vec3; b: Vec3 }[] = [];
  for (let i = 0; i < n; i++) {
    if (i > 0) {
      const axis = cross(T[i - 1], T[i]);
      const s = len(axis);
      if (s > 1e-8) {
        const ax = mul(axis, 1 / s);
        const ang = Math.atan2(s, dot(T[i - 1], T[i]));
        // Rodrigues rotation of N about ax.
        const cs = Math.cos(ang), sn = Math.sin(ang);
        N = add(add(mul(N, cs), mul(cross(ax, N), sn)), mul(ax, dot(ax, N) * (1 - cs)));
      }
      N = norm(sub(N, mul(T[i], dot(N, T[i]))));
    }
    frames.push({ n: N, b: cross(T[i], N) });
  }
  const vertices: Vec3[] = [];
  const r5 = (x: number) => Math.round(x * 1e5) / 1e5;
  for (let i = 0; i < n; i++)
    for (let k = 0; k < sides; k++) {
      const a = (k / sides) * Math.PI * 2;
      const off = add(mul(frames[i].n, Math.cos(a) * r), mul(frames[i].b, Math.sin(a) * r));
      const v = add(poly[i], off);
      vertices.push([r5(v[0]), r5(v[1]), r5(v[2])]);
    }
  const faces: number[][] = [];
  const rings = c.cyclic ? n : n - 1;
  for (let i = 0; i < rings; i++) {
    const j = (i + 1) % n;
    for (let k = 0; k < sides; k++) {
      const k2 = (k + 1) % sides;
      faces.push([i * sides + k, i * sides + k2, j * sides + k2, j * sides + k]);
    }
  }
  if (!c.cyclic) {
    faces.push(Array.from({ length: sides }, (_, k) => sides - 1 - k));
    faces.push(Array.from({ length: sides }, (_, k) => (n - 1) * sides + k));
  }
  return { vertices, faces, smooth: true };
}

// ---------------------------------------------------------------- Edit Mode on curves

/** Extrude (E): a new point past each selected end. Returns the curve and the new points' indices. */
export function extrudeCurve(pts: Vec3[], sel: number[]): { points: Vec3[]; sel: number[] } {
  const s = new Set(sel);
  const out = [...pts];
  const added: number[] = [];
  if (s.has(pts.length - 1) && pts.length >= 1) {
    const last = pts[pts.length - 1], prev = pts[pts.length - 2] ?? sub(last, [1, 0, 0]);
    out.push(add(last, sub(last, prev)));
    added.push(out.length - 1);
  }
  if (s.has(0) && pts.length >= 2 && !(pts.length === 1)) {
    const first = pts[0], next = pts[1];
    out.unshift(add(first, sub(first, next)));
    for (let i = 0; i < added.length; i++) added[i]++;
    added.push(0);
  }
  return { points: out, sel: added };
}

/** Subdivide: a point between each pair of neighbouring selected points. */
export function subdivideCurve(pts: Vec3[], sel: number[], cyclic: boolean): { points: Vec3[]; sel: number[] } {
  const s = new Set(sel);
  const out: Vec3[] = [];
  const outSel: number[] = [];
  for (let i = 0; i < pts.length; i++) {
    out.push(pts[i]);
    if (s.has(i)) outSel.push(out.length - 1);
    const j = cyclic ? (i + 1) % pts.length : i + 1;
    if (j < pts.length && j !== i && s.has(i) && s.has(j) && (cyclic || j > i)) {
      out.push(mul(add(pts[i], pts[j]), 0.5));
      outSel.push(out.length - 1);
    }
  }
  return { points: out, sel: outSel };
}

/** Delete selected points (a curve keeps at least two). */
export function deleteCurvePoints(pts: Vec3[], sel: number[]): Vec3[] {
  const s = new Set(sel);
  const out = pts.filter((_, i) => !s.has(i));
  if (out.length < 2) throw new Error('A curve needs at least two points');
  return out;
}

/** Ready-made curves for Add → Curve (metres, Z up). */
export function curvePreset(kind: 'bezier' | 'circle' | 'path'): { points: Vec3[]; cyclic: boolean } {
  if (kind === 'circle') return { points: Array.from({ length: 8 }, (_, i) => [Math.round(Math.cos((i / 8) * Math.PI * 2) * 1e4) / 1e4, Math.round(Math.sin((i / 8) * Math.PI * 2) * 1e4) / 1e4, 0] as Vec3), cyclic: true };
  if (kind === 'path') return { points: [[-2, 0, 0], [-1, 0, 0], [0, 0, 0], [1, 0, 0], [2, 0, 0]], cyclic: false };
  return { points: [[-1, 0, 0], [-0.4, 0.6, 0], [0.4, -0.6, 0], [1, 0, 0]], cyclic: false };
}
