import { describe, expect, it } from 'vitest';
import { changingChannels, easingCmd, graphChannels, graphKeys, graphValuesAt, moveKeyCmd, sampleCurves, setKeyValue, valueRange } from '../src/core/graph';
import { applyCommand, validateCommand } from '../src/core/commands';
import { createDefaultDoc } from '../src/core/store';
import type { SceneDoc } from '../src/core/types';

function animated(): SceneDoc {
  let doc = applyCommand(createDefaultDoc(), validateCommand({ type: 'add', primitive: 'cube', id: 'b' })).doc;
  const key = (frame: number, x: number, rz: number) => validateCommand({ type: 'setKeyframe', id: 'b', frame, easing: 'linear', transform: { position: [x, 0, 0], rotation: [0, 0, rz], scale: [1, 1, 1] } });
  doc = applyCommand(doc, key(1, 0, 0)).doc;
  doc = applyCommand(doc, key(11, 5, 90)).doc;
  return doc;
}
const T = { kind: 'object', id: 'b' } as const;

describe('Graph Editor data', () => {
  it('lists channels and keys with every value; only moving channels show by default', () => {
    const doc = animated();
    expect(graphChannels(T).map((c) => c.label)).toEqual(['Location X', 'Location Y', 'Location Z', 'Rotation X', 'Rotation Y', 'Rotation Z', 'Scale X', 'Scale Y', 'Scale Z']);
    const keys = graphKeys(doc, T);
    expect(keys.map((k) => k.frame)).toEqual([1, 11]);
    expect(keys[1].values.slice(0, 6)).toEqual([5, 0, 0, 0, 0, 90]);
    expect(changingChannels(keys)).toEqual([true, false, false, false, false, true, false, false, false]);
  });

  it('samples curves that pass through the keys (linear in between)', () => {
    const doc = animated();
    const [x] = sampleCurves(doc, T, [0], 1, 11, 10);
    expect(x[0]).toEqual([1, 0]);
    expect(x[x.length - 1]).toEqual([11, 5]);
    const mid = x.find(([f]) => f === 6)!;
    expect(mid[1]).toBeCloseTo(2.5, 9);
    expect(graphValuesAt(doc, T, 6)![5]).toBeCloseTo(45, 9);
    expect(valueRange([x])).toEqual([-0.5, 5.5]);
    expect(valueRange([[[1, 3]]])).toEqual([2, 4]);
  });

  it('builds commands: set one value, move a key, change interpolation', () => {
    let doc = animated();
    doc = applyCommand(doc, setKeyValue(doc, T, 11, 5, 180)!).doc;
    expect(graphKeys(doc, T)[1].values).toEqual([5, 0, 0, 0, 0, 180, 1, 1, 1]);
    expect(graphKeys(doc, T)[1].easing).toBe('linear');
    doc = applyCommand(doc, moveKeyCmd(T, 11, 9)).doc;
    expect(graphKeys(doc, T).map((k) => k.frame)).toEqual([1, 20]);
    doc = applyCommand(doc, easingCmd(T, 1, 'constant')).doc;
    expect(graphValuesAt(doc, T, 19)![0]).toBe(0);
    expect(setKeyValue(doc, T, 7, 0, 1)).toBeNull();
  });

  it('works for the camera too', () => {
    let doc = createDefaultDoc();
    doc = applyCommand(doc, validateCommand({ type: 'setCameraKey', frame: 1, position: [0, -10, 2], target: [0, 0, 1] })).doc;
    doc = applyCommand(doc, validateCommand({ type: 'setCameraKey', frame: 25, position: [10, -10, 2], target: [0, 0, 1] })).doc;
    const C = { kind: 'camera' } as const;
    expect(graphChannels(C).map((c) => c.key)).toEqual(['pos0', 'pos1', 'pos2', 'tgt0', 'tgt1', 'tgt2']);
    expect(changingChannels(graphKeys(doc, C))).toEqual([true, false, false, false, false, false]);
    doc = applyCommand(doc, setKeyValue(doc, C, 25, 2, 6)!).doc;
    expect(graphKeys(doc, C)[1].values).toEqual([10, -10, 6, 0, 0, 1]);
  });
});
