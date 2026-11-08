import { describe, expect, it } from 'vitest';
import { applyCommand, validateCommand } from '../src/core/commands';
import { createDefaultDoc } from '../src/core/store';
import { isWatertight, signedVolume } from '../src/core/mesh/topology';
import { primitiveMesh } from '../src/core/mesh/primitives';
import { runEditSteps, runQuery, softTransform } from '../src/core/mesh/script';
import { EMPTY_SEL } from '../src/core/mesh/select';

let n = 0;
const ids = () => `s${n++}`;

describe('editMesh scripted modelling', () => {
  it('models a mug: inset the top, push it down, bevel the rim', () => {
    const doc = applyCommand({ objects: {}, order: [] }, { type: 'add', primitive: 'cylinder', id: 'mug' }, ids).doc;
    const cmd = validateCommand({
      type: 'editMesh',
      id: 'mug',
      steps: [
        { op: 'inset', select: { normal: [0, 0, 1] }, thickness: 0.12 },
        { op: 'extrude', select: { last: true }, offset: -1.7 },
        { op: 'bevel', select: { mode: 'edge', box: { min: [-2, -2, 0.99], max: [2, 2, 1.01] } }, width: 0.03, segments: 2 },
        { op: 'smooth' },
      ],
    });
    const out = applyCommand(doc, cmd, ids).doc.objects.mug;
    expect(out.type).toBe('mesh');
    expect(isWatertight(out.mesh!)).toBe(true);
    expect(out.mesh!.smooth).toBe(true);
    const vol = signedVolume(out.mesh!);
    expect(vol).toBeGreaterThan(0);
    expect(vol).toBeLessThan(Math.PI * 2 * 0.6); // hollow: far less than the solid cylinder (2π)
  });

  it('queries: normal, box, sharp edges, nearest, loop', () => {
    const cube = primitiveMesh('cube');
    expect(runQuery(cube, { normal: [0, 0, 1] }, 'face', EMPTY_SEL).faces.length).toBe(1);
    expect(runQuery(cube, { box: { min: [-2, -2, 0.5], max: [2, 2, 2] } }, 'vert', EMPTY_SEL).verts.length).toBe(4);
    expect(runQuery(cube, { sharp: 30 }, 'edge', EMPTY_SEL).edges.length).toBe(12);
    expect(runQuery(cube, { nearest: [1, 1, 1] }, 'vert', EMPTY_SEL).verts.length).toBe(1);
    const sphere = primitiveMesh('sphere');
    const eq = runQuery(sphere, { nearest: [1, 0.1, 0], loop: true }, 'edge', EMPTY_SEL);
    expect(eq.edges.length).toBe(32);
  });

  it('proportional move pulls neighbours with a falloff', () => {
    const plane = runEditSteps(primitiveMesh('plane'), [{ op: 'subdivide', select: { all: true, mode: 'face' } }, { op: 'subdivide', select: { all: true, mode: 'face' } }]);
    const centre = plane.vertices.findIndex((v) => Math.abs(v[0]) < 1e-9 && Math.abs(v[1]) < 1e-9);
    const out = softTransform(plane, [centre], (p) => [p[0], p[1], p[2] + 1], 1.2);
    const zs = out.vertices.map((v) => v[2]);
    expect(Math.max(...zs)).toBeCloseTo(1);
    expect(zs.filter((z) => z > 0 && z < 1).length).toBeGreaterThan(4);
    expect(zs.filter((z) => z === 0).length).toBeGreaterThan(0);
  });

  it('move / scale / rotate selections', () => {
    const m = runEditSteps(primitiveMesh('cube'), [
      { op: 'scale', select: { normal: [0, 0, 1] }, by: 0.5 },
      { op: 'rotate', select: { last: true }, by: [0, 0, 45] },
      { op: 'move', select: { last: true }, by: [0, 0, 1] },
    ]);
    const top = m.vertices.filter((v) => v[2] > 1.5);
    expect(top.length).toBe(4);
    top.forEach((v) => expect(Math.hypot(v[0], v[1])).toBeCloseTo(Math.SQRT2 * 0.5));
    expect(isWatertight(m)).toBe(true);
  });

  it('reports the failing step clearly and rejects bad input', () => {
    const doc = createDefaultDoc(ids);
    const id = doc.order[0];
    expect(() => applyCommand(doc, validateCommand({ type: 'editMesh', id, steps: [{ op: 'extrude', select: { normal: [0, 0, -1], angle: 1 } }, { op: 'loopcut', select: { mode: 'edge', box: { min: [5, 5, 5], max: [6, 6, 6] } } }] }))).toThrow(/step 2 \(loopcut\).*empty/);
    expect(() => validateCommand({ type: 'editMesh', id, steps: [{ op: 'explode' }] })).toThrow(/op must be/);
    expect(() => validateCommand({ type: 'editMesh', id, steps: [{ op: 'bevel', select: { wat: 1 } }] })).toThrow(/unknown select field/);
    expect(() => validateCommand({ type: 'editMesh', id, steps: [{ op: 'loopcut', cuts: 99 }] })).toThrow(/cuts/);
  });
});
