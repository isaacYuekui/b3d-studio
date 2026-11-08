// Turn a B3D terrain into a Roblox Terrain heightmap + colormap (Terrain Editor → Import).
// Roblox voxel terrain looks far better in-game than a textured mesh: real grass, rock and
// ground materials with Roblox lighting, decoration grass, and it collides properly.
//
// Coordinates: B3D is Blender-style (metres, Z up). glTF / Roblox are Y up with
// Roblox (X, Y, Z) = (x, z, −y) / STUD. Image row 0 is the far edge (largest y = Roblox −Z),
// so the picture reads like a top-down map with +Y ("north") up.

import type { SceneObject } from './types';

/** Roblox's official length unit: 1 stud = 28 cm. */
export const STUD = 0.28;

/** Roblox Terrain colormap key (RGB → material), from Roblox's heightmap importer. */
export const ROBLOX_TERRAIN_COLORS = {
  Grass: [106, 127, 63],
  LeafyGrass: [115, 132, 74],
  Ground: [102, 92, 59],
  Mud: [58, 46, 36],
  Rock: [102, 108, 111],
  Slate: [63, 127, 107],
  Sand: [143, 126, 95],
  Cobblestone: [132, 123, 90],
  Snow: [195, 199, 218],
} as const;
export type RobloxTerrainMaterial = keyof typeof ROBLOX_TERRAIN_COLORS;

export interface RobloxHeightmap {
  width: number;
  height: number;
  /** Grey levels, row-major, row 0 = far (+y) edge. Black = lowest, white = highest. */
  heights: Uint8Array;
  /** RGB per pixel using the Roblox colormap key. */
  colors: Uint8Array;
  /** Import region (Terrain Editor → Import → size / position), in studs. */
  sizeStuds: [number, number, number];
  positionStuds: [number, number, number];
  /** Metres covered per pixel. */
  metresPerPixel: number;
}

export interface HeightmapOptions {
  /** Materials for the grass / path / rock layers. */
  materials?: [RobloxTerrainMaterial, RobloxTerrainMaterial, RobloxTerrainMaterial];
  /** Studs per pixel (Roblox voxels are 4 studs; 2 keeps edges smooth). */
  studsPerPixel?: number;
  /** Largest image side; Roblox accepts up to 4096. */
  maxSize?: number;
}

export function terrainHeightmap(o: SceneObject, opts: HeightmapOptions = {}): RobloxHeightmap {
  const t = o.terrain;
  if (!t || !o.mesh) throw new Error(`${o.name} is not a terrain`);
  const { nx, ny } = t;
  const [W, D] = t.size;
  const [sx, sy, sz] = o.transform.scale;
  const [px, py, pz] = o.transform.position;
  const Wm = W * sx, Dm = D * sy;
  const spp = opts.studsPerPixel ?? 2;
  const max = opts.maxSize ?? 1024;
  const w = Math.max(2, Math.min(max, Math.round(Wm / STUD / spp)));
  const h = Math.max(2, Math.min(max, Math.round(Dm / STUD / spp)));
  const mats = opts.materials ?? ['Grass', 'Ground', 'Rock'];
  const key = mats.map((m) => ROBLOX_TERRAIN_COLORS[m]);
  const V = o.mesh.vertices;

  // Bilinear sample of the grid (heights in local metres, splat weights).
  const sample = (u: number, v: number) => {
    const fx = u * (nx - 1), fy = v * (ny - 1);
    const i0 = Math.min(nx - 2, Math.floor(fx)), j0 = Math.min(ny - 2, Math.floor(fy));
    const a = fx - i0, b = fy - j0;
    const idx = [j0 * nx + i0, j0 * nx + i0 + 1, (j0 + 1) * nx + i0, (j0 + 1) * nx + i0 + 1];
    const wts = [(1 - a) * (1 - b), a * (1 - b), (1 - a) * b, a * b];
    let z = 0;
    const s = [0, 0, 0];
    idx.forEach((k, n) => {
      z += V[k][2] * wts[n];
      for (let c = 0; c < 3; c++) s[c] += (t.splat[k * 3 + c] ?? 0) * wts[n];
    });
    return { z, s };
  };

  const zs = new Float32Array(w * h);
  const colors = new Uint8Array(w * h * 3);
  let lo = Infinity, hi = -Infinity;
  for (let r = 0; r < h; r++)
    for (let c = 0; c < w; c++) {
      const u = c / (w - 1), v = 1 - r / (h - 1); // row 0 = +y edge
      const { z, s } = sample(u, v);
      const zw = z * sz + pz;
      zs[r * w + c] = zw;
      lo = Math.min(lo, zw);
      hi = Math.max(hi, zw);
      // Dominant layer wins (Roblox snaps colours to the nearest key anyway).
      const k = s[1] >= 0.45 ? 1 : s[2] > s[0] ? 2 : 0;
      colors.set(key[k], (r * w + c) * 3);
    }
  const range = Math.max(0.01, hi - lo);
  const heights = new Uint8Array(w * h);
  for (let i = 0; i < zs.length; i++) heights[i] = Math.round(((zs[i] - lo) / range) * 255);
  const r2 = (x: number) => Math.round(x * 10) / 10;
  return {
    width: w,
    height: h,
    heights,
    colors,
    sizeStuds: [r2(Wm / STUD), r2(range / STUD), r2(Dm / STUD)],
    positionStuds: [r2(px / STUD), r2((lo + hi) / 2 / STUD), r2(-py / STUD)],
    metresPerPixel: Wm / w,
  };
}

/** Minimal PNG encoder (8-bit grey or RGB, stored with zlib via the given deflate). */
export function encodePng(width: number, height: number, data: Uint8Array, channels: 1 | 3, deflate: (b: Uint8Array) => Uint8Array): Uint8Array {
  const stride = width * channels;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) raw.set(data.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  const chunks: Uint8Array[] = [];
  const u32 = (n: number) => new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
  const chunk = (type: string, body: Uint8Array) => {
    const t = new TextEncoder().encode(type);
    const td = new Uint8Array(t.length + body.length);
    td.set(t);
    td.set(body, t.length);
    chunks.push(u32(body.length), td, u32(crc32(td)));
  };
  const ihdr = new Uint8Array(13);
  ihdr.set(u32(width), 0);
  ihdr.set(u32(height), 4);
  ihdr[8] = 8;
  ihdr[9] = channels === 1 ? 0 : 2;
  chunk('IHDR', ihdr);
  chunk('IDAT', deflate(raw));
  chunk('IEND', new Uint8Array());
  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const total = chunks.reduce((s, c) => s + c.length, sig.length);
  const out = new Uint8Array(total);
  out.set(sig);
  let o = sig.length;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

let CRC: Uint32Array | null = null;
function crc32(b: Uint8Array): number {
  if (!CRC) {
    CRC = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
