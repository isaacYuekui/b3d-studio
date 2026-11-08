// Armatures and skinning, in Blender space (metres, Z up, right-handed).
//
// Bones follow Blender's convention: a bone's local Y axis runs from head to tail, roll
// twists it around that axis. A bone's pose (rotation in degrees, Euler XYZ, plus an
// optional location) is applied in its own rest axes, so "rotate X" bends a leg forward
// the same way it does in Blender's Pose Mode. Meshes deform with automatic weights from
// the distance to each bone (an envelope-style bind, top 4 influences per vertex).

import type { Animation } from './animation';
import { evaluatePose, transformAt } from './animation';
import type { Bone, BonePose, MeshData, SceneDoc, Transform, Vec3 } from './types';

/** 4×4 matrix, row-major, acting on column vectors (p' = M p). */
export type M4 = number[];

export const I4 = (): M4 => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

export function mul(a: M4, b: M4): M4 {
  const o = new Array(16).fill(0);
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) {
    let s = 0;
    for (let k = 0; k < 4; k++) s += a[r * 4 + k] * b[k * 4 + c];
    o[r * 4 + c] = s;
  }
  return o;
}

export function apply(m: M4, p: Vec3): Vec3 {
  return [m[0] * p[0] + m[1] * p[1] + m[2] * p[2] + m[3], m[4] * p[0] + m[5] * p[1] + m[6] * p[2] + m[7], m[8] * p[0] + m[9] * p[1] + m[10] * p[2] + m[11]];
}

export function invert(m: M4): M4 {
  const inv = new Array(16);
  const [a00, a01, a02, a03, a10, a11, a12, a13, a20, a21, a22, a23, a30, a31, a32, a33] = m;
  const b00 = a00 * a11 - a01 * a10, b01 = a00 * a12 - a02 * a10, b02 = a00 * a13 - a03 * a10, b03 = a01 * a12 - a02 * a11;
  const b04 = a01 * a13 - a03 * a11, b05 = a02 * a13 - a03 * a12, b06 = a20 * a31 - a21 * a30, b07 = a20 * a32 - a22 * a30;
  const b08 = a20 * a33 - a23 * a30, b09 = a21 * a32 - a22 * a31, b10 = a21 * a33 - a23 * a31, b11 = a22 * a33 - a23 * a32;
  const det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (Math.abs(det) < 1e-14) return I4();
  const d = 1 / det;
  inv[0] = (a11 * b11 - a12 * b10 + a13 * b09) * d;
  inv[1] = (a02 * b10 - a01 * b11 - a03 * b09) * d;
  inv[2] = (a31 * b05 - a32 * b04 + a33 * b03) * d;
  inv[3] = (a22 * b04 - a21 * b05 - a23 * b03) * d;
  inv[4] = (a12 * b08 - a10 * b11 - a13 * b07) * d;
  inv[5] = (a00 * b11 - a02 * b08 + a03 * b07) * d;
  inv[6] = (a32 * b02 - a30 * b05 - a33 * b01) * d;
  inv[7] = (a20 * b05 - a22 * b02 + a23 * b01) * d;
  inv[8] = (a10 * b10 - a11 * b08 + a13 * b06) * d;
  inv[9] = (a01 * b08 - a00 * b10 - a03 * b06) * d;
  inv[10] = (a30 * b04 - a31 * b02 + a33 * b00) * d;
  inv[11] = (a21 * b02 - a20 * b04 - a23 * b00) * d;
  inv[12] = (a11 * b07 - a10 * b09 - a12 * b06) * d;
  inv[13] = (a00 * b09 - a01 * b07 + a02 * b06) * d;
  inv[14] = (a31 * b01 - a30 * b03 - a32 * b00) * d;
  inv[15] = (a20 * b03 - a21 * b01 + a22 * b00) * d;
  return inv;
}

const D2R = Math.PI / 180;

/** Rotation from Blender Euler XYZ degrees (X applied first): Rz · Ry · Rx. */
export function rotEuler(e: Vec3): M4 {
  const [x, y, z] = e.map((d) => d * D2R);
  const cx = Math.cos(x), sx = Math.sin(x), cy = Math.cos(y), sy = Math.sin(y), cz = Math.cos(z), sz = Math.sin(z);
  return [
    cz * cy, cz * sy * sx - sz * cx, cz * sy * cx + sz * sx, 0,
    sz * cy, sz * sy * sx + cz * cx, sz * sy * cx - cz * sx, 0,
    -sy, cy * sx, cy * cx, 0,
    0, 0, 0, 1,
  ];
}

