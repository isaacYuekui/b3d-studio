import { describe, expect, it } from 'vitest';
import { Quaternion, Vector3 } from '@babylonjs/core/Maths/math.vector';
import { babylonQuatToEulerDeg, eulerDegToBabylonQuat, eulerDegToQuat, quatToEulerDeg, toBabylonVec } from '../src/engine/coords';
import type { Vec3 } from '../src/core/types';

/** Rotate a Blender-space vector using the converted quaternion inside Babylon, map result back. */
function rotateViaBabylon(euler: Vec3, v: Vec3): Vec3 {
  const [x, y, z, w] = eulerDegToBabylonQuat(euler);
  const out = Vector3.Zero();
  new Vector3(...toBabylonVec(v)).rotateByQuaternionToRef(new Quaternion(x, y, z, w), out);
  return [out.x, out.z, out.y].map((n) => Math.round(n * 1e6) / 1e6 + 0) as Vec3;
}

describe('Blender <-> Babylon coordinates', () => {
  it('rotating 90° about Blender Z turns +X into +Y (right-handed, counter-clockwise from above)', () => {
    expect(rotateViaBabylon([0, 0, 90], [1, 0, 0])).toEqual([0, 1, 0]);
  });

  it('rotating 90° about Blender X turns +Y into +Z', () => {
    expect(rotateViaBabylon([90, 0, 0], [0, 1, 0])).toEqual([0, 0, 1]);
  });

  it('rotating 90° about Blender Y turns +Z into +X', () => {
    expect(rotateViaBabylon([0, 90, 0], [0, 0, 1])).toEqual([1, 0, 0]);
  });

  it('applies X first, then Y, then Z (Blender XYZ Euler order)', () => {
    // X 90 maps +Y -> +Z, then Z 90 leaves +Z unchanged
    expect(rotateViaBabylon([90, 0, 90], [0, 1, 0])).toEqual([0, 0, 1]);
    // X 90: +Z -> -Y ; Z 90: -Y -> +X
    expect(rotateViaBabylon([90, 0, 90], [0, 0, 1])).toEqual([1, 0, 0]);
  });

  it('round-trips Euler angles', () => {
    const cases: Vec3[] = [[0, 0, 0], [30, 45, 60], [-120, 10, 170], [0, 0, -90], [12.5, -33, 0]];
    for (const e of cases) {
      expect(quatToEulerDeg(eulerDegToQuat(e))).toEqual(e.map((n) => n + 0));
      expect(babylonQuatToEulerDeg(eulerDegToBabylonQuat(e))).toEqual(e.map((n) => n + 0));
    }
  });

  it('handles gimbal lock without NaN', () => {
    const r = quatToEulerDeg(eulerDegToQuat([0, 90, 30]));
    expect(r.every(Number.isFinite)).toBe(true);
    expect(r[1]).toBe(90);
  });
});
