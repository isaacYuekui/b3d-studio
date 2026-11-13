// Object constraints (Blender's Object Constraint Properties, the common ones): Track To, Damped
// Track (the same here), Copy Location / Rotation / Scale and Limit Distance. They run after the
// object's keyframes and Follow Path, in world space, top to bottom, each blended by Influence.

import type { SceneObject, Transform, Vec3 } from './types';

export const CONSTRAINT_TYPES = ['trackTo', 'copyLocation', 'copyRotation', 'copyScale', 'limitDistance'] as const;
export type ConstraintType = (typeof CONSTRAINT_TYPES)[number];
export const TRACK_AXES = ['Y', '-Y', 'X', '-X', 'Z', '-Z'] as const;
export type TrackAxis = (typeof TRACK_AXES)[number];
export const MAX_CONSTRAINTS = 8;

export interface Constraint {
  type: ConstraintType;
  /** Object id the constraint looks at / copies from. */
  target: string;
  /** 0..1 (Blender: Influence). */
  influence: number;
  /** Switched off (the eye in Blender's constraint header). */
  mute?: boolean;
  /** Track To: the object's axis that points at the target (default Y; cameras and lights use -Z). */
  axis?: TrackAxis;
  /** Copy Location / Rotation / Scale: which axes (default all). */
  x?: boolean;
  y?: boolean;
  z?: boolean;
  /** Copy Location: add the object's own location on top (Blender: Offset). */
  offset?: boolean;
  /** Limit Distance: metres, and whether to stay inside, outside or exactly on it. */
  distance?: number;
  mode?: 'inside' | 'outside' | 'on';
}

export const CONSTRAINT_LABELS: Record<ConstraintType, string> = {
  trackTo: 'Track To',
  copyLocation: 'Copy Location',
  copyRotation: 'Copy Rotation',
  copyScale: 'Copy Scale',
  limitDistance: 'Limit Distance',
};

// ---------------------------------------------------------------- 4×4 maths (row-major, column vectors)

export type M4 = number[];
const I4 = (): M4 => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

export function mul4(a: M4, b: M4): M4 {
  const o = new Array(16).fill(0);
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) for (let k = 0; k < 4; k++) o[r * 4 + c] += a[r * 4 + k] * b[k * 4 + c];
  return o;
}

/** Rotation (3×3 inside a 4×4) for Blender XYZ Euler degrees: R = Rz·Ry·Rx. */
export function eulerMatrix(e: Vec3): M4 {
  const [x, y, z] = e.map((d) => (d * Math.PI) / 180);
  const cx = Math.cos(x), sx = Math.sin(x), cy = Math.cos(y), sy = Math.sin(y), cz = Math.cos(z), sz = Math.sin(z);
  return [cz * cy, cz * sy * sx - sz * cx, cz * sy * cx + sz * sx, 0, sz * cy, sz * sy * sx + cz * cx, sz * sy * cx - cz * sx, 0, -sy, cy * sx, cy * cx, 0, 0, 0, 0, 1];
}

export function trsMatrix(t: Transform): M4 {
  const m = eulerMatrix(t.rotation);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) m[r * 4 + c] *= t.scale[c];
  m[3] = t.position[0];
  m[7] = t.position[1];
  m[11] = t.position[2];
  return m;
}

/** Inverse of an affine matrix. */
export function invert4(m: M4): M4 {
  const a = m[0], b = m[1], c = m[2], d = m[4], e = m[5], f = m[6], g = m[8], h = m[9], i = m[10];
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g) || 1e-12;
  const R = [e * i - f * h, c * h - b * i, b * f - c * e, f * g - d * i, a * i - c * g, c * d - a * f, d * h - e * g, b * g - a * h, a * e - b * d].map((x) => x / det);
  const t = [m[3], m[7], m[11]];
  const o = I4();
  for (let r = 0; r < 3; r++) {
    for (let k = 0; k < 3; k++) o[r * 4 + k] = R[r * 3 + k];
    o[r * 4 + 3] = -(R[r * 3] * t[0] + R[r * 3 + 1] * t[1] + R[r * 3 + 2] * t[2]);
  }
  return o;
}