export function trs(t: Transform): M4 {
  const r = rotEuler(t.rotation);
  const [sx, sy, sz] = t.scale;
  return [r[0] * sx, r[1] * sy, r[2] * sz, t.position[0], r[4] * sx, r[5] * sy, r[6] * sz, t.position[1], r[8] * sx, r[9] * sy, r[10] * sz, t.position[2], 0, 0, 0, 1];
}

/** Rotation part → Blender Euler XYZ degrees. */
export function toEuler(m: M4): Vec3 {
  const r20 = m[8];
  let x: number, y: number, z: number;
  if (Math.abs(r20) < 0.999999) {
    y = Math.asin(-r20);
    x = Math.atan2(m[9], m[10]);
    z = Math.atan2(m[4], m[0]);
  } else {
    y = r20 < 0 ? Math.PI / 2 : -Math.PI / 2;
    x = Math.atan2(-m[6], m[5]);
    z = 0;
  }
  return [x / D2R, y / D2R, z / D2R].map((v) => Math.round(v * 1e4) / 1e4 + 0) as Vec3;
}

/** Strip scale from a matrix's rotation part (columns normalised). */
export function rotationOnly(m: M4): M4 {
  const o = I4();
  for (let c = 0; c < 3; c++) {
    const l = Math.hypot(m[c], m[4 + c], m[8 + c]) || 1;
    o[c] = m[c] / l;
    o[4 + c] = m[4 + c] / l;
    o[8 + c] = m[8 + c] / l;
  }
  return o;
}

