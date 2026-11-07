// Converts scene MeshData (Blender coordinates, CCW polygons) into Babylon vertex data.
// Kept free of scene/engine state so it can be unit-tested in Node.

import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData';
import type { MeshData } from '../core/types';
import { toBabylonVec } from './coords';

/**
 * Swapping Y/Z mirrors the geometry and Babylon is left-handed; the two flips cancel,
 * so Blender's counter-clockwise face order is kept as-is.
 * tests/geometry.test.ts verifies normals point outwards against Babylon's own box.
 */
export function buildVertexData(mesh: MeshData): VertexData {
  const positions: number[] = [];
  for (const v of mesh.vertices) positions.push(...toBabylonVec(v));
  const indices: number[] = [];
  for (const face of mesh.faces) {
    // Fan triangulation: fine for convex polygons (what scripts emit).
    for (let i = 1; i < face.length - 1; i++) indices.push(face[0], face[i], face[i + 1]);
  }
  const vd = new VertexData();
  vd.positions = positions;
  vd.indices = indices;
  const normals: number[] = [];
  VertexData.ComputeNormals(positions, indices, normals);
  vd.normals = normals;
  return vd;
}

export interface Bounds {
  min: [number, number, number];
  max: [number, number, number];
}

/** Bounding box in Blender coordinates (used by tests and future auto-framing). */
export function meshBounds(mesh: MeshData): Bounds {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const v of mesh.vertices)
    for (let i = 0; i < 3; i++) {
      min[i] = Math.min(min[i], v[i]);
      max[i] = Math.max(max[i], v[i]);
    }
  return { min, max };
}
