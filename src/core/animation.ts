// Keyframe animation: pure data + pure evaluation (no engine, no UI).
//
// Design follows the common NLE/3D pattern also used by ArtCraft's timeline (MIT/Apache):
// a keyframe stores a full transform snapshot, and the LEFT key's easing describes the
// motion into the next key. Rotation is interpolated per Euler channel, like Blender,
// so a wheel can spin 0° → 7200° between two keys.

import type { FollowPath, Transform, Vec3 } from './types';
import { DEFAULT_CURVE, curvePolyline, pathAt } from './curve';
import type { CurveSettings } from './curve';

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
  /** Bone pose keys: armature id → bone name → keys. */
  poses?: Record<string, Record<string, PoseKey[]>>;
  /** Camera shakes (impacts, explosions, quakes), added on top of the camera's motion. */
  shakes?: import('./shake').CameraShake[];
  /** The scene camera flies along a curve between two frames (overrides camera keys then). */
  cameraFollow?: CameraFollow;
  /** Shape key values: object id → key name → keys. */
  shapes?: Record<string, Record<string, import('./shapeKeys').ValueKey[]>>;
}

export interface CameraFollow {
  curve: string;
  start: number;
  end: number;
  /** Look along the path ("ahead") or at an object (its id). */
  look: string;
  /** Height above the path, metres. */
  height?: number;
}

/**
 * Where the scene camera is at a frame: its keys, or its Follow Path while that runs (from its
 * start to its end frame; outside, the keys or the saved camera).
 */
export function sceneCameraAt(doc: AnimDoc & { camera?: { position: Vec3; target: Vec3 } }, frame: number): { position: Vec3; target: Vec3 } | null {
  const a = doc.animation;
  const cf = a?.cameraFollow;
  if (cf && frame >= cf.start && frame <= cf.end) {
    const h = cf.height ?? 0;
    const here = followTransform(doc, { curve: cf.curve, start: cf.start, end: cf.end, orient: false }, { position: [0, 0, h], rotation: [0, 0, 0], scale: [1, 1, 1] }, frame);
    if (here) {
      let target: Vec3;
      const obj = cf.look !== 'ahead' ? transformAt(doc, cf.look, frame) : null;
      if (obj) target = obj.position;
      else {
        // A little further along the path (looping on closed curves).
        const span = Math.max(1, cf.end - cf.start);
        const ahead = followTransform(doc, { curve: cf.curve, start: cf.start, end: cf.end, orient: false, to: 1 + 0.08 }, { position: [0, 0, h], rotation: [0, 0, 0], scale: [1, 1, 1] }, Math.min(frame + span * 0.08, cf.end + span));
        target = ahead && Math.hypot(ahead.position[0] - here.position[0], ahead.position[1] - here.position[1], ahead.position[2] - here.position[2]) > 1e-3 ? ahead.position : [here.position[0], here.position[1] + 1, here.position[2]];
      }
      return { position: here.position, target };
    }
  }
  return (a?.camera.length ? evaluateCamera(a.camera, frame) : null) ?? doc.camera ?? null;
}