const len = (v: Vec3) => Math.hypot(v[0], v[1], v[2]);
const norm = (v: Vec3): Vec3 => {
  const l = len(v) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** World location, rotation (3×3 columns, unit) and scale of a matrix. */
interface Decomposed {
  loc: Vec3;
  rot: [Vec3, Vec3, Vec3];
  scale: Vec3;
}

function decompose(m: M4): Decomposed {
  const cols: Vec3[] = [0, 1, 2].map((c) => [m[c], m[4 + c], m[8 + c]] as Vec3);
  const scale = cols.map(len) as Vec3;
  // Negative determinant: flip X so the rotation stays proper.
  if (dot(cross(cols[0], cols[1]), cols[2]) < 0) scale[0] = -scale[0];
  return { loc: [m[3], m[7], m[11]], rot: cols.map((c, i) => (scale[i] ? (c.map((x) => x / scale[i]) as Vec3) : ([0, 0, 0].map((_, k) => (k === i ? 1 : 0)) as Vec3))) as [Vec3, Vec3, Vec3], scale };
}

function compose(d: Decomposed): M4 {
  const m = I4();
  for (let c = 0; c < 3; c++) for (let r = 0; r < 3; r++) m[r * 4 + c] = d.rot[c][r] * d.scale[c];
  m[3] = d.loc[0];
  m[7] = d.loc[1];
  m[11] = d.loc[2];
  return m;
}

/** Blender XYZ Euler degrees from a rotation's columns. */
export function eulerFromColumns(rot: [Vec3, Vec3, Vec3]): Vec3 {
  const m20 = rot[0][2], m21 = rot[1][2], m22 = rot[2][2], m10 = rot[0][1], m00 = rot[0][0];
  const y = Math.asin(Math.max(-1, Math.min(1, -m20)));
  let x: number, z: number;
  if (Math.abs(m20) < 0.99999) {
    x = Math.atan2(m21, m22);
    z = Math.atan2(m10, m00);
  } else {
    // Gimbal lock: put it all in X.
    x = Math.atan2(-rot[2][1], rot[1][1]);
    z = 0;
  }
  const deg = (r: number) => Math.round(((r * 180) / Math.PI) * 1e4) / 1e4;
  return [deg(x), deg(y), deg(z)];
}

type Quat = [number, number, number, number];

function quatFromColumns(r: [Vec3, Vec3, Vec3]): Quat {
  const m00 = r[0][0], m11 = r[1][1], m22 = r[2][2];
  const m01 = r[1][0], m02 = r[2][0], m10 = r[0][1], m12 = r[2][1], m20 = r[0][2], m21 = r[1][2];
  const tr = m00 + m11 + m22;
  let q: Quat;
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2;
    q = [(m21 - m12) / s, (m02 - m20) / s, (m10 - m01) / s, s / 4];
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    q = [s / 4, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s];
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    q = [(m01 + m10) / s, s / 4, (m12 + m21) / s, (m02 - m20) / s];
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    q = [(m02 + m20) / s, (m12 + m21) / s, s / 4, (m10 - m01) / s];
  }
  return q;
}

function columnsFromQuat([x, y, z, w]: Quat): [Vec3, Vec3, Vec3] {
  return [
    [1 - 2 * (y * y + z * z), 2 * (x * y + z * w), 2 * (x * z - y * w)],
    [2 * (x * y - z * w), 1 - 2 * (x * x + z * z), 2 * (y * z + x * w)],
    [2 * (x * z + y * w), 2 * (y * z - x * w), 1 - 2 * (x * x + y * y)],
  ];
}

function slerp(a: Quat, b: Quat, t: number): Quat {
  let d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  const bb = d < 0 ? (b.map((v) => -v) as Quat) : b;
  d = Math.abs(d);
  if (d > 0.9995) {
    const q = a.map((v, i) => v + (bb[i] - v) * t) as Quat;
    const l = Math.hypot(...q) || 1;
    return q.map((v) => v / l) as Quat;
  }
  const th = Math.acos(d), s = Math.sin(th);
  const ka = Math.sin((1 - t) * th) / s, kb = Math.sin(t * th) / s;
  return a.map((v, i) => v * ka + bb[i] * kb) as Quat;
}

function blendRot(a: [Vec3, Vec3, Vec3], b: [Vec3, Vec3, Vec3], t: number): [Vec3, Vec3, Vec3] {
  if (t >= 1) return b;
  if (t <= 0) return a;
  return columnsFromQuat(slerp(quatFromColumns(a), quatFromColumns(b), t));
}

const AXIS: Record<TrackAxis, [number, number]> = { X: [0, 1], '-X': [0, -1], Y: [1, 1], '-Y': [1, -1], Z: [2, 1], '-Z': [2, -1] };

