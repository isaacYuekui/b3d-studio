// Procedural low-poly nature: pines, broadleaf trees, bushes, rocks. Light enough to
// scatter by the thousand and to export to game engines (each part well under 20k tris),
// stylised the way many good-looking Roblox / mobile games are. Deterministic per seed.

import type { MeshData, Vec3 } from './types';
import { rng } from './terrain';

export const PLANT_KINDS = ['pine', 'tree', 'bush', 'rock', 'grass'] as const;
export type PlantKind = (typeof PLANT_KINDS)[number];

type V = Vec3;

/** Mesh builder that appends closed parts into one MeshData. */
class Builder {
  vertices: V[] = [];
  faces: number[][] = [];
  add(vs: V[], fs: number[][]) {
    const o = this.vertices.length;
    this.vertices.push(...vs);
    this.faces.push(...fs.map((f) => f.map((i) => i + o)));
  }
  mesh(smooth = false): MeshData {
    const r = (x: number) => Math.round(x * 1000) / 1000 + 0;
    return { vertices: this.vertices.map((v) => v.map(r) as V), faces: this.faces, smooth };
  }
}

/** Tapered tube along a polyline of centres, with radii, `sides` around; capped. */
function tube(b: Builder, path: V[], radii: number[], sides: number, twist = 0) {
  const vs: V[] = [];
  const fs: number[][] = [];
  for (let k = 0; k < path.length; k++) {
    const p = path[k];
    const q = path[Math.min(path.length - 1, k + 1)], o = path[Math.max(0, k - 1)];
    const d = norm(sub(q, o));
    const a = norm(Math.abs(d[2]) < 0.9 ? cross(d, [0, 0, 1]) : cross(d, [1, 0, 0]));
    const c = cross(d, a);
    for (let s = 0; s < sides; s++) {
      const t = (s / sides) * Math.PI * 2 + twist * k;
      vs.push(add(p, add(scale(a, Math.cos(t) * radii[k]), scale(c, Math.sin(t) * radii[k]))));
    }
  }
  for (let k = 0; k < path.length - 1; k++)
    for (let s = 0; s < sides; s++) {
      const a = k * sides + s, b2 = k * sides + ((s + 1) % sides);
      fs.push([a, b2, b2 + sides, a + sides]);
    }
  fs.push(Array.from({ length: sides }, (_, s) => sides - 1 - s)); // bottom cap
  const top = (path.length - 1) * sides;
  fs.push(Array.from({ length: sides }, (_, s) => top + s));
  b.add(vs, fs);
}

/** Icosphere (subdivided icosahedron), unit radius. */
function icosphere(level: number): { vs: V[]; fs: number[][] } {
  const t = (1 + Math.sqrt(5)) / 2;
  let vs: V[] = [[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]].map((v) => norm(v as V));
  let fs = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8], [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]];
  for (let l = 0; l < level; l++) {
    const mid = new Map<string, number>();
    const m = (a: number, b: number) => {
      const k = a < b ? `${a}_${b}` : `${b}_${a}`;
      let i = mid.get(k);
      if (i === undefined) {
        i = vs.length;
        vs.push(norm(scale(add(vs[a], vs[b]), 0.5)));
        mid.set(k, i);
      }
      return i;
    };
    const nf: number[][] = [];
    for (const [a, b, c] of fs) {
      const ab = m(a, b), bc = m(b, c), ca = m(c, a);
      nf.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]);
    }
    fs = nf;
  }
  vs = vs.map((v) => [v[0], v[1], v[2]]);
  return { vs, fs }; // counter-clockwise from outside (checked by tests: positive volume)
}

/** A lumpy blob: icosphere displaced by smooth random bumps. */
function blob(b: Builder, center: V, radii: V, r: () => number, level = 1, lumps = 0.22) {
  const { vs, fs } = icosphere(level);
  const bumps = Array.from({ length: 6 }, () => [norm([r() - 0.5, r() - 0.5, r() - 0.5] as V), (r() - 0.3) * lumps] as const);
  b.add(
    vs.map((v) => {
      let k = 1;
      for (const [d, amt] of bumps) k += amt * Math.max(0, dot(v, d)) ** 2;
      k += (r() - 0.5) * lumps * 0.35;
      return [center[0] + v[0] * radii[0] * k, center[1] + v[1] * radii[1] * k, center[2] + v[2] * radii[2] * k];
    }),
    fs,
  );
}

export interface PlantParts {
  /** Woody / stone part (trunk, branches, rock). */
  wood?: MeshData;
  /** Leaves (canopy, needles, bush, grass blades). */
  leaves?: MeshData;
  height: number;
}