/** Blender's bone rest matrix: Y along head→tail, minimal rotation from +Y, then roll. */
export function boneRest(b: Bone): M4 {
  const d0: Vec3 = [b.tail[0] - b.head[0], b.tail[1] - b.head[1], b.tail[2] - b.head[2]];
  const l = Math.hypot(...d0) || 1;
  const d: Vec3 = [d0[0] / l, d0[1] / l, d0[2] / l];
  // Rotation taking +Y onto d (Rodrigues), with the d ≈ -Y case handled.
  let R: M4;
  const c = d[1];
  if (c < -0.999999) R = [-1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  else {
    // axis = Y × d = (d.z, 0, -d.x)
    const ax = d[2], az = -d[0];
    const k = 1 / (1 + c);
    R = [
      c + ax * ax * k, -az, ax * az * k, 0,
      az, c, -ax, 0,
      ax * az * k, ax, c + az * az * k, 0,
      0, 0, 0, 1,
    ];
  }
  if (b.roll) {
    // Roll around the bone's own Y axis.
    const r = b.roll * D2R, cr = Math.cos(r), sr = Math.sin(r);
    R = mul(R, [cr, 0, sr, 0, 0, 1, 0, 0, -sr, 0, cr, 0, 0, 0, 0, 1]);
  }
  R[3] = b.head[0];
  R[7] = b.head[1];
  R[11] = b.head[2];
  return R;
}

export function boneLength(b: Bone) {
  return Math.hypot(b.tail[0] - b.head[0], b.tail[1] - b.head[1], b.tail[2] - b.head[2]);
}

/** Bones ordered parents-first (unknown / cyclic parents are treated as roots). */
export function sortBones(bones: Bone[]): Bone[] {
  const byName = new Map(bones.map((b) => [b.name, b]));
  const out: Bone[] = [];
  const seen = new Set<string>();
  const visit = (b: Bone, depth = 0) => {
    if (seen.has(b.name) || depth > bones.length) return;
    const p = b.parent ? byName.get(b.parent) : undefined;
    if (p && !seen.has(p.name)) visit(p, depth + 1);
    if (!seen.has(b.name)) {
      seen.add(b.name);
      out.push(b);
    }
  };
  bones.forEach((b) => visit(b));
  return out;
}

export interface PosedBones {
  rest: Map<string, M4>;
  posed: Map<string, M4>;
  /** posed · rest⁻¹: moves rest-pose points to posed points (armature space). */
  skin: Map<string, M4>;
}

export function poseBones(bones: Bone[], pose: Record<string, Partial<BonePose>> = {}): PosedBones {
  const rest = new Map<string, M4>();
  const posed = new Map<string, M4>();
  const skin = new Map<string, M4>();
  for (const b of sortBones(bones)) {
    const R = boneRest(b);
    rest.set(b.name, R);
    const p = pose[b.name];
    const local = p ? trs({ position: p.location ?? [0, 0, 0], rotation: p.rotation ?? [0, 0, 0], scale: [1, 1, 1] }) : I4();
    const parentRest = b.parent ? rest.get(b.parent) : undefined;
    const parentPosed = b.parent ? posed.get(b.parent) : undefined;
    const base = parentRest && parentPosed ? mul(mul(parentPosed, invert(parentRest)), R) : R;
    const P = mul(base, local);
    posed.set(b.name, P);
    skin.set(b.name, mul(P, invert(R)));
  }
  return { rest, posed, skin };
}

/** The pose an armature shows at a frame: bone keys where animated, otherwise its stored pose. */
export function poseAt(doc: { animation?: Animation; objects: SceneDoc['objects'] }, id: string, frame: number): Record<string, BonePose> {
  const o = doc.objects[id];
  const out: Record<string, BonePose> = { ...(o?.pose ?? {}) };
  const tracks = doc.animation?.poses?.[id];
  if (tracks) for (const [bone, keys] of Object.entries(tracks)) {
    const p = evaluatePose(keys, frame);
    if (p) out[bone] = p;
  }
  return out;
}

/** Object → world matrix (Blender space) at a frame, through its parents. */
export function worldMatrix(doc: { animation?: Animation; objects: SceneDoc['objects'] }, id: string, frame: number, depth = 0): M4 {
  const o = doc.objects[id];
  if (!o || depth > 64) return I4();
  const local = trs(transformAt(doc, id, frame) ?? o.transform);
  return o.parentId ? mul(worldMatrix(doc, o.parentId, frame, depth + 1), local) : local;
}

// ---------------------------------------------------------------- skinning

function segDist(p: Vec3, a: Vec3, b: Vec3): number {
  const ab: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const ap: Vec3 = [p[0] - a[0], p[1] - a[1], p[2] - a[2]];
  const L = ab[0] * ab[0] + ab[1] * ab[1] + ab[2] * ab[2];
  const t = L ? Math.max(0, Math.min(1, (ap[0] * ab[0] + ap[1] * ab[1] + ap[2] * ab[2]) / L)) : 0;
  return Math.hypot(ap[0] - ab[0] * t, ap[1] - ab[1] * t, ap[2] - ab[2] * t);
}

export interface Weights {
  bones: string[];
  /** Per vertex: up to 4 [bone index, weight] pairs, weights summing to 1. */
  w: [number, number][][];
}

/**
 * Automatic weights: inverse distance to each deforming bone's segment (rest pose,
 * armature space), keeping bones within 1.5× of the nearest one, top 4, normalised.
 */
export function autoWeights(points: Vec3[], bones: Bone[]): Weights {
  const def = bones.filter((b) => b.deform !== false);
  const names = def.map((b) => b.name);
  const w = points.map((p) => {
    const d = def.map((b) => segDist(p, b.head, b.tail));
    const near = Math.min(...d);
    const cand = d
      .map((di, i) => [i, di] as [number, number])
      .filter(([, di]) => di <= near * 1.5 + 0.01)
      .map(([i, di]) => [i, 1 / Math.pow(di + 0.005, 4)] as [number, number])
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4);
    const sum = cand.reduce((s, [, x]) => s + x, 0) || 1;
    return cand.map(([i, x]) => [i, x / sum] as [number, number]);
  });
  return { bones: names, w };
}

/** Deform points with per-bone matrices (linear blend skinning). */
export function deform(points: Vec3[], weights: Weights, mats: Map<string, M4>): Vec3[] {
  const ms = weights.bones.map((n) => mats.get(n) ?? I4());
  return points.map((p, i) => {
    let x = 0, y = 0, z = 0;
    for (const [bi, wt] of weights.w[i]) {
      const q = apply(ms[bi], p);
      x += q[0] * wt;
      y += q[1] * wt;
      z += q[2] * wt;
    }
    return weights.w[i].length ? [x, y, z] : p;
  });
}

/**
 * Deform a skinned mesh (in its own local space) by its armature at a frame.
 * `bindCache` keeps the automatic weights between frames.
 */
