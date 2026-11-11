import { beforeAll, describe, expect, it } from 'vitest';
import { loadBooleans, meshBoolean } from '../src/core/mesh/boolean';
import { primitiveMesh } from '../src/core/mesh/primitives';
import { isWatertight, signedVolume } from '../src/core/mesh/topology';
import { applyCommand, validateCommand } from '../src/core/commands';
import { createDefaultDoc } from '../src/core/store';
import type { MeshData, SceneDoc } from '../src/core/types';

const shift = (m: MeshData, d: number[], k = 1): MeshData => ({ ...m, vertices: m.vertices.map((v) => [v[0] * k + d[0], v[1] * k + d[1], v[2] * k + d[2]]) });

describe('booleans', () => {
  beforeAll(() => loadBooleans());

  it('difference, union and intersect of two cubes have the right volumes and stay closed', () => {
    const a = primitiveMesh('cube'); // 2×2×2 = 8 m³
    const b = shift(primitiveMesh('cube'), [1, 0, 0]); // overlaps half of a
    const diff = meshBoolean(a, b, 'difference');
    const uni = meshBoolean(a, b, 'union');
    const int = meshBoolean(a, b, 'intersect');
    expect(signedVolume(diff)).toBeCloseTo(4, 4);
    expect(signedVolume(uni)).toBeCloseTo(12, 4);
    expect(signedVolume(int)).toBeCloseTo(4, 4);
    for (const m of [diff, uni, int]) expect(isWatertight(m)).toBe(true);
  });

  it('the boolean command cuts a hole with a rotated, moved cutter and hides it', () => {
    let doc: SceneDoc = createDefaultDoc();
    const run = (cmd: unknown) => (doc = applyCommand(doc, validateCommand(cmd)).doc);
    run({ type: 'add', primitive: 'cube', id: 'block', transform: { position: [5, 0, 0] } });
    run({ type: 'add', primitive: 'cylinder', id: 'drill', params: { radiusTop: 0.4, radiusBottom: 0.4, segments: 48 }, transform: { position: [5, 0, 0], rotation: [90, 0, 0], scale: [1, 1, 2] } });
    run({ type: 'boolean', id: 'block', cutter: 'drill', op: 'difference' });
    const m = doc.objects.block.mesh!;
    // 8 m³ minus a 0.4 m-radius hole 2 m long ≈ 8 − π·0.16·2
    expect(signedVolume(m)).toBeCloseTo(8 - Math.PI * 0.16 * 2, 1);
    expect(isWatertight(m)).toBe(true);
    expect(doc.objects.drill.visible).toBe(false);
    // The hole runs along Y (the cylinder was turned 90° about X): the block's centre is empty along Y.
    expect(m.vertices.some((v) => Math.abs(v[1] + 1) < 1e-4 && Math.hypot(v[0], v[2]) < 0.41)).toBe(true);
  });

  it('explains bad input', () => {
    expect(() => validateCommand({ type: 'boolean', id: 'a', cutter: 'b', op: 'xor' })).toThrow(/op must be/);
    let doc = createDefaultDoc();
    doc = applyCommand(doc, validateCommand({ type: 'add', primitive: 'plane', id: 'sheet' })).doc;
    doc = applyCommand(doc, validateCommand({ type: 'add', primitive: 'cube', id: 'c' })).doc;
    expect(() => applyCommand(doc, validateCommand({ type: 'boolean', id: 'c', cutter: 'sheet' }))).toThrow(/closed solid/);
  });
});