export function makePlant(kind: PlantKind, seed: number, height?: number): PlantParts {
  const r = rng(seed * 31 + 7);
  const wood = new Builder();
  const leaves = new Builder();
  switch (kind) {
    case 'pine': {
      const h = height ?? 7 + r() * 5;
      const lean: V = [(r() - 0.5) * 0.04 * h, (r() - 0.5) * 0.04 * h, 0];
      tube(wood, [[0, 0, -0.2], [lean[0] * 0.5, lean[1] * 0.5, h * 0.5], [lean[0], lean[1], h * 0.86]], [h * 0.035, h * 0.022, h * 0.008], 7);
      const tiers = 5 + Math.floor(r() * 3);
      for (let k = 0; k < tiers; k++) {
        const f = k / tiers;
        const z0 = h * (0.22 + f * 0.66);
        const rad = h * (0.24 * (1 - f) + 0.05);
        const tierH = h * (0.24 - f * 0.08);
        const cx = lean[0] * (z0 / h), cy = lean[1] * (z0 / h);
        // A drooping cone: skirt ring, a ring part-way, and the tip.
        const n = 9;
        const vs: V[] = [];
        const rot = r() * Math.PI;
        for (let s = 0; s < n; s++) {
          const a = rot + (s / n) * Math.PI * 2;
          const rr = rad * (0.85 + r() * 0.3);
          vs.push([cx + Math.cos(a) * rr, cy + Math.sin(a) * rr, z0 - tierH * 0.12 * r()]);
        }
        for (let s = 0; s < n; s++) {
          const a = rot + ((s + 0.5) / n) * Math.PI * 2;
          vs.push([cx + Math.cos(a) * rad * 0.45, cy + Math.sin(a) * rad * 0.45, z0 + tierH * 0.45]);
        }
        vs.push([cx, cy, z0 + tierH]);
        vs.push([cx, cy, z0 + tierH * 0.15]); // underside centre
        const tip = 2 * n, under = 2 * n + 1;
        const fs: number[][] = [];
        for (let s = 0; s < n; s++) {
          const a = s, b2 = (s + 1) % n, m = n + s, m2 = n + ((s + 1) % n);
          fs.push([a, b2, m], [b2, m2, m], [m, m2, tip], [b2, a, under]);
        }
        leaves.add(vs, fs);
      }
      return { wood: wood.mesh(true), leaves: leaves.mesh(false), height: h };
    }
    case 'tree': {
      const h = height ?? 6 + r() * 4;
      const trunkTop: V = [(r() - 0.5) * h * 0.08, (r() - 0.5) * h * 0.08, h * 0.55];
      tube(wood, [[0, 0, -0.2], [trunkTop[0] * 0.3, trunkTop[1] * 0.3, h * 0.25], trunkTop], [h * 0.06, h * 0.045, h * 0.035], 7);
      const branches = 3 + Math.floor(r() * 2);
      const tips: V[] = [];
      for (let k = 0; k < branches; k++) {
        const a = (k / branches) * Math.PI * 2 + r() * 0.8;
        const len = h * (0.22 + r() * 0.12);
        const tip: V = [trunkTop[0] + Math.cos(a) * len, trunkTop[1] + Math.sin(a) * len, trunkTop[2] + h * (0.15 + r() * 0.12)];
        tube(wood, [trunkTop, [(trunkTop[0] + tip[0]) / 2, (trunkTop[1] + tip[1]) / 2, (trunkTop[2] + tip[2]) / 2 + h * 0.03], tip], [h * 0.03, h * 0.02, h * 0.012], 5);
        tips.push(tip);
      }
      const crown: V = [trunkTop[0], trunkTop[1], h * 0.78];
      blob(leaves, crown, [h * 0.3, h * 0.3, h * 0.24], r, 1);
      for (const t of tips) blob(leaves, [t[0], t[1], t[2] + h * 0.04], [h * (0.18 + r() * 0.06), h * (0.18 + r() * 0.06), h * (0.15 + r() * 0.04)], r, 1);
      return { wood: wood.mesh(true), leaves: leaves.mesh(false), height: h };
    }
    case 'bush': {
      const h = height ?? 0.8 + r() * 0.7;
      const n = 2 + Math.floor(r() * 3);
      for (let k = 0; k < n; k++) {
        const a = r() * Math.PI * 2, d = h * 0.35 * r();
        blob(leaves, [Math.cos(a) * d, Math.sin(a) * d, h * (0.45 + r() * 0.1)], [h * (0.5 + r() * 0.2), h * (0.5 + r() * 0.2), h * 0.5], r, 1);
      }
      return { leaves: leaves.mesh(false), height: h };
    }
    case 'rock': {
      const h = height ?? 0.6 + r() * 1.2;
      blob(wood, [0, 0, h * 0.35], [h * (0.8 + r() * 0.5), h * (0.7 + r() * 0.4), h * 0.65], r, 1, 0.35);
      return { wood: wood.mesh(false), height: h };
    }
    case 'grass': {
      // A tuft of blades (thin triangles), for close-up ground cover.
      const h = height ?? 0.35 + r() * 0.2;
      const n = 9 + Math.floor(r() * 6);
      for (let k = 0; k < n; k++) {
        const a = r() * Math.PI * 2, d = r() * 0.12;
        const bx = Math.cos(a) * d, by = Math.sin(a) * d;
        const w = 0.025 + r() * 0.015;
        const bend = (r() - 0.5) * 0.25;
        const dir = r() * Math.PI;
        const px = Math.cos(dir) * w, py = Math.sin(dir) * w;
        const bh = h * (0.6 + r() * 0.5);
        leaves.add([[bx - px, by - py, 0], [bx + px, by + py, 0], [bx + bend * Math.cos(a), by + bend * Math.sin(a), bh]], [[0, 1, 2], [1, 0, 2]]);
      }
      return { leaves: leaves.mesh(false), height: h };
    }
  }
}

// small vector helpers
function add(a: V, b: V): V {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}
function sub(a: V, b: V): V {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
function scale(a: V, k: number): V {
  return [a[0] * k, a[1] * k, a[2] * k];
}
function dot(a: V, b: V) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
function cross(a: V, b: V): V {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function norm(a: V): V {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
}
