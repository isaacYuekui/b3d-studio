// Proportional editing (Blender's O): the selection moves fully, and nearby vertices follow
// with a smooth falloff that reaches zero at `radius` (measured in world space).

import type { Vec3 } from '../types';

/** Weight per moving vertex: 1 for the selection, (1 − t²)² for others at distance t·radius. */
export function proportionalWeights(points: Vec3[], selected: number[], radius: number): Map<number, number> {
  const sel = new Set(selected);
  const sp = selected.map((i) => points[i]);
  const out = new Map<number, number>();
  for (const i of selected) out.set(i, 1);
  points.forEach((p, i) => {
    if (sel.has(i)) return;
    let d = Infinity;
    for (const q of sp) d = Math.min(d, Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]));
    if (d >= radius) return;
    const t = d / radius;
    out.set(i, (1 - t * t) * (1 - t * t));
  });
  return out;
}
