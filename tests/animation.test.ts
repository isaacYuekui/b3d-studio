import { describe, expect, it } from 'vitest';
import { ease, evaluateCamera, evaluateTransform, keyFrames, transformAt, transformEdit, animationOf } from '../src/core/animation';
import type { TransformKey } from '../src/core/animation';
import { applyCommand, validateCommand, validateSceneDoc } from '../src/core/commands';
import { parseProject, serializeProject } from '../src/core/serialize';
import { Store } from '../src/core/store';
import type { SceneDoc } from '../src/core/types';

const empty = (): SceneDoc => ({ objects: {}, order: [] });
const seq = () => { let n = 0; return () => `id${++n}`; };
const T = (x: number, rz = 0) => ({ position: [x, 0, 0] as [number, number, number], rotation: [0, 0, rz] as [number, number, number], scale: [1, 1, 1] as [number, number, number] });

describe('easing', () => {
  it('hits the endpoints and is monotonic', () => {
    for (const e of ['linear', 'ease', 'easeIn', 'easeOut'] as const) {
      expect(ease(e, 0)).toBeCloseTo(0, 5);
      expect(ease(e, 1)).toBeCloseTo(1, 5);
      let prev = -1;
      for (let t = 0; t <= 1.0001; t += 0.05) { const v = ease(e, t); expect(v).toBeGreaterThanOrEqual(prev - 1e-9); prev = v; }
    }
    expect(ease('linear', 0.25)).toBe(0.25);
    expect(ease('ease', 0.5)).toBeCloseTo(0.5, 3); // symmetric
    expect(ease('easeIn', 0.25)).toBeLessThan(0.25);
    expect(ease('easeOut', 0.25)).toBeGreaterThan(0.25);
    expect(ease('constant', 0.9)).toBe(0);
  });
});

describe('evaluation', () => {
  const keys: TransformKey[] = [
    { frame: 1, transform: T(0, 0), easing: 'linear' },
    { frame: 11, transform: T(10, 7200), easing: 'linear' },
  ];
  it('interpolates between keys and holds outside them', () => {
    expect(evaluateTransform(keys, 6)!.position[0]).toBeCloseTo(5);
    expect(evaluateTransform(keys, -20)!.position[0]).toBe(0);
    expect(evaluateTransform(keys, 500)!.position[0]).toBe(10);
  });
  it('spins past 360° (per-channel Euler, like Blender) so wheels can turn many times', () => {
    expect(evaluateTransform(keys, 6)!.rotation[2]).toBeCloseTo(3600);
  });
  it('holds with constant easing, then jumps on the next key', () => {
    const k: TransformKey[] = [{ frame: 1, transform: T(0), easing: 'constant' }, { frame: 10, transform: T(5), easing: 'linear' }];
    expect(evaluateTransform(k, 9.9)!.position[0]).toBe(0);
    expect(evaluateTransform(k, 10)!.position[0]).toBe(5);
  });
  it('evaluates camera keys', () => {
    const cam = evaluateCamera([{ frame: 0, position: [0, -10, 2], target: [0, 0, 0], easing: 'linear' }, { frame: 10, position: [10, -10, 2], target: [2, 0, 0], easing: 'linear' }], 5)!;
    expect(cam.position).toEqual([5, -10, 2]);
    expect(cam.target).toEqual([1, 0, 0]);
  });
});

