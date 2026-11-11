import { describe, expect, it } from 'vitest';
import { particlesAt, PARTICLE_PRESETS } from '../src/core/particles';
import { applyCommand, validateCommand, validateSceneDoc } from '../src/core/commands';
import { createDefaultDoc } from '../src/core/store';
import type { SceneDoc } from '../src/core/types';

function emitter(particles: Record<string, unknown>, extra: unknown[] = []): SceneDoc {
  let doc = createDefaultDoc();
  doc = applyCommand(doc, validateCommand({ type: 'delete', ids: [...doc.order] })).doc;
  for (const c of [{ type: 'setAnimation', fps: 24, start: 1, end: 120 }, { type: 'add', primitive: 'sphere', id: 'e', transform: { position: [0, 0, 2], scale: [0.2, 0.2, 0.2] } }, { type: 'setParticles', id: 'e', particles }, ...extra])
    doc = applyCommand(doc, validateCommand(c)).doc;
  return doc;
}

describe('particles', () => {
  it('emit evenly over the frame range and die after their lifetime', () => {
    const doc = emitter({ count: 100, start: 1, end: 100, lifetime: 10, speed: 1, random: 0 });
    expect(particlesAt(doc, 'e', 0, 24).positions.length).toBe(0);
    const mid = particlesAt(doc, 'e', 50, 24).positions.length;
    expect(mid).toBeGreaterThanOrEqual(9);
    expect(mid).toBeLessThanOrEqual(11);
    expect(particlesAt(doc, 'e', 115, 24).positions.length).toBe(0);
  });

  it('fly off the surface and fall with gravity; the same frame always gives the same answer', () => {
    const doc = emitter({ count: 50, start: 1, end: 1, lifetime: 100, speed: 3, random: 0, gravity: 1 });
    const a = particlesAt(doc, 'e', 25, 24); // 1 s after birth
    const b = particlesAt(doc, 'e', 25, 24);
    expect(a).toEqual(b);
    for (const p of a.positions) {
      // 3 m/s outwards for 1 s (+ the ball's 0.2 m radius), measured from where gravity took the centre
      const r = Math.hypot(p[0], p[1], p[2] - (2 - 0.5 * 9.81));
      expect(r).toBeCloseTo(3.2, 1);
    }
    // Centre of mass drops by about ½ g t² (the outward speeds cancel out)
    const cz = a.positions.reduce((s, p) => s + p[2], 0) / a.positions.length;
    expect(cz).toBeCloseTo(2 - 0.5 * 9.81, 0);
  });

  it('land and stay on the ground when asked', () => {
    const doc = emitter({ count: 30, start: 1, end: 1, lifetime: 200, speed: 0, random: 1, gravity: 1, ground: 'stop' });
    const late = particlesAt(doc, 'e', 150, 24);
    expect(late.positions.every((p) => Math.abs(p[2]) < 1e-6)).toBe(true);
    const free = emitter({ count: 30, start: 1, end: 1, lifetime: 200, speed: 0, random: 1, gravity: 1, ground: 'none' });
    expect(particlesAt(free, 'e', 150, 24).positions.every((p) => p[2] < -10)).toBe(true);
  });

  it('a moving emitter leaves a trail', () => {
    const doc = emitter({ count: 48, start: 1, end: 48, lifetime: 100, speed: 0, random: 0, gravity: 0 }, [
      { type: 'setKeyframe', id: 'e', frame: 1, transform: { position: [0, 0, 2], rotation: [0, 0, 0], scale: [0.2, 0.2, 0.2] } },
      { type: 'setKeyframe', id: 'e', frame: 48, transform: { position: [10, 0, 2], rotation: [0, 0, 0], scale: [0.2, 0.2, 0.2] } },
    ]);
    const xs = particlesAt(doc, 'e', 48, 24).positions.map((p) => p[0]);
    expect(Math.min(...xs)).toBeLessThan(1);
    expect(Math.max(...xs)).toBeGreaterThan(9);
  });

  it('setParticles merges, null removes, presets validate, and it is saved', () => {
    let doc = emitter({});
    expect(doc.objects.e.particles).toMatchObject({ count: 500, start: 1, lifetime: 50 });
    for (const pr of PARTICLE_PRESETS) doc = applyCommand(doc, validateCommand({ type: 'setParticles', id: 'e', particles: pr.settings })).doc;
    expect(doc.objects.e.particles!.shape).toBe('cube');
    expect(validateSceneDoc(JSON.parse(JSON.stringify(doc))).objects.e.particles).toEqual(doc.objects.e.particles);
    doc = applyCommand(doc, validateCommand({ type: 'setParticles', id: 'e', particles: null })).doc;
    expect(doc.objects.e.particles).toBeUndefined();
    expect(() => validateCommand({ type: 'setParticles', id: 'e', particles: { count: 0 } })).toThrow(/count/);
    expect(() => validateCommand({ type: 'setParticles', id: 'e', particles: { colour: '#fff' } })).toThrow(/no setting/);
  });
});

describe('fire, smoke and wind', () => {
  it('negative gravity rises, wind pushes sideways, life runs 0 → 1', () => {
    const doc = emitter({ count: 40, start: 1, end: 1, lifetime: 48, speed: 0, random: 0, gravity: -0.2, wind: [1, 0, 0], shape: 'smoke' });
    const f = particlesAt(doc, 'e', 25, 24); // 1 s in
    const cz = f.positions.reduce((s, p) => s + p[2], 0) / f.positions.length;
    const cx = f.positions.reduce((s, p) => s + p[0], 0) / f.positions.length;
    expect(cz).toBeCloseTo(2 + 0.5 * 0.2 * 9.81, 1);
    expect(cx).toBeCloseTo(0.5, 1);
    expect(f.life.every((t) => Math.abs(t - 0.5) < 1e-9)).toBe(true);
    expect(() => validateCommand({ type: 'setParticles', id: 'e', particles: { wind: [1, 2] } })).toThrow(/wind/);
  });
});
