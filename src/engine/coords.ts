// Coordinate conversion between the scene model and Babylon.
//
// The scene model uses BLENDER conventions: right-handed, Z-up, Euler XYZ in degrees.
// Babylon is left-handed, Y-up. Swapping the Y and Z axes maps one exactly onto the
// other (the swap flips handedness, which is what we need), so:
//   position/scale: (x, y, z)_blender  ->  (x, z, y)_babylon
//   rotation quaternion (w, x, y, z)   ->  (w, -x, -z, -y)
// (a rotation axis is a pseudovector, so it picks up a minus sign under reflection).
// Pure math, no Babylon import, so it is unit-testable in Node.

import type { Vec3 } from '../core/types';

export type Quat = [number, number, number, number]; // x, y, z, w (Babylon storage order)

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

export const toBabylonVec = (v: Vec3): Vec3 => [v[0], v[2], v[1]];
export const fromBabylonVec = (v: Vec3): Vec3 => [v[0], v[2], v[1]];

/** Quaternion multiply a*b (Hamilton), x,y,z,w order. */
function mul(a: Quat, b: Quat): Quat {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

const axisQuat = (axis: 0 | 1 | 2, rad: number): Quat => {
  const q: Quat = [0, 0, 0, Math.cos(rad / 2)];
  q[axis] = Math.sin(rad / 2);
  return q;
};

/** Blender Euler XYZ (degrees) -> quaternion in Blender space. X applied first. */
export function eulerDegToQuat(e: Vec3): Quat {
  return mul(axisQuat(2, e[2] * D2R), mul(axisQuat(1, e[1] * D2R), axisQuat(0, e[0] * D2R)));
}

/** Quaternion in Blender space -> Blender Euler XYZ (degrees). */
export function quatToEulerDeg(q: Quat): Vec3 {
  const [x, y, z, w] = q;
  const r00 = 1 - 2 * (y * y + z * z);
  const r01 = 2 * (x * y - w * z);
  const r10 = 2 * (x * y + w * z);
  const r11 = 1 - 2 * (x * x + z * z);
  const r20 = 2 * (x * z - w * y);
  const r21 = 2 * (y * z + w * x);
  const r22 = 1 - 2 * (x * x + y * y);
  let ax: number, ay: number, az: number;
  if (Math.abs(r20) < 0.999999) {
    ay = Math.asin(-r20);
    ax = Math.atan2(r21, r22);
    az = Math.atan2(r10, r00);
  } else {
    ay = r20 < 0 ? Math.PI / 2 : -Math.PI / 2;
    ax = 0;
    az = Math.atan2(-r01, r11);
  }
  return [clean(ax * R2D), clean(ay * R2D), clean(az * R2D)];
}

/** Map a quaternion between Blender and Babylon space (the map is its own inverse). */
export const swapQuat = (q: Quat): Quat => [-q[0], -q[2], -q[1], q[3]];

export const eulerDegToBabylonQuat = (e: Vec3): Quat => swapQuat(eulerDegToQuat(e));
export const babylonQuatToEulerDeg = (q: Quat): Vec3 => quatToEulerDeg(swapQuat(q));

/** Round away float noise (e.g. 89.99999999 -> 90, -0 -> 0). */
export function clean(n: number, digits = 4): number {
  const f = 10 ** digits;
  const r = Math.round(n * f) / f;
  return Object.is(r, -0) ? 0 : r;
}
