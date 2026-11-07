import { describe, expect, it } from 'vitest';
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData';
import '@babylonjs/core/Meshes/Builders/boxBuilder';
import { buildVertexData } from '../src/engine/geometry';
import type { MeshData } from '../src/core/types';

// Unit cube in Blender coordinates, faces CCW when seen from outside (Blender's convention).
export const CUBE: MeshData = {
  vertices: [[-1,-1,-1],[1,-1,-1],[1,1,-1],[-1,1,-1],[-1,-1,1],[1,-1,1],[1,1,1],[-1,1,1]],
  faces: [[0,3,2,1],[4,5,6,7],[0,1,5,4],[1,2,6,5],[2,3,7,6],[3,0,4,7]],
  smooth: false,
};

describe('custom mesh geometry', () => {
  it('Blender CCW faces end up front-facing with outward normals in Babylon', () => {
    const vd = buildVertexData(CUBE);
    // Babylon's own box is the reference for "front-facing": compare normal at its top face.
    const ref = VertexData.CreateBox({ size: 2 });
    const refNormals: number[] = [];
    VertexData.ComputeNormals(ref.positions!, ref.indices!, refNormals);
    // reference: vertices with y=+1 should have normals with positive y component (outward)
    const refTop = [...Array(ref.positions!.length / 3).keys()].filter((i) => ref.positions![i * 3 + 1] > 0.99);
    const refSign = Math.sign(refTop.reduce((s, i) => s + refNormals[i * 3 + 1], 0));
    // our cube: Blender top (z=+1) becomes Babylon y=+1
    const top = [4, 5, 6, 7];
    const ourSign = Math.sign(top.reduce((s, i) => s + vd.normals![i * 3 + 1], 0));
    expect(refSign).toBe(1);
    expect(ourSign).toBe(refSign);
  });

  it('box-projects UVs in metres so textures repeat at real-world scale', () => {
    const vd = buildVertexData({ vertices: [[0,0,0],[3,0,0],[3,2,0],[0,2,0]], faces: [[0,1,2,3]], smooth: true });
    expect(vd.uvs).toEqual([0,0, 3,0, 3,2, 0,2]); // floor quad: UV = (x, y)
  });

  it('fan-triangulates polygons', () => {
    const vd = buildVertexData({ vertices: [[0,0,0],[1,0,0],[1,1,0],[0.5,1.5,0],[0,1,0]], faces: [[0,1,2,3,4]], smooth: true });
    expect(vd.indices).toEqual([0,1,2, 0,2,3, 0,3,4]);
  });
});
