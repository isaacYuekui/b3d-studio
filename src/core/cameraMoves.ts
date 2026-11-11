// Ready-made camera moves for videos: orbit, dolly in/out, flyover, crane and pan. Each is sampled
// into dense camera keys (linear between keys) so curved paths stay smooth, with an optional
// ease-in/out applied along the whole move. Blender coordinates (metres, Z up).

import type { SceneDoc, SceneObject, Vec3 } from './types';
import { applyModifiers } from './mesh/modifiers';

export const CAMERA_MOVES = ['orbit', 'dollyIn', 'dollyOut', 'flyover', 'crane', 'pan', 'follow', 'track'] as const;
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
      case 'follow':
      case 'track':
        throw new Error('follow / track need a subject: use sampleFollow');
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

// ---------------------------------------------------------------- clearance

interface Obstacle {
  x: number;
  y: number;
  r: number;
  top: number;
}

/** Bounds of an object and its children in its own frame (child rotations ignored: conservative enough). */
function localBounds(doc: SceneDoc, o: SceneObject, kids: Map<string, SceneObject[]>, hidden = false): { min: Vec3; max: Vec3 } | null {
  let min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity];
  const grow = (p: Vec3) => {
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], p[k]);
      max[k] = Math.max(max[k], p[k]);
    }
  };
  if (o.mesh) for (const v of (o.modifiers ? applyModifiers(o.mesh, o.modifiers) : o.mesh).vertices) grow(v);
  else if (o.type !== 'empty' && o.type !== 'scatter' && o.type !== 'light' && o.type !== 'armature' && o.type !== 'model') grow([-1, -1, -1]), grow([1, 1, 1]);
  for (const c of kids.get(o.id) ?? []) {
    if (c.visible === false && !hidden) continue;
    const b = localBounds(doc, c, kids, hidden);
    if (!b) continue;
    const { position: P, scale: S } = c.transform;
    grow([P[0] + Math.min(b.min[0] * S[0], b.max[0] * S[0]), P[1] + Math.min(b.min[1] * S[1], b.max[1] * S[1]), P[2] + Math.min(b.min[2] * S[2], b.max[2] * S[2])]);
    grow([P[0] + Math.max(b.min[0] * S[0], b.max[0] * S[0]), P[1] + Math.max(b.min[1] * S[1], b.max[1] * S[1]), P[2] + Math.max(b.min[2] * S[2], b.max[2] * S[2])]);
  }
  return Number.isFinite(min[0]) ? { min, max } : null;
}

/** Things a camera move should fly over: buildings, plants, rocks and every scatter copy (terrain and water excluded). */
export function sceneObstacles(doc: SceneDoc): Obstacle[] {
  const kids = new Map<string, SceneObject[]>();
  for (const o of Object.values(doc.objects)) if (o.parentId) kids.set(o.parentId, [...(kids.get(o.parentId) ?? []), o]);
  const out: Obstacle[] = [];
  const footprint = (b: { min: Vec3; max: Vec3 }, S: Vec3) => ({
    cx: ((b.min[0] + b.max[0]) / 2) * S[0],
    cy: ((b.min[1] + b.max[1]) / 2) * S[1],
    // Round-ish things (crowns, rocks): the larger half-extent, not the box diagonal.
    r: Math.max(Math.abs((b.max[0] - b.min[0]) * S[0]), Math.abs((b.max[1] - b.min[1]) * S[1])) / 2,
  });
  for (const o of Object.values(doc.objects)) {
    if (o.terrain || o.water) continue;
    if (o.type === 'scatter' && o.scatter?.source) {
      const src = doc.objects[o.scatter.source];
      if (!src) continue;
      const b = localBounds(doc, src, kids, true); // the template is hidden; its copies are not
      if (!b) continue;
      const f = footprint(b, src.transform.scale);
      for (const [x, y, z, , k] of o.scatter.items) out.push({ x: x + f.cx * k, y: y + f.cy * k, r: f.r * k, top: z + b.max[2] * src.transform.scale[2] * k });
      continue;
    }
    if (o.parentId || o.visible === false) continue;
    const b = localBounds(doc, o, kids);
    if (!b) continue;
    const { position: P, scale: S } = o.transform;
    const f = footprint(b, S);
    out.push({ x: P[0] + f.cx, y: P[1] + f.cy, r: f.r, top: P[2] + b.max[2] * S[2] });
  }
  return out;
}

