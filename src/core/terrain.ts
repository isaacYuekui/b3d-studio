// Procedural terrain (heightfield) and scattering. Pure and deterministic: the same
// parameters and seed always give the same landscape, so scripts stay reproducible.

import type { MeshData, SceneObject, Vec3 } from './types';
import { trs, apply as m4apply } from './rig';

// ---------------------------------------------------------------- noise

/** Small, fast seeded PRNG (mulberry32). */
export function rng(seed: number) {
  let a = seed >>> 0 || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 2D gradient noise (Perlin-style), seeded. Returns roughly -1..1. */
function makeNoise(seed: number) {
  const r = rng(seed);
  const perm = new Uint8Array(512);
  const p = Array.from({ length: 256 }, (_, i) => i);
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [p[i], p[j]] = [p[j], p[i]];
  }
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255];
  const g = (h: number, x: number, y: number) => {
    const a = (h & 7) * (Math.PI / 4);
    return Math.cos(a) * x + Math.sin(a) * y;
  };
  const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
  return (x: number, y: number) => {
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = x - xi, yf = y - yi;
    const X = xi & 255, Y = yi & 255;
    const aa = perm[perm[X] + Y], ab = perm[perm[X] + Y + 1], ba = perm[perm[X + 1] + Y], bb = perm[perm[X + 1] + Y + 1];
    const u = fade(xf), v = fade(yf);
    const l1 = g(aa, xf, yf) + u * (g(ba, xf - 1, yf) - g(aa, xf, yf));
    const l2 = g(ab, xf, yf - 1) + u * (g(bb, xf - 1, yf - 1) - g(ab, xf, yf - 1));
    return (l1 + v * (l2 - l1)) * 1.4;
  };
}

// ---------------------------------------------------------------- terrain

export interface TerrainParams {
  /** Width (x) and depth (y) in metres. */
  size: [number, number];
  /** Grid cells along the longer side (the other side scales to match). */
  resolution: number;
  /** Height of the hills, metres. */
  height: number;
  seed: number;
  /** Size of the main hills, metres (bigger = broader hills). */
  scale?: number;
  /** 0..1: how rugged the detail is. */
  roughness?: number;
  /** 0..1: mountain ridges instead of rolling hills. */
  ridges?: number;
  /** Flattened areas (for buildings, plazas, lakes), blended softly into the land. */
  flats?: { center: [number, number]; radius: number; height?: number }[];
  /** Paths / roads carved along polylines; they are levelled across and painted. */
  paths?: { points: [number, number][]; width: number }[];
  /** Raise the outer border into hills (a natural edge for game maps). */
  rim?: number;
  /** Slope (degrees) where rock takes over from grass. */
  rockSlope?: number;
}

export interface TerrainData {
  /** Grid points along x and y. */
  nx: number;
  ny: number;
  size: [number, number];
  /** Per vertex: grass / path / rock weights (3 numbers, 0..1, 2 decimals). */
  splat: number[];
  /** Layer textures (library ids) for grass, path, rock, and tiling (repeats per metre). */
  layers: [string, string, string];
  scales: [number, number, number];
}

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

function distToPolyline(x: number, y: number, pts: [number, number][]): { d: number; t: number; k: number } {
  let best = { d: Infinity, t: 0, k: 0 };
  for (let k = 0; k < pts.length - 1; k++) {
    const [ax, ay] = pts[k], [bx, by] = pts[k + 1];
    const dx = bx - ax, dy = by - ay;
    const L = dx * dx + dy * dy;
    const t = L ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / L)) : 0;
    const d = Math.hypot(x - (ax + dx * t), y - (ay + dy * t));
    if (d < best.d) best = { d, t, k };
  }
  return best;
}

