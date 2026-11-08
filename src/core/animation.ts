// Keyframe animation: pure data + pure evaluation (no engine, no UI).
//
// Design follows the common NLE/3D pattern also used by ArtCraft's timeline (MIT/Apache):
// a keyframe stores a full transform snapshot, and the LEFT key's easing describes the
// motion into the next key. Rotation is interpolated per Euler channel, like Blender,
// so a wheel can spin 0° → 7200° between two keys.

import type { Transform, Vec3 } from './types';

export const EASINGS = ['linear', 'ease', 'easeIn', 'easeOut', 'constant'] as const;
export type Easing = (typeof EASINGS)[number];

export interface TransformKey {
  frame: number;
  transform: Transform;
  /** Curve into the next key. */
  easing: Easing;
}

export interface CameraKey {
  frame: number;
  position: Vec3;
  target: Vec3;
  easing: Easing;
}

export interface Animation {
  fps: number;
  start: number;
  end: number;
  /** Per-object transform keys, sorted by frame. */
  tracks: Record<string, TransformKey[]>;
  /** Scene-camera keys, sorted by frame. */
  camera: CameraKey[];
}

export const DEFAULT_ANIMATION: Animation = { fps: 24, start: 1, end: 250, tracks: {}, camera: [] };

export const animationOf = (doc: { animation?: Animation }): Animation => ({ ...DEFAULT_ANIMATION, ...doc.animation });

// ---------------------------------------------------------------- easing

/** Cubic-bezier with endpoints (0,0) and (1,1), CSS semantics; solved for x by Newton + bisection. */
function bezier(p1x: number, p1y: number, p2x: number, p2y: number, x: number): number {
  const cx = 3 * p1x, bx = 3 * (p2x - p1x) - cx, ax = 1 - cx - bx;
  const cy = 3 * p1y, by = 3 * (p2y - p1y) - cy, ay = 1 - cy - by;
  const sx = (t: number) => ((ax * t + bx) * t + cx) * t;
  const dx = (t: number) => (3 * ax * t + 2 * bx) * t + cx;
  let t = x;
  for (let i = 0; i < 6; i++) {
    const err = sx(t) - x;
    const d = dx(t);
    if (Math.abs(err) < 1e-6 || Math.abs(d) < 1e-6) break;
    t -= err / d;
  }
  if (t < 0 || t > 1 || Math.abs(sx(t) - x) > 1e-4) {
    let lo = 0, hi = 1;
    t = x;
    for (let i = 0; i < 30; i++) {
      if (sx(t) < x) lo = t;
      else hi = t;
      t = (lo + hi) / 2;
    }
  }
  return ((ay * t + by) * t + cy) * t;
}

export function ease(e: Easing, t: number): number {
  const x = Math.min(1, Math.max(0, t));
  switch (e) {
    case 'linear': return x;
    case 'constant': return 0;
    case 'ease': return bezier(0.42, 0, 0.58, 1, x);
    case 'easeIn': return bezier(0.42, 0, 1, 1, x);
    case 'easeOut': return bezier(0, 0, 0.58, 1, x);
  }
}

// ---------------------------------------------------------------- evaluation

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const lerp3 = (a: Vec3, b: Vec3, t: number): Vec3 => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];

/** Find the surrounding keys and eased blend factor. Holds the first/last key outside the range. */
function segment<K extends { frame: number; easing: Easing }>(keys: K[], frame: number): [K, K, number] | null {
  if (!keys.length) return null;
  if (frame <= keys[0].frame) return [keys[0], keys[0], 0];
  const last = keys[keys.length - 1];
  if (frame >= last.frame) return [last, last, 0];
  let i = 0;
  while (i < keys.length - 1 && keys[i + 1].frame <= frame) i++;
  const a = keys[i], b = keys[i + 1];
  return [a, b, ease(a.easing, (frame - a.frame) / (b.frame - a.frame))];
}

export function evaluateTransform(keys: TransformKey[], frame: number): Transform | null {
  const s = segment(keys, frame);
  if (!s) return null;
  const [a, b, t] = s;
  return {
    position: lerp3(a.transform.position, b.transform.position, t),
    rotation: lerp3(a.transform.rotation, b.transform.rotation, t),
    scale: lerp3(a.transform.scale, b.transform.scale, t),
  };
}

export function evaluateCamera(keys: CameraKey[], frame: number): { position: Vec3; target: Vec3 } | null {
  const s = segment(keys, frame);
  if (!s) return null;
  const [a, b, t] = s;
  return { position: lerp3(a.position, b.position, t), target: lerp3(a.target, b.target, t) };
}

/** Transform an object shows at a frame: animated if it has keys, otherwise its own. */
export function transformAt(doc: { animation?: Animation; objects: Record<string, { transform: Transform }> }, id: string, frame: number): Transform | null {
  const o = doc.objects[id];
  if (!o) return null;
  const keys = doc.animation?.tracks[id];
  return (keys && evaluateTransform(keys, frame)) ?? o.transform;
}

export const isAnimated = (doc: { animation?: Animation }, id: string) => (doc.animation?.tracks[id]?.length ?? 0) > 0;

/** Insert or replace a key at its frame, keeping the list sorted. */
export function upsertKey<K extends { frame: number }>(keys: K[], key: K): K[] {
  const out = keys.filter((k) => k.frame !== key.frame);
  out.push(key);
  return out.sort((a, b) => a.frame - b.frame);
}

/** Frames of all keys, for "jump to next/previous keyframe". */
export function keyFrames(anim: Animation, ids: string[] | null): number[] {
  const set = new Set<number>();
  const tracks = ids ? ids.map((id) => anim.tracks[id] ?? []) : Object.values(anim.tracks);
  for (const t of tracks) for (const k of t) set.add(k.frame);
  if (!ids) for (const k of anim.camera) set.add(k.frame);
  return [...set].sort((a, b) => a - b);
}

/**
 * The command for a transform edit at a frame. Animated objects get a keyframe at that
 * frame (auto-key), so the edit isn't silently overridden by the animation; others are
 * edited directly.
 */
export function transformEdit(
  doc: { animation?: Animation; objects: Record<string, { transform: Transform }> },
  frame: number,
  id: string,
  patch: Partial<Transform>,
):
  | { type: 'transform'; id: string; position?: Vec3; rotation?: Vec3; scale?: Vec3 }
  | { type: 'setKeyframe'; id: string; frame: number; transform: Transform } {
  if (!isAnimated(doc, id)) return { type: 'transform', id, ...patch };
  const cur = transformAt(doc, id, frame)!;
  return { type: 'setKeyframe', id, frame, transform: { position: patch.position ?? cur.position, rotation: patch.rotation ?? cur.rotation, scale: patch.scale ?? cur.scale } };
}
