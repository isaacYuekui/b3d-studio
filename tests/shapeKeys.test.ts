import { describe, expect, it } from 'vitest';
import { applyCommand, validateCommand, validateSceneDoc } from '../src/core/commands';
import { createDefaultDoc } from '../src/core/store';
import { mixShapes, shapedMesh, shapeValuesAt } from '../src/core/shapeKeys';
import { evaluateValue } from '../src/core/animation';
import type { SceneDoc, Vec3 } from '../src/core/types';

let n = 0;
const gen = () => `id${++n}`;
const emptyDoc = (): SceneDoc => { const d = createDefaultDoc(); return applyCommand(d, validateCommand({ type: 'delete', ids: [...d.order] })).doc; };
const run = (doc: SceneDoc, ...cmds: unknown[]) => cmds.reduce<SceneDoc>((d, c) => applyCommand(d, validateCommand(c), gen).doc, doc);

const quad = { vertices: [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]] as Vec3[], faces: [[0, 1, 2, 3]] };

describe('shape keys', () => {
  it('first add makes the Basis, the next a key that becomes active', () => {
    let d = run(emptyDoc(), { type: 'add', primitive: 'mesh', id: 'q', mesh: quad });
    d = run(d, { type: 'addShapeKey', id: 'q' });
    expect(d.objects.q.shapeKeys!.keys.map((k) => k.name)).toEqual(['Basis']);
    d = run(d, { type: 'addShapeKey', id: 'q', name: 'Lift' });
    expect(d.objects.q.shapeKeys!.active).toBe(1);
    expect(d.objects.q.shapeKeys!.keys[1].name).toBe('Lift');
  });

  it('edits go into the active key; the Basis stays; the mix follows the value', () => {
    let d = run(emptyDoc(), { type: 'add', primitive: 'mesh', id: 'q', mesh: quad }, { type: 'addShapeKey', id: 'q' }, { type: 'addShapeKey', id: 'q', name: 'Lift' });
    d = run(d, { type: 'editMesh', id: 'q', steps: [{ op: 'move', select: { mode: 'vert', indices: [2] }, by: [0, 0, 1] }] });
    const sk = d.objects.q.shapeKeys!;
    expect(sk.keys[1].verts[2]).toEqual([1, 1, 1]);
    expect(sk.keys[0].verts[2]).toEqual([1, 1, 0]);
    d = run(d, { type: 'setShapeKey', id: 'q', index: 1, value: 0.5 });
    expect(mixShapes(d.objects.q.shapeKeys!)[2]).toEqual([1, 1, 0.5]);
    // Back to the Basis: the mesh shows it again.
    d = run(d, { type: 'setActiveShapeKey', id: 'q', index: 0 });
    expect(d.objects.q.mesh!.vertices[2]).toEqual([1, 1, 0]);
  });

  it('moving the Basis carries the other keys along', () => {
    let d = run(emptyDoc(), { type: 'add', primitive: 'mesh', id: 'q', mesh: quad }, { type: 'addShapeKey', id: 'q' }, { type: 'addShapeKey', id: 'q', name: 'Lift' });
    d = run(d, { type: 'editMesh', id: 'q', steps: [{ op: 'move', select: { mode: 'vert', indices: [2] }, by: [0, 0, 1] }] }, { type: 'setActiveShapeKey', id: 'q', index: 0 });
    d = run(d, { type: 'editMesh', id: 'q', steps: [{ op: 'move', select: { mode: 'vert' }, by: [2, 0, 0] }] });
    expect(d.objects.q.shapeKeys!.keys[1].verts[2]).toEqual([3, 1, 1]);
  });

  it('adding geometry needs the Basis', () => {
    let d = run(emptyDoc(), { type: 'add', primitive: 'mesh', id: 'q', mesh: quad }, { type: 'addShapeKey', id: 'q' }, { type: 'addShapeKey', id: 'q', name: 'Lift' });
    expect(() => run(d, { type: 'editMesh', id: 'q', steps: [{ op: 'extrude', select: { mode: 'face', indices: [0] }, offset: 1 }] })).toThrow(/Basis/);
    d = run(d, { type: 'setActiveShapeKey', id: 'q', index: 0 }, { type: 'editMesh', id: 'q', steps: [{ op: 'extrude', select: { mode: 'face', indices: [0] }, offset: 1 }] });
    const sk = d.objects.q.shapeKeys!;
    expect(sk.keys[1].verts.length).toBe(d.objects.q.mesh!.vertices.length);
  });

  it('values animate with keyframes; rename and remove keep the tracks tidy', () => {
    let d = run(emptyDoc(), { type: 'add', primitive: 'mesh', id: 'q', mesh: quad }, { type: 'addShapeKey', id: 'q' }, { type: 'addShapeKey', id: 'q', name: 'Lift' });
    d = run(d, { type: 'keyShape', id: 'q', key: 'Lift', frame: 1, value: 0 }, { type: 'keyShape', id: 'q', key: 'Lift', frame: 11, value: 1, easing: 'linear' });
    const v = shapeValuesAt(d.objects.q.shapeKeys!, d.animation!.shapes!.q, 6, evaluateValue);
    expect(v[1]).toBeCloseTo(0.5);
    expect(d.objects.q.mesh && shapedMesh(d.objects.q.mesh, d.objects.q.shapeKeys, v).vertices.length).toBe(4);
    d = run(d, { type: 'setShapeKey', id: 'q', index: 1, name: 'Up' });
    expect(Object.keys(d.animation!.shapes!.q)).toEqual(['Up']);
    d = run(d, { type: 'removeShapeKey', id: 'q', index: 1 });
    expect(d.objects.q.shapeKeys).toBeUndefined();
    expect(d.animation!.shapes?.q).toBeUndefined();
  });

  it('round-trips through a saved project', () => {
    let d = run(emptyDoc(), { type: 'add', primitive: 'mesh', id: 'q', mesh: quad }, { type: 'addShapeKey', id: 'q' }, { type: 'addShapeKey', id: 'q', name: 'Lift' }, { type: 'keyShape', id: 'q', key: 'Lift', frame: 5, value: 1 });
    const back = validateSceneDoc(JSON.parse(JSON.stringify(d)));
    expect(back.objects.q.shapeKeys).toEqual(d.objects.q.shapeKeys);
    expect(back.animation!.shapes).toEqual(d.animation!.shapes);
  });
});

describe('shape keys script example (docs/SCRIPTS.md)', () => {
  it('squash ball runs', () => {
    const d = run(emptyDoc(), { type: 'batch', commands: [
      { type: 'add', primitive: 'sphere', id: 'ball' },
      { type: 'addShapeKey', id: 'ball' },
      { type: 'addShapeKey', id: 'ball', name: 'Squash' },
      { type: 'editMesh', id: 'ball', steps: [{ op: 'scale', select: { mode: 'vert' }, by: [1.3, 1.3, 0.6] }] },
      { type: 'setActiveShapeKey', id: 'ball', index: 0 },
      { type: 'keyShape', id: 'ball', key: 'Squash', frame: 1, value: 0 },
      { type: 'keyShape', id: 'ball', key: 'Squash', frame: 12, value: 1 },
    ] });
    const sk = d.objects.ball.shapeKeys!;
    expect(Math.max(...sk.keys[1].verts.map((v) => v[2]))).toBeCloseTo(0.6, 2);
    expect(Math.max(...d.objects.ball.mesh!.vertices.map((v) => v[2]))).toBeCloseTo(1, 2);
  });
});
