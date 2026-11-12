import { describe, expect, it } from 'vitest';
import { oceanDisplace, oceanGrid } from '../src/core/ocean';
import { applyCommand, validateCommand, validateSceneDoc } from '../src/core/commands';
import { createDefaultDoc } from '../src/core/store';
import { PARTICLE_PRESETS } from '../src/core/particles';

describe('ocean waves', () => {
  it('flat when height is 0; bounded by half the height; moves with time', () => {
    expect(oceanDisplace(3, 4, 1, { waves: 1, speed: 0.2 })).toEqual([0, 0, 0]);
    const w = { waves: 1.5, speed: 0.2, height: 2, direction: 30 };
    let max = 0;
    for (let i = 0; i < 400; i++) {
      const d = oceanDisplace((i * 0.37) % 40, (i * 1.13) % 40, i * 0.05, w);
      max = Math.max(max, Math.abs(d[2]));
      expect(Math.hypot(d[0], d[1])).toBeLessThan(2);
    }
    expect(max).toBeGreaterThan(0.4);
    expect(max).toBeLessThanOrEqual(1 + 1e-9);
    expect(oceanDisplace(5, 5, 0, w)).not.toEqual(oceanDisplace(5, 5, 0.5, w));
    expect(oceanDisplace(5, 5, 0.5, w)).toEqual(oceanDisplace(5, 5, 0.5, w));
  });

  it('grid is fine enough but capped for tablets', () => {
    const [nx, ny] = oceanGrid(40, 40, { waves: 1.5, speed: 0.2, height: 1 });
    expect((nx + 1) * (ny + 1)).toBeLessThanOrEqual(40000);
    expect(nx).toBeGreaterThan(50);
    const [sx, sy] = oceanGrid(2, 2, { waves: 1.5, speed: 0.2, height: 1 });
    expect(sx).toBeGreaterThanOrEqual(8);
    expect(sy).toBeGreaterThanOrEqual(8);
  });

  it('addWater takes a wave height; setWater changes it; it is saved', () => {
    let doc = createDefaultDoc();
    doc = applyCommand(doc, validateCommand({ type: 'addWater', id: 'sea', size: [50, 50], level: 0, height: 1.2, direction: 45 })).doc;
    expect(doc.objects.sea.water).toEqual({ waves: 1.2, speed: 0.25, height: 1.2, direction: 45 });
    doc = applyCommand(doc, validateCommand({ type: 'setWater', id: 'sea', water: { height: 3.5, waves: 6 } })).doc;
    expect(doc.objects.sea.water).toMatchObject({ height: 3.5, waves: 6, direction: 45 });
    expect(validateSceneDoc(JSON.parse(JSON.stringify(doc))).objects.sea.water).toEqual(doc.objects.sea.water);
    expect(() => validateCommand({ type: 'setWater', id: 'sea', water: { height: 50 } })).toThrow(/height/);
    doc = applyCommand(doc, validateCommand({ type: 'add', primitive: 'cube', id: 'c' })).doc;
    expect(() => applyCommand(doc, validateCommand({ type: 'setWater', id: 'c', water: { height: 1 } }))).toThrow(/isn't water/);
  });

  it('burst presets are short emission windows', () => {
    const ex = PARTICLE_PRESETS.find((p) => p.id === 'explosion')!;
    expect(ex.burst).toBeGreaterThan(0);
    expect(ex.settings.shape).toBe('fire');
  });
});

describe('float on water', () => {
  it('rides the waves: height follows the surface, tilts on slopes, nothing when off the water', async () => {
    const { floatTransform, oceanDisplace } = await import('../src/core/ocean');
    let doc = createDefaultDoc();
    doc = applyCommand(doc, validateCommand({ type: 'addWater', id: 'sea', size: [40, 40], level: 1, height: 2, waves: 2 })).doc;
    doc = applyCommand(doc, validateCommand({ type: 'add', primitive: 'cube', id: 'boat', transform: { position: [3, 4, 5], rotation: [0, 0, 30] } })).doc;
    expect(floatTransform(doc, 'boat', 10)).toBeNull();
    doc = applyCommand(doc, validateCommand({ type: 'setFloat', id: 'boat', float: { offset: -0.3 } })).doc;
    const fps = 24;
    const zs: number[] = [];
    for (const f of [1, 7, 13, 19]) {
      const t = floatTransform(doc, 'boat', f)!;
      const want = 1 + oceanDisplace(3, 4, f / fps, doc.objects.sea.water!)[2] - 0.3;
      expect(t.position[2]).toBeCloseTo(want, 3);
      expect(t.position.slice(0, 2)).toEqual([3, 4]);
      expect(t.rotation[2]).toBe(30);
      zs.push(t.position[2]);
    }
    expect(new Set(zs.map((z) => z.toFixed(3))).size).toBeGreaterThan(1);
    const tilts = [1, 5, 9, 13].map((f) => floatTransform(doc, 'boat', f)!.rotation.slice(0, 2));
    expect(tilts.some(([x, y]) => Math.abs(x) + Math.abs(y) > 1)).toBe(true);
    doc = applyCommand(doc, validateCommand({ type: 'add', primitive: 'cube', id: 'far', transform: { position: [100, 0, 0] } })).doc;
    doc = applyCommand(doc, validateCommand({ type: 'setFloat', id: 'far', float: { offset: 0 } })).doc;
    expect(floatTransform(doc, 'far', 5)).toBeNull();
    expect(validateSceneDoc(JSON.parse(JSON.stringify(doc))).objects.boat.float).toEqual({ offset: -0.3 });
    doc = applyCommand(doc, validateCommand({ type: 'setFloat', id: 'boat', float: null })).doc;
    expect(doc.objects.boat.float).toBeUndefined();
    expect(() => applyCommand(doc, validateCommand({ type: 'setFloat', id: 'sea', float: { offset: 0 } }))).toThrow(/Water can't float/);
  });
});

describe('tsunami surge', () => {
  it('a sech² wall that travels at its speed, from its start frame', async () => {
    const { oceanDisplace } = await import('../src/core/ocean');
    const w = { waves: 1, speed: 0, surge: { height: 10, start: 25, speed: 20, width: 20, from: -50 } };
    // before it starts (frame 13 → t 0.5 s) it sits at −50
    expect(oceanDisplace(-50, 0, 0.5, w)[2]).toBeCloseTo(10, 6);
    expect(oceanDisplace(0, 0, 0.5, w)[2]).toBeLessThan(0.01);
    // frame 25 is its start: 2 s later (t = 1 + 2 = 3 s) the crest is at −50 + 40 = −10
    expect(oceanDisplace(-10, 0, 3, w)[2]).toBeCloseTo(10, 6);
    expect(oceanDisplace(-10, 30, 3, w)[2]).toBeCloseTo(10, 6); // a straight front
    expect(oceanDisplace(20, 0, 3, w)[2]).toBeLessThan(0.5);
  });

  it('carries floating objects along and validates', async () => {
    const { floatTransform } = await import('../src/core/ocean');
    let doc = createDefaultDoc();
    doc = applyCommand(doc, validateCommand({ type: 'addWater', id: 'sea', size: [200, 60], level: 0 })).doc;
    doc = applyCommand(doc, validateCommand({ type: 'setWater', id: 'sea', water: { surge: { height: 6, start: 1, speed: 15, width: 16, from: -60 } } })).doc;
    doc = applyCommand(doc, validateCommand({ type: 'add', primitive: 'cube', id: 'boat', transform: { position: [-20, 0, 0] } })).doc;
    doc = applyCommand(doc, validateCommand({ type: 'setFloat', id: 'boat', float: { offset: 0 } })).doc;
    const at = (f: number) => floatTransform(doc, 'boat', f)!.position;
    const peak = Math.max(...[30, 40, 50, 60, 70].map((f) => at(f)[2]));
    expect(peak).toBeGreaterThan(3); // lifted by the wave
    expect(at(120)[0]).toBeGreaterThan(-20 + 3); // and carried forward
    expect(doc.objects.sea.water!.surge).toEqual({ height: 6, start: 1, speed: 15, width: 16, from: -60 });
    expect(validateSceneDoc(JSON.parse(JSON.stringify(doc))).objects.sea.water!.surge).toEqual(doc.objects.sea.water!.surge);
    doc = applyCommand(doc, validateCommand({ type: 'setWater', id: 'sea', water: { surge: null } })).doc;
    expect(doc.objects.sea.water!.surge).toBeUndefined();
    expect(() => validateCommand({ type: 'setWater', id: 'sea', water: { surge: { height: 500 } } })).toThrow(/surge.height/);
  });
});

describe('wave spray (v3.14)', () => {
  it('is thrown off the top of the giant wave while it crosses the water', async () => {
    const { particlesAt, crestFrames } = await import('../src/core/particles');
    let doc = createDefaultDoc();
    doc = applyCommand(doc, validateCommand({ type: 'delete', ids: [...doc.order] })).doc;
    for (const c of [
      { type: 'addWater', id: 'sea', size: [100, 60], level: 0, direction: 0 },
      { type: 'setWater', id: 'sea', water: { surge: { height: 8, start: 10, speed: 12, width: 16, from: -80 } } },
    ])
      doc = applyCommand(doc, validateCommand(c)).doc;
    const span = crestFrames(doc.objects.sea, 24)!;
    // front reaches x = -50 after 30 m → 2.5 s = 60 frames after frame 9; leaves x = 50 after 130 m.
    expect(span.start).toBe(69);
    expect(span.end).toBe(269);
    const spray = PARTICLE_PRESETS.find((p) => p.id === 'spray')!;
    doc = applyCommand(doc, validateCommand({ type: 'setParticles', id: 'sea', particles: { ...spray.settings, ...span, seed: 3 } })).doc;
    expect(doc.objects.sea.particles?.emit).toBe('crest');
    expect(particlesAt(doc, 'sea', 60, 24).positions.length).toBe(0);
    const at = (f: number) => particlesAt(doc, 'sea', f, 24);
    const f = 150;
    const front = -80 + 12 * ((f - 9) / 24);
    const ps = at(f);
    expect(ps.positions.length).toBeGreaterThan(100);
    const young = ps.positions.filter((_, i) => ps.life[i] < 0.05);
    expect(young.length).toBeGreaterThan(5);
    for (const p of young) {
      expect(Math.abs(p[0] - front)).toBeLessThan(12); // near the crest
      expect(p[2]).toBeGreaterThan(3); // up on the wave
      expect(Math.abs(p[1])).toBeLessThan(31); // across the water
    }
    // On average the spray moves forward with the wave.
    const meanX = (r: { positions: number[][] }) => r.positions.reduce((s, p) => s + p[0], 0) / r.positions.length;
    expect(meanX(at(f + 12))).toBeGreaterThan(meanX(ps));
    // Not on water / no surge: crest falls back to nothing special.
    expect(validateCommand({ type: 'setParticles', id: 'sea', particles: { emit: 'surface' } }).type).toBe('setParticles');
    expect(() => validateCommand({ type: 'setParticles', id: 'sea', particles: { emit: 'sky' } })).toThrow(/emit/);
  });
});