export function generateTerrain(p: TerrainParams, layers: [string, string, string] = ['aerial_grass_rock', 'grass_path_2', 'rock_face']): { mesh: MeshData; terrain: TerrainData } {
  const [W, D] = p.size;
  const longest = Math.max(W, D);
  const cell = longest / p.resolution;
  const nx = Math.max(2, Math.round(W / cell) + 1);
  const ny = Math.max(2, Math.round(D / cell) + 1);
  const n1 = makeNoise(p.seed), n2 = makeNoise(p.seed + 101), n3 = makeNoise(p.seed + 202);
  const S = p.scale ?? Math.max(20, longest / 3);
  const rough = p.roughness ?? 0.45;
  const ridge = p.ridges ?? 0;
  const fbm = (x: number, y: number) => {
    let a = 0, amp = 1, f = 1 / S, norm = 0;
    for (let o = 0; o < 5; o++) {
      let v = n1(x * f + o * 17.3, y * f - o * 9.1);
      if (ridge > 0) v = (1 - ridge) * v + ridge * (1 - 2 * Math.abs(v));
      a += v * amp;
      norm += amp;
      amp *= 0.35 + rough * 0.35;
      f *= 2.03;
    }
    return a / norm;
  };
  const H: number[] = new Array(nx * ny);
  const pathW: number[] = new Array(nx * ny).fill(0);
  const X = (i: number) => -W / 2 + (i / (nx - 1)) * W;
  const Y = (j: number) => -D / 2 + (j / (ny - 1)) * D;
  // Base height
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      const x = X(i), y = Y(j);
      let h = (fbm(x, y) * 0.5 + 0.5) * p.height;
      // Gentle low-frequency variation so the land isn't uniform.
      h += n2(x / (S * 2.5), y / (S * 2.5)) * p.height * 0.15;
      if (p.rim) {
        const e = Math.min(x + W / 2, W / 2 - x, y + D / 2, D / 2 - y);
        h += p.rim * (1 - smoothstep(0, longest * 0.12, e)) * (0.7 + 0.3 * n3(x / 15, y / 15));
      }
      H[j * nx + i] = h;
    }
  // Flats: blend towards a level (default: the terrain height at the centre).
  for (const f of p.flats ?? []) {
    const ci = Math.round(((f.center[0] + W / 2) / W) * (nx - 1)), cj = Math.round(((f.center[1] + D / 2) / D) * (ny - 1));
    const level = f.height ?? H[Math.max(0, Math.min(ny - 1, cj)) * nx + Math.max(0, Math.min(nx - 1, ci))];
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        const d = Math.hypot(X(i) - f.center[0], Y(j) - f.center[1]);
        const w = 1 - smoothstep(f.radius, f.radius * 1.8 + 2, d);
        if (w > 0) H[j * nx + i] = H[j * nx + i] * (1 - w) + level * w;
      }
  }
  // Paths: level across the path (follow a smoothed centre-line height), slightly sunk.
  for (const path of p.paths ?? []) {
    if (path.points.length < 2) continue;
    // Densify the centre line (≤ ~2 cells apart) so the path follows the ground instead of
    // bridging straight between far-apart points, then smooth the heights along it.
    const pts: [number, number][] = [path.points[0]];
    for (let k = 1; k < path.points.length; k++) {
      const [ax, ay] = path.points[k - 1], [bx, by] = path.points[k];
      const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / Math.max(1, cell * 2)));
      for (let q = 1; q <= n; q++) pts.push([ax + ((bx - ax) * q) / n, ay + ((by - ay) * q) / n]);
    }
    let sm = pts.map(([x, y]) => sampleGrid(H, nx, ny, W, D, x, y));
    for (let pass = 0; pass < 4; pass++) sm = sm.map((h, k) => (sm[Math.max(0, k - 1)] + 2 * h + sm[Math.min(sm.length - 1, k + 1)]) / 4);
    const half = path.width / 2;
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        const { d, t, k } = distToPolyline(X(i), Y(j), pts);
        if (d > half * 2.2 + cell) continue;
        const centre = sm[k] * (1 - t) + sm[Math.min(sm.length - 1, k + 1)] * t - 0.06;
        const w = 1 - smoothstep(half * 0.9, half * 2.2 + cell, d);
        H[j * nx + i] = H[j * nx + i] * (1 - w) + centre * w;
        pathW[j * nx + i] = Math.max(pathW[j * nx + i], 1 - smoothstep(half * 0.6, half * 1.15, d));
      }
  }
  // Mesh
  const vertices: Vec3[] = [];
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) vertices.push([r3(X(i)), r3(Y(j)), r3(H[j * nx + i])]);
  const faces: number[][] = [];
  for (let j = 0; j < ny - 1; j++)
    for (let i = 0; i < nx - 1; i++) {
      const a = j * nx + i;
      faces.push([a, a + 1, a + nx + 1, a + nx]);
    }
  // Splat: rock on steep slopes, path where carved, grass elsewhere; a little noise in the edges.
  const rockSlope = ((p.rockSlope ?? 34) * Math.PI) / 180;
  const splat: number[] = [];
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      const hx = (H[j * nx + Math.min(nx - 1, i + 1)] - H[j * nx + Math.max(0, i - 1)]) / (2 * cell);
      const hy = (H[Math.min(ny - 1, j + 1) * nx + i] - H[Math.max(0, j - 1) * nx + i]) / (2 * cell);
      const slope = Math.atan(Math.hypot(hx, hy));
      const wobble = n3(X(i) / 4, Y(j) / 4) * 0.08;
      let rock = smoothstep(rockSlope - 0.12, rockSlope + 0.1, slope + wobble);
      const path = pathW[j * nx + i] * (1 - rock * 0.5);
      rock *= 1 - path;
      const grass = Math.max(0, 1 - rock - path);
      splat.push(r2(grass), r2(path), r2(rock));
    }
  return {
    mesh: { vertices, faces, smooth: true },
    terrain: { nx, ny, size: [W, D], splat, layers, scales: [0.35, 0.5, 0.25] },
  };
}

