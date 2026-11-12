import { describe, expect, it } from 'vitest';
import { boxMesh, hipRoof, townBuildingIds, townCommands, DEFAULT_TOWN } from '../src/core/town';
import { isWatertight, signedVolume } from '../src/core/mesh/topology';
import { applyCommand, validateCommand, validateSceneDoc } from '../src/core/commands';
import { createDefaultDoc } from '../src/core/store';
import { patternGlowValues, patternTile, patternValues, WINDOW_GRID } from '../src/core/patterns';
import type { Command } from '../src/core/commands';

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

  it('the windows pattern has dark windows in a light wall, 4 × 4 per tile', () => {
    const v = patternValues('windows', 256, 1);
    const at = (u: number, w: number) => v[Math.floor(w * 256) * 256 + Math.floor(u * 256)];
    for (let c = 0; c < WINDOW_GRID; c++) {
      expect(at((c + 0.4) / WINDOW_GRID, (c + 0.5) / WINDOW_GRID)).toBeLessThan(0.2); // glass
      expect(at((c + 0.1) / WINDOW_GRID, (c + 0.1) / WINDOW_GRID)).toBeGreaterThan(0.7); // wall
    }
    expect(patternTile('windows')).toBe(WINDOW_GRID);
    expect(patternTile('bricks')).toBe(1);
  });

  it('lit windows: about half glow, walls and frames never do', () => {
    const g = patternGlowValues('windows', 256, 1);
    const v = patternValues('windows', 256, 1);
    let lit = 0;
    for (let cy = 0; cy < WINDOW_GRID; cy++)
      for (let cx = 0; cx < WINDOW_GRID; cx++) {
        const i = Math.floor(((cy + 0.45) / WINDOW_GRID) * 256) * 256 + Math.floor(((cx + 0.4) / WINDOW_GRID) * 256);
        if (g[i] > 0.3) lit++;
      }
    expect(lit).toBeGreaterThan(3);
    expect(lit).toBeLessThan(13);
    for (let i = 0; i < v.length; i++) if (v[i] > 0.4) expect(g[i]).toBe(0);
    // Other patterns glow where they show colour A.
    const n = patternValues('noise', 32, 1), ng = patternGlowValues('noise', 32, 1);
    expect(ng[5]).toBeCloseTo(1 - n[5]);
  });

  it('town lights put a glow on every facade, and facades are shifted by whole storeys', () => {
    const cmds = townCommands({ ...DEFAULT_TOWN, lights: 3, seed: 4 });
    const buildings = cmds.filter((c): c is Extract<Command, { type: 'add' }> => c.type === 'add' && /-b\d+$/.test(c.id ?? ''));
    const storey = 3.2;
    const offsets = new Set<string>();
    for (const b of buildings) {
      expect(b.material?.pattern?.glow).toBe(3);
      expect(b.material?.pattern?.glowColor).toMatch(/^#[0-9a-f]{6}$/);
      for (const o of b.mesh!.uvOffset!) expect(Math.abs(o / storey - Math.round(o / storey))).toBeLessThan(1e-9);
      offsets.add(b.mesh!.uvOffset!.join());
    }
    expect(offsets.size).toBeGreaterThan(3);
    expect(townCommands(DEFAULT_TOWN).some((c) => c.type === 'add' && c.material?.pattern?.glow)).toBe(false);
    let doc = createDefaultDoc();
    doc = applyCommand(doc, validateCommand({ type: 'addTown', lights: 2.5 })).doc;
    expect(doc.objects['town-b0'].material.pattern?.glow).toBe(2.5);
    expect(() => validateCommand({ type: 'addTown', lights: 500 })).toThrow(/lights/);
  });

  it('pattern glow validates and is dropped at 0', () => {
    const ok = validateCommand({ type: 'setMaterial', id: 'x', material: { pattern: { type: 'noise', glow: 4, glowColor: '#ff8800' } } });
    expect(ok.type === 'setMaterial' && ok.material.pattern).toMatchObject({ glow: 4, glowColor: '#ff8800' });
    const off = validateCommand({ type: 'setMaterial', id: 'x', material: { pattern: { type: 'noise', glow: 0 } } });
    expect(off.type === 'setMaterial' && off.material.pattern && 'glow' in off.material.pattern).toBe(false);
    expect(() => validateCommand({ type: 'setMaterial', id: 'x', material: { pattern: { type: 'noise', glow: -1 } } })).toThrow(/glow/);
    expect(() => validateCommand({ type: 'setMaterial', id: 'x', material: { pattern: { type: 'noise', glow: 1, glowColor: 'red' } } })).toThrow(/glowColor/);
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
