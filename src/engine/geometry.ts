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
  vd.uvs = boxUVs(mesh, normals);
  return vd;
}

/**
 * Box-projected UVs in metres: each vertex is projected on the axis plane its normal
 * faces most. A texture with textureScale 1 then repeats once per metre on walls,
 * floors and props alike, with no unwrapping needed.
 */
export function boxUVs(mesh: MeshData, babylonNormals: number[]): number[] {
  const uvs: number[] = [];
  mesh.vertices.forEach(([x, y, z], i) => {
    // Babylon normal (x, y, z) = Blender (x, z, y)
    const nx = Math.abs(babylonNormals[i * 3]);
    const nz = Math.abs(babylonNormals[i * 3 + 1]);
    const ny = Math.abs(babylonNormals[i * 3 + 2]);
    if (nz >= nx && nz >= ny) uvs.push(x, y);
    else if (nx >= ny) uvs.push(y, z);
    else uvs.push(x, z);
  });
  return uvs;
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
