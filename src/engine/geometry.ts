// Converts scene MeshData (Blender coordinates, CCW polygons) into Babylon vertex data.
// Kept free of scene/engine state so it can be unit-tested in Node.

import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData';
import type { MeshData, Vec3 } from '../core/types';
import { faceNormal, triangulate } from '../core/mesh/topology';
import { toBabylonVec } from './coords';

/**
 * Swapping Y/Z mirrors the geometry and Babylon is left-handed; the two flips cancel,
 * so Blender's counter-clockwise face order is kept as-is.
 * tests/geometry.test.ts verifies normals point outwards against Babylon's own box.
 *
 * Smooth meshes share vertices (averaged normals); flat meshes get their own vertices per
 * face with the face normal. Concave polygons are ear-clipped.
 */
export function buildVertexData(mesh: MeshData): VertexData {
  const positions: number[] = [];
  const indices: number[] = [];
  const vd = new VertexData();
  if (mesh.smooth) {
    for (const v of mesh.vertices) positions.push(...toBabylonVec(v));
    for (const face of mesh.faces) for (const t of triangulate(mesh.vertices, face)) indices.push(...t);
    const normals: number[] = [];
    VertexData.ComputeNormals(positions, indices, normals);
    vd.positions = positions;
    vd.indices = indices;
    vd.normals = normals;
    vd.uvs = boxUVs(mesh, normals);
    return vd;
  }
  const normals: number[] = [];
  const uvs: number[] = [];
  for (const face of mesh.faces) {
    const n = faceNormal(mesh.vertices, face);
    const bn = toBabylonVec(n);
    const base = positions.length / 3;
    const local = new Map<number, number>();
    face.forEach((v, i) => {
      local.set(v, base + i);
      const p = mesh.vertices[v];
      positions.push(...toBabylonVec(p));
      normals.push(...bn);
      const o = mesh.uvOffset;
      uvs.push(...boxUV(o ? [p[0] + o[0], p[1] + o[1], p[2] + o[2]] : p, n));
    });
    for (const t of triangulate(mesh.vertices, face)) indices.push(local.get(t[0])!, local.get(t[1])!, local.get(t[2])!);
  }
  vd.positions = positions;
  vd.indices = indices;
  vd.normals = normals;
  vd.uvs = uvs;
  return vd;
}

/** Box-projected UV for one point with a (Blender-space) normal. */
function boxUV([x, y, z]: Vec3, [nx, ny, nz]: Vec3): [number, number] {
  const ax = Math.abs(nx), ay = Math.abs(ny), az = Math.abs(nz);
  if (az >= ax && az >= ay) return [x, y];
  if (ax >= ay) return [y, z];
  return [x, z];
}

/**
 * Box-projected UVs in metres: each vertex is projected on the axis plane its normal
 * faces most. A texture with textureScale 1 then repeats once per metre on walls,
 * floors and props alike, with no unwrapping needed.
 */
export function boxUVs(mesh: MeshData, babylonNormals: number[]): number[] {
  const uvs: number[] = [];
  const [ox, oy, oz] = mesh.uvOffset ?? [0, 0, 0];
  mesh.vertices.forEach(([x0, y0, z0], i) => {
    const x = x0 + ox, y = y0 + oy, z = z0 + oz;
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
