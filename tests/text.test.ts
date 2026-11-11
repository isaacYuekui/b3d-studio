import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import opentype from 'opentype.js';
import { DEFAULT_TEXT, registerFont, textMesh } from '../src/core/text';
import { isWatertight, signedVolume } from '../src/core/mesh/topology';
import { applyCommand, validateCommand, validateSceneDoc } from '../src/core/commands';
import { createDefaultDoc } from '../src/core/store';

const load = (file: string) => {
  const b = readFileSync(file);
  return opentype.parse(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
};
registerFont('sans', load('node_modules/@fontsource/inter/files/inter-latin-700-normal.woff'));
registerFont('display', load('node_modules/@fontsource/bebas-neue/files/bebas-neue-latin-400-normal.woff'));
registerFont('serif', load('node_modules/@fontsource/playfair-display/files/playfair-display-latin-700-normal.woff'));

const span = (m: { vertices: number[][] }, k: number) => Math.max(...m.vertices.map((v) => v[k])) - Math.min(...m.vertices.map((v) => v[k]));

describe('3D text', () => {
  it('makes closed, outward-facing letters, holes included (O, B, 8)', () => {
    for (const font of ['sans', 'serif', 'display'] as const) {
      const m = textMesh({ ...DEFAULT_TEXT, body: 'OB8', font });
      expect(isWatertight(m)).toBe(true);
      expect(signedVolume(m)).toBeGreaterThan(0);
      expect(span(m, 2)).toBeCloseTo(0.2, 6);
    }
    // a hole really is a hole: an O has less volume than its filled outline would
    const o = textMesh({ ...DEFAULT_TEXT, body: 'O', depth: 1 });
    const filled = span(o, 0) * span(o, 1);
    expect(signedVolume(o)).toBeLessThan(filled * 0.6);
  });

  it('centres, sizes and stacks lines', () => {
    const one = textMesh({ ...DEFAULT_TEXT, body: 'HI' });
    const minX = Math.min(...one.vertices.map((v) => v[0])), maxX = Math.max(...one.vertices.map((v) => v[0]));
    expect(Math.abs(minX + maxX)).toBeLessThan(0.15); // centred
    const big = textMesh({ ...DEFAULT_TEXT, body: 'HI', size: 2 });
    expect(span(big, 0)).toBeCloseTo(span(one, 0) * 2, 1);
    const two = textMesh({ ...DEFAULT_TEXT, body: 'HI\nHI' });
    expect(span(two, 1)).toBeGreaterThan(span(one, 1) * 1.8);
    const left = textMesh({ ...DEFAULT_TEXT, body: 'HI', align: 'left' });
    expect(Math.min(...left.vertices.map((v) => v[0]))).toBeGreaterThanOrEqual(-0.01);
    const flat = textMesh({ ...DEFAULT_TEXT, body: 'A', depth: 0 });
    expect(span(flat, 2)).toBe(0);
    expect(() => textMesh({ ...DEFAULT_TEXT, body: 'မင်္ဂလာ' })).toThrow(/Latin/);
  });

  it('addText / setText commands; editing the mesh turns it into a plain mesh', () => {
    let doc = createDefaultDoc();
    doc = applyCommand(doc, validateCommand({ type: 'addText', id: 't', text: { body: 'Hello' } })).doc;
    const o = doc.objects.t;
    expect(o.type).toBe('mesh');
    expect(o.name).toBe('Text');
    expect(o.transform.rotation).toEqual([90, 0, 0]);
    expect(o.text).toMatchObject({ body: 'Hello', font: 'sans', size: 1 });
    const n0 = o.mesh!.faces.length;
    doc = applyCommand(doc, validateCommand({ type: 'setText', id: 't', text: { body: 'Hello world', font: 'display' } })).doc;
    expect(doc.objects.t.mesh!.faces.length).toBeGreaterThan(n0);
    expect(doc.objects.t.text!.font).toBe('display');
    // saved and loaded
    expect(validateSceneDoc(JSON.parse(JSON.stringify(doc))).objects.t.text).toEqual(doc.objects.t.text);
    // a direct mesh edit converts it
    doc = applyCommand(doc, validateCommand({ type: 'setMesh', id: 't', mesh: doc.objects.t.mesh })).doc;
    expect(doc.objects.t.text).toBeUndefined();
    expect(() => applyCommand(doc, validateCommand({ type: 'setText', id: 't', text: { body: 'x' } }))).toThrow(/isn't a text object/);
    expect(() => validateCommand({ type: 'addText', text: { body: '  ' } })).toThrow(/body/);
    expect(() => validateCommand({ type: 'addText', text: { body: 'a', font: 'comic' } })).toThrow(/font/);
  });
});