export function skinMesh(
  doc: { animation?: Animation; objects: SceneDoc['objects'] },
  meshId: string,
  mesh: MeshData,
  frame: number,
  bindCache?: Map<string, { key: unknown; weights: Weights; rel: string }>,
  /** Explicit weights (library weight sets); used when they match the vertex count. */
  explicit?: Weights | null,
): MeshData {
  const o = doc.objects[meshId];
  const armId = o?.skin?.armature;
  const arm = armId ? doc.objects[armId] : undefined;
  if (!arm?.armature) return mesh;
  // mesh local → armature local
  const rel = mul(invert(worldMatrix(doc, armId!, frame)), worldMatrix(doc, meshId, frame));
  const relKey = rel.map((x) => x.toFixed(4)).join(',');
  const relInv = invert(rel);
  const restPts = mesh.vertices.map((v) => apply(rel, v));
  let cached = bindCache?.get(meshId);
  if (!cached || cached.key !== mesh || cached.rel !== relKey || (cached as unknown as { bones: unknown }).bones !== arm.armature.bones || (cached as unknown as { ex: unknown }).ex !== explicit) {
    const bone = o.skin!.bone;
    const weights: Weights =
      bone && arm.armature.bones.some((b) => b.name === bone)
        ? { bones: [bone], w: restPts.map(() => [[0, 1]] as [number, number][]) }
        : explicit && explicit.w.length === restPts.length
          ? explicit
          : autoWeights(restPts, arm.armature.bones);
    cached = { key: mesh, rel: relKey, weights };
    (cached as unknown as { bones: unknown }).bones = arm.armature.bones;
    (cached as unknown as { ex: unknown }).ex = explicit;
    bindCache?.set(meshId, cached);
  }
  const { skin } = poseBones(arm.armature.bones, poseAt(doc, armId!, frame));
  const moved = deform(restPts, cached.weights, skin);
  return { ...mesh, vertices: moved.map((p) => apply(relInv, p)) };
}

/** Quaternion (x, y, z, w) → rotation matrix. */
export function quatToM4([x, y, z, w]: [number, number, number, number]): M4 {
  return [
    1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y), 0,
    2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x), 0,
    2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y), 0,
    0, 0, 0, 1,
  ];
}

/** Rotation matrix → quaternion (x, y, z, w). */
export function m4ToQuat(m: M4): [number, number, number, number] {
  const t = m[0] + m[5] + m[10];
  let x: number, y: number, z: number, w: number;
  if (t > 0) {
    const s = Math.sqrt(t + 1) * 2;
    w = s / 4; x = (m[9] - m[6]) / s; y = (m[2] - m[8]) / s; z = (m[4] - m[1]) / s;
  } else if (m[0] > m[5] && m[0] > m[10]) {
    const s = Math.sqrt(1 + m[0] - m[5] - m[10]) * 2;
    w = (m[9] - m[6]) / s; x = s / 4; y = (m[1] + m[4]) / s; z = (m[2] + m[8]) / s;
  } else if (m[5] > m[10]) {
    const s = Math.sqrt(1 + m[5] - m[0] - m[10]) * 2;
    w = (m[2] - m[8]) / s; x = (m[1] + m[4]) / s; y = s / 4; z = (m[6] + m[9]) / s;
  } else {
    const s = Math.sqrt(1 + m[10] - m[0] - m[5]) * 2;
    w = (m[4] - m[1]) / s; x = (m[2] + m[8]) / s; y = (m[6] + m[9]) / s; z = s / 4;
  }
  return [x, y, z, w];
}

/** The "base" frame a bone's pose is applied in: parent's posed motion × the bone's rest. */
export function boneBase(bones: Bone[], posed: PosedBones, name: string): M4 {
  const b = bones.find((x) => x.name === name)!;
  const R = posed.rest.get(name)!;
  if (!b.parent) return R;
  return mul(mul(posed.posed.get(b.parent)!, invert(posed.rest.get(b.parent)!)), R);
}

/**
 * The command for a bone pose edit at a frame: animated bones get a key (auto-key),
 * others change the stored pose.
 */
export function poseEdit(doc: SceneDoc, frame: number, armId: string, bone: string, pose: BonePose) {
  const keys = doc.animation?.poses?.[armId]?.[bone];
  if (keys?.length) return { type: 'setPoseKey' as const, id: armId, bone, frame, rotation: pose.rotation, ...(pose.location ? { location: pose.location } : {}) };
  return { type: 'setPose' as const, id: armId, pose: { [bone]: pose } };
}
