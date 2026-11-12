import { describe, expect, it } from 'vitest';
import { applyCommand, validateCommand, validateSceneDoc } from '../src/core/commands';
import { currentWeights, skinMesh } from '../src/core/rig';
import { carryGroups, groupsToWeights, paintWeights, weightColor } from '../src/core/vertexGroups';
import type { SceneDoc, Vec3 } from '../src/core/types';

const ids = (() => { let n = 0; return () => `v${n++}`; })();
const run = (doc: SceneDoc, ...cmds: unknown[]) => cmds.reduce<SceneDoc>((d, c) => applyCommand(d, validateCommand(c), ids).doc, doc);

const arm = { bones: [
  { name: 'root', parent: null, head: [0, 0, 0], tail: [0, 0, 1] },
  { name: 'top', parent: 'root', head: [0, 0, 1], tail: [0, 0, 2] },
] };
const rigged = () => run(
  { objects: {}, order: [] },
  { type: 'add', primitive: 'armature', id: 'rig', armature: arm },
  { type: 'add', primitive: 'cylinder', id: 'pole', parentId: 'rig', transform: { position: [0, 0, 1], scale: [0.1, 0.1, 1] } },
  { type: 'editMesh', id: 'pole', steps: [{ op: 'loopcut', select: { mode: 'edge', nearest: [0.1, 0, 0] }, cuts: 5 }] },
  { type: 'setSkin', id: 'pole', armature: 'rig' },
);

describe('vertex groups / weight paint', () => {
  it('brush: draw / add / subtract / blur, falloff and X symmetry', () => {
    const verts: Vec3[] = [[0, 0, 0], [0.5, 0, 0], [2, 0, 0], [-2, 0, 0]];
    const w0 = [0, 0, 0, 0];
    const d = paintWeights(verts, w0, { mode: 'draw', weight: 1, strength: 1, radius: 1, center: [0, 0, 0] });
    expect(d[0]).toBe(1);
    expect(d[1]).toBeGreaterThan(0);
    expect(d[1]).toBeLessThan(1);
    expect(d[2]).toBe(0);
    const sym = paintWeights(verts, w0, { mode: 'add', weight: 1, strength: 1, radius: 0.5, center: [2, 0, 0], symmetryX: true });
    expect(sym[2]).toBe(1);
    expect(sym[3]).toBe(1);
    const sub = paintWeights(verts, [1, 1, 1, 1], { mode: 'subtract', weight: 1, strength: 0.5, radius: 0.1, center: [0, 0, 0] });
    expect(sub[0]).toBe(0.5);
    const blur = paintWeights(verts, [1, 0, 0, 0], { mode: 'blur', weight: 1, strength: 1, radius: 0.1, center: [0, 0, 0] }, [[1], [0], [], []]);
    expect(blur[0]).toBe(0);
    expect(weightColor(0)).toEqual([0, 0, 1]);
    expect(weightColor(1)).toEqual([1, 0, 0]);
  });

  it('groups named after bones skin the mesh instead of automatic weights', () => {
    let doc = rigged();
    const auto = currentWeights(doc, 'pole', 1)!;
    doc = run(doc, { type: 'groupsFromWeights', id: 'pole', weights: auto });
    const vg = doc.objects.pole.vertexGroups!;
    expect(vg.groups.map((g) => g.name).sort()).toEqual(['root', 'top']);
    const n = doc.objects.pole.mesh!.vertices.length;
    // Paint everything onto "root": bending "top" no longer moves anything.
    doc = run(doc, { type: 'setWeights', id: 'pole', group: 'top', weights: new Array(n).fill(0) }, { type: 'setWeights', id: 'pole', group: 'root', weights: new Array(n).fill(1) });
    expect(groupsToWeights(doc.objects.pole.vertexGroups, arm.bones as never, n)!.w.every((p) => p.length === 1)).toBe(true);
    doc = run(doc, { type: 'setPose', id: 'rig', pose: { top: { rotation: [90, 0, 0] } } });
    const rest = doc.objects.pole.mesh!;
    const bent = skinMesh(doc, 'pole', rest, 1);
    const moved = bent.vertices.some((v, i) => Math.hypot(v[0] - rest.vertices[i][0], v[1] - rest.vertices[i][1], v[2] - rest.vertices[i][2]) > 1e-4);
    expect(moved).toBe(false);
    // …and painting "top" back on the upper half bends it again.
    const upper = rest.vertices.map((v, i) => (v[2] > 0.2 ? i : -1)).filter((i) => i >= 0);
    doc = run(doc, { type: 'setWeights', id: 'pole', group: 'top', verts: upper, value: 1 }, { type: 'setWeights', id: 'pole', group: 'root', verts: upper, value: 0 });
    const bent2 = skinMesh(doc, 'pole', rest, 1);
    expect(bent2.vertices.some((v, i) => Math.abs(v[1] - rest.vertices[i][1]) > 0.1)).toBe(true);
  });

  it('commands: add / rename / active / remove, round trip, carry over new geometry', () => {
    let doc = run({ objects: {}, order: [] }, { type: 'add', primitive: 'cube', id: 'c' }, { type: 'addVertexGroup', id: 'c' }, { type: 'addVertexGroup', id: 'c', name: 'Arm' });
    expect(doc.objects.c.vertexGroups!.groups.map((g) => g.name)).toEqual(['Group', 'Arm']);
    expect(doc.objects.c.vertexGroups!.active).toBe(1);
    doc = run(doc, { type: 'setVertexGroup', id: 'c', index: 0, name: 'Leg' }, { type: 'setActiveVertexGroup', id: 'c', index: 0 });
    expect(() => run(doc, { type: 'setVertexGroup', id: 'c', index: 0, name: 'Arm' })).toThrow(/already/);
    doc = run(doc, { type: 'setWeights', id: 'c', group: 'Leg', verts: [0, 1], value: 0.5 });
    const back = validateSceneDoc(JSON.parse(JSON.stringify(doc)));
    expect(back.objects.c.vertexGroups).toEqual(doc.objects.c.vertexGroups);
    // Extruding keeps old weights and gives the new points their neighbours' weights.
    const before = doc.objects.c.mesh!;
    doc = run(doc, { type: 'editMesh', id: 'c', steps: [{ op: 'extrude', select: { normal: [0, 0, 1] }, offset: 0.5 }] });
    const after = doc.objects.c.mesh!;
    expect(doc.objects.c.vertexGroups!.groups[0].w.length).toBe(after.vertices.length);
    expect(carryGroups(before, before, doc.objects.c.vertexGroups!)).toBe(doc.objects.c.vertexGroups);
    doc = run(doc, { type: 'removeVertexGroup', id: 'c', index: 0 }, { type: 'removeVertexGroup', id: 'c', index: 0 });
    expect(doc.objects.c.vertexGroups).toBeUndefined();
  });
});
