// Primitives as editable polygon meshes with Blender's default topology and sizes
// (2 m cube and plane, 1 m radius sphere / cylinder / cone, UV sphere 32 × 16, torus 48 × 12).

import type { MeshData, PrimitiveParams, PrimitiveType, Vec3 } from '../types';

const TAU = Math.PI * 2;
const r6 = (x: number) => Math.round(x * 1e6) / 1e6 + 0; // tidy coordinates (no -0)

function ring(n: number, r: number, z: number): Vec3[] {
  const out: Vec3[] = [];
  for (let i = 0; i < n; i++) out.push([r6(Math.cos((i / n) * TAU) * r), r6(Math.sin((i / n) * TAU) * r), z]);
  return out;
}

export function primitiveMesh(type: PrimitiveType, p: PrimitiveParams = {}): MeshData {
  switch (type) {
    case 'cube':
      return {
        vertices: [[-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1], [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]],
        faces: [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]],
        smooth: false,
      };
    case 'plane':
      return { vertices: [[-1, -1, 0], [1, -1, 0], [1, 1, 0], [-1, 1, 0]], faces: [[0, 1, 2, 3]], smooth: false };
    case 'cylinder':
    case 'cone': {
      const n = p.segments ?? 32;
      const rb = p.radiusBottom ?? 1;
      const rt = p.radiusTop ?? (type === 'cone' ? 0 : 1);
      const vertices: Vec3[] = [];
      const faces: number[][] = [];
      const bottom = rb > 1e-9;
      const top = rt > 1e-9;
      const b0 = vertices.length;
      if (bottom) vertices.push(...ring(n, rb, -1));
      else vertices.push([0, 0, -1]);
      const t0 = vertices.length;
      if (top) vertices.push(...ring(n, rt, 1));
      else vertices.push([0, 0, 1]);
      const B = (i: number) => (bottom ? b0 + (i % n) : b0);
      const T = (i: number) => (top ? t0 + (i % n) : t0);
      for (let i = 0; i < n; i++) {
        const f = [B(i), B(i + 1), T(i + 1), T(i)];
        faces.push(f.filter((v, k) => f.indexOf(v) === k)); // tri where a ring collapses to a point
      }
      if (bottom) faces.push(Array.from({ length: n }, (_, i) => B(n - i)));
      if (top) faces.push(Array.from({ length: n }, (_, i) => T(i)));
      return { vertices, faces, smooth: false };
    }
    case 'sphere':
      return uvSphere(p.segments ?? 32, Math.max(3, Math.round((p.segments ?? 32) / 2)), 1);
    case 'torus': {
      const n = p.segments ?? 48;
      const m = 12;
      const R = p.majorRadius ?? 1;
      const r = p.minorRadius ?? 0.25;
      const vertices: Vec3[] = [];
      for (let i = 0; i < n; i++) {
        const a = (i / n) * TAU;
        for (let j = 0; j < m; j++) {
          const b = (j / m) * TAU;
          const d = R + r * Math.cos(b);
          vertices.push([r6(d * Math.cos(a)), r6(d * Math.sin(a)), r6(r * Math.sin(b))]);
        }
      }
      const id = (i: number, j: number) => (i % n) * m + (j % m);
      const faces: number[][] = [];
      for (let i = 0; i < n; i++) for (let j = 0; j < m; j++) faces.push([id(i, j), id(i + 1, j), id(i + 1, j + 1), id(i, j + 1)]);
      return { vertices, faces, smooth: false };
    }
    case 'capsule':
      return capsule(p.segments ?? 24, 0.5, 2);
  }
}

/** Blender-style UV sphere: `seg` around, `rings` from pole to pole, triangle fans at the poles. */
export function uvSphere(seg: number, rings: number, radius: number): MeshData {
  const vertices: Vec3[] = [[0, 0, -radius]];
  for (let k = 1; k < rings; k++) {
    const phi = -Math.PI / 2 + (k / rings) * Math.PI;
    vertices.push(...ring(seg, Math.cos(phi) * radius, r6(Math.sin(phi) * radius)));
  }
  vertices.push([0, 0, radius]);
  const top = vertices.length - 1;
  const V = (k: number, i: number) => 1 + (k - 1) * seg + (i % seg);
  const faces: number[][] = [];
  for (let i = 0; i < seg; i++) faces.push([0, V(1, i + 1), V(1, i)]);
  for (let k = 1; k < rings - 1; k++) for (let i = 0; i < seg; i++) faces.push([V(k, i), V(k, i + 1), V(k + 1, i + 1), V(k + 1, i)]);
  for (let i = 0; i < seg; i++) faces.push([V(rings - 1, i), V(rings - 1, i + 1), top]);
  return { vertices, faces, smooth: false };
}

/** Capsule of total height h: hemispheres of radius r joined by a cylinder. */
function capsule(seg: number, r: number, h: number): MeshData {
  const half = Math.max(0, h / 2 - r);
  const rings = 8; // even, so the equator ring exists
  const vertices: Vec3[] = [[0, 0, -r - half]];
  for (let k = 1; k < rings; k++) {
    const phi = -Math.PI / 2 + (k / rings) * Math.PI;
    const z = Math.sin(phi) * r;
    if (k === rings / 2) {
      vertices.push(...ring(seg, r, -half));
      vertices.push(...ring(seg, r, half));
    } else vertices.push(...ring(seg, r6(Math.cos(phi) * r), r6(z + (k < rings / 2 ? -half : half))));
  }
  vertices.push([0, 0, r + half]);
  const ringsTotal = rings; // rings - 1 latitude rings, plus the equator ring twice
  const top = vertices.length - 1;
  const V = (k: number, i: number) => 1 + (k - 1) * seg + (i % seg);
  const faces: number[][] = [];
  for (let i = 0; i < seg; i++) faces.push([0, V(1, i + 1), V(1, i)]);
  for (let k = 1; k < ringsTotal; k++) {
    for (let i = 0; i < seg; i++) faces.push([V(k, i), V(k, i + 1), V(k + 1, i + 1), V(k + 1, i)]);
  }
  for (let i = 0; i < seg; i++) faces.push([V(ringsTotal, i), V(ringsTotal, i + 1), top]);
  return { vertices, faces, smooth: false };
}
