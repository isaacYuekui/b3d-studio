import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { applyCommand, validateCommand } from '../src/core/commands';
import { registerHuman, humanWeights } from '../src/core/humans';
import type { HumanData } from '../src/core/humans';
import { isHumanRig, standPose } from '../src/core/motion';
import { poseAt, poseBones, apply } from '../src/core/rig';
import { transformAt } from '../src/core/animation';

const file = 'public/library/humans/male.json';
const have = fs.existsSync(file);

describe.runIf(have)('human presets (MakeHuman CC0)', () => {
  const data = have ? (JSON.parse(fs.readFileSync(file, 'utf8')) as HumanData) : null!;
  registerHuman('male', data);
  let n = 0;
  const ids = () => `h${n++}`;
  const add = () => applyCommand({ objects: {}, order: [] }, validateCommand({ type: 'addHuman', id: 'bob', preset: 'male', outfit: { hair: null, shirt: '#112233' } }), ids).doc;

  it('builds a rig, skinned parts and eyes; starts relaxed', () => {
    const doc = add();
    const rig = doc.objects.bob;
    expect(rig.type).toBe('armature');
    expect(isHumanRig(rig.armature!.bones)).toBe(true);
    expect(doc.objects['bob-body'].skin).toEqual({ armature: 'bob', weights: 'humans/male#body' });
    expect(doc.objects['bob-hair']).toBeUndefined();
    expect(doc.objects['bob-shirt'].material.baseColor).toBe('#112233');
    expect(doc.objects['bob-eyeL'].skin?.bone).toBe('eye.L');
    expect(Object.keys(rig.pose ?? {}).length).toBeGreaterThan(4);
    expect(humanWeights('humans/male#body')!.w.length).toBe(doc.objects['bob-body'].mesh!.vertices.length);
    // Relaxed: hands well below the shoulders and close to the body.
    const posed = poseBones(rig.armature!.bones, rig.pose);
    const hand = apply(posed.posed.get('wrist.L')!, [0, 0, 0]);
    expect(hand[2]).toBeLessThan(0.95);
    expect(Math.abs(hand[0])).toBeLessThan(0.33);
    expect(Object.keys(standPose(rig.armature!.bones)).length).toBeGreaterThan(4);
  });

  it('walk travels forward with feet on the floor; actions chain', () => {
    let doc = add();
    doc = applyCommand(doc, validateCommand({ type: 'playAction', id: 'bob', action: 'walk', start: 1, cycles: 2 })).doc;
    const y0 = transformAt(doc, 'bob', 1)!.position[1];
    const y1 = transformAt(doc, 'bob', 61)!.position[1];
    expect(y0 - y1).toBeCloseTo(2.9, 1); // faces −Y, 1.45 m per cycle
    const zs = [1, 9, 17, 25].map((f) => transformAt(doc, 'bob', f)!.position[2]);
    zs.forEach((z) => expect(Math.abs(z)).toBeLessThan(0.08));
    doc = applyCommand(doc, validateCommand({ type: 'playAction', id: 'bob', action: 'wave', start: 70, cycles: 1 })).doc;
    expect(transformAt(doc, 'bob', 80)!.position[1]).toBeCloseTo(y1, 3);
    const p = poseAt(doc, 'bob', 80);
    expect(p['upperarm01.R']).toBeDefined();
    expect(() => validateCommand({ type: 'playAction', id: 'bob', action: 'moonwalk', start: 1 })).toThrow();
  });

  it('refuses unknown presets and unloaded data', () => {
    expect(() => validateCommand({ type: 'addHuman', id: 'x', preset: 'robot' })).toThrow(/preset/);
    expect(() => applyCommand({ objects: {}, order: [] }, { type: 'addHuman', id: 'x', preset: 'female' })).toThrow(/not loaded/);
  });
});
