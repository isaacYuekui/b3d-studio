import { describe, expect, it } from 'vitest';
import { bakeGraph, connect, defaultGraph, validateGraph } from '../src/core/shaderNodes';
import type { ShaderGraph } from '../src/core/shaderNodes';
import { applyCommand, validateCommand } from '../src/core/commands';
import { createDefaultDoc } from '../src/core/store';
import { DEFAULT_MATERIAL } from '../src/core/types';

const fail = (m: string): never => {
  throw new Error(m);
};
const noImages = () => null;

const g = (nodes: ShaderGraph['nodes'], links: ShaderGraph['links'] = []): ShaderGraph => validateGraph({ nodes, links }, fail);

describe('shader nodes', () => {
  it('a lone Principled BSDF bakes to constants (no maps)', () => {
    const r = bakeGraph(defaultGraph({ ...DEFAULT_MATERIAL, baseColor: '#ff0000', roughness: 0.3 }), 16, noImages);
    expect(r.base).toBe('#ff0000');
    expect(r.roughness).toBeCloseTo(0.3);
    expect(typeof r.metallic).toBe('number');
    expect(r.height).toBeUndefined();
  });

  it('pattern → color ramp → base colour; pattern → roughness; bump → normal', () => {
    const graph = g(
      [
        { id: 't', type: 'texture', x: 0, y: 0, props: { pattern: 'checker', scale: 2 } },
        { id: 'r', type: 'ramp', x: 0, y: 0, props: { c0: '#000000', c1: '#ff0000' } },
        { id: 'b', type: 'bump', x: 0, y: 0, props: { strength: 0.7 } },
        { id: 'out', type: 'principled', x: 0, y: 0, props: {} },
      ],
      [
        { from: 't', out: 'fac', to: 'r', in: 'fac' },
        { from: 'r', out: 'color', to: 'out', in: 'base' },
        { from: 't', out: 'fac', to: 'out', in: 'roughness' },
        { from: 't', out: 'fac', to: 'b', in: 'height' },
        { from: 'b', out: 'normal', to: 'out', in: 'normal' },
      ],
    );
    const r = bakeGraph(graph, 32, noImages);
    const base = r.base as Float32Array;
    expect(base).toBeInstanceOf(Float32Array);
    // Only red varies (ramp black → red).
    let maxR = 0, maxG = 0;
    for (let i = 0; i < 32 * 32; i++) {
      maxR = Math.max(maxR, base[i * 3]);
      maxG = Math.max(maxG, base[i * 3 + 1]);
    }
    expect(maxR).toBeGreaterThan(0.9);
    expect(maxG).toBe(0);
    expect(r.roughness).toBeInstanceOf(Float32Array);
    expect(r.height?.strength).toBe(0.7);
  });

  it('mix multiply, math and invert', () => {
    const graph = g(
      [
        { id: 'a', type: 'rgb', x: 0, y: 0, props: { color: '#808080' } },
        { id: 'm', type: 'mix', x: 0, y: 0, props: { mode: 'multiply', fac: 1, b: '#ff0000' } },
        { id: 'v', type: 'math', x: 0, y: 0, props: { op: 'multiply', a: 0.5, b: 0.4 } },
        { id: 'i', type: 'invert', x: 0, y: 0, props: { color: '#ffffff' } },
        { id: 'out', type: 'principled', x: 0, y: 0, props: {} },
      ],
      [
        { from: 'a', out: 'color', to: 'm', in: 'a' },
        { from: 'm', out: 'color', to: 'out', in: 'base' },
        { from: 'v', out: 'value', to: 'out', in: 'metallic' },
        { from: 'i', out: 'color', to: 'out', in: 'emission' },
      ],
    );
    const r = bakeGraph(graph, 8, noImages);
    expect(r.base).toBe('#800000');
    expect(r.metallic).toBeCloseTo(0.2);
    expect(r.emission).toBe('#000000');
  });

  it('image texture through the sampler; a missing one is magenta', () => {
    const px = new Uint8ClampedArray(8 * 8 * 4).fill(255);
    for (let i = 0; i < 64; i++) px[i * 4 + 1] = 0; // magenta-free check: green 0 → (255,0,255)
    const graph = g([{ id: 'im', type: 'image', x: 0, y: 0, props: { image: 'img-1' } }, { id: 'out', type: 'principled', x: 0, y: 0, props: {} }], [{ from: 'im', out: 'color', to: 'out', in: 'base' }]);
    const r = bakeGraph(graph, 8, (id) => (id === 'img-1' ? px : null));
    expect((r.base as Float32Array)[0]).toBe(1);
    expect((r.base as Float32Array)[1]).toBe(0);
    const missing = bakeGraph(graph, 8, noImages);
    expect(missing.base).toBe('#ff00ff');
  });

  it('validation: one Principled BSDF, no loops, links replace, normal only from Bump', () => {
    expect(() => g([{ id: 'v', type: 'value', x: 0, y: 0, props: {} }])).toThrow(/Principled/);
    const base = g([
      { id: 'a', type: 'math', x: 0, y: 0, props: {} },
      { id: 'b', type: 'math', x: 0, y: 0, props: {} },
      { id: 'out', type: 'principled', x: 0, y: 0, props: {} },
    ], [{ from: 'a', out: 'value', to: 'b', in: 'a' }]);
    expect(() => connect(base, { from: 'b', out: 'value', to: 'a', in: 'a' })).toThrow(/loop/);
    const re = connect(connect(base, { from: 'a', out: 'value', to: 'out', in: 'roughness' }), { from: 'b', out: 'value', to: 'out', in: 'roughness' });
    expect(re.links.filter((l) => l.to === 'out').map((l) => l.from)).toEqual(['b']);
    expect(() => connect(base, { from: 'a', out: 'value', to: 'out', in: 'normal' })).toThrow(/Bump/);
    expect(() => g([{ id: 'out', type: 'principled', x: 0, y: 0, props: { roughness: 3 } }])).toThrow(/Roughness/);
  });

  it('setMaterial with nodes, and back to none', () => {
    let doc = createDefaultDoc();
    const id = doc.order[0];
    doc = applyCommand(doc, validateCommand({ type: 'setMaterial', id, material: { nodes: defaultGraph(DEFAULT_MATERIAL) } })).doc;
    expect(doc.objects[id].material.nodes?.nodes).toHaveLength(1);
    doc = applyCommand(doc, validateCommand({ type: 'setMaterial', id, material: { nodes: null } })).doc;
    expect(doc.objects[id].material.nodes).toBeNull();
  });
});
