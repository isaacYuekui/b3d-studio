import { describe, expect, it } from 'vitest';
import * as CANNON from 'cannon-es';
import { activeFields, fieldAcceleration } from '../src/core/fields';
import { registerPhysics, simulate } from '../src/core/physics';
import { applyCommand, validateCommand, validateSceneDoc } from '../src/core/commands';
import { createDefaultDoc } from '../src/core/store';
import type { SceneDoc } from '../src/core/types';

registerPhysics(CANNON);

function scene(cmds: unknown[]): SceneDoc {
  let doc = createDefaultDoc();
  doc = applyCommand(doc, validateCommand({ type: 'delete', ids: [...doc.order] })).doc;
  for (const c of cmds) doc = applyCommand(doc, validateCommand(c)).doc;
  return doc;
}

describe('force fields', () => {
  it('force pushes out with falloff, wind blows along Z, vortex swirls; frame windows apply', () => {
    const doc = scene([
      { type: 'add', primitive: 'empty', id: 'f' },
      { type: 'setField', id: 'f', field: { type: 'force', strength: 10, radius: 10, start: 5, end: 6 } },
    ]);
    expect(activeFields(doc, 4)).toEqual([]);
    const fs = activeFields(doc, 5);
    const a = fieldAcceleration(fs, [5, 0, 0]);
    expect(a[0]).toBeCloseTo(5, 9); // half strength at half radius, pointing away
    expect(fieldAcceleration(fs, [20, 0, 0])).toEqual([0, 0, 0]);
    const wind = fieldAcceleration([{ field: { type: 'wind', strength: 3, radius: 0 }, at: [0, 0, 0], axis: [1, 0, 0] }], [100, 5, 2]);
    expect(wind).toEqual([3, 0, 0]);
    const v = fieldAcceleration([{ field: { type: 'vortex', strength: 2, radius: 0 }, at: [0, 0, 0], axis: [0, 0, 1] }], [1, 0, 0]);
    expect(v[1]).toBeCloseTo(2, 9); // counter-clockwise around +Z
  });

  it('an explosion field blows resting boxes apart in the bake', () => {
    const boxes = [-1, 1].flatMap((x, i) => [
      { type: 'add', primitive: 'cube', id: `b${i}`, transform: { position: [x, 0, 0.5], scale: [0.5, 0.5, 0.5] } },
      { type: 'setRigidBody', id: `b${i}`, rigid: {} },
    ]);
    const doc = scene([
      { type: 'add', primitive: 'cube', id: 'ground', transform: { position: [0, 0, -0.5], scale: [30, 30, 0.5] } },
      { type: 'setRigidBody', id: 'ground', rigid: { type: 'passive' } },
      ...boxes,
      { type: 'add', primitive: 'empty', id: 'boom', transform: { position: [0, 0, 0.2] } },
      { type: 'setField', id: 'boom', field: { type: 'force', strength: 600, radius: 6, start: 10, end: 11 } },
    ]);
    const { tracks } = simulate(doc, 1, 48, 24);
    const x0 = tracks.b0.find((k) => k.frame === 9)!.transform.position[0];
    const x1 = tracks.b0[tracks.b0.length - 1].transform.position[0];
    expect(Math.abs(x0 + 1)).toBeLessThan(0.01); // still before the blast
    expect(x1).toBeLessThan(-3); // thrown away from the centre
    expect(tracks.b1[tracks.b1.length - 1].transform.position[0]).toBeGreaterThan(3);
  });

  it('setField validates, merges, saves, and only goes on empties', () => {
    let doc = scene([{ type: 'add', primitive: 'empty', id: 'f' }, { type: 'add', primitive: 'cube', id: 'c' }]);
    doc = applyCommand(doc, validateCommand({ type: 'setField', id: 'f', field: { type: 'wind' } })).doc;
    expect(doc.objects.f.field).toEqual({ type: 'wind', strength: 30, radius: 10 });
    doc = applyCommand(doc, validateCommand({ type: 'setField', id: 'f', field: { strength: 5 } })).doc;
    expect(doc.objects.f.field!.strength).toBe(5);
    expect(validateSceneDoc(JSON.parse(JSON.stringify(doc))).objects.f.field).toEqual(doc.objects.f.field);
    expect(() => applyCommand(doc, validateCommand({ type: 'setField', id: 'c', field: {} }))).toThrow(/empties/);
    expect(() => validateCommand({ type: 'setField', id: 'f', field: { type: 'magnet' } })).toThrow(/type/);
    doc = applyCommand(doc, validateCommand({ type: 'setField', id: 'f', field: null })).doc;
    expect(doc.objects.f.field).toBeUndefined();
  });
});

describe('animated passive bodies', () => {
  it('a keyframed passive paddle shoves an active box along', () => {
    const doc = scene([
      { type: 'add', primitive: 'cube', id: 'ground', transform: { position: [0, 0, -0.5], scale: [30, 30, 0.5] } },
      { type: 'setRigidBody', id: 'ground', rigid: { type: 'passive' } },
      { type: 'add', primitive: 'cube', id: 'box', transform: { position: [0, 0, 0.5], scale: [0.5, 0.5, 0.5] } },
      { type: 'setRigidBody', id: 'box', rigid: {} },
      { type: 'add', primitive: 'cube', id: 'paddle', transform: { position: [-4, 0, 0.6], scale: [0.2, 1, 0.6] } },
      { type: 'setKeyframe', id: 'paddle', frame: 1, easing: 'linear', transform: { position: [-4, 0, 0.6], rotation: [0, 0, 0], scale: [0.2, 1, 0.6] } },
      { type: 'setKeyframe', id: 'paddle', frame: 25, easing: 'linear', transform: { position: [4, 0, 0.6], rotation: [0, 0, 0], scale: [0.2, 1, 0.6] } },
      { type: 'setRigidBody', id: 'paddle', rigid: { type: 'passive', animated: true } },
    ]);
    const { tracks } = simulate(doc, 1, 48, 24);
    expect(tracks.paddle).toBeUndefined(); // it isn't baked, it keeps its own keys
    const x = tracks.box[tracks.box.length - 1].transform.position[0];
    expect(x).toBeGreaterThan(4); // pushed past where the paddle stopped
    // Not animated → a static wall at its start pose: the box stays put.
    const still = applyCommand(doc, validateCommand({ type: 'setRigidBody', id: 'paddle', rigid: { animated: false } })).doc;
    const t2 = simulate(still, 1, 48, 24).tracks.box;
    expect(Math.abs(t2[t2.length - 1].transform.position[0])).toBeLessThan(0.05);
  });
});