/**
 * Raise the camera smoothly wherever its path passes over (or into) an obstacle: it keeps
 * `clearance` metres above anything within `margin` metres of it.
 */
export function liftOverObstacles(samples: CameraSample[], obstacles: Obstacle[], clearance = 1.5, margin = 1): void {
  if (!obstacles.length || !samples.length) return;
  // Bucket obstacles on a coarse grid so long scatters stay fast.
  const cell = 8;
  const grid = new Map<string, Obstacle[]>();
  let maxR = 0;
  for (const ob of obstacles) {
    maxR = Math.max(maxR, ob.r);
    const key = `${Math.floor(ob.x / cell)},${Math.floor(ob.y / cell)}`;
    grid.set(key, [...(grid.get(key) ?? []), ob]);
  }
  const reach = Math.ceil((maxR + margin) / cell);
  const need = samples.map(({ position: [x, y] }) => {
    let z = -Infinity;
    const gx = Math.floor(x / cell), gy = Math.floor(y / cell);
    for (let i = -reach; i <= reach; i++)
      for (let j = -reach; j <= reach; j++)
        for (const ob of grid.get(`${gx + i},${gy + j}`) ?? []) if (Math.hypot(x - ob.x, y - ob.y) < ob.r + margin) z = Math.max(z, ob.top + clearance);
    return z;
  });
  // Spread each lift to its neighbours, then smooth, so the camera rises before it gets there.
  const w = 4;
  const spread = need.map((_, i) => Math.max(...need.slice(Math.max(0, i - w), i + w + 1)));
  const lifted = spread.map((z, i) => Math.max(samples[i].position[2], z));
  const smoothZ = lifted.map((_, i) => {
    const win = lifted.slice(Math.max(0, i - w), i + w + 1);
    return Math.max(lifted[i], win.reduce((s, v) => s + v, 0) / win.length);
  });
  samples.forEach((s, i) => {
    if (smoothZ[i] > s.position[2] + 1e-6) s.position = [s.position[0], s.position[1], Math.round(smoothZ[i] * 1000) / 1000];
  });
}

// ---------------------------------------------------------------- following a moving subject

/**
 * Camera that follows an animated subject: `follow` stays behind it, `track` runs alongside
 * (side shot). `subject(frame)` gives the subject's position and facing (rotation about Z in
 * degrees; rigs face −Y). The camera lags a little behind (smoothed), which reads as a real
 * operator rather than a camera bolted to the character.
 */
export function sampleFollow(
  kind: 'follow' | 'track',
  subject: (frame: number) => { position: Vec3; heading: number },
  p: { start: number; end: number; distance?: number; height?: number; side?: number; lookHeight?: number },
): CameraSample[] {
  const D = p.distance ?? (kind === 'follow' ? 4 : 5);
  const H = p.height ?? 1.6;
  const look = p.lookHeight ?? 1.2;
  const side = p.side ?? 1;
  const out: CameraSample[] = [];
  let cam: Vec3 | null = null;
  let tgt: Vec3 | null = null;
  const k = 0.18; // smoothing per frame
  for (let f = p.start; f <= p.end; f++) {
    const s = subject(f);
    const h = (s.heading * Math.PI) / 180;
    const fwd: Vec3 = [Math.sin(h), -Math.cos(h), 0]; // facing (−Y rotated)
    const right: Vec3 = [-fwd[1], fwd[0], 0];
    const want: Vec3 =
      kind === 'follow'
        ? [s.position[0] - fwd[0] * D + right[0] * 0.6, s.position[1] - fwd[1] * D + right[1] * 0.6, s.position[2] + H]
        : [s.position[0] + right[0] * D * side + fwd[0] * 0.8, s.position[1] + right[1] * D * side + fwd[1] * 0.8, s.position[2] + H];
    const wantT: Vec3 = [s.position[0] + fwd[0] * (kind === 'follow' ? 2 : 0.6), s.position[1] + fwd[1] * (kind === 'follow' ? 2 : 0.6), s.position[2] + look];
    cam = cam ? (cam.map((c, i) => c + (want[i] - c) * k) as Vec3) : want;
    tgt = tgt ? (tgt.map((c, i) => c + (wantT[i] - c) * (k * 1.5)) as Vec3) : wantT;
    if ((f - p.start) % 2 === 0 || f === p.end) {
      const r = (x: number) => Math.round(x * 1000) / 1000;
      out.push({ frame: f, position: cam.map(r) as Vec3, target: tgt.map(r) as Vec3 });
    }
  }
  return out;
}
