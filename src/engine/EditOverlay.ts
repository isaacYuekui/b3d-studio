// Edit-mode display and hit testing: vertex dots, edge wires and selected-face tint drawn
// over the edited mesh, plus screen-space picking with occlusion against the cage.

import type { Scene } from '@babylonjs/core/scene';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData';
import type { LinesMesh } from '@babylonjs/core/Meshes/linesMesh';
import type { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { Color3, Color4 } from '@babylonjs/core/Maths/math.color';
import { Matrix, Vector3 } from '@babylonjs/core/Maths/math.vector';
import type { Camera } from '@babylonjs/core/Cameras/camera';
import type { MeshData } from '../core/types';
import type { MeshSelection, SelectMode } from '../core/mesh/select';
import { ekParse, edgeMap, triangulate } from '../core/mesh/topology';
import { toBabylonVec } from './coords';

const SEL = new Color4(1, 0.63, 0.1, 1);
const WIRE = new Color4(0.02, 0.02, 0.02, 1);
const VERT = new Color4(0.02, 0.02, 0.02, 1);

export type Hit = number | string | null;

export class EditOverlay {
  private edges: LinesMesh | null = null;
  private verts: Mesh | null = null;
  private faces: Mesh | null = null;
  private vertMat: StandardMaterial;
  private faceMat: StandardMaterial;
  private tris: { t: [number, number, number]; f: number }[] = [];
  private trisFor: MeshData | null = null;

  constructor(private scene: Scene) {
    const vm = (this.vertMat = new StandardMaterial('edit-verts', scene));
    vm.disableLighting = true;
    vm.emissiveColor = Color3.White();
    vm.pointsCloud = true;
    vm.backFaceCulling = false;
    const fm = (this.faceMat = new StandardMaterial('edit-faces', scene));
    fm.disableLighting = true;
    fm.emissiveColor = new Color3(1, 0.55, 0.1);
    fm.alpha = 0.28;
    fm.backFaceCulling = false;
  }

  /** Rebuild the overlay for a mesh and selection, parented to the object's node. */
  update(parent: TransformNode, mesh: MeshData, mode: SelectMode, sel: MeshSelection, xray: boolean, pointPx: number) {
    this.clear();
    const s = this.scene;
    const P = mesh.vertices.map((v) => new Vector3(...toBabylonVec(v)));
    const group = xray ? 1 : 0;

    // Edges
    const selEdges = new Set(sel.edges);
    const lines: Vector3[][] = [];
    const colors: Color4[][] = [];
    for (const k of edgeMap(mesh).keys()) {
      const [a, b] = ekParse(k);
      lines.push([P[a], P[b]]);
      const c = selEdges.has(k) ? SEL : WIRE;
      colors.push([c, c]);
    }
    // Curves have points only: draw the control polygon through them.
    if (!mesh.faces.length)
      for (let i = 0; i + 1 < P.length; i++) {
        lines.push([P[i], P[i + 1]]);
        colors.push([WIRE, WIRE]);
      }
    if (lines.length) {
      const e = (this.edges = MeshBuilder.CreateLineSystem('edit-edges', { lines, colors, useVertexAlpha: false }, s));
      e.isPickable = false;
      e.parent = parent;
      e.renderingGroupId = group;
      e.alwaysSelectAsActiveMesh = true;
    }

    // Vertices (vertex mode only, like Blender)
    if (mode === 'vert' && P.length) {
      const sv = new Set(sel.verts);
      const v = (this.verts = new Mesh('edit-verts', s));
      const vd = new VertexData();
      vd.positions = P.flatMap((p) => [p.x, p.y, p.z]);
      vd.indices = P.map((_, i) => i);
      vd.colors = P.flatMap((_, i) => {
        const c = sv.has(i) ? SEL : VERT;
        return [c.r, c.g, c.b, 1];
      });
      vd.applyToMesh(v);
      v.material = this.vertMat;
      this.vertMat.pointSize = pointPx;
      v.isPickable = false;
      v.parent = parent;
      v.renderingGroupId = group;
      v.alwaysSelectAsActiveMesh = true;
    }

    // Selected faces tint
    if (sel.faces.length) {
      const pos: number[] = [];
      const idx: number[] = [];
      for (const f of sel.faces) {
        for (const t of triangulate(mesh.vertices, mesh.faces[f])) {
          const base = pos.length / 3;
          for (const v of t) pos.push(P[v].x, P[v].y, P[v].z);
          idx.push(base, base + 1, base + 2);
        }
      }
      const fm = (this.faces = new Mesh('edit-faces', s));
      const vd = new VertexData();
      vd.positions = pos;
      vd.indices = idx;
      vd.applyToMesh(fm);
      fm.material = this.faceMat;
      fm.isPickable = false;
      fm.parent = parent;
      fm.renderingGroupId = group;
      fm.alwaysSelectAsActiveMesh = true;
    }
  }

  clear() {
    this.edges?.dispose();
    this.verts?.dispose(false, false);
    this.faces?.dispose(false, false);
    this.edges = this.verts = this.faces = null;
  }

  dispose() {
    this.clear();
    this.vertMat.dispose();
    this.faceMat.dispose();
  }

  // ---------------------------------------------------------------- hit testing

  private triangles(mesh: MeshData) {
    if (this.trisFor !== mesh) {
      this.tris = [];
      mesh.faces.forEach((face, f) => triangulate(mesh.vertices, face).forEach((t) => this.tris.push({ t: t as [number, number, number], f })));
      this.trisFor = mesh;
    }
    return this.tris;
  }

  /** Nearest face hit by a local-space ray (origin o, direction d), with its ray parameter. */
  private rayFaces(mesh: MeshData, o: Vector3, d: Vector3): { f: number; t: number } | null {
    let best: { f: number; t: number } | null = null;
    const V = mesh.vertices;
    for (const { t: [a, b, c], f } of this.triangles(mesh)) {
      const t = rayTri(o, d, bv(V[a]), bv(V[b]), bv(V[c]));
      if (t !== null && t > 1e-6 && (!best || t < best.t)) best = { f, t };
    }
    return best;
  }

  /** Is the local point visible from the camera (nothing of the cage in front of it)? */
  private visible(mesh: MeshData, camLocal: Vector3, p: Vector3): boolean {
    const d = p.subtract(camLocal);
    const hit = this.rayFaces(mesh, camLocal, d);
    return !hit || hit.t > 0.995;
  }

  /**
   * Find the element under a screen point (CSS pixels relative to the canvas). `world` is
   * the object's world matrix; `radius` the pick radius in CSS pixels.
   */
  pick(mesh: MeshData, mode: SelectMode, world: Matrix, camera: Camera, x: number, y: number, radius: number, xray: boolean): Hit {
    const scene = this.scene;
    const inv = world.clone().invert();
    const camLocal = Vector3.TransformCoordinates(camera.globalPosition, inv);
    if (mode === 'face') {
      const ray = scene.createPickingRay(x, y, Matrix.Identity(), camera);
      const o = Vector3.TransformCoordinates(ray.origin, inv);
      const d = Vector3.TransformNormal(ray.direction, inv);
      return this.rayFaces(mesh, o, d)?.f ?? null;
    }
    const proj = this.projector(world, camera);
    const P = mesh.vertices.map(bv);
    const cands: { el: number | string; d: number; at: Vector3 }[] = [];
    if (mode === 'vert') {
      P.forEach((p, i) => {
        const s = proj(p);
        if (!s) return;
        const dd = Math.hypot(s.x - x, s.y - y);
        if (dd <= radius) cands.push({ el: i, d: dd, at: p });
      });
    } else {
      for (const k of edgeMap(mesh).keys()) {
        const [a, b] = ekParse(k);
        const sa = proj(P[a]), sb = proj(P[b]);
        if (!sa || !sb) continue;
        const { d: dd, t } = segDist(x, y, sa.x, sa.y, sb.x, sb.y);
        if (dd <= radius) cands.push({ el: k, d: dd, at: Vector3.Lerp(P[a], P[b], Math.min(0.9, Math.max(0.1, t))) });
      }
    }
    cands.sort((p, q) => p.d - q.d);
    for (const c of cands.slice(0, 12)) if (xray || this.visible(mesh, camLocal, c.at)) return c.el;
    return null;
  }

  /** Elements whose screen position falls inside a rectangle (CSS pixels relative to the canvas). */
  boxSelect(mesh: MeshData, mode: SelectMode, world: Matrix, camera: Camera, rect: { x0: number; y0: number; x1: number; y1: number }, xray: boolean): (number | string)[] {
    const inv = world.clone().invert();
    const camLocal = Vector3.TransformCoordinates(camera.globalPosition, inv);
    const proj = this.projector(world, camera);
    const inside = (p: Vector3) => {
      const s = proj(p);
      return !!s && s.x >= rect.x0 && s.x <= rect.x1 && s.y >= rect.y0 && s.y <= rect.y1;
    };
    const P = mesh.vertices.map(bv);
    const cost = (n: number) => n * mesh.faces.length;
    const out: (number | string)[] = [];
    const vis = (p: Vector3, n: number) => xray || cost(n) > 4e7 || this.visible(mesh, camLocal, p);
    if (mode === 'vert') {
      const hits = P.map((p, i) => [p, i] as const).filter(([p]) => inside(p));
      for (const [p, i] of hits) if (vis(p, hits.length)) out.push(i);
    } else if (mode === 'edge') {
      const hits: [Vector3, string][] = [];
      for (const k of edgeMap(mesh).keys()) {
        const [a, b] = ekParse(k);
        if (inside(P[a]) && inside(P[b])) hits.push([Vector3.Lerp(P[a], P[b], 0.5), k]);
      }
      for (const [p, k] of hits) if (vis(p, hits.length)) out.push(k);
    } else {
      const hits: [Vector3, number][] = [];
      mesh.faces.forEach((f, i) => {
        const c = f.reduce((s, v) => s.addInPlace(P[v]), Vector3.Zero()).scaleInPlace(1 / f.length);
        if (inside(c)) hits.push([c, i]);
      });
      for (const [p, i] of hits) if (vis(p, hits.length)) out.push(i);
    }
    return out;
  }

  /** Local point → screen (CSS pixels), or null when behind the camera. */
  private projector(world: Matrix, camera: Camera) {
    const engine = this.scene.getEngine();
    const k = engine.getHardwareScalingLevel(); // render px × k = CSS px
    const w = engine.getRenderWidth(), h = engine.getRenderHeight();
    const vp = camera.viewport.toGlobal(w, h);
    const view = camera.getViewMatrix();
    const near = camera.minZ;
    const tm = this.scene.getTransformMatrix();
    return (p: Vector3) => {
      const wp = Vector3.TransformCoordinates(p, world);
      if (Vector3.TransformCoordinates(wp, view).z < near) return null;
      const s = Vector3.Project(p, world, tm, vp);
      return { x: s.x * k, y: s.y * k };
    };
  }
}

const bv = (v: [number, number, number]) => new Vector3(...toBabylonVec(v));

function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const dx = bx - ax, dy = by - ay;
  const L = dx * dx + dy * dy;
  const t = L ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L)) : 0;
  return { d: Math.hypot(px - (ax + t * dx), py - (ay + t * dy)), t };
}

/** Möller–Trumbore; returns the ray parameter or null. Double-sided. */
function rayTri(o: Vector3, d: Vector3, a: Vector3, b: Vector3, c: Vector3): number | null {
  const e1 = b.subtract(a), e2 = c.subtract(a);
  const p = Vector3.Cross(d, e2);
  const det = Vector3.Dot(e1, p);
  if (Math.abs(det) < 1e-12) return null;
  const inv = 1 / det;
  const s = o.subtract(a);
  const u = Vector3.Dot(s, p) * inv;
  if (u < -1e-7 || u > 1 + 1e-7) return null;
  const q = Vector3.Cross(s, e1);
  const v = Vector3.Dot(d, q) * inv;
  if (v < -1e-7 || u + v > 1 + 1e-7) return null;
  return Vector3.Dot(e2, q) * inv;
}