export interface PoseKey {
  frame: number;
  rotation: Vec3;
  location?: Vec3;
  easing: Easing;
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

export function evaluateValue(keys: { frame: number; value: number; easing: Easing }[], frame: number): number | null {
  const s = segment(keys, frame);
  if (!s) return null;
  const [a, b, t] = s;
  return lerp(a.value, b.value, t);
}

export function evaluatePose(keys: PoseKey[], frame: number): { rotation: Vec3; location: Vec3 } | null {
  const s = segment(keys, frame);
  if (!s) return null;
  const [a, b, t] = s;
  return { rotation: lerp3(a.rotation, b.rotation, t), location: lerp3(a.location ?? [0, 0, 0], b.location ?? [0, 0, 0], t) };
}

/** Transform an object shows at a frame: animated if it has keys, otherwise its own. */
type AnimDoc = { animation?: Animation; objects: Record<string, { transform: Transform; follow?: FollowPath; mesh?: { vertices: Vec3[] }; modifiers?: { curve?: Partial<CurveSettings> } }> };

export function transformAt(doc: AnimDoc, id: string, frame: number): Transform | null {
  const o = doc.objects[id];
  if (!o) return null;
  const keys = doc.animation?.tracks[id];
  const base = (keys && evaluateTransform(keys, frame)) ?? o.transform;
  return o.follow && o.follow.curve !== id ? followTransform(doc, o.follow, base, frame) ?? base : base;
}

const polyCache = new WeakMap<Vec3[], Map<string, Vec3[]>>();

/** Rotation matrix (row-major 4×4) for Blender XYZ Euler degrees. */
function rotEuler(e: Vec3): number[] {
  const [x, y, z] = e.map((d) => (d * Math.PI) / 180);
  const cx = Math.cos(x), sx = Math.sin(x), cy = Math.cos(y), sy = Math.sin(y), cz = Math.cos(z), sz = Math.sin(z);
  return [cz * cy, cz * sy * sx - sz * cx, cz * sy * cx + sz * sx, 0, sz * cy, sz * sy * sx + cz * cx, sz * sy * cx - cz * sx, 0, -sy, cy * sx, cy * cx, 0, 0, 0, 0, 1];
}

/**
 * Follow Path: where an object is along a curve at a frame. Like Blender's constraint, the
 * object's own location is an offset from the path, and its rotation is added to the path's.
 */
export function followTransform(doc: AnimDoc, f: FollowPath, base: Transform, frame: number): Transform | null {
  const c = doc.objects[f.curve];
  const pts = c?.mesh?.vertices;
  if (!c || !pts || pts.length < 2 || !c.modifiers?.curve) return null;
  const cs = { ...DEFAULT_CURVE, ...c.modifiers.curve };
  let byRes = polyCache.get(pts);
  if (!byRes) polyCache.set(pts, (byRes = new Map()));
  const key = `${cs.cyclic}|${cs.resolution}`;
  let poly = byRes.get(key);
  if (!poly) byRes.set(key, (poly = curvePolyline(pts, cs.cyclic, cs.resolution)));
  const span = Math.max(1e-6, f.end - f.start);
  const k = Math.max(0, Math.min(1, (frame - f.start) / span));
  const at = pathAt(poly, cs.cyclic, (f.from ?? 0) + ((f.to ?? 1) - (f.from ?? 0)) * k);
  // Into world space with the curve's own transform (not its parents).
  const ct = transformAt(doc, f.curve, frame) ?? c.transform;
  const M = rotEuler(ct.rotation);
  const local = (v: Vec3, s: Vec3): Vec3 => {
    const x = v[0] * s[0], y = v[1] * s[1], z = v[2] * s[2];
    return [M[0] * x + M[1] * y + M[2] * z, M[4] * x + M[5] * y + M[6] * z, M[8] * x + M[9] * y + M[10] * z];
  };
  const p = local(at.p, ct.scale);
  const t = local(at.t, ct.scale);
  const tl = Math.hypot(t[0], t[1], t[2]) || 1;
  const position: Vec3 = [ct.position[0] + p[0] + base.position[0], ct.position[1] + p[1] + base.position[1], ct.position[2] + p[2] + base.position[2]];
  if (!f.orient) return { ...base, position };
  // +Y along the path: pitch about X, then heading about Z.
  const pitch = (Math.asin(Math.max(-1, Math.min(1, t[2] / tl))) * 180) / Math.PI;
  const yaw = (Math.atan2(-t[0], t[1]) * 180) / Math.PI;
  return { ...base, position, rotation: [base.rotation[0] + pitch, base.rotation[1], base.rotation[2] + yaw] };
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
  // Bone keys count for their armature.
  for (const [arm, bones] of Object.entries(anim.poses ?? {})) if (!ids || ids.includes(arm)) for (const ks of Object.values(bones)) for (const k of ks) set.add(k.frame);
  for (const [id, keys] of Object.entries(anim.shapes ?? {})) if (!ids || ids.includes(id)) for (const ks of Object.values(keys)) for (const k of ks) set.add(k.frame);
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
