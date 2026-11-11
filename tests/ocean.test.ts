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
