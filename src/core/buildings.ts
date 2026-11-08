// Procedural buildings: houses with walls, gable / hip / flat roofs, windows, a door,
// a chimney and a stone base. Each part is a separate simple mesh so it can take its own
// material (plaster, brick, roof tiles, glass) and export cleanly to game engines.
// Coordinates: metres, Z up; the building stands on z = 0, its front faces −Y.

import type { MeshData, Vec3 } from './types';
import { rng } from './terrain';
import { recalcNormals } from './mesh/ops';
import { EMPTY_SEL } from './mesh/select';

type V = Vec3;

export const ROOFS = ['gable', 'hip', 'flat'] as const;
export type RoofKind = (typeof ROOFS)[number];

export interface BuildingParams {
  width: number;
  depth: number;
  floors: number;
  floorHeight?: number;
  roof?: RoofKind;
  roofPitch?: number;
  seed?: number;
  /** Chimney on the roof. */
  chimney?: boolean;
}

export interface BuildingParts {
  walls: MeshData;
  roof: MeshData;
  frames: MeshData;
  glass: MeshData;
  door: MeshData;
  base: MeshData;
  chimney?: MeshData;
  height: number;
}

class B {
  v: V[] = [];
  f: number[][] = [];
  /** Closed hexahedron from 8 corners: bottom 0-3 (counter-clockwise seen from above), top 4-7. */
  hexa(c: V[]) {
    const o = this.v.length;
    this.v.push(...c);
    for (const face of [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]]) this.f.push(face.map((i) => i + o));
  }
  box(min: V, max: V) {
    const [a, b, c] = min, [d, e, f] = max;
    this.hexa([[a, b, c], [d, b, c], [d, e, c], [a, e, c], [a, b, f], [d, b, f], [d, e, f], [a, e, f]]);
  }
  poly(vs: V[], faces: number[][]) {
    const o = this.v.length;
    this.v.push(...vs);
    for (const f of faces) this.f.push(f.map((i) => i + o));
  }
  mesh(): MeshData {
    const r = (x: number) => Math.round(x * 1000) / 1000 + 0;
    const m: MeshData = { vertices: this.v.map((p) => p.map(r) as V), faces: this.f, smooth: false };
    // Orient every closed piece outwards (robust against hand-written winding).
    return m.faces.length ? recalcNormals(m, EMPTY_SEL, 'face').mesh : m;
  }
}

