import { describe, expect, it } from 'vitest';
import { PATTERNS, patternValues } from '../src/core/patterns';
import { applyCommand, validateCommand } from '../src/core/commands';
import { createDefaultDoc } from '../src/core/store';

describe('procedural patterns', () => {
  it.each(PATTERNS)('%s is deterministic, in 0..1 and (except gradient) tiles seamlessly', (type) => {
    const n = 64;
    const a = patternValues(type, n), b = patternValues(type, n);
    expect(a).toEqual(b);
    for (const v of a) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
    if (type === 'gradient' || type === 'checker' || type === 'bricks') return; // hard edges by design
    // Seam: the jump across the wrap is no bigger than typical neighbour steps.
    const step = (i: number, j: number, k: number, l: number) => Math.abs(a[j * n + i] - a[l * n + k]);
    let inner = 0, seam = 0;
    for (let j = 0; j < n; j++) {
      inner = Math.max(inner, step(n / 2, j, n / 2 - 1, j));
      seam = Math.max(seam, step(0, j, n - 1, j));
    }
    expect(seam).toBeLessThan(Math.max(0.35, inner * 3));
  });

  it('noise has real variation; checker is two-tone', () => {
    const v = patternValues('noise', 64);
    expect(Math.max(...v) - Math.min(...v)).toBeGreaterThan(0.5);
    expect(new Set(patternValues('checker', 16)).size).toBe(2);
  });
});

describe('Principled material fields', () => {
  it('validate, store and merge', () => {
    let d = applyCommand(createDefaultDoc(), validateCommand({ type: 'add', primitive: 'cube', id: 'c' })).doc;
    d = applyCommand(d, validateCommand({ type: 'setMaterial', id: 'c', material: { clearcoat: 1, transmission: 0.9, ior: 1.45, pattern: { type: 'marble', scale: 0.5 } } })).doc;
    const m = d.objects.c.material!;
    expect(m.clearcoat).toBe(1);
    expect(m.ior).toBe(1.45);
    expect(m.pattern).toEqual({ type: 'marble', colorA: '#2b2b2b', colorB: '#d8d8d8', scale: 0.5, bump: 0.3 });
    d = applyCommand(d, validateCommand({ type: 'setMaterial', id: 'c', material: { pattern: null } })).doc;
    expect(d.objects.c.material!.pattern).toBeNull();
    expect(() => validateCommand({ type: 'setMaterial', id: 'c', material: { ior: 5 } })).toThrow(/ior/);
    expect(() => validateCommand({ type: 'setMaterial', id: 'c', material: { pattern: { type: 'plaid' } } })).toThrow(/pattern.type/);
  });
});
