// Procedural patterns, like Blender's Noise / Voronoi / Checker / Brick / Wave textures: a
// tileable grey "mix" image (0 → colour A, 1 → colour B) that also serves as a bump height.
// Pure and deterministic, so a scene looks the same everywhere.

export const PATTERNS = ['noise', 'voronoi', 'checker', 'bricks', 'wood', 'marble', 'gradient', 'windows'] as const;
export type PatternType = (typeof PATTERNS)[number];

export interface Pattern {
  type: PatternType;
  colorA: string;
  colorB: string;
  /** Repeats per metre (bigger = smaller features), like Blender's Scale. */
  scale: number;
  /** Bump strength 0..1 (0 = flat). */
  bump: number;
  /**
   * Light from the pattern (0 = none), like plugging the texture into Emission Strength: colour A
   * areas glow in `glowColor`. On Windows, a random half of the windows are lit instead (night).
   */
  glow?: number;
  /** Colour of the glow (default warm light). */
  glowColor?: string;
}

export const DEFAULT_GLOW_COLOR = '#ffc27a';

/** Windows per tile in each direction (so neighbouring windows differ); the scale still means storeys per metre. */
export const WINDOW_GRID = 4;

/** How many pattern repeats one texture tile holds (the texture's own scale is divided by this). */
export const patternTile = (type: PatternType) => (type === 'windows' ? WINDOW_GRID : 1);

const fract = (x: number) => x - Math.floor(x);
const smooth = (t: number) => t * t * (3 - 2 * t);

