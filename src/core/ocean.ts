// Ocean waves for water surfaces, like Blender's Ocean modifier: the surface is a fine grid moved
// by a few Gerstner waves (rolling crests, flatter troughs). Worked out from the frame time, so
// every frame of a video is exact and scrubbing matches playback.

import { isShown } from './collections';
import type { SceneDoc, Transform, Vec3 } from './types';
import { animationOf, transformAt } from './animation';

export interface WaterSettings {
  /** Size of the ripples/waves in metres (wavelength of the main wave = 8 × this). */
  waves: number;
  /** Ripple drift speed (m/s) for the surface texture. */
  speed: number;
  /** Wave height crest-to-trough in metres; 0 = flat water (ripples only). */
  height?: number;
  /** Direction the waves travel, degrees from +X towards +Y. */
  direction?: number;
  /** One giant travelling wave (tsunami / surge), crossing the water in the waves' direction. */
  surge?: Surge;
}

export interface Surge {
  /** Height of the wave above the sea, metres. */
  height: number;
  /** Frame it starts from `from`. */
  start: number;
  /** Travel speed, m/s (real tsunamis near shore: 10–30). */
  speed: number;
  /** Front-to-back length of the wave, metres. */
  width: number;
  /** Where it starts, metres along its direction from the water's centre (negative = behind). */
  from: number;
}

export const DEFAULT_SURGE: Surge = { height: 8, start: 1, speed: 15, width: 18, from: -60 };

const G = 9.81;
// Main wave plus three smaller ones at angles to it, so the sea doesn't look like corduroy.
const COMPONENTS = [
  { len: 1, amp: 1, angle: 0, steep: 0.55, phase: 0 },
  { len: 0.61, amp: 0.45, angle: 27, steep: 0.5, phase: 1.7 },
  { len: 0.37, amp: 0.25, angle: -38, steep: 0.45, phase: 4.1 },
  { len: 0.23, amp: 0.12, angle: 63, steep: 0.4, phase: 2.6 },
];
const AMP_SUM = COMPONENTS.reduce((s, c) => s + c.amp, 0);

export const oceanWavelength = (w: WaterSettings) => Math.max(0.5, w.waves * 8);

/** How a surface point at (x, y) (object space, metres) moves at time t seconds: [dx, dy, dz]. */
export function oceanDisplace(x: number, y: number, t: number, w: WaterSettings, fps = 24): Vec3 {
  const H = w.height ?? 0;
  const base = ((w.direction ?? 0) * Math.PI) / 180;
  let dx = 0, dy = 0, dz = 0;
  if (w.surge) {
    // A solitary wave: sech² profile, its front leaning forward a little as it runs.
    const g = w.surge;
    const ux = Math.cos(base), uy = Math.sin(base);
    const front = g.from + g.speed * Math.max(0, t - (g.start - 1) / fps);
    const u = (ux * x + uy * y - front) / Math.max(0.5, g.width / 2);
    const sech = 1 / Math.cosh(u);
    const lift = g.height * sech * sech;
    const lean = 0.25 * g.height * sech * sech * Math.tanh(u) * -1;
    dz += lift;
    dx += ux * lean;
    dy += uy * lean;
  }
  if (H <= 0) return [dx, dy, dz];
  const L0 = oceanWavelength(w);
  for (const c of COMPONENTS) {
    const L = L0 * c.len;
    const k = (2 * Math.PI) / L;
    const omega = Math.sqrt(G * k);
    const a = ((H / 2) * c.amp) / AMP_SUM;
    const ang = base + (c.angle * Math.PI) / 180;
    const ux = Math.cos(ang), uy = Math.sin(ang);
    const ph = k * (ux * x + uy * y) - omega * t + c.phase;
    // Horizontal pull towards crests, capped so crests never fold over.
    const q = Math.min(c.steep / (k * a * COMPONENTS.length), 1);
    dx += q * a * ux * Math.cos(ph);
    dy += q * a * uy * Math.cos(ph);
    dz += a * Math.sin(ph);
  }
  return [dx, dy, dz];
}

