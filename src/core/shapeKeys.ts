// Shape keys (Blender's Object Data → Shape Keys): other shapes of the same mesh — a smile, a
// blink, a squashed ball — mixed on top of the Basis by a value 0..1 that can be keyframed.
//
// Storage: `shapeKeys.keys[0]` is the Basis; every key holds absolute vertex positions. The
// mesh's own vertices are always the ACTIVE key's shape (that's what Edit Mode and sculpting
// change), so every editing tool works on shape keys without knowing about them: after each
// command the edited positions are written back into the active key (see carryShapeKeys).
// What the viewport shows in Object Mode is the mix: Basis + Σ value × (key − Basis).

import type { MeshData, Vec3 } from './types';
import type { Easing } from './animation';

export interface ShapeKey {
  name: string;
  /** Absolute vertex positions, one per mesh vertex. */
  verts: Vec3[];
  /** How much of this shape is mixed in (Basis: unused). */
  value: number;
  /** Slider range (Blender: Range Min / Max). */
  min?: number;
  max?: number;
  /** Switched off (Blender's checkbox). */
  mute?: boolean;
}

export interface ShapeKeys {
  /** The key Edit Mode and sculpting change (0 = Basis). */
  active: number;
  keys: ShapeKey[];
}

/** A keyframe on a shape key's value. */
export interface ValueKey {
  frame: number;
  value: number;
  easing: Easing;
}

export const MAX_SHAPE_KEYS = 32;

const r5 = (x: number) => Math.round(x * 1e5) / 1e5;
const copy = (vs: Vec3[]): Vec3[] => vs.map((v) => [v[0], v[1], v[2]] as Vec3);
const posKey = (v: Vec3) => `${r5(v[0])},${r5(v[1])},${r5(v[2])}`;

export function hasShapeKeys(sk: ShapeKeys | undefined): sk is ShapeKeys {
  return !!sk && sk.keys.length > 1;
}

/** A name not used yet ("Key 1", "Key 2"…). */
export function uniqueKeyName(sk: ShapeKeys | undefined, want?: string): string {
  const used = new Set(sk?.keys.map((k) => k.name) ?? []);
  if (want && !used.has(want)) return want;
  const base = want || 'Key';
  for (let i = 1; ; i++) if (!used.has(`${base} ${i}`)) return `${base} ${i}`;
}

/**
 * Add a shape key. The first call also makes the Basis. The new key starts as the current mix
 * (`fromMix`, Blender's "New Shape from Mix") or as a copy of the Basis; it becomes active.
 */
export function addShapeKey(mesh: MeshData, sk: ShapeKeys | undefined, name?: string, fromMix = false, values?: number[]): { mesh: MeshData; shapeKeys: ShapeKeys } {
  const cur: ShapeKeys = sk ?? { active: 0, keys: [{ name: 'Basis', verts: copy(mesh.vertices), value: 0 }] };
  if (cur.keys.length >= MAX_SHAPE_KEYS) throw new Error(`At most ${MAX_SHAPE_KEYS} shape keys`);
  if (!sk && name === undefined && cur.keys.length === 1 && !fromMix) {
    // First press makes just the Basis, like Blender.
    return { mesh, shapeKeys: cur };
  }
  const verts = fromMix ? mixShapes(cur, values) : copy(cur.keys[0].verts);
  const key: ShapeKey = { name: uniqueKeyName(cur, name), verts, value: 0 };
  const keys = [...cur.keys, key];
  return { mesh: { ...mesh, vertices: copy(verts) }, shapeKeys: { active: keys.length - 1, keys } };
}

/** Make another key the one that's edited: the mesh shows its shape. */
export function setActiveKey(mesh: MeshData, sk: ShapeKeys, index: number): { mesh: MeshData; shapeKeys: ShapeKeys } {
  if (!(index >= 0 && index < sk.keys.length)) throw new Error('No such shape key');
  return { mesh: { ...mesh, vertices: copy(sk.keys[index].verts) }, shapeKeys: { ...sk, active: index } };
}

/** Remove a key. Removing the Basis removes them all (the mesh keeps the Basis shape). */
export function removeShapeKey(mesh: MeshData, sk: ShapeKeys, index: number): { mesh: MeshData; shapeKeys: ShapeKeys | undefined } {
  if (!(index >= 0 && index < sk.keys.length)) throw new Error('No such shape key');
  if (index === 0 || sk.keys.length <= 2) return { mesh: { ...mesh, vertices: copy(sk.keys[0].verts) }, shapeKeys: undefined };
  const keys = sk.keys.filter((_, i) => i !== index);
  const active = sk.active === index ? Math.max(0, index - 1) : sk.active > index ? sk.active - 1 : sk.active;
  return { mesh: { ...mesh, vertices: copy(keys[active].verts) }, shapeKeys: { active, keys } };
}