const r2 = (x: number) => Math.round(x * 100) / 100;
const r3 = (x: number) => Math.round(x * 1000) / 1000;

function sampleGrid(H: number[], nx: number, ny: number, W: number, D: number, x: number, y: number): number {
  const fx = Math.max(0, Math.min(nx - 1.0001, ((x + W / 2) / W) * (nx - 1)));
  const fy = Math.max(0, Math.min(ny - 1.0001, ((y + D / 2) / D) * (ny - 1)));
  const i = Math.floor(fx), j = Math.floor(fy), u = fx - i, v = fy - j;
  const h00 = H[j * nx + i], h10 = H[j * nx + i + 1], h01 = H[(j + 1) * nx + i], h11 = H[(j + 1) * nx + i + 1];
  return h00 * (1 - u) * (1 - v) + h10 * u * (1 - v) + h01 * (1 - u) * v + h11 * u * v;
}

const heights = new WeakMap<object, number[]>();

/** Height and slope (degrees) of a terrain object at a world x, y (identity rotation assumed, translation + scale honoured). */
export function terrainSample(o: SceneObject, x: number, y: number): { z: number; slope: number; path: number } | null {
  const t = o.terrain;
  if (!t || !o.mesh) return null;
  const { position: P, scale: S } = o.transform;
  const lx = (x - P[0]) / S[0], ly = (y - P[1]) / S[1];
  const [W, D] = t.size;
  if (Math.abs(lx) > W / 2 || Math.abs(ly) > D / 2) return null;
  let H = heights.get(o.mesh);
  if (!H) heights.set(o.mesh, (H = o.mesh.vertices.map((v) => v[2])));
  // Bilinear on the grid (vertices are row-major, x fastest).
  const h = (xx: number, yy: number) => sampleGrid(H!, t.nx, t.ny, W, D, xx, yy);
  const e = W / (t.nx - 1);
  const z = h(lx, ly);
  const slope = (Math.atan(Math.hypot((h(lx + e, ly) - h(lx - e, ly)) / (2 * e) * S[2] / S[0], (h(lx, ly + e) - h(lx, ly - e)) / (2 * e) * S[2] / S[1])) * 180) / Math.PI;
  const fx = Math.round(((lx + W / 2) / W) * (t.nx - 1)), fy = Math.round(((ly + D / 2) / D) * (t.ny - 1));
  const path = t.splat[(fy * t.nx + fx) * 3 + 1] ?? 0;
  return { z: P[2] + z * S[2], slope, path };
}

// ---------------------------------------------------------------- scatter

