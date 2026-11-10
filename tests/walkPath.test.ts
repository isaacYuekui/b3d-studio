import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { applyCommand, validateCommand } from '../src/core/commands';
import { registerHuman } from '../src/core/humans';
import type { HumanData } from '../src/core/humans';
import { polylineRoute } from '../src/core/motion';
import { transformAt } from '../src/core/animation';
import { terrainSample } from '../src/core/terrain';
import type { SceneDoc } from '../src/core/types';

describe('polyline routes', () => {
  it('measures length, interpolates and turns the short way round', () => {
    const r = polylineRoute([[0, 0], [0, 10], [10, 10]]);
    expect(r.length).toBeCloseTo(20);
    expect(r.at(5)).toMatchObject({ x: 0, y: 5 });
    expect(r.at(15)).toMatchObject({ x: 5, y: 10 });
    // Rigs face −Y: walking +Y is heading 180°, walking +X is heading 90° (or −270°): the turn is 90°, not 270°.
    const h0 = (r.at(2).heading * 180) / Math.PI, h1 = (r.at(18).heading * 180) / Math.PI;
    expect(Math.abs(Math.abs(h0) - 180)).toBeLessThan(1e-6);
    expect(Math.abs(h1 - h0)).toBeCloseTo(90, 5);
    // Smooth through the corner.
    const near = [9.5, 9.8, 10, 10.2, 10.5].map((d) => (r.at(d).heading * 180) / Math.PI);
    for (let i = 1; i < near.length; i++) expect(Math.abs(near[i] - near[i - 1])).toBeLessThan(40);
    expect(() => polylineRoute([[1, 1], [1, 1]])).toThrow(/two different points/);
  });
});

const file = 'public/library/humans/male.json';
const have = fs.existsSync(file);

describe.runIf(have)('walkPath', () => {
  registerHuman('male', JSON.parse(fs.readFileSync(have ? file : '/dev/null', 'utf8') || '{}') as HumanData);
  let n = 0;
  const ids = () => `w${n++}`;
  const run = (doc: SceneDoc, cmd: unknown) => applyCommand(doc, validateCommand(cmd), ids).doc;

  it('walks the whole path over terrain, facing along it, feet on the ground', () => {
    let doc: SceneDoc = { objects: {}, order: [] };
    doc = run(doc, { type: 'addTerrain', id: 'land', size: [60, 60], resolution: 60, height: 6, seed: 4 });
    doc = run(doc, { type: 'addHuman', id: 'bob', preset: 'male' });
    const pts: [number, number][] = [[-10, -10], [-10, 5], [8, 5]];
    doc = run(doc, { type: 'walkPath', id: 'bob', points: pts, start: 1 });
    const keys = doc.animation!.tracks.bob;
    const last = keys[keys.length - 1];
    // Ends at the last point, after ~33 m at 1.45 m per 30-frame cycle.
    expect(Math.hypot(last.transform.position[0] - 8, last.transform.position[1] - 5)).toBeLessThan(0.3);
    expect(last.frame).toBeGreaterThan(600);
    expect(doc.animation!.end).toBeGreaterThanOrEqual(last.frame);
    // Facing: on the first leg (+Y) about 180°, on the last leg (+X) about 90° or −270°.
    const mid1 = transformAt(doc, 'bob', 120)!;
    expect(Math.abs(Math.abs(mid1.rotation[2]) - 180)).toBeLessThan(2);
    const mid2 = transformAt(doc, 'bob', last.frame - 60)!;
    expect(((mid2.rotation[2] % 360) + 360) % 360).toBeCloseTo(90, 0);
    // Height follows the terrain (within the stride bob of a few cm).
    for (const k of keys.filter((_, i) => i % 10 === 0)) {
      const g = terrainSample(doc.objects.land, k.transform.position[0], k.transform.position[1])!.z;
      expect(Math.abs(k.transform.position[2] - g)).toBeLessThan(0.12);
    }
  });

  it('rejects bad paths', () => {
    expect(() => validateCommand({ type: 'walkPath', id: 'bob', points: [[0, 0]], start: 1 })).toThrow(/points/);
    expect(() => validateCommand({ type: 'walkPath', id: 'bob', points: [[0, 0], [1, 1]], start: 1, action: 'fly' })).toThrow(/walk or run/);
  });
});
