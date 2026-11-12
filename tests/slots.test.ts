import { describe, expect, it } from 'vitest';
import { applyCommand, validateCommand, validateSceneDoc } from '../src/core/commands';
import type { Command } from '../src/core/commands';
import { createDefaultDoc } from '../src/core/store';
import { buildVertexData } from '../src/engine/geometry';
import { applyModifiers } from '../src/core/mesh/modifiers';
import { slotOf, surfaceSlots, transferMaterialIndex, usesSlots } from '../src/core/mesh/materialIndex';
import { boxMesh } from '../src/core/town';
import type { MeshData, SceneDoc } from '../src/core/types';

const cube = (): MeshData => ({ ...boxMesh(2, 2, 2, -1), materialIndex: [0, 1, 0, 0, 0, 0] }); // top face (index 1) on slot 1

function scene(cmds: unknown[]): SceneDoc {
  let doc = createDefaultDoc();
  doc = applyCommand(doc, validateCommand({ type: 'delete', ids: [...doc.order] })).doc;
  for (const c of cmds) doc = applyCommand(doc, validateCommand(c)).doc;
  return doc;
}

describe('material slots', () => {
  it('vertex data groups faces by slot (one sub-mesh range per slot)', () => {
    const vd = buildVertexData(cube()) as ReturnType<typeof buildVertexData> & { groups?: { slot: number; start: number; count: number }[] };
    expect(vd.groups).toEqual([
      { slot: 0, start: 0, count: 30 },
      { slot: 1, start: 30, count: 6 },
    ]);
    expect((buildVertexData(boxMesh(1, 1, 1)) as { groups?: unknown }).groups).toBeUndefined();
    // smooth meshes too
    const sm = buildVertexData({ ...cube(), smooth: true }) as { groups?: { slot: number; count: number }[] };
    expect(sm.groups?.map((g) => [g.slot, g.count])).toEqual([[0, 30], [1, 6]]);
  });

  it('setMaterial slot adds / edits slots; assign, remove and validation', () => {
    let doc = scene([{ type: 'add', primitive: 'mesh', id: 'm', mesh: boxMesh(2, 2, 2), material: { baseColor: '#ff0000' } }]);
    doc = applyCommand(doc, validateCommand({ type: 'setMaterial', id: 'm', slot: 1, material: { baseColor: '#00ff00' } })).doc;
    expect(doc.objects.m.materialSlots).toHaveLength(1);
    expect(doc.objects.m.materialSlots![0]).toMatchObject({ baseColor: '#00ff00', roughness: doc.objects.m.material.roughness });
    expect(() => applyCommand(doc, validateCommand({ type: 'setMaterial', id: 'm', slot: 3, material: {} }))).toThrow(/slot/);
    doc = applyCommand(doc, validateCommand({ type: 'setMaterial', id: 'm', slot: 2, material: { baseColor: '#0000ff' } })).doc;
    doc = applyCommand(doc, validateCommand({ type: 'assignMaterial', id: 'm', slot: 1, faces: [1, 2] })).doc;
    doc = applyCommand(doc, validateCommand({ type: 'assignMaterial', id: 'm', slot: 2, faces: [3] })).doc;
    expect(doc.objects.m.mesh!.materialIndex).toEqual([0, 1, 1, 2, 0, 0]);
    expect(() => applyCommand(doc, validateCommand({ type: 'assignMaterial', id: 'm', slot: 5, faces: [0] }))).toThrow(/slot/);
    expect(() => applyCommand(doc, validateCommand({ type: 'assignMaterial', id: 'm', slot: 1, faces: [99] }))).toThrow(/face/);
    // Saved and loaded
    const back = validateSceneDoc(JSON.parse(JSON.stringify(doc)));
    expect(back.objects.m.mesh!.materialIndex).toEqual([0, 1, 1, 2, 0, 0]);
    expect(back.objects.m.materialSlots!.map((m) => m.baseColor)).toEqual(['#00ff00', '#0000ff']);
    // Removing slot 1: its faces go to the main material, slot 2 becomes slot 1
    doc = applyCommand(doc, validateCommand({ type: 'removeMaterialSlot', id: 'm', slot: 1 })).doc;
    expect(doc.objects.m.mesh!.materialIndex).toEqual([0, 0, 0, 1, 0, 0]);
    expect(doc.objects.m.materialSlots!.map((m) => m.baseColor)).toEqual(['#0000ff']);
    doc = applyCommand(doc, validateCommand({ type: 'removeMaterialSlot', id: 'm', slot: 1 })).doc;
    expect(doc.objects.m.materialSlots).toBeUndefined();
    expect(doc.objects.m.mesh!.materialIndex).toBeUndefined();
    expect(() => validateCommand({ type: 'add', primitive: 'mesh', mesh: { ...boxMesh(1, 1, 1), materialIndex: [0, 1] } })).toThrow(/materialIndex/);
  });

  it('mesh edits keep each face on its slot (tools need not know about slots)', () => {
    let doc = scene([
      { type: 'add', primitive: 'mesh', id: 'm', mesh: cube(), materialSlots: [{ baseColor: '#00ff00' }] },
    ]);
    // Extrude the top face (slot 1) up, then inset it: the cap stays on slot 1, sides on the main material.
    doc = applyCommand(doc, validateCommand({ type: 'editMesh', id: 'm', steps: [
      { op: 'extrude', select: { normal: [0, 0, 1], angle: 5 }, offset: 1 },
      { op: 'inset', select: { last: true }, thickness: 0.2 },
    ] })).doc;
    const m = doc.objects.m.mesh!;
    expect(usesSlots(m)).toBe(true);
    const top = m.faces.map((f, i) => [i, Math.min(...f.map((v) => m.vertices[v][2]))] as const).filter(([, z]) => z > 1.99).map(([i]) => i);
    expect(top.length).toBeGreaterThan(0);
    for (const f of top) expect(slotOf(m, f)).toBe(1);
    const bottom = m.faces.findIndex((f) => f.every((v) => m.vertices[v][2] < -0.99));
    expect(slotOf(m, bottom)).toBe(0);
  });

  it('transfer by shared corners and planes', () => {
    const a = cube();
    // the same faces in another order
    const b: MeshData = { ...a, faces: [...a.faces].reverse(), materialIndex: undefined };
    expect(transferMaterialIndex(a, b)).toEqual([...a.materialIndex!].reverse());
    expect(transferMaterialIndex(boxMesh(1, 1, 1), b)).toBeUndefined();
    // surfaceSlots: a face lying inside the top face gets its slot, a cut face gets `inside`
    const piece: MeshData = { vertices: [[0, 0, 1], [0.5, 0, 1], [0.5, 0.5, 1], [0, 0, 0], [0.5, 0, 0], [0.5, 0.5, 0]], faces: [[0, 1, 2], [3, 5, 4]], smooth: false };
    expect(surfaceSlots(a, piece, 7)).toEqual([1, 7]);
  });

  it('modifiers carry slots: mirror, array, solidify, subdivision', () => {
    const c = cube();
    const count = (m: MeshData) => (m.materialIndex ?? []).filter((s) => s === 1).length;
    expect(count(applyModifiers(c, { array: { count: 3, relative: [1, 0, 0], constant: [0.5, 0, 0] } }))).toBe(3);
    expect(count(applyModifiers(c, { subdivision: { levels: 1 } }))).toBe(4);
    expect(count(applyModifiers(c, { solidify: { thickness: 0.1 } }))).toBe(2);
    const mir = applyModifiers({ ...c, vertices: c.vertices.map((v) => [v[0] + 2, v[1], v[2]] as [number, number, number]) }, { mirror: { x: true, y: false, z: false } });
    expect(count(mir)).toBe(2);
    expect(mir.materialIndex).toHaveLength(mir.faces.length);
  });

  it('separate keeps the faces’ slots on both parts', () => {
    let doc = scene([{ type: 'add', primitive: 'mesh', id: 'm', mesh: cube(), materialSlots: [{ baseColor: '#00ff00' }] }]);
    doc = applyCommand(doc, validateCommand({ type: 'separate', id: 'm', faces: [1, 2] })).doc;
    const other = Object.values(doc.objects).find((o) => o.id !== 'm')!;
    expect(other.mesh!.materialIndex).toEqual([1, 0]);
    expect(other.materialSlots).toHaveLength(1);
    expect(doc.objects.m.mesh!.materialIndex).toBeUndefined();
  });

  it('join keeps each part’s material as a slot (equal materials shared)', () => {
    let doc = scene([
      { type: 'add', primitive: 'mesh', id: 'a', mesh: boxMesh(1, 1, 1), material: { baseColor: '#ff0000' } },
      { type: 'add', primitive: 'mesh', id: 'b', mesh: boxMesh(1, 1, 1), material: { baseColor: '#00ff00' }, transform: { position: [3, 0, 0] } },
      { type: 'add', primitive: 'mesh', id: 'c', mesh: boxMesh(1, 1, 1), material: { baseColor: '#ff0000' }, transform: { position: [-3, 0, 0] } },
    ]);
    doc = applyCommand(doc, validateCommand({ type: 'join', id: 'a', others: ['b', 'c'] })).doc;
    const a = doc.objects.a;
    expect(a.materialSlots!.map((m) => m.baseColor)).toEqual(['#00ff00']);
    expect(a.mesh!.materialIndex).toEqual([0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0]);
  });

  it('cell fracture gives the broken insides their own material', async () => {
    const { loadBooleans } = await import('../src/core/mesh/boolean');
    await loadBooleans();
    let doc = scene([
      { type: 'add', primitive: 'mesh', id: 'b', mesh: boxMesh(6, 4, 9), material: { baseColor: '#d8cdb8', pattern: { type: 'windows', colorA: '#2b3a48', colorB: '#d8cdb8', scale: 0.333, bump: 0.5 } } },
    ]);
    doc = applyCommand(doc, validateCommand({ type: 'fracture', id: 'b', pieces: 6, seed: 2 })).doc;
    const pieces = Object.values(doc.objects).filter((o) => o.id.startsWith('b.'));
    expect(pieces.length).toBeGreaterThan(3);
    let inner = 0, outer = 0;
    for (const p of pieces) {
      expect(p.materialSlots).toHaveLength(1);
      expect(p.materialSlots![0].pattern?.type).toBe('noise');
      const m = p.mesh!;
      m.faces.forEach((_, f) => (slotOf(m, f) === 1 ? inner++ : outer++));
    }
    expect(inner).toBeGreaterThan(10);
    expect(outer).toBeGreaterThan(10);
    // inner: false keeps one material
    let d2 = scene([{ type: 'add', primitive: 'mesh', id: 'c', mesh: boxMesh(2, 2, 2) }]);
    d2 = applyCommand(d2, validateCommand({ type: 'fracture', id: 'c', pieces: 4, seed: 1, inner: false } as Command)).doc;
    expect(Object.values(d2.objects).every((o) => !o.materialSlots && !o.mesh?.materialIndex)).toBe(true);
    // a custom inner material
    let d3 = scene([{ type: 'add', primitive: 'mesh', id: 'c', mesh: boxMesh(2, 2, 2) }]);
    d3 = applyCommand(d3, validateCommand({ type: 'fracture', id: 'c', pieces: 4, seed: 1, inner: { baseColor: '#112233', pattern: null } })).doc;
    expect(Object.values(d3.objects)[0].materialSlots![0]).toMatchObject({ baseColor: '#112233', pattern: null });
  });
});
