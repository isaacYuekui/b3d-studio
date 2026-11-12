// Weight Paint display: the mesh drawn with its active vertex group as colours (blue 0 → red 1),
// like Blender's Weight Paint mode. A separate mesh parented to the object, so the object's own
// materials are left alone; positions are the mesh's rest shape (what the brush paints).

import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { Color3 } from '@babylonjs/core/Maths/math.color';
import type { Scene } from '@babylonjs/core/scene';
import type { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import { triangulate } from '../core/mesh/topology';
import { weightColor } from '../core/vertexGroups';
import type { MeshData } from '../core/types';
import { toBabylonVec } from './coords';

export class WeightView {
  private mesh: Mesh | null = null;
  private mat: StandardMaterial | null = null;
  private faces: unknown = null;
  private verts: unknown = null;

  constructor(private scene: Scene) {}

  /** Show `weights` on `data` under `parent` (null weights: all blue). */
  show(parent: TransformNode, data: MeshData, weights: number[] | null) {
    if (!this.mat) {
      this.mat = new StandardMaterial('weight-view', this.scene);
      this.mat.diffuseColor = new Color3(0.85, 0.85, 0.85);
      this.mat.specularColor = new Color3(0.05, 0.05, 0.05);
      this.mat.emissiveColor = new Color3(0.3, 0.3, 0.3);
      this.mat.backFaceCulling = false;
    }
    const rebuild = !this.mesh || this.mesh.parent !== parent || this.faces !== data.faces || this.verts !== data.vertices;
    const colors = new Float32Array(data.vertices.length * 4);
    for (let i = 0; i < data.vertices.length; i++) {
      const c = weightColor(weights?.[i] ?? 0);
      colors.set([c[0], c[1], c[2], 1], i * 4);
    }
    if (rebuild) {
      this.mesh?.dispose();
      const m = new Mesh('weight-view', this.scene);
      const positions: number[] = [];
      for (const v of data.vertices) positions.push(...toBabylonVec(v));
      const indices: number[] = [];
      for (const f of data.faces) for (const t of triangulate(data.vertices, f)) indices.push(...t);
      const normals: number[] = [];
      VertexData.ComputeNormals(positions, indices, normals);
      const vd = new VertexData();
      vd.positions = positions;
      vd.indices = indices;
      vd.normals = normals;
      vd.colors = colors;
      vd.applyToMesh(m, true);
      m.material = this.mat;
      m.parent = parent;
      m.isPickable = true;
      m.metadata = { weightView: true };
      this.mesh = m;
      this.faces = data.faces;
      this.verts = data.vertices;
    } else {
      this.mesh!.updateVerticesData('color', colors, false, false);
    }
  }

  /** The display mesh (for brush picking). */
  get node(): Mesh | null {
    return this.mesh;
  }

  hide() {
    this.mesh?.dispose();
    this.mesh = null;
    this.faces = this.verts = null;
  }
}
