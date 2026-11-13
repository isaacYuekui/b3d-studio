import { describe, expect, it } from 'vitest';
import { applyCommand, validateCommand, validateSceneDoc } from '../src/core/commands';
import { drivenShapeValues, transformAt } from '../src/core/animation';
import { exprProblem, parseExpr, runExpr } from '../src/core/expr';
import type { SceneDoc } from '../src/core/types';

const ids = (() => { let n = 0; return () => `d${n++}`; })();
const run = (doc: SceneDoc, ...cmds: unknown[]) => cmds.reduce<SceneDoc>((d, c) => applyCommand(d, validateCommand(c), ids).doc, doc);

describe('expressions (safe, no eval)', () => {
  it('arithmetic, precedence, functions, ternary', () => {
    expect(runExpr('1 + 2 * 3', {})).toBe(7);
    expect(runExpr('-2 ^ 2', {})).toBe(-4);
    expect(runExpr('2 ** 3 ** 2', {})).toBe(512);
    expect(runExpr('max(a, 3) / 2', { a: 10 })).toBe(5);
    expect(runExpr('a > 1 ? 10 : 20', { a: 2 })).toBe(10);
    expect(runExpr('clamp(frame / 10)', { frame: 30 })).toBe(1);
    expect(runExpr('sin(pi / 2)', {})).toBeCloseTo(1);
    expect(runExpr('1 / 0', {})).toBe(0);
    expect(runExpr('-7 % 3', {})).toBe(2);
  });
  it('rejects anything that is not maths', () => {
    for (const bad of ['alert(1)', 'window.location', 'a; b', '"x"', '[1]', 'constructor', 'x => 1', 'a = 1', '1 +']) {
      expect(runExpr(bad, { a: 1, b: 1 })).toBeNull();
    }
    expect(() => parseExpr('fetch(1)')).toThrow(/Unknown function/);
    expect(exprProblem('dist * 2', [])).toMatch(/Unknown name dist/);
    expect(exprProblem('dist * 2', ['dist'])).toBeNull();
    expect(() => parseExpr('('.repeat(100) + '1' + ')'.repeat(100))).toThrow();
  });
});

describe('drivers', () => {
  const base = () => run({ objects: {}, order: [] },
    { type: 'add', primitive: 'cube', id: 'car', transform: { position: [0, 0, 0] } },
    { type: 'add', primitive: 'cylinder', id: 'wheel', transform: { position: [0, 0, 0] } });

  it('a wheel turns with the car’s X location (degrees), including on keyframes', () => {
    let doc = run(base(), { type: 'addDriver', id: 'wheel', driver: { property: 'rotation.y', expression: 'x / (2 * pi * 0.5) * 360', vars: [{ name: 'x', object: 'car', channel: 'location.x' }] } });
    doc = run(doc, { type: 'setKeyframe', id: 'car', frame: 1, transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } }, { type: 'setKeyframe', id: 'car', frame: 11, transform: { position: [Math.PI, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } });
    expect(transformAt(doc, 'wheel', 1)!.rotation[1]).toBeCloseTo(0, 3);
    expect(transformAt(doc, 'wheel', 11)!.rotation[1]).toBeCloseTo(360, 2);
    // frame / time built in
    doc = run(doc, { type: 'addDriver', id: 'wheel', driver: { property: 'location.z', expression: 'time', vars: [] } });
    expect(transformAt(doc, 'wheel', 48)!.position[2]).toBeCloseTo(2);
  });

  it('validation: bad expressions, duplicates, unknown names; round trip; delete cleans vars', () => {
    const doc = run(base(), { type: 'addDriver', id: 'wheel', driver: { property: 'scale.z', expression: '1 + h', vars: [{ name: 'h', object: 'car', channel: 'location.z' }] } });
    expect(() => run(doc, { type: 'addDriver', id: 'wheel', driver: { property: 'scale.z', expression: '1', vars: [] } })).toThrow(/already/);
    expect(() => run(doc, { type: 'setDriver', id: 'wheel', index: 0, patch: { expression: 'eval(1)' } })).toThrow(/Unknown function/);
    expect(() => run(doc, { type: 'setDriver', id: 'wheel', index: 0, patch: { expression: 'q * 2' } })).toThrow(/Unknown name q/);
    const back = validateSceneDoc(JSON.parse(JSON.stringify(doc)));
    expect(back.objects.wheel.drivers).toEqual(doc.objects.wheel.drivers);
    const gone = run(doc, { type: 'delete', ids: ['car'] });
    expect(gone.objects.wheel.drivers![0].vars).toEqual([]);
    expect(transformAt(gone, 'wheel', 1)!.scale[2]).toBe(1);
  });

  it('drives a shape key value', () => {
    let doc = run(base(), { type: 'addShapeKey', id: 'wheel' }, { type: 'addShapeKey', id: 'wheel', name: 'Squash' });
    doc = run(doc, { type: 'addDriver', id: 'wheel', driver: { property: 'shape:Squash', expression: 'clamp(1 - d / 4)', vars: [{ name: 'd', object: 'car', channel: 'location.x' }] } }, { type: 'transform', id: 'car', position: [2, 0, 0] });
    expect(drivenShapeValues(doc, 'wheel', 1, ['Basis', 'Squash'], [0, 0])[1]).toBeCloseTo(0.5);
    doc = run(doc, { type: 'setShapeKey', id: 'wheel', index: 1, name: 'Flat' });
    expect(doc.objects.wheel.drivers![0].property).toBe('shape:Flat');
  });
});
