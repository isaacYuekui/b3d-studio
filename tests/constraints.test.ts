import { describe, expect, it } from 'vitest';
import { applyCommand, validateCommand, validateSceneDoc } from '../src/core/commands';
import { transformAt, worldAt } from '../src/core/animation';
import { eulerFromColumns, eulerMatrix, invert4, mul4, trackRotation, trsMatrix } from '../src/core/constraints';
import type { SceneDoc, Vec3 } from '../src/core/types';

const ids = (() => { let n = 0; return () => `k${n++}`; })();
const run = (doc: SceneDoc, ...cmds: unknown[]) => cmds.reduce<SceneDoc>((d, c) => applyCommand(d, validateCommand(c), ids).doc, doc);
const close = (a: number[], b: number[], eps = 1e-3) => a.forEach((x, i) => expect(Math.abs(x - b[i])).toBeLessThan(eps));
const colsOf = (e: Vec3) => { const m = eulerMatrix(e); return [0, 1, 2].map((c) => [m[c], m[4 + c], m[8 + c]]); };
const scene = () => run({ objects: {}, order: [] },
  { type: 'add', primitive: 'cube', id: 'a', transform: { position: [0, 0, 0] } },
  { type: 'add', primitive: 'sphere', id: 't', transform: { position: [3, 0, 0] } });

describe('constraints', () => {
  it('maths: euler round trip, inverse, track rotation', () => {
    for (const e of [[10, 20, 30], [-45, 80, 170], [0, -30, 90]] as Vec3[]) {
      const m = eulerMatrix(e);
      close(eulerFromColumns([0, 1, 2].map((c) => [m[c], m[4 + c], m[8 + c]]) as never), e, 1e-2);
    }
    const m = trsMatrix({ position: [1, 2, 3], rotation: [10, 20, 30], scale: [2, 1, 0.5] });
    close(mul4(m, invert4(m)), [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    const r = trackRotation([1, 0, 0], 'Y')!;
    close(r[1], [1, 0, 0]);
    close(r[2], [0, 0, 1]);
    const cam = trackRotation([0, 1, 0], '-Z')!;
    close(cam[2], [0, -1, 0]);
    close(cam[1], [0, 0, 1]);
  });

  it('Track To points the +Y axis at the target and follows it', () => {
    let doc = run(scene(), { type: 'addConstraint', id: 'a', constraint: { type: 'trackTo', target: 't' } });
    let t = transformAt(doc, 'a', 1)!;
    close(colsOf(t.rotation)[1], [1, 0, 0]);
    doc = run(doc, { type: 'transform', id: 't', position: [0, 0, 5] });
    t = transformAt(doc, 'a', 1)!;
    close(colsOf(t.rotation)[1], [0, 0, 1]);
    // Influence 0.5: halfway.
    doc = run(doc, { type: 'setConstraint', id: 'a', index: 0, patch: { influence: 0.5 } }, { type: 'transform', id: 't', position: [3, 0, 0] });
    t = transformAt(doc, 'a', 1)!;
    expect(Math.abs(t.rotation[2])).toBeGreaterThan(20);
    expect(Math.abs(t.rotation[2])).toBeLessThan(70);
  });

  it('Copy Location (axes, offset), Copy Scale, Limit Distance; works under a parent', () => {
    let doc = run(scene(), { type: 'addConstraint', id: 'a', constraint: { type: 'copyLocation', target: 't', y: false } });
    close(transformAt(doc, 'a', 1)!.position, [3, 0, 0]);
    doc = run(doc, { type: 'transform', id: 'a', position: [0, 1, 1] }, { type: 'setConstraint', id: 'a', index: 0, patch: { offset: true } });
    close(transformAt(doc, 'a', 1)!.position, [3, 1, 1]);
    doc = run(doc, { type: 'removeConstraint', id: 'a', index: 0 }, { type: 'addConstraint', id: 'a', constraint: { type: 'limitDistance', target: 't', distance: 1 } });
    const L = worldAt(doc, 'a', 1);
    const r = Math.sqrt(11);
    close([L[3], L[7], L[11]], [3 - 3 / r, 1 / r, 1 / r]);
    // Under a moved parent the constrained world position is still the target's.
    doc = run(scene(),
      { type: 'add', primitive: 'empty', id: 'p', transform: { position: [10, 0, 0], rotation: [0, 0, 90] } },
      { type: 'setParent', id: 'a', parentId: 'p' },
      { type: 'addConstraint', id: 'a', constraint: { type: 'copyLocation', target: 't' } },
      { type: 'addConstraint', id: 'a', constraint: { type: 'copyScale', target: 't' } },
      { type: 'transform', id: 't', scale: [2, 2, 2] });
    const w = worldAt(doc, 'a', 1);
    close([w[3], w[7], w[11]], [3, 0, 0]);
    close([Math.hypot(w[0], w[4], w[8])], [2]);
  });

  it('loops stop, deleting the target removes the constraint, files round-trip', () => {
    let doc = run(scene(), { type: 'addConstraint', id: 'a', constraint: { type: 'trackTo', target: 't' } }, { type: 'addConstraint', id: 't', constraint: { type: 'trackTo', target: 'a' } });
    expect(transformAt(doc, 'a', 1)).toBeTruthy();
    const back = validateSceneDoc(JSON.parse(JSON.stringify(doc)));
    expect(back.objects.a.constraints).toEqual(doc.objects.a.constraints);
    expect(() => run(doc, { type: 'addConstraint', id: 'a', constraint: { type: 'trackTo', target: 'a' } })).toThrow(/itself/);
    doc = run(doc, { type: 'delete', ids: ['t'] });
    expect(doc.objects.a.constraints).toBeUndefined();
  });
});
