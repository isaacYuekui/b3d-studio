import { describe, expect, it } from 'vitest';
import * as CANNON from 'cannon-es';
import { applyCommand, validateCommand } from '../src/core/commands';
import { createDefaultDoc } from '../src/core/store';
import { levelAt, soundEvents } from '../src/core/sound';
import { registerPhysics } from '../src/core/physics';
import type { SceneDoc } from '../src/core/types';

registerPhysics(CANNON);

function scene(cmds: unknown[]): SceneDoc {
  let doc = createDefaultDoc();
  doc = applyCommand(doc, validateCommand({ type: 'delete', ids: [...doc.order] })).doc;
  for (const c of [{ type: 'setAnimation', fps: 24, start: 1, end: 120 }, ...cmds]) doc = applyCommand(doc, validateCommand(c)).doc;
  return doc;
}

describe('automatic sound effects', () => {
  it('a quiet scene makes no sound', () => {
    expect(soundEvents(scene([{ type: 'add', primitive: 'cube' }]), 1, 120, 24)).toEqual([]);
  });

  it('explosion field → boom at its frame; camera shake → rumble', () => {
    const doc = scene([
      { type: 'add', primitive: 'empty', id: 'blast' },
      { type: 'setField', id: 'blast', field: { type: 'force', strength: 400, radius: 14, start: 49, end: 50 } },
      { type: 'addCameraShake', start: 49, end: 97, strength: 0.8 },
    ]);
    const ev = soundEvents(doc, 1, 120, 24);
    const boom = ev.find((e) => e.kind === 'boom')!;
    expect(boom.start).toBeCloseTo(2, 6);
    expect(boom.gain).toBeGreaterThan(0.5);
    const rumble = ev.find((e) => e.kind === 'rumble')!;
    expect(rumble.start).toBeCloseTo(2, 6);
    expect(levelAt(rumble, 2.1)).toBeGreaterThan(levelAt(rumble, 3.9));
    // From a later start frame, times shift.
    expect(soundEvents(doc, 25, 120, 24).find((e) => e.kind === 'boom')!.start).toBeCloseTo(1, 6);
    // A gentle push field is not an explosion.
    const calm = scene([{ type: 'add', primitive: 'empty', id: 'p' }, { type: 'setField', id: 'p', field: { type: 'force', strength: 20, radius: 5 } }]);
    expect(soundEvents(calm, 1, 120, 24).some((e) => e.kind === 'boom')).toBe(false);
  });

  it('a giant wave roars louder as it reaches the camera; stormy seas wash', () => {
    const doc = scene([
      { type: 'addWater', id: 'sea', size: [200, 100], level: 0, direction: 0, height: 1.2 },
      { type: 'setWater', id: 'sea', water: { surge: { height: 8, start: 1, speed: 15, width: 16, from: -90 } } },
      { type: 'setCameraKey', frame: 1, position: [40, 0, 6], target: [0, 0, 3] },
    ]);
    const ev = soundEvents(doc, 1, 120, 24);
    const roar = ev.find((e) => e.kind === 'roar')!;
    expect(roar).toBeTruthy();
    // front at x = 40 after 130 m / 15 m/s ≈ 8.7 s; early on it is far away
    expect(levelAt(roar, 4.9)).toBeGreaterThan(levelAt(roar, 1.5));
    expect(ev.some((e) => e.kind === 'sea')).toBe(true);
  });

  it('fire crackles; a fast-moving fire (meteor) whooshes; rain hisses', () => {
    const doc = scene([
      { type: 'add', primitive: 'sphere', id: 'camp' },
      { type: 'setParticles', id: 'camp', particles: { shape: 'fire', count: 1800, start: 1, end: 100, lifetime: 26 } },
      { type: 'add', primitive: 'sphere', id: 'meteor' },
      { type: 'setKeyframe', id: 'meteor', frame: 1, transform: { position: [-200, 0, 150], rotation: [0, 0, 0], scale: [1, 1, 1] } },
      { type: 'setKeyframe', id: 'meteor', frame: 60, transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } },
      { type: 'setParticles', id: 'meteor', particles: { shape: 'fire', count: 3000, start: 1, end: 60, lifetime: 20 } },
      { type: 'add', primitive: 'plane', id: 'cloud' },
      { type: 'setParticles', id: 'cloud', particles: { shape: 'drop', count: 3000, start: 1, end: 120, gravity: 1.2, lifetime: 40 } },
    ]);
    const kinds = soundEvents(doc, 1, 120, 24).map((e) => `${e.kind}:${e.source}`);
    expect(kinds).toContain('crackle:Sphere');
    expect(kinds.some((k) => k.startsWith('whoosh:'))).toBe(true);
    expect(kinds.some((k) => k.startsWith('rain:'))).toBe(true);
  });

  it('baked falling pieces crash where they land', () => {
    let doc = scene([
      { type: 'add', primitive: 'cube', id: 'floor', transform: { position: [0, 0, -1], scale: [10, 10, 1] } },
      { type: 'setRigidBody', id: 'floor', rigid: { type: 'passive' } },
      { type: 'add', primitive: 'cube', id: 'box', transform: { position: [0, 0, 6] } },
      { type: 'setRigidBody', id: 'box', rigid: { type: 'active', mass: 50 } },
    ]);
    doc = applyCommand(doc, validateCommand({ type: 'bakePhysics' })).doc;
    const debris = soundEvents(doc, 1, 120, 24).find((e) => e.kind === 'debris')!;
    expect(debris).toBeTruthy();
    // Falls 5 m: lands after about 1 s.
    const loudest = debris.env!.reduce((a, b) => (b[1] > a[1] ? b : a));
    expect(loudest[0]).toBeGreaterThan(0.8);
    expect(loudest[0]).toBeLessThan(1.4);
  });
});