export interface ScatterParams {
  count: number;
  seed: number;
  /** Area in world x/y: a rectangle or a circle. Default: the whole terrain. */
  area?: { min: [number, number]; max: [number, number] } | { center: [number, number]; radius: number };
  scale?: [number, number];
  /** Minimum distance between items, metres. */
  spacing?: number;
  /** Skip slopes steeper than this, degrees. */
  maxSlope?: number;
  /** Keep off carved paths. */
  avoidPaths?: boolean;
  /** Circles to keep clear (houses, plazas, a camera lane…). */
  avoid?: { center: [number, number]; radius: number }[];
  /** Sink items into the ground a little (metres), e.g. rocks. */
  sink?: number;
  /** Clustered placement (0 = even, 1 = clumps), like real vegetation. */
  clump?: number;
}

export type ScatterItem = [number, number, number, number, number]; // x, y, z, yaw°, scale

export function scatterOn(terrain: SceneObject, p: ScatterParams): ScatterItem[] {
  const r = rng(p.seed * 7919 + 13);
  const t = terrain.terrain!;
  const { position: P, scale: S } = terrain.transform;
  const area = p.area ?? { min: [P[0] - (t.size[0] * S[0]) / 2, P[1] - (t.size[1] * S[1]) / 2] as [number, number], max: [P[0] + (t.size[0] * S[0]) / 2, P[1] + (t.size[1] * S[1]) / 2] as [number, number] };
  const inArea = (x: number, y: number) => ('center' in area ? Math.hypot(x - area.center[0], y - area.center[1]) <= area.radius : x >= area.min[0] && x <= area.max[0] && y >= area.min[1] && y <= area.max[1]);
  const box = 'center' in area ? { min: [area.center[0] - area.radius, area.center[1] - area.radius], max: [area.center[0] + area.radius, area.center[1] + area.radius] } : area;
  const sp = p.spacing ?? 0;
  const cellSize = Math.max(sp, 0.5);
  const grid = new Map<string, [number, number][]>();
  const key = (x: number, y: number) => `${Math.floor(x / cellSize)},${Math.floor(y / cellSize)}`;
  const tooClose = (x: number, y: number) => {
    if (!sp) return false;
    const cx = Math.floor(x / cellSize), cy = Math.floor(y / cellSize);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (const [ox, oy] of grid.get(`${cx + dx},${cy + dy}`) ?? []) if (Math.hypot(ox - x, oy - y) < sp) return true;
    return false;
  };
  const clumpNoise = makeNoise(p.seed + 55);
  const out: ScatterItem[] = [];
  const [s0, s1] = p.scale ?? [0.8, 1.2];
  for (let tries = 0; out.length < p.count && tries < p.count * 40; tries++) {
    const x = box.min[0] + r() * (box.max[0] - box.min[0]);
    const y = box.min[1] + r() * (box.max[1] - box.min[1]);
    if (!inArea(x, y)) continue;
    if (p.clump && (clumpNoise(x / 9, y / 9) * 0.5 + 0.5) < p.clump * 0.75 * r() + p.clump * 0.25) continue;
    if (p.avoid?.some((a) => Math.hypot(x - a.center[0], y - a.center[1]) < a.radius)) continue;
    const s = terrainSample(terrain, x, y);
    if (!s) continue;
    if (p.maxSlope !== undefined && s.slope > p.maxSlope) continue;
    if (p.avoidPaths && s.path > 0.15) continue;
    if (tooClose(x, y)) continue;
    const k = key(x, y);
    grid.set(k, [...(grid.get(k) ?? []), [x, y]]);
    const sc = s0 + (s1 - s0) * r();
    out.push([r3(x), r3(y), r3(s.z - (p.sink ?? 0) * sc), Math.round(r() * 360), Math.round(sc * 1000) / 1000]);
  }
  return out;
}

/** World transform of a scatter item (Blender convention), for export and tests. */
export function itemMatrix([x, y, z, yaw, s]: ScatterItem) {
  return trs({ position: [x, y, z], rotation: [0, 0, yaw], scale: [s, s, s] });
}
export const itemPoint = (it: ScatterItem, p: Vec3) => m4apply(itemMatrix(it), p);
