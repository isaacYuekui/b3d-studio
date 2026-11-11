import { describe, expect, it } from 'vitest';
import { brushStep, strokeContext } from '../src/core/mesh/sculpt';
import type { MeshData } from '../src/core/types';

/** Flat 2 × 2 m grid at z = 0, 0.0625 m spacing. */
const grid = (n = 32): MeshData => {
  const vertices: [number, number, number][] = [];
  const faces: number[][] = [];
  for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) vertices.push([-1 + (2 * i) / n, -1 + (2 * j) / n, 0]);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) faces.push([j * (n + 1) + i, j * (n + 1) + i + 1, (j + 1) * (n + 1) + i + 1, (j + 1) * (n + 1) + i]);
  return { vertices, faces, smooth: true };
};
const maxZ = (vs: number[][]) => Math.max(...vs.map((v) => v[2]));

describe('sculpt brushes', () => {
  it('Draw raises a bump under the brush only; Invert digs in', () => {
    const m = grid();
    const ctx = strokeContext(m);
    const up = brushStep(m.vertices, m.faces, ctx, { brush: 'draw', center: [0, 0, 0], radius: 0.4, strength: 1 });
    expect(maxZ(up)).toBeGreaterThan(0.02);
    // outside the radius nothing moves
    up.forEach((v, i) => { if (Math.hypot(m.vertices[i][0], m.vertices[i][1]) > 0.41) expect(v).toEqual(m.vertices[i]); });
    const down = brushStep(m.vertices, m.faces, ctx, { brush: 'draw', center: [0, 0, 0], radius: 0.4, strength: 1, invert: true });
    expect(Math.min(...down.map((v) => v[2]))).toBeLessThan(-0.02);
  });

  it('X symmetry makes the same bump on the other side', () => {
    const m = grid();
    const ctx = strokeContext(m);
    const v = brushStep(m.vertices, m.faces, ctx, { brush: 'draw', center: [0.5, 0.2, 0], radius: 0.3, strength: 1, symmetryX: true });
    const at = (x: number, y: number) => v[m.vertices.findIndex((p) => Math.abs(p[0] - x) < 1e-6 && Math.abs(p[1] - y) < 1e-6)][2];
    expect(at(0.5, 0.25)).toBeGreaterThan(0.01);
    expect(at(-0.5, 0.25)).toBeCloseTo(at(0.5, 0.25), 5);
  });

  it('Smooth flattens a spike; Grab drags the area with the brush', () => {
    const m = grid();
    const ctx = strokeContext(m);
    const spiky = m.vertices.map((p) => (Math.hypot(p[0], p[1]) < 0.01 ? [p[0], p[1], 0.5] : p)) as [number, number, number][];
    const s = brushStep(spiky, m.faces, ctx, { brush: 'smooth', center: [0, 0, 0.4], radius: 0.6, strength: 1 });
    expect(maxZ(s)).toBeLessThan(0.3);
    const g = brushStep(m.vertices, m.faces, ctx, { brush: 'grab', center: [0, 0, 0], radius: 0.5, strength: 1, grabStart: [0, 0, 0], grabDelta: [0, 0, 0.4] });
    expect(maxZ(g)).toBeCloseTo(0.4, 5);
  });

  it('Flatten pulls a bumpy area towards its average plane', () => {
    const m = grid();
    const ctx = strokeContext(m);
    const bumpy = m.vertices.map((p) => [p[0], p[1], 0.05 * Math.sin(p[0] * 20) * Math.cos(p[1] * 20)]) as [number, number, number][];
    let v = bumpy;
    for (let k = 0; k < 10; k++) v = brushStep(v, m.faces, ctx, { brush: 'flatten', center: [0, 0, 0], radius: 0.5, strength: 1 });
    const spread = (vs: number[][]) => Math.max(...vs.filter((p) => Math.hypot(p[0], p[1]) < 0.15).map((p) => Math.abs(p[2])));
    expect(spread(v)).toBeLessThan(spread(bumpy) * 0.5);
  });
});