/** Rotation (columns) whose `axis` points along `dir`, keeping world up (+Z) up. */
export function trackRotation(dir: Vec3, axis: TrackAxis): [Vec3, Vec3, Vec3] | null {
  if (len(dir) < 1e-9) return null;
  const d = norm(dir);
  const [k, s] = AXIS[axis];
  const u = k === 2 ? 1 : 2;
  const t = 3 - k - u;
  const cols: Vec3[] = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  cols[k] = d.map((x) => x * s) as Vec3;
  let hint: Vec3 = [0, 0, 1];
  if (Math.abs(dot(hint, cols[k])) > 0.9999) hint = [0, 1, 0];
  cols[u] = norm(hint.map((h, i) => h - dot(hint, cols[k]) * cols[k][i]) as Vec3);
  cols[t] = cross(cols[(t + 1) % 3], cols[(t + 2) % 3]);
  return cols as [Vec3, Vec3, Vec3];
}

/**
 * Apply an object's constraints. `base` is its local transform after keys and Follow Path,
 * `parentWorld` its parent's world matrix and `worldOf(id)` any object's (constrained) world
 * matrix. Returns the new local transform.
 */
export function applyConstraints(o: Pick<SceneObject, 'id' | 'constraints'>, base: Transform, parentWorld: M4 | null, worldOf: (id: string) => M4 | null): Transform {
  const list = o.constraints?.filter((c) => !c.mute && c.influence > 0 && c.target !== o.id);
  if (!list?.length) return base;
  const P = parentWorld ?? I4();
  let w = decompose(mul4(P, trsMatrix(base)));
  const own = w;
  for (const c of list) {
    const T = worldOf(c.target);
    if (!T) continue;
    const tw = decompose(T);
    const k = Math.min(1, c.influence);
    const next: Decomposed = { loc: [...w.loc] as Vec3, rot: w.rot, scale: [...w.scale] as Vec3 };
    const axes = [c.x !== false, c.y !== false, c.z !== false];
    if (c.type === 'trackTo') {
      const r = trackRotation([tw.loc[0] - w.loc[0], tw.loc[1] - w.loc[1], tw.loc[2] - w.loc[2]], c.axis ?? 'Y');
      if (r) next.rot = r;
    } else if (c.type === 'copyLocation') {
      axes.forEach((on, i) => on && (next.loc[i] = tw.loc[i] + (c.offset ? own.loc[i] : 0)));
    } else if (c.type === 'copyRotation') {
      next.rot = tw.rot;
    } else if (c.type === 'copyScale') {
      axes.forEach((on, i) => on && (next.scale[i] = Math.abs(tw.scale[i]) * Math.sign(w.scale[i] || 1)));
    } else if (c.type === 'limitDistance') {
      const dist = Math.max(0, c.distance ?? 1);
      const v: Vec3 = [w.loc[0] - tw.loc[0], w.loc[1] - tw.loc[1], w.loc[2] - tw.loc[2]];
      const l = len(v);
      const mode = c.mode ?? 'inside';
      const clamp = mode === 'inside' ? l > dist : mode === 'outside' ? l < dist : Math.abs(l - dist) > 1e-9;
      if (clamp) {
        const dir = l > 1e-9 ? norm(v) : ([0, 0, 1] as Vec3);
        next.loc = [tw.loc[0] + dir[0] * dist, tw.loc[1] + dir[1] * dist, tw.loc[2] + dir[2] * dist];
      }
    }
    w = {
      loc: w.loc.map((x, i) => x + (next.loc[i] - x) * k) as Vec3,
      rot: blendRot(w.rot, next.rot, k),
      scale: w.scale.map((x, i) => x + (next.scale[i] - x) * k) as Vec3,
    };
  }
  const local = decompose(mul4(invert4(P), compose(w)));
  const r5 = (x: number) => Math.round(x * 1e5) / 1e5;
  return { position: local.loc.map(r5) as Vec3, rotation: eulerFromColumns(local.rot), scale: local.scale.map(r5) as Vec3 };
}

/** Checks for a loaded / scripted constraint (null = fine). */
export function constraintError(c: Constraint): string | null {
  if (!CONSTRAINT_TYPES.includes(c.type)) return `constraint type must be one of ${CONSTRAINT_TYPES.join(', ')}`;
  if (typeof c.target !== 'string' || !c.target) return 'constraint needs a target object';
  if (!(Number.isFinite(c.influence) && c.influence >= 0 && c.influence <= 1)) return 'constraint influence must be 0..1';
  if (c.axis !== undefined && !TRACK_AXES.includes(c.axis)) return `track axis must be one of ${TRACK_AXES.join(', ')}`;
  if (c.distance !== undefined && !(Number.isFinite(c.distance) && c.distance >= 0 && c.distance <= 1e5)) return 'limit distance must be 0..100000 m';
  if (c.mode !== undefined && !['inside', 'outside', 'on'].includes(c.mode)) return 'limit distance mode must be inside, outside or on';
  return null;
}
