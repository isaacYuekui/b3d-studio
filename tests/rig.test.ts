import { describe, expect, it } from 'vitest';
import { apply, autoWeights, boneRest, deform, invert, mul, poseBones, rotEuler, toEuler } from '../src/core/rig';
import type { Bone } from '../src/core/types';

const close = (a: number[], b: number[], eps = 1e-6) => a.forEach((x, i) => expect(x).toBeCloseTo(b[i], 5 + 0 * eps));

describe('rig math', () => {
  it('bone rest frame puts Y along the bone (Blender convention)', () => {
    const up: Bone = { name: 'a', parent: null, head: [0, 0, 0], tail: [0, 0, 1] };
    const R = boneRest(up);
    close(apply(R, [0, 1, 0]), [0, 0, 1]);
    close(apply(R, [1, 0, 0]), [1, 0, 0]); // X stays X for a bone pointing up
    const down: Bone = { name: 'b', parent: null, head: [0, 0, 1], tail: [0, 0, 0] };
    close(apply(boneRest(down), [0, 1, 0]), [0, 0, 0]);
    const side: Bone = { name: 'c', parent: null, head: [0, 0, 0], tail: [2, 0, 0] };
    close(apply(boneRest(side), [0, 2, 0]), [2, 0, 0]);
    const back: Bone = { name: 'd', parent: null, head: [0, 0, 0], tail: [0, -1, 0] };
    close(apply(boneRest(back), [0, 1, 0]), [0, -1, 0]);
  });

  it('euler round trip and inverse', () => {
    const e: [number, number, number] = [20, -35, 70];
    close(toEuler(rotEuler(e)), e);
    const m = mul(rotEuler(e), invert(rotEuler(e)));
    close(m, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  });

  it('posing a parent carries the child; rest pose is identity skinning', () => {
    const bones: Bone[] = [
      { name: 'upper', parent: null, head: [0, 0, 1], tail: [0, 0, 0.5] },
      { name: 'lower', parent: 'upper', head: [0, 0, 0.5], tail: [0, 0, 0] },
    ];
    const rest = poseBones(bones);
    close(apply(rest.skin.get('lower')!, [0.1, 0.2, 0.3]), [0.1, 0.2, 0.3]);
    // Bend the upper bone 90° about its X: the foot point swings to the side/front.
    const p = poseBones(bones, { upper: { rotation: [90, 0, 0] } });
    const foot = apply(p.skin.get('lower')!, [0, 0, 0]);
    expect(Math.abs(foot[2] - 1)).toBeCloseTo(0, 5);
    expect(Math.hypot(foot[0], foot[1])).toBeCloseTo(1, 5);
  });

  it('auto weights follow the nearest bones and sum to 1', () => {
    const bones: Bone[] = [
      { name: 'a', parent: null, head: [0, 0, 0], tail: [0, 0, 1] },
      { name: 'b', parent: 'a', head: [0, 0, 1], tail: [0, 0, 2] },
      { name: 'ctrl', parent: null, head: [5, 0, 0], tail: [5, 0, 1], deform: false },
    ];
    const W = autoWeights([[0.1, 0, 0.2], [0.1, 0, 1], [0.1, 0, 1.8]], bones);
    expect(W.bones).toEqual(['a', 'b']);
    W.w.forEach((ws) => expect(ws.reduce((s, [, x]) => s + x, 0)).toBeCloseTo(1));
    expect(W.w[0][0][0]).toBe(0);
    expect(W.w[2][0][0]).toBe(1);
    expect(W.w[1].length).toBe(2); // the joint blends both
    const moved = deform([[0.1, 0, 1.8]], { bones: W.bones, w: [W.w[2]] }, poseBones(bones, { b: { rotation: [0, 0, 0], location: [0, 0.5, 0] } }).skin);
    close(moved[0], [0.1, 0, 2.3]);
  });
});

import { applyCommand, validateCommand } from '../src/core/commands';
import { parseProject, serializeProject } from '../src/core/serialize';
import { poseAt, skinMesh } from '../src/core/rig';
import { primitiveMesh } from '../src/core/mesh/primitives';

describe('armature commands', () => {
  const ids = (() => { let n = 0; return () => `r${n++}`; })();
  const arm = { bones: [
    { name: 'root', parent: null, head: [0, 0, 0], tail: [0, 0, 1] },
    { name: 'top', parent: 'root', head: [0, 0, 1], tail: [0, 0, 2] },
  ] };
  const base = () => {
    let doc = applyCommand({ objects: {}, order: [] }, validateCommand({ type: 'add', primitive: 'armature', id: 'rig', armature: arm }), ids).doc;
    doc = applyCommand(doc, validateCommand({ type: 'add', primitive: 'cylinder', id: 'pole', parentId: 'rig', transform: { position: [0, 0, 1], scale: [0.1, 0.1, 1] } }), ids).doc;
    doc = applyCommand(doc, validateCommand({ type: 'editMesh', id: 'pole', steps: [{ op: 'loopcut', select: { mode: 'edge', nearest: [0.1, 0, 0] }, cuts: 5 }] }), ids).doc;
    return applyCommand(doc, validateCommand({ type: 'setSkin', id: 'pole', armature: 'rig' }), ids).doc;
  };

  it('validates bones (parents, duplicates, zero length)', () => {
    expect(() => validateCommand({ type: 'add', primitive: 'armature', armature: { bones: [{ name: 'a', parent: 'nope', head: [0, 0, 0], tail: [0, 0, 1] }] } })).toThrow(/parent "nope"/);
    expect(() => validateCommand({ type: 'add', primitive: 'armature', armature: { bones: [{ name: 'a', head: [0, 0, 0], tail: [0, 0, 1] }, { name: 'a', head: [0, 0, 0], tail: [0, 0, 1] }] } })).toThrow(/twice/);
    expect(() => validateCommand({ type: 'add', primitive: 'armature', armature: { bones: [{ name: 'a', head: [0, 0, 0], tail: [0, 0, 0] }] } })).toThrow(/zero length/);
  });

  it('poses, pose keys and skinning bend the mesh; survives a round trip', () => {
    let doc = base();
    const rest = doc.objects.pole.mesh!;
    doc = applyCommand(doc, validateCommand({ type: 'setPoseKey', id: 'rig', bone: 'top', frame: 1, rotation: [0, 0, 0] })).doc;
    doc = applyCommand(doc, validateCommand({ type: 'setPoseKey', id: 'rig', bone: 'top', frame: 11, rotation: [90, 0, 0] })).doc;
    expect(poseAt(doc, 'rig', 11).top.rotation).toEqual([90, 0, 0]);
    expect(poseAt(doc, 'rig', 6).top.rotation[0]).toBeGreaterThan(10);
    const bent = skinMesh(doc, 'pole', rest, 11);
    const topZ = Math.max(...bent.vertices.map((v) => v[2]));
    expect(topZ).toBeLessThan(0.75); // the upper half folded over (local z ≤ 1 at rest)
    const restAgain = skinMesh(doc, 'pole', rest, 1);
    restAgain.vertices.forEach((v, i) => v.forEach((x, k) => expect(x).toBeCloseTo(rest.vertices[i][k], 6)));
    const back = parseProject(serializeProject(doc));
    expect(back.objects.pole.skin).toEqual({ armature: 'rig' });
    expect(back.animation!.poses!.rig.top.length).toBe(2);
    expect(() => applyCommand(doc, validateCommand({ type: 'setPose', id: 'rig', pose: { nope: { rotation: [1, 2, 3] } } }))).toThrow(/no bone/);
  });

  it('deleting the armature unskins its meshes and drops its pose keys', () => {
    let doc = base();
    doc = applyCommand(doc, validateCommand({ type: 'setPoseKey', id: 'rig', bone: 'top', frame: 1, rotation: [0, 0, 0] })).doc;
    // Unparent the pole so it survives the armature's deletion.
    doc = applyCommand(doc, { type: 'setParent', id: 'pole', parentId: null }).doc;
    doc = applyCommand(doc, { type: 'delete', ids: ['rig'] }).doc;
    expect(doc.objects.pole.skin).toBeUndefined();
    expect(doc.animation?.poses?.rig).toBeUndefined();
  });

  void primitiveMesh;
});
