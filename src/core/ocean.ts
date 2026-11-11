// Ocean waves for water surfaces, like Blender's Ocean modifier: the surface is a fine grid moved
// by a few Gerstner waves (rolling crests, flatter troughs). Worked out from the frame time, so
// every frame of a video is exact and scrubbing matches playback.

import type { Vec3 } from './types';

export interface WaterSettings {
  /** Size of the ripples/waves in metres (wavelength of the main wave = 8 × this). */
  waves: number;
  /** Ripple drift speed (m/s) for the surface texture. */
  speed: number;
  /** Wave height crest-to-trough in metres; 0 = flat water (ripples only). */
  height?: number;
  /** Direction the waves travel, degrees from +X towards +Y. */
  direction?: number;
}

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
export function oceanDisplace(x: number, y: number, t: number, w: WaterSettings): Vec3 {
  const H = w.height ?? 0;
  if (H <= 0) return [0, 0, 0];
  const L0 = oceanWavelength(w);
  const base = ((w.direction ?? 0) * Math.PI) / 180;
  let dx = 0, dy = 0, dz = 0;
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
