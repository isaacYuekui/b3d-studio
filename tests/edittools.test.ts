import { describe, expect, it } from 'vitest';
import { applyCommand, validateCommand, looseParts } from '../src/core/commands';
import { createDefaultDoc } from '../src/core/store';
import { proportionalWeights } from '../src/core/mesh/proportional';
import { primitiveMesh } from '../src/core/mesh/primitives';
import type { SceneDoc } from '../src/core/types';

let n = 0;
const ids = () => `n${n++}`;
const run = (doc: SceneDoc, cmd: unknown) => applyCommand(doc, validateCommand(cmd), ids);

describe('proportional editing weights', () => {
  it('1 at the selection, smooth falloff, 0 beyond the radius', () => {
    const pts: [number, number, number][] = [[0, 0, 0], [0.5, 0, 0], [1, 0, 0], [2, 0, 0]];
    const w = proportionalWeights(pts, [0], 1);
    expect(w.get(0)).toBe(1);
    expect(w.get(1)).toBeCloseTo(0.5625); // (1 − 0.25)²
    expect(w.has(2)).toBe(false);
    expect(w.has(3)).toBe(false);
  });
});

describe('separate and join', () => {
  it('separates selected faces into a new object and splits loose parts', () => {
    let d = run(createDefaultDoc(), { type: 'add', primitive: 'cube', id: 'c' }).doc;
    const r = run(d, { type: 'separate', id: 'c', faces: [0, 1] });
    d = r.doc;
    const part = d.objects[r.created[0]];
    expect(d.objects.c.mesh!.faces.length).toBe(4);
    expect(part.mesh!.faces.length).toBe(2);
    expect(part.transform).toEqual(d.objects.c.transform);
    // Two cubes joined, then split back apart by loose parts.
    let j = run(createDefaultDoc(), { type: 'add', primitive: 'cube', id: 'a' }).doc;
    j = run(j, { type: 'add', primitive: 'cube', id: 'b', transform: { position: [5, 0, 0], rotation: [0, 0, 90], scale: [0.5, 0.5, 0.5] } }).doc;
    j = run(j, { type: 'join', id: 'a', others: ['b'] }).doc;
    expect(j.objects.b).toBeUndefined();
    expect(j.objects.a.mesh!.vertices.length).toBe(16);
    expect(Math.max(...j.objects.a.mesh!.vertices.map((v) => v[0]))).toBeCloseTo(5.5); // b in a's space
    expect(looseParts(j.objects.a.mesh!).length).toBe(2);
    const s = run(j, { type: 'separate', id: 'a', mode: 'loose' });
    expect(s.created.length).toBe(1);
    expect(s.doc.objects.a.mesh!.faces.length).toBe(6);
  });

  it('explains what cannot be done', () => {
    const d = run(createDefaultDoc(), { type: 'add', primitive: 'cube', id: 'c' }).doc;
    expect(() => run(d, { type: 'separate', id: 'c', faces: [0, 1, 2, 3, 4, 5] })).toThrow(/whole mesh/);
    expect(() => run(d, { type: 'separate', id: 'c', mode: 'loose' })).toThrow(/all one piece/);
    expect(() => run(d, { type: 'join', id: 'c', others: ['c'] })).toThrow(/at least one other/);
    expect(primitiveMesh('cube').faces.length).toBe(6);
  });
});
