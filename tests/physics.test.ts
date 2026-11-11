import { describe, expect, it } from 'vitest';
import * as CANNON from 'cannon-es';
import { registerPhysics, simulate } from '../src/core/physics';
import { applyCommand, validateCommand, validateSceneDoc } from '../src/core/commands';
import { createDefaultDoc } from '../src/core/store';
import { transformAt } from '../src/core/animation';
import type { SceneDoc } from '../src/core/types';

registerPhysics(CANNON);

function scene(cmds: unknown[]): SceneDoc {
  let doc = createDefaultDoc();
  doc = applyCommand(doc, validateCommand({ type: 'delete', ids: [...doc.order] })).doc;
  for (const c of cmds) doc = applyCommand(doc, validateCommand(c)).doc;
  return doc;
}
const ground = [
  { type: 'add', primitive: 'cube', id: 'ground', transform: { position: [0, 0, -0.5], scale: [10, 10, 0.5] } },
  { type: 'setRigidBody', id: 'ground', rigid: { type: 'passive' } },
];

describe('rigid body physics', () => {
  it('a box falls onto the ground and comes to rest on it; keys stop once it settles', () => {
    const doc = scene([...ground, { type: 'add', primitive: 'cube', id: 'box', transform: { position: [0, 0, 4], scale: [0.5, 0.5, 0.5] } }, { type: 'setRigidBody', id: 'box', rigid: {} }]);
    const { tracks, bodies } = simulate(doc, 1, 120, 24);
    expect(bodies).toBe(2);
    expect(Object.keys(tracks)).toEqual(['box']); // passive bodies don't move
    const keys = tracks.box;
    expect(keys[0].frame).toBe(1);
    expect(keys[0].transform.position[2]).toBe(4);
    const last = keys[keys.length - 1];
    expect(last.transform.position[2]).toBeCloseTo(0.5, 1); // resting on the ground (top at z = 0)
    // settled early: no keys in between, just one at the end of the bake to hold it there
    expect(keys[keys.length - 2].frame).toBeLessThan(100);
    expect(last.frame).toBe(120);
    // free fall: after 0.5 s it has dropped about ½ g t² ≈ 1.23 m
    const k13 = keys.find((k) => k.frame === 13)!;
    expect(4 - k13.transform.position[2]).toBeCloseTo(1.23, 1);
  });

  it('bouncy balls bounce, and a starting velocity throws them', () => {
    const doc = scene([
      ...ground,
      { type: 'add', primitive: 'sphere', id: 'ball', transform: { position: [0, 0, 3], scale: [0.3, 0.3, 0.3] } },
      { type: 'setRigidBody', id: 'ball', rigid: { bounce: 0.9 } },
      { type: 'setRigidBody', id: 'ground', rigid: { bounce: 0.9 } },
      { type: 'add', primitive: 'sphere', id: 'thrown', transform: { position: [-3, 3, 1], scale: [0.3, 0.3, 0.3] } },
      { type: 'setRigidBody', id: 'thrown', rigid: { velocity: [4, 0, 2] } },
    ]);
    const { tracks } = simulate(doc, 1, 72, 24);
    const z = tracks.ball.map((k) => k.transform.position[2]);
    const firstLow = z.findIndex((v) => v < 0.35);
    expect(firstLow).toBeGreaterThan(0);
    expect(Math.max(...z.slice(firstLow + 2))).toBeGreaterThan(1.5); // came back up most of the way
    expect(tracks.thrown[tracks.thrown.length - 1].transform.position[0]).toBeGreaterThan(-1);
  });

  it('bakePhysics writes keys (one undo), keeps keys outside the range, and validates', () => {
    let doc = scene([...ground, { type: 'add', primitive: 'cube', id: 'box', transform: { position: [0, 0, 3] } }, { type: 'setRigidBody', id: 'box', rigid: { mass: 2 } }]);
    expect(doc.objects.box.rigid).toEqual({ type: 'active', shape: 'auto', mass: 2, friction: 0.5, bounce: 0 });
    doc = applyCommand(doc, validateCommand({ type: 'setKeyframe', id: 'box', frame: 200, transform: { position: [5, 5, 5], rotation: [0, 0, 0], scale: [1, 1, 1] } })).doc;
    doc = applyCommand(doc, validateCommand({ type: 'bakePhysics', start: 1, end: 100 })).doc;
    const keys = doc.animation!.tracks.box;
    expect(keys.some((k) => k.frame === 200)).toBe(true);
    expect(transformAt(doc, 'box', 90)!.position[2]).toBeCloseTo(1, 1);
    expect(validateSceneDoc(JSON.parse(JSON.stringify(doc))).objects.box.rigid).toEqual(doc.objects.box.rigid);
    doc = applyCommand(doc, validateCommand({ type: 'setRigidBody', id: 'box', rigid: null })).doc;
    expect(doc.objects.box.rigid).toBeUndefined();
    expect(() => applyCommand(doc, validateCommand({ type: 'bakePhysics' }))).toThrow(/No active rigid bodies/);
    expect(() => validateCommand({ type: 'setRigidBody', id: 'box', rigid: { bounce: 2 } })).toThrow(/bounce/);
    expect(() => validateCommand({ type: 'setRigidBody', id: 'box', rigid: { kind: 'x' } })).toThrow(/no setting/);
    const light = applyCommand(doc, validateCommand({ type: 'add', primitive: 'light', id: 'l' })).doc;
    expect(() => applyCommand(light, validateCommand({ type: 'setRigidBody', id: 'l', rigid: {} }))).toThrow(/only shapes and meshes/);
  });

  it('a tower of blocks stands still until something hits it', () => {
    const blocks = [0, 1, 2, 3].flatMap((i) => [
      { type: 'add', primitive: 'cube', id: `b${i}`, transform: { position: [0, 0, 0.25 + i * 0.5], scale: [0.25, 0.25, 0.25] } },
      { type: 'setRigidBody', id: `b${i}`, rigid: {} },
    ]);
    const doc = scene([...ground, ...blocks]);
    const { tracks } = simulate(doc, 1, 48, 24);
    const top = tracks.b3[tracks.b3.length - 1].transform.position;
    expect(Math.hypot(top[0], top[1])).toBeLessThan(0.02);
    expect(top[2]).toBeCloseTo(1.75, 1);
  });
});