describe('keyframe commands', () => {
  const withCube = () => applyCommand(empty(), { type: 'add', primitive: 'cube', id: 'c' }).doc;

  it('inserts keys sorted, replaces a key on the same frame, and evaluates', () => {
    let doc = withCube();
    doc = applyCommand(doc, validateCommand({ type: 'setKeyframe', id: 'c', frame: 20, transform: T(4), easing: 'linear' })).doc;
    doc = applyCommand(doc, validateCommand({ type: 'setKeyframe', id: 'c', frame: 1, transform: T(0), easing: 'linear' })).doc;
    doc = applyCommand(doc, validateCommand({ type: 'setKeyframe', id: 'c', frame: 20, transform: T(8) })).doc;
    const keys = doc.animation!.tracks.c;
    expect(keys.map((k) => k.frame)).toEqual([1, 20]);
    expect(keys[1].easing).toBe('linear'); // keeps the existing key's easing when not given
    expect(transformAt(doc, 'c', 20.5)!.position[0]).toBe(8);
  });

  it('a key without a transform captures the current pose', () => {
    let doc = withCube();
    doc = applyCommand(doc, { type: 'transform', id: 'c', position: [3, 2, 1] }).doc;
    doc = applyCommand(doc, { type: 'setKeyframe', id: 'c', frame: 5 }).doc;
    expect(doc.animation!.tracks.c[0].transform.position).toEqual([3, 2, 1]);
  });

  it('auto-key: editing an animated object keys the current frame instead of being overridden', () => {
    let doc = withCube();
    expect(transformEdit(doc, 10, 'c', { position: [1, 1, 1] }).type).toBe('transform');
    doc = applyCommand(doc, { type: 'setKeyframe', id: 'c', frame: 1, transform: T(0) }).doc;
    const cmd = transformEdit(doc, 10, 'c', { position: [5, 0, 0] });
    expect(cmd).toMatchObject({ type: 'setKeyframe', frame: 10, transform: { position: [5, 0, 0] } });
    doc = applyCommand(doc, cmd).doc;
    expect(doc.animation!.tracks.c.map((k) => k.frame)).toEqual([1, 10]);
  });

  it('deleting the last key leaves the object where that key had it', () => {
    let doc = withCube();
    doc = applyCommand(doc, { type: 'setKeyframe', id: 'c', frame: 3, transform: T(7) }).doc;
    doc = applyCommand(doc, { type: 'deleteKeyframe', id: 'c', frame: 3 }).doc;
    expect(doc.animation!.tracks.c).toBeUndefined();
    expect(doc.objects.c.transform.position[0]).toBe(7);
  });

  it('deleting an object removes its track; duplicating copies it, offset like the copy', () => {
    let doc = withCube();
    doc = applyCommand(doc, { type: 'setKeyframe', id: 'c', frame: 1, transform: T(2) }).doc;
    const dup = applyCommand(doc, { type: 'duplicate', ids: ['c'] }, seq());
    expect(dup.doc.animation!.tracks.id1[0].transform.position[0]).toBe(3);
    doc = applyCommand(doc, { type: 'delete', ids: ['c'] }).doc;
    expect(doc.animation!.tracks.c).toBeUndefined();
  });

  it('camera keys, range and validation', () => {
    let doc = applyCommand(empty(), validateCommand({ type: 'setCameraKey', frame: 1, position: [6, -6, 3], target: [0, 0, 1] })).doc;
    doc = applyCommand(doc, validateCommand({ type: 'setAnimation', fps: 30, end: 300 })).doc;
    expect(animationOf(doc)).toMatchObject({ fps: 30, start: 1, end: 300 });
    expect(doc.animation!.camera).toHaveLength(1);
    expect(() => applyCommand(doc, { type: 'setAnimation', end: 0 })).toThrow(/after the start/);
    expect(() => validateCommand({ type: 'setKeyframe', id: 'c', frame: 1, easing: 'bouncy' })).toThrow(/easing/);
    expect(() => validateCommand({ type: 'setAnimation', fps: 0 })).toThrow(/fps/);
    expect(keyFrames(animationOf(doc), null)).toEqual([1]);
  });

  it('animation survives the project file round-trip and drops tracks of missing objects', () => {
    let doc = withCube();
    doc = applyCommand(doc, { type: 'setKeyframe', id: 'c', frame: 1, transform: T(1) }).doc;
    doc = applyCommand(doc, { type: 'setCameraKey', frame: 1, position: [1, 2, 3], target: [0, 0, 0] }).doc;
    expect(parseProject(serializeProject(doc))).toEqual(doc);
    const raw = JSON.parse(JSON.stringify(doc));
    raw.animation.tracks.ghost = raw.animation.tracks.c;
    expect(validateSceneDoc(raw).animation!.tracks.ghost).toBeUndefined();
  });

  it('a whole animated script is one undo step', () => {
    const s = new Store(empty(), seq());
    s.dispatch(validateCommand({ type: 'batch', commands: [
      { type: 'add', primitive: 'cube', id: 'car' },
      { type: 'setKeyframe', id: 'car', frame: 1, transform: T(0) },
      { type: 'setKeyframe', id: 'car', frame: 48, transform: T(20) },
    ] }));
    expect(s.getState().doc.animation!.tracks.car).toHaveLength(2);
    s.undo();
    expect(s.getState().doc.order).toEqual([]);
  });
});
