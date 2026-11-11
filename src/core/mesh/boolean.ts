// Boolean modelling (Difference / Union / Intersect), like Blender's Boolean modifier applied.
// Uses manifold-3d (Apache-2.0), a robust mesh-boolean library compiled to WebAssembly. The
// WASM module is loaded once on demand (loadBooleans) before a boolean command runs.

import type { MeshData } from '../types';
import type { V } from './topology';
import { compact, triangulate } from './topology';

export const BOOLEAN_OPS = ['difference', 'union', 'intersect'] as const;
export type BooleanOp = (typeof BOOLEAN_OPS)[number];

// The manifold-3d module API (only what we use).
interface ManifoldApi {
  Manifold: {
    ofMesh(mesh: unknown): ManifoldSolid;
  };
  Mesh: new (opts: { numProp: number; vertProperties: Float32Array; triVerts: Uint32Array }) => { merge(): boolean };
}
interface ManifoldSolid {
  subtract(o: ManifoldSolid): ManifoldSolid;
  add(o: ManifoldSolid): ManifoldSolid;
  intersect(o: ManifoldSolid): ManifoldSolid;
  getMesh(): { numProp: number; vertProperties: Float32Array; triVerts: Uint32Array };
  isEmpty(): boolean;
  delete(): void;
}

let api: ManifoldApi | null = null;
let loading: Promise<void> | null = null;

export const booleansReady = () => !!api;

/** Load the boolean engine (WASM). `locateFile` gives the .wasm URL in the browser. */
export function loadBooleans(locateFile?: () => string): Promise<void> {
  if (api) return Promise.resolve();
  loading ??= import('manifold-3d').then(async (m) => {
    const wasm = await (m.default as unknown as (cfg?: { locateFile: () => string }) => Promise<ManifoldApi & { setup(): void }>)(locateFile ? { locateFile } : undefined);
    wasm.setup();
    api = wasm;
  });
  return loading;
}

export class BooleanError extends Error {}

function toSolid(mesh: MeshData, name: string): ManifoldSolid {
  const tris: number[] = [];
  for (const f of mesh.faces) for (const t of triangulate(mesh.vertices, f)) tris.push(...t);
  const m = new api!.Mesh({ numProp: 3, vertProperties: Float32Array.from(mesh.vertices.flat()), triVerts: Uint32Array.from(tris) });
  m.merge();
  try {
    return api!.Manifold.ofMesh(m);
  } catch {
    throw new BooleanError(`${name} is not a closed solid (it has holes or loose faces), so it can't be used in a boolean`);
  }
}

/** Boolean of two meshes given in the same space. Returns triangles (flat-shaded hard surface). */
export function meshBoolean(a: MeshData, b: MeshData, op: BooleanOp, names: [string, string] = ['Object', 'Cutter']): MeshData {
  if (!api) throw new BooleanError('The boolean engine is still loading; try again in a moment');
  const A = toSolid(a, names[0]);
  const B = toSolid(b, names[1]);
  let R: ManifoldSolid | null = null;
  try {
    R = op === 'difference' ? A.subtract(B) : op === 'union' ? A.add(B) : A.intersect(B);
    if (R.isEmpty()) throw new BooleanError(op === 'intersect' ? 'The two objects do not overlap' : 'The result is empty');
    const out = R.getMesh();
    const vertices: V[] = [];
    for (let i = 0; i < out.vertProperties.length; i += out.numProp) vertices.push([out.vertProperties[i], out.vertProperties[i + 1], out.vertProperties[i + 2]]);
    const faces: number[][] = [];
    for (let i = 0; i < out.triVerts.length; i += 3) faces.push([out.triVerts[i], out.triVerts[i + 1], out.triVerts[i + 2]]);
    return compact({ vertices: vertices.map((v) => v.map((x) => Math.round(x * 1e5) / 1e5) as V), faces, smooth: a.smooth }).mesh;
  } finally {
    A.delete();
    B.delete();
    R?.delete();
  }
}