/** Grid resolution (cells per side) for a water surface: fine enough for the waves, capped for tablets. */
export function oceanGrid(sizeX: number, sizeY: number, w: WaterSettings): [number, number] {
  const cell = Math.max(0.05, oceanWavelength(w) * 0.23 / 6);
  const nx = Math.max(8, Math.min(220, Math.ceil(sizeX / cell)));
  const ny = Math.max(8, Math.min(220, Math.ceil(sizeY / cell)));
  // Keep the total under ~40k vertices.
  const k = Math.min(1, Math.sqrt(40000 / ((nx + 1) * (ny + 1))));
  return [Math.max(8, Math.floor(nx * k)), Math.max(8, Math.floor(ny * k))];
}

/** Float on water: the object's origin rides `offset` metres above the surface, tilting with the slope. */
export interface FloatSettings {
  offset: number;
}

/** Where a floating object is at a frame (null if it doesn't float or isn't over water). */
export function floatTransform(doc: SceneDoc, id: string, frame: number): Transform | null {
  const o = doc.objects[id];
  if (!o?.float) return null;
  const base = transformAt(doc, id, frame) ?? o.transform;
  const t = frame / animationOf(doc).fps;
  for (const wid of doc.order) {
    const w = doc.objects[wid];
    if (!w?.water || !w.mesh?.vertices.length || !isShown(doc, w) || wid === id) continue;
    const wt = transformAt(doc, wid, frame) ?? w.transform;
    const sx = wt.scale[0] || 1, sy = wt.scale[1] || 1;
    const lx = (base.position[0] - wt.position[0]) / sx, ly = (base.position[1] - wt.position[1]) / sy;
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const v of w.mesh.vertices) {
      x0 = Math.min(x0, v[0]);
      x1 = Math.max(x1, v[0]);
      y0 = Math.min(y0, v[1]);
      y1 = Math.max(y1, v[1]);
    }
    if (lx < x0 || lx > x1 || ly < y0 || ly > y1) continue;
    const ws = w.water;
    const fps = animationOf(doc).fps;
    const h = (x: number, y: number) => oceanDisplace(x, y, t, ws, fps)[2] * (wt.scale[2] || 1);
    const z = wt.position[2] + h(lx, ly) + o.float.offset;
    // A surge carries floating things along with it (a fraction of its speed while they're on it).
    let carryX = 0, carryY = 0;
    if (ws.surge) {
      const g = ws.surge;
      const a = ((ws.direction ?? 0) * Math.PI) / 180;
      // Integrate the push over the frames so far: moved forward while the wave was under it.
      let along = 0;
      const steps = Math.max(1, Math.round(frame - g.start));
      for (let i = 0; i < steps && frame > g.start; i++) {
        const f = g.start + i;
        const tt = f / fps;
        const sx2 = lx + (Math.cos(a) * along) / sx, sy2 = ly + (Math.sin(a) * along) / sy;
        const lift = oceanDisplace(sx2, sy2, tt, { waves: ws.waves, speed: ws.speed, direction: ws.direction, surge: g }, fps)[2];
        along += (g.speed / fps) * Math.min(0.9, Math.max(0, lift / g.height)) ;
      }
      carryX = Math.cos(a) * along;
      carryY = Math.sin(a) * along;
    }
    // Tilt with the slope under it (measured over a metre either side), a little less than the water.
    const slopeX = (h(lx + 1 / sx, ly) - h(lx - 1 / sx, ly)) / 2;
    const slopeY = (h(lx, ly + 1 / sy) - h(lx, ly - 1 / sy)) / 2;
    const deg = 180 / Math.PI;
    const roll = Math.atan(slopeY) * deg * 0.8;
    const pitch = -Math.atan(slopeX) * deg * 0.8;
    const r = (v: number) => Math.round(v * 1e4) / 1e4;
    if (carryX || carryY) {
      // Ride the surge: re-measure the height where it has been carried to.
      // Washed up at the edge of the water: it stays there.
      const cx = Math.min(x1, Math.max(x0, lx + carryX / sx)), cy = Math.min(y1, Math.max(y0, ly + carryY / sy));
      carryX = (cx - lx) * sx;
      carryY = (cy - ly) * sy;
      const zc = wt.position[2] + h(cx, cy) + o.float.offset;
      return { ...base, position: [r(base.position[0] + carryX), r(base.position[1] + carryY), r(zc)], rotation: [r(base.rotation[0] + roll), r(base.rotation[1] + pitch), base.rotation[2]] };
    }
    return { ...base, position: [base.position[0], base.position[1], r(z)], rotation: [r(base.rotation[0] + roll), r(base.rotation[1] + pitch), base.rotation[2]] };
  }
  return null;
}