/** Periodic hash lattice value in [0, 1). */
function hash(ix: number, iy: number, period: number, seed: number): number {
  const x = ((ix % period) + period) % period, y = ((iy % period) + period) % period;
  let h = (x * 374761393 + y * 668265263 + seed * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Tileable value noise at (u, v) in [0, 1)² with `period` cells across. */
function valueNoise(u: number, v: number, period: number, seed: number): number {
  const x = u * period, y = v * period;
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = smooth(x - ix), fy = smooth(y - iy);
  const a = hash(ix, iy, period, seed), b = hash(ix + 1, iy, period, seed);
  const c = hash(ix, iy + 1, period, seed), d = hash(ix + 1, iy + 1, period, seed);
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}

/** Tileable fBm in [0, 1]. */
function fbm(u: number, v: number, base: number, octaves: number, seed: number): number {
  let sum = 0, amp = 0.5, norm = 0, p = base;
  for (let o = 0; o < octaves; o++) {
    sum += amp * valueNoise(u, v, p, seed + o * 31);
    norm += amp;
    amp *= 0.5;
    p *= 2;
  }
  return sum / norm;
}

/** Tileable Voronoi (F1 distance to the nearest feature point), roughly in [0, 1]. */
function voronoi(u: number, v: number, cells: number, seed: number): number {
  const x = u * cells, y = v * cells;
  const ix = Math.floor(x), iy = Math.floor(y);
  let best = 9;
  for (let j = -1; j <= 1; j++)
    for (let i = -1; i <= 1; i++) {
      const cx = ix + i, cy = iy + j;
      const px = cx + hash(cx, cy, cells, seed), py = cy + hash(cx, cy, cells, seed + 7);
      best = Math.min(best, Math.hypot(px - x, py - y));
    }
  return Math.min(1, best / 0.9);
}

/** Glass area of one window cell (cell coordinates 0..1; v runs up the wall on box-mapped faces). */
const inWindow = (fu: number, fv: number) => fu > 0.27 && fu < 0.73 && fv > 0.33 && fv < 0.82;

/**
 * The pattern's mix values on a size×size tile (row-major, v down). One tile spans 1 / scale
 * metres on the object; it wraps seamlessly in both directions (gradient excepted).
 */
export function patternValues(type: PatternType, size = 256, seed = 1): Float32Array {
  const out = new Float32Array(size * size);
  for (let j = 0; j < size; j++)
    for (let i = 0; i < size; i++) {
      const u = i / size, v = j / size;
      let t: number;
      switch (type) {
        case 'noise':
          t = fbm(u, v, 4, 5, seed);
          t = Math.min(1, Math.max(0, (t - 0.5) * 1.8 + 0.5));
          break;
        case 'voronoi':
          t = voronoi(u, v, 6, seed);
          break;
        case 'checker':
          t = (Math.floor(u * 2) + Math.floor(v * 2)) % 2;
          break;
        case 'bricks': {
          // 4 rows of 2 bricks, every other row offset by half a brick; thin mortar lines.
          const rows = 4, cols = 2, mortar = 0.035;
          const r = Math.floor(v * rows);
          const bu = u * cols + (r % 2 ? 0.5 : 0);
          const fu = fract(bu), fv = fract(v * rows);
          const inBrick = fu > mortar / 2 && fu < 1 - mortar / 2 && fv > mortar && fv < 1 - mortar;
          const tone = hash(Math.floor(bu) % cols, r, 64, seed);
          t = inBrick ? 0.55 + 0.45 * tone : 0;
          break;
        }
        case 'wood': {
          // Rings across v, wobbling with low-frequency noise; integer ring count keeps it tileable.
          const w = fbm(u, v, 2, 3, seed) * 1.6;
          const r = fract(v * 8 + w);
          t = Math.pow(Math.abs(Math.sin(Math.PI * r)), 0.6);
          t = t * 0.85 + 0.15 * fbm(u, v, 32, 2, seed + 5);
          break;
        }
        case 'marble': {
          const turb = fbm(u, v, 3, 5, seed) * 4;
          t = 0.5 + 0.5 * Math.sin(2 * Math.PI * (u * 2 + turb));
          t = Math.pow(t, 3);
          break;
        }
        case 'gradient':
          t = u;
          break;
        case 'windows': {
          // A 4 × 4 grid of storey × bay cells: wall (B) with an inset window (A) and a thin frame;
          // each window a slightly different shade, like blinds and reflections.
          const cx = Math.floor(u * WINDOW_GRID), cy = Math.floor(v * WINDOW_GRID);
          const fu = fract(u * WINDOW_GRID), fv = fract(v * WINDOW_GRID);
          if (inWindow(fu, fv)) t = 0.02 + 0.08 * hash(cx, cy, WINDOW_GRID, seed) + (Math.abs(fu - 0.5) < 0.012 ? 0.3 : 0);
          else if (fu > 0.24 && fu < 0.76 && fv > 0.3 && fv < 0.85) t = 0.5;
          else t = 0.84 + 0.16 * fbm(u, v, 8 * WINDOW_GRID, 2, seed + 3);
          break;
        }
      }
      out[j * size + i] = t;
    }
  return out;
}

/**
 * Where the pattern glows (0..1) on the same tile as patternValues. Most patterns glow where they
 * show colour A; Windows lights about half its windows (each a little brighter or dimmer, some
 * with the blind half down) and leaves walls and frames dark.
 */
export function patternGlowValues(type: PatternType, size = 256, seed = 1): Float32Array {
  if (type !== 'windows') {
    const v = patternValues(type, size, seed);
    return v.map((t) => 1 - t);
  }
  const out = new Float32Array(size * size);
  for (let j = 0; j < size; j++)
    for (let i = 0; i < size; i++) {
      const u = i / size, v = j / size;
      const cx = Math.floor(u * WINDOW_GRID), cy = Math.floor(v * WINDOW_GRID);
      const fu = fract(u * WINDOW_GRID), fv = fract(v * WINDOW_GRID);
      if (!inWindow(fu, fv) || Math.abs(fu - 0.5) < 0.012) continue;
      if (hash(cx, cy, WINDOW_GRID, seed + 11) > 0.5) continue; // unlit window
      const level = 0.55 + 0.45 * hash(cx, cy, WINDOW_GRID, seed + 23);
      // Some blinds are half down: the top of the window stays dark (v runs up the wall).
      const blind = hash(cx, cy, WINDOW_GRID, seed + 37) < 0.3 && fv > 0.6;
      out[j * size + i] = blind ? level * 0.15 : level;
    }
  return out;
}