export function makeBuilding(p: BuildingParams): BuildingParts {
  const r = rng((p.seed ?? 1) * 97 + 3);
  const W = p.width, D = p.depth, F = Math.max(1, Math.round(p.floors));
  const fh = p.floorHeight ?? 3;
  const baseH = 0.35;
  const H = baseH + F * fh; // eaves height
  const roof = p.roof ?? 'gable';
  const pitch = ((p.roofPitch ?? 38) * Math.PI) / 180;
  const walls = new B(), roofB = new B(), frames = new B(), glass = new B(), door = new B(), base = new B();

  // Stone base (slightly wider) and walls.
  base.box([-W / 2 - 0.08, -D / 2 - 0.08, -0.3], [W / 2 + 0.08, D / 2 + 0.08, baseH]);
  walls.box([-W / 2, -D / 2, baseH], [W / 2, D / 2, H]);
  // Gable ends (triangles closing the roof space), along X: ridge runs along X.
  const ridgeH = roof === 'flat' ? 0 : (Math.min(W, D) / 2) * Math.tan(pitch);
  const alongX = W >= D;
  if (roof === 'gable') {
    const half = (alongX ? D : W) / 2;
    for (const s of [-1, 1]) {
      // Prism wedge for the gable: thin closed triangle slab at each end.
      if (alongX) {
        const x0 = s * (W / 2), x1 = x0 - s * 0.01;
        const tri: V[] = [[x0, -half, H], [x0, half, H], [x0, 0, H + ridgeH], [x1, -half, H], [x1, half, H], [x1, 0, H + ridgeH]];
        walls.poly(tri, s > 0 ? [[0, 1, 2], [3, 5, 4], [0, 3, 4, 1], [1, 4, 5, 2], [2, 5, 3, 0]] : [[0, 2, 1], [3, 4, 5], [0, 1, 4, 3], [1, 2, 5, 4], [2, 0, 3, 5]]);
      } else {
        const y0 = s * (D / 2), y1 = y0 - s * 0.01;
        const tri: V[] = [[-half, y0, H], [half, y0, H], [0, y0, H + ridgeH], [-half, y1, H], [half, y1, H], [0, y1, H + ridgeH]];
        walls.poly(tri, s > 0 ? [[0, 2, 1], [3, 4, 5], [0, 1, 4, 3], [1, 2, 5, 4], [2, 0, 3, 5]] : [[0, 1, 2], [3, 5, 4], [0, 3, 4, 1], [1, 4, 5, 2], [2, 5, 3, 0]]);
      }
    }
  }

  // Roof
  const oh = 0.35; // overhang
  const t = 0.14; // thickness
  if (roof === 'flat') {
    roofB.box([-W / 2 - 0.15, -D / 2 - 0.15, H], [W / 2 + 0.15, D / 2 + 0.15, H + 0.25]);
    // parapet
    roofB.box([-W / 2 - 0.15, -D / 2 - 0.15, H + 0.25], [W / 2 + 0.15, -D / 2 + 0.05, H + 0.7]);
    roofB.box([-W / 2 - 0.15, D / 2 - 0.05, H + 0.25], [W / 2 + 0.15, D / 2 + 0.15, H + 0.7]);
  } else if (roof === 'gable') {
    const half = (alongX ? D : W) / 2 + oh;
    const len = (alongX ? W : D) / 2 + oh;
    const drop = oh * Math.tan(pitch);
    for (const s of [-1, 1]) {
      // One slab from the eave (outer, lower) to the ridge.
      const e0 = s * half, z0 = H - drop, zr = H + ridgeH;
      const n = [0, -s * Math.sin(pitch), Math.cos(pitch)] as const; // slab normal (in the cross-section)
      const off = (k: number): [number, number] => [n[1] * k, n[2] * k];
      const [oy, oz] = off(t);
      const cs: [number, number][] = [[e0, z0], [0, zr], [oy, zr + oz], [e0 + oy, z0 + oz]]; // y, z of the slab section
      const pts = (x: number) => cs.map(([y, z]) => (alongX ? ([x, y, z] as V) : ([y, x, z] as V)));
      const a = pts(-len), b = pts(len);
      // hexahedron: bottom = (eave-out, ridge, ridge-top… ) — build faces explicitly
      const vs = [...a, ...b];
      const quads = [[0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7], [0, 3, 2, 1], [4, 5, 6, 7]];
      const flip = (s > 0) !== alongX;
      roofB.poly(vs, flip ? quads.map((q) => [...q].reverse()) : quads);
    }
  } else {
    // Hip roof: a pyramid-ish solid with a short ridge.
    const ox = W / 2 + oh, oy2 = D / 2 + oh;
    const rl = Math.max(0, (Math.max(W, D) - Math.min(W, D)) / 2);
    const z0 = H - oh * Math.tan(pitch);
    const zr = H + ridgeH;
    const ridge: V[] = alongX ? [[-rl, 0, zr], [rl, 0, zr]] : [[0, -rl, zr], [0, rl, zr]];
    const vs: V[] = [[-ox, -oy2, z0], [ox, -oy2, z0], [ox, oy2, z0], [-ox, oy2, z0], ...ridge];
    const fs = alongX
      ? [[0, 1, 5, 4], [1, 2, 5], [2, 3, 4, 5], [3, 0, 4], [0, 3, 2, 1]]
      : [[0, 1, 4], [1, 2, 5, 4], [2, 3, 5], [3, 0, 4, 5], [0, 3, 2, 1]];
    roofB.poly(vs, fs);
  }

  // Windows and the door. Facades: front (−Y), back (+Y), sides (±X).
  const winW = 1.0, winH = 1.3, sill = 0.95;
  const facade = (axis: 'x' | 'y', sign: number, length: number, isFront: boolean) => {
    const n = Math.max(1, Math.floor((length - 0.8) / 2.3));
    const step = length / n;
    const doorSlot = isFront ? Math.floor(n / 2) : -1;
    for (let f = 0; f < F; f++)
      for (let i = 0; i < n; i++) {
        const c = -length / 2 + step * (i + 0.5);
        const z0 = baseH + f * fh;
        if (f === 0 && i === doorSlot) {
          // Door with a frame
          const dw = 1.1, dh = 2.15;
          addPanel(door, axis, sign, c, z0, dw, dh, W, D, 0.06);
          addFrame(frames, axis, sign, c, z0, dw, dh, W, D);
          continue;
        }
        if (r() < 0.06) continue; // the odd blank wall looks less generated
        addPanel(glass, axis, sign, c, z0 + sill, winW, winH, W, D, 0.03);
        addFrame(frames, axis, sign, c, z0 + sill, winW, winH, W, D, true);
      }
  };
  facade('y', -1, W, true);
  facade('y', 1, W, false);
  facade('x', 1, D, false);
  facade('x', -1, D, false);

  let chimney: MeshData | undefined;
  if (p.chimney ?? roof !== 'flat') {
    const c = new B();
    const cx = (alongX ? W : D) * 0.25 * (r() < 0.5 ? -1 : 1);
    const cy = (alongX ? D : W) * 0.18;
    const [x, y] = alongX ? [cx, cy] : [cy, cx];
    c.box([x - 0.35, y - 0.35, H], [x + 0.35, y + 0.35, H + ridgeH + 0.6]);
    c.box([x - 0.42, y - 0.42, H + ridgeH + 0.6], [x + 0.42, y + 0.42, H + ridgeH + 0.75]);
    chimney = c.mesh();
  }

  return { walls: walls.mesh(), roof: roofB.mesh(), frames: frames.mesh(), glass: glass.mesh(), door: door.mesh(), base: base.mesh(), chimney, height: H + ridgeH };
}

