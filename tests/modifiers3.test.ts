import { describe, expect, it } from 'vitest';
import { applyModifiers, arrayModifier, displace, fbm3, hasModifiers, solidify } from '../src/core/mesh/modifiers';
import { primitiveMesh } from '../src/core/mesh/primitives';
import { isWatertight, signedVolume } from '../src/core/mesh/topology';
import { applyCommand, validateCommand } from '../src/core/commands';
import { createDefaultDoc } from '../src/core/store';
import type { MeshData } from '../src/core/types';

const cube = () => primitiveMesh('cube'); // 2 m, vertices at ±1
const plane = (): MeshData => ({ vertices: [[-1, -1, 0], [1, -1, 0], [1, 1, 0], [-1, 1, 0]], faces: [[0, 1, 2, 3]], smooth: false });
const span = (m: MeshData, k: number) => Math.max(...m.vertices.map((v) => v[k])) - Math.min(...m.vertices.map((v) => v[k]));

describe('Array modifier', () => {
  it('three touching cubes merge into one clean solid', () => {
    const m = arrayModifier(cube(), 3, [1, 0, 0]);
    expect(span(m, 0)).toBeCloseTo(6, 9);
    expect(m.vertices.length).toBe(16); // 8 + 4 + 4
    expect(m.faces.length).toBe(14); // 18 − the 4 faces where copies touch
    expect(isWatertight(m)).toBe(true);
    expect(signedVolume(m)).toBeCloseTo(24, 6);
  });

  it('without merge, copies stay separate; relative + constant offsets add up', () => {
    const m = arrayModifier(cube(), 3, [1, 0, 0], [0.5, 0, 1], false);
    expect(m.vertices.length).toBe(24);
    expect(m.faces.length).toBe(18);
    expect(span(m, 0)).toBeCloseTo(2 * 2.5 + 2, 9);
    expect(span(m, 2)).toBeCloseTo(2 + 2, 9);
  });

  it('gapped copies do not weld; a strip of planes welds edge to edge', () => {
    expect(arrayModifier(cube(), 2, [1.5, 0, 0]).vertices.length).toBe(16);
    const strip = arrayModifier(plane(), 4, [1, 0, 0]);
    expect(strip.vertices.length).toBe(10);
    expect(strip.faces.length).toBe(4);
  });

  it('caps the copy count so the result stays light', () => {
    const big = primitiveMesh('sphere');
    const m = arrayModifier(big, 1000, [1, 0, 0], [0, 0, 0], false);
    expect(m.faces.reduce((s, f) => s + f.length, 0)).toBeLessThanOrEqual(400_000);
  });
});

describe('Solidify modifier', () => {
  it('gives a plane thickness: two shells and a rim, closed', () => {
    const m = solidify(plane(), 0.1);
    expect(m.vertices.length).toBe(8);
    expect(m.faces.length).toBe(6);
    expect(isWatertight(m)).toBe(true);
    expect(signedVolume(m)).toBeCloseTo(0.4, 6); // 2 × 2 × 0.1, normals out
    expect(Math.min(...m.vertices.map((v) => v[2]))).toBeCloseTo(-0.1, 9); // grows inwards (offset −1)
  });

  it('offset 1 grows outwards; a negative thickness still faces out', () => {
    const out = solidify(plane(), 0.1, 1);
    expect(Math.max(...out.vertices.map((v) => v[2]))).toBeCloseTo(0.1, 9);
    expect(signedVolume(out)).toBeGreaterThan(0);
    expect(signedVolume(solidify(plane(), -0.1))).toBeGreaterThan(0);
  });

  it('a closed mesh becomes a hollow shell (no rim)', () => {
    const m = solidify(cube(), 0.1);
    expect(m.faces.length).toBe(12);
    expect(isWatertight(m)).toBe(true);
  });
});

