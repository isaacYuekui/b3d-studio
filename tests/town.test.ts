import { describe, expect, it } from 'vitest';
import { boxMesh, hipRoof, townBuildingIds, townCommands, DEFAULT_TOWN } from '../src/core/town';
import { isWatertight, signedVolume } from '../src/core/mesh/topology';
import { applyCommand, validateCommand, validateSceneDoc } from '../src/core/commands';
import { createDefaultDoc } from '../src/core/store';
import { patternValues } from '../src/core/patterns';

describe('town generator', () => {
  it('buildings and roofs are closed, outward-facing solids', () => {
    for (const m of [boxMesh(6, 4, 9), hipRoof(8, 5, 2), hipRoof(5, 8, 2), hipRoof(6, 6, 3)]) {
      expect(isWatertight(m)).toBe(true);
      expect(signedVolume(m)).toBeGreaterThan(0);
    }
    expect(signedVolume(boxMesh(6, 4, 9))).toBeCloseTo(216, 6);
    // the ridge follows the longer side
    const r = hipRoof(5, 8, 2);
    const top = r.vertices.filter((v) => v[2] === 2);
    expect(Math.abs(top[0][1] - top[1][1])).toBeGreaterThan(0);
    expect(top[0][0]).toBeCloseTo(top[1][0], 9);
  });

  it('is deterministic per seed, sized by style, with streets', () => {
    const a = townCommands({ ...DEFAULT_TOWN, seed: 4 });
    expect(townCommands({ ...DEFAULT_TOWN, seed: 4 })).toEqual(a);
    expect(townCommands({ ...DEFAULT_TOWN, seed: 5 })).not.toEqual(a);
    const count = (style: 'village' | 'town' | 'city') => townBuildingIds(townCommands({ ...DEFAULT_TOWN, style, size: [100, 100] })).length;
    expect(count('village')).toBeGreaterThan(count('city'));
    const city = townCommands({ ...DEFAULT_TOWN, style: 'city', size: [100, 100] });
    const tall = Math.max(...city.flatMap((c) => (c.type === 'add' && /-b\d+$/.test(c.id!) ? [Math.max(...c.mesh!.vertices.map((v) => v[2]))] : [])));
    expect(tall).toBeGreaterThan(20);
  });

  it('addTown adds buildings, roofs and a passive ground; prefix clashes are refused; saves', () => {
    let doc = createDefaultDoc();
    doc = applyCommand(doc, validateCommand({ type: 'addTown', style: 'village', center: [10, 0], size: [50, 40], seed: 2 })).doc;
    const ids = Object.keys(doc.objects).filter((id) => /^town-b\d+$/.test(id));
    expect(ids.length).toBeGreaterThan(3);
    expect(doc.objects[`${ids[0]}-roof`]).toBeDefined();
    expect(doc.objects['town-ground'].rigid?.type).toBe('passive');
    expect(doc.objects[ids[0]].material.pattern?.type).toBe('windows');
    expect(() => applyCommand(doc, validateCommand({ type: 'addTown' }))).toThrow(/already a town/);
    doc = applyCommand(doc, validateCommand({ type: 'addTown', prefix: 'city2', style: 'city', ground: false, center: [200, 0] })).doc;
    expect(doc.objects['city2-ground']).toBeUndefined();
    expect(validateSceneDoc(JSON.parse(JSON.stringify(doc))).objects[ids[0]].material.pattern?.type).toBe('windows');
    expect(() => validateCommand({ type: 'addTown', style: 'metropolis' })).toThrow(/style/);
    expect(() => validateCommand({ type: 'addTown', size: [5, 5] })).toThrow(/size/);
  });

  it('the windows pattern has dark windows in a light wall', () => {
    const v = patternValues('windows', 64, 1);
    const at = (u: number, w: number) => v[Math.floor(w * 64) * 64 + Math.floor(u * 64)];
    expect(at(0.4, 0.5)).toBeLessThan(0.2); // glass
    expect(at(0.1, 0.1)).toBeGreaterThan(0.7); // wall
  });
});

describe('fractured pieces keep the texture in place', () => {
  it('each piece carries its offset inside the original object', async () => {
    const { loadBooleans } = await import('../src/core/mesh/boolean');
    await loadBooleans();
    let doc = createDefaultDoc();
    doc = applyCommand(doc, validateCommand({ type: 'add', primitive: 'mesh', id: 'b', mesh: boxMesh(6, 4, 9) })).doc;
    doc = applyCommand(doc, validateCommand({ type: 'fracture', id: 'b', pieces: 6, seed: 2 })).doc;
    const pieces = Object.values(doc.objects).filter((o) => o.id.startsWith('b.'));
    expect(pieces.length).toBeGreaterThan(3);
    for (const p of pieces) {
      const off = p.mesh!.uvOffset!;
      for (const v of p.mesh!.vertices) {
        // piece vertex + offset = where it was in the whole building (inside its box)
        expect(v[0] + off[0]).toBeGreaterThan(-3.001);
        expect(v[0] + off[0]).toBeLessThan(3.001);
        expect(v[2] + off[2]).toBeGreaterThan(-0.001);
        expect(v[2] + off[2]).toBeLessThan(9.001);
      }
      // and the piece sits where that part of the building was
      expect(p.transform.position[2]).toBeCloseTo(off[2], 4);
    }
    expect(validateSceneDoc(JSON.parse(JSON.stringify(doc))).objects[pieces[0].id].mesh!.uvOffset).toEqual(pieces[0].mesh!.uvOffset);
  });
});