/** A flat panel (glass / door) proud of the wall by `out`. */
function addPanel(b: B, axis: 'x' | 'y', sign: number, c: number, z0: number, w: number, h: number, W: number, D: number, out: number) {
  if (axis === 'y') {
    const y = (sign * D) / 2;
    b.box([c - w / 2, Math.min(y, y + sign * out), z0], [c + w / 2, Math.max(y, y + sign * out), z0 + h]);
  } else {
    const x = (sign * W) / 2;
    b.box([Math.min(x, x + sign * out), c - w / 2, z0], [Math.max(x, x + sign * out), c + w / 2, z0 + h]);
  }
}

/** Frame around an opening (four bars), plus a sill for windows. */
function addFrame(b: B, axis: 'x' | 'y', sign: number, c: number, z0: number, w: number, h: number, W: number, D: number, sill = false) {
  const k = 0.08, out = 0.09;
  const bars: [number, number, number, number][] = [
    [c - w / 2 - k, c - w / 2, z0, z0 + h], // left
    [c + w / 2, c + w / 2 + k, z0, z0 + h], // right
    [c - w / 2 - k, c + w / 2 + k, z0 + h, z0 + h + k], // top
    [c - 0.025, c + 0.025, z0, z0 + h], // mullion
  ];
  if (sill) bars.push([c - w / 2 - k * 1.5, c + w / 2 + k * 1.5, z0 - k, z0]);
  else bars.splice(3, 1);
  for (const [u0, u1, z1, z2] of bars) {
    if (axis === 'y') {
      const y = (sign * D) / 2;
      b.box([u0, Math.min(y, y + sign * out), z1], [u1, Math.max(y, y + sign * out), z2]);
    } else {
      const x = (sign * W) / 2;
      b.box([Math.min(x, x + sign * out), u0, z1], [Math.max(x, x + sign * out), u1, z2]);
    }
  }
}