describe('Displace modifier', () => {
  it('is deterministic, bounded by strength, and changes with the seed', () => {
    const base = applyModifiers(primitiveMesh('sphere'), { subdivision: { levels: 1 } });
    const a = displace(base, 0.2, 0.5, 1);
    const b = displace(base, 0.2, 0.5, 1);
    const c = displace(base, 0.2, 0.5, 2);
    expect(a.vertices).toEqual(b.vertices);
    expect(a.vertices).not.toEqual(c.vertices);
    expect(a.faces.length).toBe(base.faces.length);
    let max = 0;
    a.vertices.forEach((v, i) => (max = Math.max(max, Math.hypot(v[0] - base.vertices[i][0], v[1] - base.vertices[i][1], v[2] - base.vertices[i][2]))));
    expect(max).toBeGreaterThan(0.01);
    expect(max).toBeLessThanOrEqual(0.2 + 1e-9);
  });

  it('noise stays within −1..1', () => {
    for (let i = 0; i < 500; i++) {
      const n = fbm3(i * 0.37, i * 0.11 - 3, i * 0.53 + 7, 3);
      expect(Math.abs(n)).toBeLessThanOrEqual(1);
    }
  });
});

describe('modifier stack and setModifiers', () => {
  it('runs Array → Solidify → Subdivision → Displace and reports them', () => {
    expect(hasModifiers({ array: { count: 2, relative: [1, 0, 0] } })).toBe(true);
    expect(hasModifiers({ array: { count: 1, relative: [1, 0, 0] } })).toBe(false);
    expect(hasModifiers({ solidify: { thickness: 0.02 } })).toBe(true);
    expect(hasModifiers({ displace: { strength: 0.1, scale: 1 } })).toBe(true);
    const m = applyModifiers(plane(), { array: { count: 3, relative: [1, 0, 0] }, solidify: { thickness: 0.05 }, subdivision: { levels: 1 } });
    expect(isWatertight(m)).toBe(true);
    expect(span(m, 0)).toBeGreaterThan(5);
  });

  it('validates and merges the new modifiers; null removes one', () => {
    let doc = createDefaultDoc();
    doc = applyCommand(doc, validateCommand({ type: 'add', primitive: 'cube', id: 'c' })).doc;
    doc = applyCommand(doc, validateCommand({ type: 'setModifiers', id: 'c', modifiers: { array: { count: 4, relative: [0, 1, 0], constant: [0, 0.1, 0] }, solidify: { thickness: 0.02 }, displace: { strength: 0.05, scale: 0.3, seed: 7 } } })).doc;
    const mods = doc.objects.c.modifiers!;
    expect(mods.array).toEqual({ count: 4, relative: [0, 1, 0], constant: [0, 0.1, 0] });
    expect(mods.solidify).toEqual({ thickness: 0.02 });
    expect(mods.displace).toEqual({ strength: 0.05, scale: 0.3, seed: 7 });
    doc = applyCommand(doc, validateCommand({ type: 'setModifiers', id: 'c', modifiers: { array: { count: 2 }, solidify: null } })).doc;
    expect(doc.objects.c.modifiers!.array!.count).toBe(2);
    expect(doc.objects.c.modifiers!.array!.relative).toEqual([0, 1, 0]); // other settings kept
    expect(doc.objects.c.modifiers!.solidify).toBeUndefined();
    expect(() => validateCommand({ type: 'setModifiers', id: 'c', modifiers: { array: { count: 0 } } })).toThrow(/count/);
    expect(() => validateCommand({ type: 'setModifiers', id: 'c', modifiers: { array: { count: 3.5 } } })).toThrow(/count/);
    expect(() => validateCommand({ type: 'setModifiers', id: 'c', modifiers: { wobble: {} } })).toThrow(/unknown modifier/);
    expect(() => validateCommand({ type: 'setModifiers', id: 'c', modifiers: { displace: { strength: 0.1, scale: 0 } } })).toThrow(/scale/);
  });
});

describe('setModifiers patches', () => {
  it('a patch with only some settings creates the modifier with defaults, and later patches keep the rest', () => {
    let doc = applyCommand(createDefaultDoc(), validateCommand({ type: 'add', primitive: 'cube', id: 'c' })).doc;
    doc = applyCommand(doc, validateCommand({ type: 'setModifiers', id: 'c', modifiers: { array: { relative: [0, 0, 1.2] }, bevel: { segments: 3 } } })).doc;
    expect(doc.objects.c.modifiers!.array).toEqual({ count: 2, relative: [0, 0, 1.2] });
    expect(doc.objects.c.modifiers!.bevel).toEqual({ width: 0.02, segments: 3, angle: 30 });
    doc = applyCommand(doc, validateCommand({ type: 'setModifiers', id: 'c', modifiers: { bevel: { width: 0.05 } } })).doc;
    expect(doc.objects.c.modifiers!.bevel).toEqual({ width: 0.05, segments: 3, angle: 30 });
  });
});
