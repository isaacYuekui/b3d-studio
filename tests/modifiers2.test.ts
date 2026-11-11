import { describe, expect, it } from 'vitest';
import { applyModifiers, sharpEdges } from '../src/core/mesh/modifiers';
import { primitiveMesh } from '../src/core/mesh/primitives';
import { isWatertight, signedVolume } from '../src/core/mesh/topology';
import { applyCommand, validateCommand } from '../src/core/commands';
import { createDefaultDoc } from '../src/core/store';

const cube = () => primitiveMesh('cube');
const maxAbs = (m: { vertices: number[][] }, axis: number) => Math.max(...m.vertices.map((v) => Math.abs(v[axis])));

describe('creased subdivision', () => {
  it('a cube with sharpAngle keeps its corners and edges; without it, it rounds into a ball', () => {
    const soft = applyModifiers(cube(), { subdivision: { levels: 3 } });
    const hard = applyModifiers(cube(), { subdivision: { levels: 3, sharpAngle: 30 } });
    expect(maxAbs(soft, 0)).toBeLessThan(0.9);
    expect(maxAbs(hard, 0)).toBeCloseTo(1, 5);
    // every corner of the cage is still there
    for (const c of cube().vertices) expect(hard.vertices.some((v) => Math.hypot(v[0] - c[0], v[1] - c[1], v[2] - c[2]) < 1e-9)).toBe(true);
    expect(isWatertight(hard)).toBe(true);
  });

  it('only creases edges above the angle: a bevelled box gets crisp main edges and soft bevels', () => {
    const m = applyModifiers(cube(), { bevel: { width: 0.15, segments: 1, angle: 30 } });
    // 6 faces + 12 bevel strips + 8 corner patches
    expect(m.faces.length).toBe(26);
    expect(isWatertight(m)).toBe(true);
    expect(signedVolume(m)).toBeGreaterThan(7);
    expect(signedVolume(m)).toBeLessThan(8);
    // 45° bevel faces meet the main faces at 45°: sharp at 30°, not at 50°
    expect(sharpEdges(m, 30).size).toBeGreaterThan(0);
    expect(sharpEdges(m, 50).size).toBe(0);
    const smooth = applyModifiers(cube(), { bevel: { width: 0.15, segments: 1, angle: 30 }, subdivision: { levels: 2 } });
    expect(isWatertight(smooth)).toBe(true);
  });

  it('setModifiers validates and stores bevel and sharpAngle', () => {
    let doc = applyCommand(createDefaultDoc(), validateCommand({ type: 'add', primitive: 'cube', id: 'c' })).doc;
    doc = applyCommand(doc, validateCommand({ type: 'convertToMesh', id: 'c' })).doc;
    doc = applyCommand(doc, validateCommand({ type: 'setModifiers', id: 'c', modifiers: { bevel: { width: 0.05, segments: 2 }, subdivision: { levels: 2, sharpAngle: 40 } } })).doc;
    expect(doc.objects.c.modifiers).toEqual({ bevel: { width: 0.05, segments: 2, angle: 30 }, subdivision: { levels: 2, sharpAngle: 40 } });
    expect(() => validateCommand({ type: 'setModifiers', id: 'c', modifiers: { bevel: { width: 0.1, segments: 9 } } })).toThrow(/segments/);
  });
});
