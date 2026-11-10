// Ready-made camera moves for videos: orbit, dolly in/out, flyover, crane and pan. Each is sampled
// into dense camera keys (linear between keys) so curved paths stay smooth, with an optional
// ease-in/out applied along the whole move. Blender coordinates (metres, Z up).

import type { Vec3 } from './types';

export const CAMERA_MOVES = ['orbit', 'dollyIn', 'dollyOut', 'flyover', 'crane', 'pan'] as const;
export type CameraMoveKind = (typeof CAMERA_MOVES)[number];

export interface CameraMoveParams {
  move: CameraMoveKind;
  /** What the camera looks at. */
  target: Vec3;
  start: number;
  end: number;
  /** Horizontal distance from the target, metres. */
  distance?: number;
  /** Camera height above the target, metres. */
  height?: number;
  /** Compass direction the camera starts from, degrees (0 = +X, 90 = +Y, 270 = −Y / front). */
  heading?: number;
  /** Orbit / pan sweep in degrees (negative = clockwise). */
  degrees?: number;
  /** Ease in and out over the whole move (default true). */
  smooth?: boolean;
}

export interface CameraSample {
  frame: number;
  position: Vec3;
  target: Vec3;
}

const rad = (d: number) => (d * Math.PI) / 180;
const smooth = (t: number) => t * t * t * (t * (t * 6 - 15) + 10); // smootherstep

export function sampleCameraMove(p: CameraMoveParams): CameraSample[] {
  const [tx, ty, tz] = p.target;
  const D = p.distance ?? 12;
  const H = p.height ?? D * 0.35;
  const h0 = rad(p.heading ?? 270);
  const span = Math.max(1, p.end - p.start);
  const step = Math.max(1, Math.min(4, Math.round(span / 60)));
  const at = (u: number): { position: Vec3; target: Vec3 } => {
    switch (p.move) {
      case 'orbit': {
        const a = h0 + rad(p.degrees ?? 90) * u;
        return { position: [tx + Math.cos(a) * D, ty + Math.sin(a) * D, tz + H], target: [tx, ty, tz] };
      }
      case 'dollyIn':
      case 'dollyOut': {
        const k = p.move === 'dollyIn' ? 1 - 0.6 * u : 0.4 + 0.6 * u;
        return { position: [tx + Math.cos(h0) * D * k, ty + Math.sin(h0) * D * k, tz + H * (0.55 + 0.45 * k)], target: [tx, ty, tz] };
      }
      case 'flyover': {
        // Straight pass over the target, from `heading` side to the opposite side, looking a
        // little ahead and down.
        const s = (1 - 2 * u) * D;
        const px = tx + Math.cos(h0) * s, py = ty + Math.sin(h0) * s;
        return { position: [px, py, tz + Math.max(H, D * 0.45)], target: [px - Math.cos(h0) * D * 0.7, py - Math.sin(h0) * D * 0.7, tz] };
      }
      case 'crane': {
        // Rise from near the ground and pull back a little, keeping the target framed.
        const k = 0.75 + 0.25 * u;
        return { position: [tx + Math.cos(h0) * D * k, ty + Math.sin(h0) * D * k, tz + 0.6 + (H * 2.2 - 0.6) * u], target: [tx, ty, tz + 0.4 * (1 - u)] };
      }
      case 'pan': {
        // The camera stays put; the view sweeps across.
        const a = h0 + Math.PI + rad(p.degrees ?? 60) * (u - 0.5);
        const cx = tx + Math.cos(h0) * D, cy = ty + Math.sin(h0) * D;
        return { position: [cx, cy, tz + H], target: [cx + Math.cos(a) * D, cy + Math.sin(a) * D, tz] };
      }
    }
  };
  const out: CameraSample[] = [];
  for (let f = p.start; ; f = Math.min(p.end, f + step)) {
    const t = (f - p.start) / span;
    const v = at(p.smooth === false ? t : smooth(t));
    const r = (x: number) => Math.round(x * 1000) / 1000;
    out.push({ frame: f, position: v.position.map(r) as Vec3, target: v.target.map(r) as Vec3 });
    if (f >= p.end) break;
  }
  return out;
}
