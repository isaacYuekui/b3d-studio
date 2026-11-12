import { describe, expect, it } from 'vitest';
import { applyCommand, validateCommand, validateSceneDoc } from '../src/core/commands';
import { createDefaultDoc } from '../src/core/store';
import { smartUvProject, validUv } from '../src/core/mesh/uv';
import { applyModifiers } from '../src/core/mesh/modifiers';
import { primitiveMesh } from '../src/core/mesh/primitives';
import { boxMesh } from '../src/core/town';
import { buildVertexData } from '../src/engine/geometry';
import type { SceneDoc } from '../src/core/types';

function scene(cmds: unknown[]): SceneDoc {
  let doc = createDefaultDoc();
  doc = applyCommand(doc, validateCommand({ type: 'delete', ids: [...doc.order] })).doc;
  for (const c of cmds) doc = applyCommand(doc, validateCommand(c)).doc;
  return doc;
}

const bbox = (pts: [number, number][]) => {
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
};

describe('UV unwrap (Smart UV Project)', () => {
  it('a box: one island per side, true proportions, packed into 0..1 without overlaps', () => {
    const m = boxMesh(4, 2, 1);
    const uv = smartUvProject(m);
    expect(uv).toHaveLength(6);
    const boxes = uv.map((f) => bbox(f));
    for (const b of boxes) {
      expect(b.x0).toBeGreaterThanOrEqual(0);
      expect(b.y0).toBeGreaterThanOrEqual(0);
      expect(b.x1).toBeLessThanOrEqual(1.0001);
      expect(b.y1).toBeLessThanOrEqual(1.0001);
    }
    for (let i = 0; i < 6; i++)
      for (let j = i + 1; j < 6; j++) {
        const a = boxes[i], b = boxes[j];
        const overlap = a.x0 < b.x1 - 1e-6 && b.x0 < a.x1 - 1e-6 && a.y0 < b.y1 - 1e-6 && b.y0 < a.y1 - 1e-6;
        expect(overlap, `${i} ${j}`).toBe(false);
      }
    // The 4×2 top keeps its 2:1 shape; all sides use the same metres-per-UV.
    const top = boxes[1];
    expect((top.x1 - top.x0) / (top.y1 - top.y0)).toBeCloseTo(2, 3);
    const side = boxes[2]; // 4 × 1
    expect(Math.max(side.x1 - side.x0, side.y1 - side.y0) / Math.max(top.x1 - top.x0, top.y1 - top.y0)).toBeCloseTo(1, 3);
  });

  it('a smooth sphere: neighbouring faces facing alike share islands', () => {
    const m = primitiveMesh('sphere');
    const uv = smartUvProject(m);
    expect(uv.length).toBe(m.faces.length);
    expect(uv.flat().every(([u, v]) => u >= 0 && u <= 1.0001 && v >= 0 && v <= 1.0001)).toBe(true);
  });

  it('unwrap / clearUv commands; UVs saved; kept when vertices move, dropped when faces are rebuilt', () => {
    let doc = scene([{ type: 'add', primitive: 'mesh', id: 'm', mesh: boxMesh(2, 2, 2) }, { type: 'unwrap', id: 'm' }]);
    expect(validUv(doc.objects.m.mesh!)).toBe(true);
    expect(validateSceneDoc(JSON.parse(JSON.stringify(doc))).objects.m.mesh!.uv).toEqual(doc.objects.m.mesh!.uv);
    // Move every vertex up: same faces, UVs stay.
    const up = applyCommand(doc, validateCommand({ type: 'editMesh', id: 'm', steps: [{ op: 'move', select: { all: true }, by: [0, 0, 1] }] })).doc;
    expect(up.objects.m.mesh!.uv).toEqual(doc.objects.m.mesh!.uv);
    // Extrude rebuilds faces: UVs dropped (box projection until unwrapped again).
    const ex = applyCommand(doc, validateCommand({ type: 'editMesh', id: 'm', steps: [{ op: 'extrude', select: { normal: [0, 0, 1], angle: 5 }, offset: 1 }] })).doc;
    expect(ex.objects.m.mesh!.uv).toBeUndefined();
    doc = applyCommand(doc, validateCommand({ type: 'clearUv', id: 'm' })).doc;
    expect(doc.objects.m.mesh!.uv).toBeUndefined();
    expect(() => validateCommand({ type: 'add', primitive: 'mesh', mesh: { ...boxMesh(1, 1, 1), uv: [[[0, 0]]] } })).toThrow(/uv/);
  });

  it('subdivision carries the UV map; vertex data uses it', () => {
    const m = { ...boxMesh(2, 2, 2), uv: smartUvProject(boxMesh(2, 2, 2)) };
    const sub = applyModifiers(m, { subdivision: { levels: 1 } });
    expect(validUv(sub)).toBe(true);
    expect(sub.faces.length).toBe(24);
    const vd = buildVertexData(m);
    const firstFace = m.uv[m.faces.findIndex(() => true)];
    expect(vd.uvs!.length).toBe(24 * 2);
    expect([vd.uvs![0], vd.uvs![1]]).toEqual(firstFace[0]);
    // Smooth + UV: split at seams (corner vertices) with averaged normals.
    const s = buildVertexData({ ...m, smooth: true });
    expect(s.positions!.length).toBe(24 * 3);
    expect(Math.abs(s.normals![0])).toBeGreaterThan(0.3);
    expect(Math.abs(s.normals![1])).toBeGreaterThan(0.3);
  });
});
