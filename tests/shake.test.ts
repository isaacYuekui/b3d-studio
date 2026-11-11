import { describe, expect, it } from 'vitest';
import { shakeCamera, shakeEnvelope, shakeOffsets } from '../src/core/shake';
import { applyCommand, validateCommand, validateSceneDoc } from '../src/core/commands';
import { createDefaultDoc } from '../src/core/store';

describe('camera shake', () => {
  const s = { start: 10, end: 40, strength: 0.5, frequency: 8 };
  it('hits fast, dies away, nothing outside its frames', () => {
    expect(shakeEnvelope(s, 9)).toBe(0);
    expect(shakeEnvelope(s, 10)).toBe(0);
    expect(shakeEnvelope(s, 13)).toBeGreaterThan(0.8);
    expect(shakeEnvelope(s, 30)).toBeLessThan(shakeEnvelope(s, 15));
    expect(shakeEnvelope(s, 40)).toBe(0);
    expect(shakeOffsets([s], 5, 24)).toBeNull();
  });

  it('is deterministic, bounded by strength, and moves the aim more than the body', () => {
    let maxT = 0, maxP = 0;
    for (let f = 10; f <= 40; f++) {
      const o = shakeOffsets([s], f, 24)!;
      if (!o) continue;
      expect(shakeOffsets([s], f, 24)).toEqual(o);
      maxT = Math.max(maxT, ...o.target.map(Math.abs));
      maxP = Math.max(maxP, ...o.position.map(Math.abs));
    }
    expect(maxT).toBeGreaterThan(0.1);
    expect(maxT).toBeLessThanOrEqual(0.5 + 1e-9);
    expect(maxP).toBeLessThan(maxT);
    const cam = { position: [0, -10, 2] as [number, number, number], target: [0, 0, 1] as [number, number, number] };
    expect(shakeCamera(cam, [s], 5, 24)).toBe(cam);
    expect(shakeCamera(cam, [s], 14, 24).target).not.toEqual(cam.target);
  });

  it('addCameraShake / removeCameraShake, saved with the project', () => {
    let doc = createDefaultDoc();
    doc = applyCommand(doc, validateCommand({ type: 'addCameraShake', start: 30, strength: 0.8, frequency: 11 })).doc;
    doc = applyCommand(doc, validateCommand({ type: 'addCameraShake', start: 5, end: 100 })).doc;
    expect(doc.animation!.shakes).toEqual([{ start: 5, end: 100, strength: 0.35 }, { start: 30, end: 54, strength: 0.8, frequency: 11 }]);
    expect(validateSceneDoc(JSON.parse(JSON.stringify(doc))).animation!.shakes).toEqual(doc.animation!.shakes);
    doc = applyCommand(doc, validateCommand({ type: 'removeCameraShake', start: 5 })).doc;
    expect(doc.animation!.shakes!.length).toBe(1);
    doc = applyCommand(doc, validateCommand({ type: 'removeCameraShake' })).doc;
    expect(doc.animation!.shakes).toBeUndefined();
    expect(() => validateCommand({ type: 'addCameraShake', start: 3, strength: 50 })).toThrow(/strength/);
    expect(() => applyCommand(doc, validateCommand({ type: 'addCameraShake', start: 30, end: 20 }))).toThrow(/end/);
  });
});
