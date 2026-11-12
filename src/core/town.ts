// Town generator: a grid of streets and buildings in one go — village houses with pitched roofs,
// town blocks with flat roofs, or city towers — built from real-size meshes with a "windows"
// facade pattern, so they look like buildings from a distance and work with Cell Fracture,
// physics and force fields. Deterministic per seed.

import type { Command } from './commands';
import type { MeshData, Vec3 } from './types';

export const TOWN_STYLES = ['village', 'town', 'city'] as const;
export type TownStyle = (typeof TOWN_STYLES)[number];

export interface TownOptions {
  /** Id prefix for the objects (default "town"). */
  prefix: string;
  style: TownStyle;
  /** Centre of the town on the ground, metres. */
  center: [number, number];
  /** Width and depth of the area, metres. */
  size: [number, number];
  /** Height of the ground the buildings stand on (default 0). */
  base: number;
  seed: number;
  /** Add an asphalt ground under the town (default true). */
  ground: boolean;
}

export const DEFAULT_TOWN: TownOptions = { prefix: 'town', style: 'town', center: [0, 0], size: [60, 60], base: 0, seed: 1, ground: true };

const STYLE = {
  village: { lot: 14, street: 7, storeys: [1, 2], fill: [0.45, 0.65], roof: 'pitched', walls: ['#e8dcc5', '#f0e3cf', '#e4d2b6', '#dfe6dc', '#efd9c8', '#d9d2c3'], glass: '#33424f', storey: 3 },
  town: { lot: 16, street: 9, storeys: [2, 5], fill: [0.6, 0.85], roof: 'flat', walls: ['#c9b9a0', '#b7a38a', '#a7b3bd', '#bfa595', '#d4c8b0', '#9e8b78', '#c2c7c9'], glass: '#2c3a46', storey: 3.2 },
  city: { lot: 22, street: 12, storeys: [6, 24], fill: [0.65, 0.85], roof: 'flat', walls: ['#a9b4bf', '#8d99a6', '#c4c9cf', '#b3a693', '#7f8b96', '#d0d4d8'], glass: '#3a5468', storey: 3.5 },
} as const;