/** Basis + Σ value × (key − Basis), values clamped to each key's range. `values[i]` overrides key i's own value. */
export function mixShapes(sk: ShapeKeys, values?: number[]): Vec3[] {
  const basis = sk.keys[0].verts;
  const out = copy(basis);
  for (let i = 1; i < sk.keys.length; i++) {
    const k = sk.keys[i];
    if (k.mute || k.verts.length !== basis.length) continue;
    const v = Math.max(k.min ?? 0, Math.min(k.max ?? 1, values?.[i] ?? k.value));
    if (!v) continue;
    for (let j = 0; j < out.length; j++) {
      const a = k.verts[j], b = basis[j];
      out[j][0] += (a[0] - b[0]) * v;
      out[j][1] += (a[1] - b[1]) * v;
      out[j][2] += (a[2] - b[2]) * v;
    }
  }
  return out.map((p) => [r5(p[0]), r5(p[1]), r5(p[2])] as Vec3);
}

/**
 * After a command changed a mesh that has shape keys: its new positions belong to the active
 * key. Editing the Basis moves the other keys by the same amount (they stay relative to it).
 * Changing the geometry (adding or removing points) only works on the Basis; the other keys
 * keep their offsets on the points that are still where they were.
 */
export function carryShapeKeys(before: MeshData, after: MeshData, sk: ShapeKeys): ShapeKeys {
  const a = sk.active;
  const n = after.vertices.length;
  // Same points (moved, or faces changed between them): positions go to the active key.
  if (before.vertices.length === n) {
    const keys = sk.keys.map((k, i) => {
      if (i === a) return { ...k, verts: copy(after.vertices) };
      if (a !== 0) return k;
      // Basis moved: keep the other keys relative to it.
      return {
        ...k,
        verts: k.verts.map((p, j) => {
          const d0 = after.vertices[j][0] - before.vertices[j][0], d1 = after.vertices[j][1] - before.vertices[j][1], d2 = after.vertices[j][2] - before.vertices[j][2];
          return d0 || d1 || d2 ? ([r5(p[0] + d0), r5(p[1] + d1), r5(p[2] + d2)] as Vec3) : p;
        }),
      };
    });
    return { ...sk, keys };
  }
  if (a !== 0) throw new Error('Switch to the Basis shape key to add or remove geometry');
  // New geometry: match points by position, keep their offsets; new points get none.
  const at = new Map<string, number>();
  before.vertices.forEach((v, i) => at.set(posKey(v), i));
  const keys = sk.keys.map((k, ki) => {
    if (ki === 0) return { ...k, verts: copy(after.vertices) };
    return {
      ...k,
      verts: after.vertices.map((v) => {
        const i = at.get(posKey(v));
        if (i === undefined || !k.verts[i]) return [v[0], v[1], v[2]] as Vec3;
        const o = k.verts[i], b = before.vertices[i];
        return [r5(v[0] + o[0] - b[0]), r5(v[1] + o[1] - b[1]), r5(v[2] + o[2] - b[2])] as Vec3;
      }),
    };
  });
  return { ...sk, keys };
}

/** Values of every key at a frame: keyframed ones animate, the rest use their own value. */
export function shapeValuesAt(sk: ShapeKeys, tracks: Record<string, ValueKey[]> | undefined, frame: number, evaluate: (keys: ValueKey[], frame: number) => number | null): number[] {
  return sk.keys.map((k, i) => (i === 0 ? 0 : (tracks?.[k.name]?.length ? evaluate(tracks[k.name], frame) : null) ?? k.value));
}

/** The mesh as the viewport shows it in Object Mode (the mix), or the mesh itself without keys. */
export function shapedMesh(mesh: MeshData, sk: ShapeKeys | undefined, values?: number[]): MeshData {
  if (!hasShapeKeys(sk) || sk.keys[0].verts.length !== mesh.vertices.length) return mesh;
  return { ...mesh, vertices: mixShapes(sk, values) };
}

/** Checks for loaded / scripted shape keys against the mesh. */
export function validShapeKeys(sk: ShapeKeys, vertexCount: number): string | null {
  if (!Array.isArray(sk.keys) || sk.keys.length < 1 || sk.keys.length > MAX_SHAPE_KEYS) return 'shapeKeys.keys must hold 1..32 keys';
  if (!Number.isInteger(sk.active) || sk.active < 0 || sk.active >= sk.keys.length) return 'shapeKeys.active invalid';
  const names = new Set<string>();
  for (const k of sk.keys) {
    if (typeof k.name !== 'string' || !k.name || k.name.length > 64 || names.has(k.name)) return 'shape key names must be unique, 1..64 characters';
    names.add(k.name);
    if (!Array.isArray(k.verts) || k.verts.length !== vertexCount) return `shape key "${k.name}" needs ${vertexCount} points`;
    if (!k.verts.every((v) => Array.isArray(v) && v.length === 3 && v.every((x) => Number.isFinite(x) && Math.abs(x) < 1e6))) return `shape key "${k.name}" has a bad point`;
    if (!Number.isFinite(k.value) || Math.abs(k.value) > 10) return `shape key "${k.name}" value invalid`;
    if (k.min !== undefined && !(Number.isFinite(k.min) && k.min >= -10 && k.min <= 10)) return 'shape key min invalid';
    if (k.max !== undefined && !(Number.isFinite(k.max) && k.max >= -10 && k.max <= 10)) return 'shape key max invalid';
  }
  return null;
}
