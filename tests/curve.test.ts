import { describe, expect, it } from 'vitest';
import { applyCommand, validateCommand, validateSceneDoc } from '../src/core/commands';
import { createDefaultDoc } from '../src/core/store';
import { curvePolyline, curveTube, curvePreset, DEFAULT_CURVE, extrudeCurve, pathAt, pathLength, subdivideCurve } from '../src/core/curve';
import { sceneCameraAt, transformAt } from '../src/core/animation';
import { applyModifiers } from '../src/core/mesh/modifiers';
import { isWatertight } from '../src/core/mesh/topology';
import type { SceneDoc, Vec3 } from '../src/core/types';

function scene(cmds: unknown[]): SceneDoc {
  let doc = createDefaultDoc();
  doc = applyCommand(doc, validateCommand({ type: 'delete', ids: [...doc.order] })).doc;
  for (const c of cmds) doc = applyCommand(doc, validateCommand(c)).doc;
  return doc;
}

describe('curves', () => {
  it('the path passes through every control point; a straight line stays straight', () => {
    const pts: Vec3[] = [[0, 0, 0], [1, 2, 0], [3, 1, 1], [4, 4, 0]];
    const poly = curvePolyline(pts, false, 8);
    expect(poly.length).toBe(3 * 8 + 1);
    for (let i = 0; i < pts.length; i++) expect(poly[Math.min(i * 8, poly.length - 1)]).toEqual(pts[i]);
    const line = curvePolyline(curvePreset('path').points, false, 4);
    expect(line.every((p) => Math.abs(p[1]) < 1e-9 && Math.abs(p[2]) < 1e-9)).toBe(true);
    expect(pathLength(line, false)).toBeCloseTo(4, 6);
    expect(pathAt(line, false, 0.5).p[0]).toBeCloseTo(0, 6);
    expect(pathAt(line, false, 0.5).t).toEqual([1, 0, 0]);
  });

  it('tube: closed (watertight) for open curves with caps and for loops', () => {
    const open = curveTube(curvePreset('bezier').points, DEFAULT_CURVE);
    expect(isWatertight(open)).toBe(true);
    const loop = curveTube(curvePreset('circle').points, { ...DEFAULT_CURVE, cyclic: true });
    expect(isWatertight(loop)).toBe(true);
    // Radius is the bevel depth.
    const r = Math.hypot(loop.vertices[0][0], loop.vertices[0][1]);
    expect(Math.abs(r - 1)).toBeLessThan(0.06);
  });

  it('edit tools: extrude past an end, subdivide between, delete', () => {
    const pts: Vec3[] = [[0, 0, 0], [1, 0, 0], [2, 0, 0]];
    expect(extrudeCurve(pts, [2]).points.at(-1)).toEqual([3, 0, 0]);
    expect(extrudeCurve(pts, [0]).points[0]).toEqual([-1, 0, 0]);
    expect(extrudeCurve(pts, [1]).points).toHaveLength(3);
    const sd = subdivideCurve(pts, [0, 1], false);
    expect(sd.points).toEqual([[0, 0, 0], [0.5, 0, 0], [1, 0, 0], [2, 0, 0]]);
    let doc = scene([{ type: 'add', primitive: 'mesh', id: 'c', mesh: { vertices: pts, faces: [], smooth: true } }, { type: 'setModifiers', id: 'c', modifiers: { curve: {} } }]);
    doc = applyCommand(doc, validateCommand({ type: 'editCurve', id: 'c', op: 'delete', points: [1] })).doc;
    expect(doc.objects.c.mesh!.vertices).toHaveLength(2);
    expect(() => applyCommand(doc, validateCommand({ type: 'editCurve', id: 'c', op: 'delete', points: [0] }))).toThrow(/two points/);
    // The modifier makes the tube everywhere a mesh is used (render, physics, Convert).
    expect(applyModifiers(doc.objects.c.mesh!, doc.objects.c.modifiers).faces.length).toBeGreaterThan(8);
  });

  it('Follow Path: along the curve between the frames, facing along it, location as offset', () => {
    let doc = scene([
      { type: 'add', primitive: 'mesh', id: 'road', mesh: { vertices: curvePreset('path').points, faces: [], smooth: true }, transform: { position: [0, 10, 0], rotation: [0, 0, 90] } },
      { type: 'setModifiers', id: 'road', modifiers: { curve: {} } },
      { type: 'add', primitive: 'cube', id: 'car', transform: { position: [0, 0, 0.5] } },
      { type: 'setFollow', id: 'car', follow: { curve: 'road', start: 1, end: 101, orient: true } },
    ]);
    const at = (f: number) => transformAt(doc, 'car', f)!;
    // The road runs along +Y (rotated 90°) from y = 8 to 12, at x = 0.
    expect(at(1).position[1]).toBeCloseTo(8, 4);
    expect(at(51).position[1]).toBeCloseTo(10, 4);
    expect(at(101).position[1]).toBeCloseTo(12, 4);
    expect(at(200).position[1]).toBeCloseTo(12, 4);
    expect(at(51).position[2]).toBeCloseTo(0.5, 6);
    // Facing along +Y: no turn needed.
    expect(Math.abs(at(51).rotation[2]) % 360).toBeCloseTo(0, 4);
    // Saved and loaded, and removable.
    expect(validateSceneDoc(JSON.parse(JSON.stringify(doc))).objects.car.follow).toEqual(doc.objects.car.follow);
    expect(() => applyCommand(doc, validateCommand({ type: 'setFollow', id: 'car', follow: { curve: 'car', start: 1, end: 5 } }))).toThrow(/curve/);
    doc = applyCommand(doc, validateCommand({ type: 'setFollow', id: 'car', follow: null })).doc;
    expect(doc.objects.car.follow).toBeUndefined();
  });

  it('the camera flies along a curve, looking ahead or at an object', () => {
    let doc = scene([
      { type: 'add', primitive: 'mesh', id: 'loop', mesh: { vertices: curvePreset('circle').points.map((p) => p.map((x) => x * 10) as Vec3), faces: [], smooth: true } },
      { type: 'setModifiers', id: 'loop', modifiers: { curve: { cyclic: true } } },
      { type: 'add', primitive: 'cube', id: 'hero' },
      { type: 'setCameraFollow', follow: { curve: 'loop', start: 1, end: 97, look: 'hero', height: 2 } },
    ]);
    const c = sceneCameraAt(doc, 25)!;
    expect(Math.hypot(c.position[0], c.position[1])).toBeGreaterThan(9);
    expect(c.position[2]).toBeCloseTo(2, 6);
    expect(c.target).toEqual([0, 0, 0]);
    doc = applyCommand(doc, validateCommand({ type: 'setCameraFollow', follow: { curve: 'loop', start: 1, end: 97, look: 'ahead' } })).doc;
    const a = sceneCameraAt(doc, 25)!;
    expect(Math.hypot(a.target[0] - a.position[0], a.target[1] - a.position[1])).toBeGreaterThan(0.5);
    expect(validateSceneDoc(JSON.parse(JSON.stringify(doc))).animation?.cameraFollow?.look).toBe('ahead');
  });
});