/** Small, fast, seeded random numbers (mulberry32). */
function rng(seed: number) {
  let a = seed >>> 0 || 1;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Box mesh from z = 0 up to h, centred on x/y, faces outward. */
export function boxMesh(w: number, d: number, h: number, z0 = 0): MeshData {
  const hx = w / 2, hy = d / 2;
  const r = (v: number) => Math.round(v * 1000) / 1000;
  const vertices: Vec3[] = [];
  for (const z of [z0, z0 + h]) for (const y of [-hy, hy]) for (const x of [-hx, hx]) vertices.push([r(x), r(y), r(z)]);
  return { vertices, faces: [[0, 2, 3, 1], [4, 5, 7, 6], [0, 1, 5, 4], [1, 3, 7, 5], [3, 2, 6, 7], [2, 0, 4, 6]], smooth: false };
}

/** Hip roof: four slopes up to a ridge along the longer side (a pyramid on a square). */
export function hipRoof(w: number, d: number, h: number): MeshData {
  const r = (v: number) => Math.round(v * 1000) / 1000;
  const turn = d > w; // build along x, then turn a quarter so the ridge follows the longer side
  const [L, S] = turn ? [d, w] : [w, d];
  const hx = L / 2, hy = S / 2;
  const ridge = hx - hy;
  let vertices: Vec3[];
  let faces: number[][];
  if (ridge < 0.05) {
    vertices = [[-hx, -hy, 0], [hx, -hy, 0], [hx, hy, 0], [-hx, hy, 0], [0, 0, h]];
    faces = [[0, 3, 2, 1], [0, 1, 4], [1, 2, 4], [2, 3, 4], [3, 0, 4]];
  } else {
    vertices = [[-hx, -hy, 0], [hx, -hy, 0], [hx, hy, 0], [-hx, hy, 0], [-ridge, 0, h], [ridge, 0, h]];
    faces = [[0, 3, 2, 1], [0, 1, 5, 4], [2, 3, 4, 5], [1, 2, 5], [3, 0, 4]];
  }
  if (turn) vertices = vertices.map(([x, y, z]) => [-y, x, z]);
  return { vertices: vertices.map((v) => v.map(r) as Vec3), faces, smooth: false };
}

/** The commands that build the town (objects only; no selection or camera). */
export function townCommands(o: TownOptions): Command[] {
  const st = STYLE[o.style];
  const rand = rng(o.seed * 7919 + 13);
  const pick = <T,>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length) % xs.length];
  const cmds: Command[] = [];
  const [cx, cy] = o.center;
  const [W, D] = o.size;
  // Lots in a grid; every third row / column is a street.
  const pitch = st.lot;
  const nx = Math.max(1, Math.floor(W / pitch)), ny = Math.max(1, Math.floor(D / pitch));
  const x0 = cx - (nx * pitch) / 2 + pitch / 2, y0 = cy - (ny * pitch) / 2 + pitch / 2;
  if (o.ground) {
    cmds.push({
      type: 'add',
      primitive: 'mesh',
      id: `${o.prefix}-ground`,
      name: 'Town ground',
      mesh: boxMesh(W + pitch, D + pitch, 0.2, -0.2),
      material: { baseColor: '#b8b8b2', roughness: 0.9, texture: 'asphalt_02', textureScale: 0.25 },
      transform: { position: [cx, cy, o.base] },
    });
    cmds.push({ type: 'setRigidBody', id: `${o.prefix}-ground`, rigid: { type: 'passive', friction: 0.7 } });
  }
  let n = 0;
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      if (i % 3 === 2 || j % 3 === 2) continue; // streets
      const lotFree = pitch - st.street * 0.5;
      const w = Math.max(4, lotFree * (st.fill[0] + rand() * (st.fill[1] - st.fill[0])));
      const d = Math.max(4, lotFree * (st.fill[0] + rand() * (st.fill[1] - st.fill[0])));
      const floors = Math.round(st.storeys[0] + Math.pow(rand(), o.style === 'city' ? 1.6 : 1) * (st.storeys[1] - st.storeys[0]));
      const h = floors * st.storey + (o.style === 'village' ? 0.4 : 0.6);
      const jitter = (pitch - Math.max(w, d)) * 0.25;
      const px = x0 + i * pitch + (rand() - 0.5) * jitter, py = y0 + j * pitch + (rand() - 0.5) * jitter;
      const yaw = o.style === 'village' ? Math.round((rand() - 0.5) * 16) : 0;
      const id = `${o.prefix}-b${n}`;
      const wall = pick(st.walls);
      cmds.push({
        type: 'add',
        primitive: 'mesh',
        id,
        name: `${o.style === 'village' ? 'House' : 'Building'} ${n + 1}`,
        mesh: boxMesh(w, d, h),
        material: { baseColor: wall, roughness: 0.82, pattern: { type: 'windows', colorA: st.glass, colorB: wall, scale: 1 / st.storey, bump: 0.5 } },
        transform: { position: [px, py, o.base], rotation: [0, 0, yaw] },
      });
      // Roofs: a pitched roof for houses, a parapet slab for flat roofs (it also hides the roof windows).
      if (st.roof === 'pitched')
        cmds.push({
          type: 'add',
          primitive: 'mesh',
          id: `${id}-roof`,
          name: `Roof ${n + 1}`,
          mesh: hipRoof(w + 0.8, d + 0.8, Math.min(w, d) * 0.45),
          material: { baseColor: pick(['#9c3b2e', '#7d4a32', '#5d4a44', '#8a3a2a']), roughness: 0.7, texture: 'clay_roof_tiles_02', textureScale: 0.5 },
          transform: { position: [px, py, o.base + h], rotation: [0, 0, yaw] },
        });
      else
        cmds.push({
          type: 'add',
          primitive: 'mesh',
          id: `${id}-roof`,
          name: `Roof ${n + 1}`,
          mesh: boxMesh(w + 0.3, d + 0.3, 0.5),
          material: { baseColor: '#6f6f6b', roughness: 0.9 },
          transform: { position: [px, py, o.base + h], rotation: [0, 0, yaw] },
        });
      n++;
    }
  return cmds;
}

/** Ids of the buildings (not roofs) a town with these options creates. */
export function townBuildingIds(cmds: Command[]): string[] {
  return cmds.flatMap((c) => (c.type === 'add' && c.id && /-b\d+$/.test(c.id) ? [c.id] : []));
}
