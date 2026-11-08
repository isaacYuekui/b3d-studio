import { describe, expect, it } from 'vitest';
import { primitiveMesh } from '../src/core/mesh/primitives';
import { PRIMITIVES } from '../src/core/types';
import type { MeshData } from '../src/core/types';
import { compact, edgeMap, ek, faceNormal, isWatertight, signedVolume, triangulate } from '../src/core/mesh/topology';
import { EMPTY_SEL, edgeLoop, flush, invert, pickElement, selectAll, selectLinked } from '../src/core/mesh/select';
import { bevel, deleteSelected, duplicateFaces, extrude, fill, flipNormals, inset, loopCut, mergeAtCenter, mergeByDistance, recalcNormals, subdivide } from '../src/core/mesh/ops';
import { applyModifiers, catmullClark, mirror } from '../src/core/mesh/modifiers';

const cube = () => primitiveMesh('cube');
const euler = (m: MeshData) => m.vertices.length - edgeMap(m).size + m.faces.length;
const topFace = (m: MeshData) => m.faces.findIndex((f) => f.every((v) => m.vertices[v][2] > 0.99));
const faceSel = (m: MeshData, faces: number[]) => flush(m, 'face', { ...EMPTY_SEL, faces });
const edgeSel = (m: MeshData, edges: string[]) => flush(m, 'edge', { ...EMPTY_SEL, edges });

describe('primitives as polygon meshes', () => {
  it.each(PRIMITIVES.filter((p) => p !== 'plane'))('%s is closed, outward and genus-correct', (p) => {
    const m = primitiveMesh(p);
    expect(isWatertight(m)).toBe(true);
    expect(signedVolume(m)).toBeGreaterThan(0);
    expect(euler(m)).toBe(p === 'torus' ? 0 : 2);
  });
  it('matches Blender default topology', () => {
    expect(cube().vertices.length).toBe(8);
    expect(cube().faces.length).toBe(6);
    const s = primitiveMesh('sphere');
    expect(s.vertices.length).toBe(32 * 15 + 2);
    expect(s.faces.length).toBe(32 * 16);
    expect(primitiveMesh('cylinder').faces.length).toBe(34);
    expect(primitiveMesh('torus').faces.length).toBe(48 * 12);
    expect(faceNormal(primitiveMesh('plane').vertices, primitiveMesh('plane').faces[0])).toEqual([0, 0, 1]);
  });
});

describe('selection', () => {
  it('flushes vertices to edges and faces', () => {
    const m = cube();
    const s = flush(m, 'vert', { ...EMPTY_SEL, verts: m.faces[topFace(m)] });
    expect(s.edges.length).toBe(4);
    expect(s.faces).toEqual([topFace(m)]);
    expect(selectAll(m, 'edge').edges.length).toBe(12);
    expect(invert(m, 'face', faceSel(m, [0])).faces.length).toBe(5);
    expect(pickElement(m, 'face', faceSel(m, [0]), 1, true).faces).toEqual([0, 1]);
    expect(selectLinked(m, 'vert', flush(m, 'vert', { ...EMPTY_SEL, verts: [0] })).verts.length).toBe(8);
  });
  it('edge loop runs around a cylinder side and a sphere', () => {
    const s = primitiveMesh('sphere');
    // A ring edge on the equator band of the UV sphere loops all the way round (32 edges).
    const a = 1 + 7 * 32, b = a + 1;
    expect(edgeLoop(s, ek(a, b)).length).toBe(32);
    const c = cube();
    expect(edgeLoop(c, ek(0, 1)).length).toBe(1); // cube corners are 3-valent: no loop
  });
});

describe('operators', () => {
  it('extrudes a face region', () => {
    const m = cube();
    const r = extrude(m, faceSel(m, [topFace(m)]), 1);
    expect(r.mesh.faces.length).toBe(10);
    expect(r.mesh.vertices.length).toBe(12);
    expect(isWatertight(r.mesh)).toBe(true);
    expect(signedVolume(r.mesh)).toBeCloseTo(12, 6);
    expect(r.sel.faces.length).toBe(1);
    expect(r.mesh.faces[r.sel.faces[0]].every((v) => r.mesh.vertices[v][2] === 2)).toBe(true);
  });
  it('extrudes a plane boundary edge outwards in its plane', () => {
    const p = primitiveMesh('plane');
    const r = extrude(p, edgeSel(p, [ek(1, 2)]), 1);
    expect(r.mesh.faces.length).toBe(2);
    const xs = r.mesh.vertices.map((v) => v[0]);
    expect(Math.max(...xs)).toBeCloseTo(2);
    expect(faceNormal(r.mesh.vertices, r.mesh.faces[1])[2]).toBeCloseTo(1);
  });
  it('insets a face (region and individual)', () => {
    const m = cube();
    const r = inset(m, faceSel(m, [topFace(m)]), 0.25);
    expect(r.mesh.faces.length).toBe(10);
    expect(isWatertight(r.mesh)).toBe(true);
    const inner = r.mesh.faces[r.sel.faces[0]].map((v) => r.mesh.vertices[v]);
    inner.forEach((p) => expect(Math.abs(p[0])).toBeCloseTo(0.75));
    const two = inset(m, faceSel(m, [0, 1]), 0.2, 0, true);
    expect(two.mesh.faces.length).toBe(6 + 8);
    expect(isWatertight(two.mesh)).toBe(true);
  });
  it('bevels one cube edge, all edges, and with segments', () => {
    const m = cube();
    const one = bevel(m, edgeSel(m, [ek(4, 5)]), 0.2);
    expect(one.mesh.faces.length).toBe(7);
    expect(one.mesh.vertices.length).toBe(10);
    expect(isWatertight(one.mesh)).toBe(true);
    const all = bevel(m, selectAll(m, 'edge'), 0.2);
    expect(all.mesh.faces.length).toBe(26);
    expect(isWatertight(all.mesh)).toBe(true);
    expect(signedVolume(all.mesh)).toBeLessThan(8);
    const round = bevel(m, edgeSel(m, [ek(4, 5)]), 0.3, 4);
    expect(isWatertight(round.mesh)).toBe(true);
    expect(round.sel.faces.length).toBe(4);
    const roundAll = bevel(m, selectAll(m, 'edge'), 0.3, 3);
    expect(isWatertight(roundAll.mesh)).toBe(true);
    const two = bevel(m, edgeSel(m, [ek(4, 5), ek(5, 6)]), 0.2, 2);
    expect(isWatertight(two.mesh)).toBe(true);
  });
  it('loop cuts a cube and a cylinder', () => {
    const m = cube();
    const r = loopCut(m, ek(4, 5), 1);
    expect(r.mesh.faces.length).toBe(10);
    expect(r.mesh.vertices.length).toBe(12);
    expect(r.sel.edges.length).toBe(4);
    expect(isWatertight(r.mesh)).toBe(true);
    const r3 = loopCut(m, ek(4, 5), 3);
    expect(r3.mesh.faces.length).toBe(6 + 4 * 3);
    expect(isWatertight(r3.mesh)).toBe(true);
    const cyl = primitiveMesh('cylinder');
    const side = cyl.faces[0];
    const rc = loopCut(cyl, ek(side[1], side[2]), 2); // vertical edge → horizontal rings
    expect(isWatertight(rc.mesh)).toBe(true);
    expect(rc.mesh.faces.length).toBe(34 + 64);
    const slid = loopCut(m, ek(4, 5), 1, 0.5);
    expect(isWatertight(slid.mesh)).toBe(true);
  });
  it('loop cut stops at triangles and keeps the mesh closed', () => {
    const s = primitiveMesh('sphere');
    const a = 1 + 3 * 32; // a vertical edge between rings 4 and 5
    const r = loopCut(s, ek(a, a + 32), 1);
    expect(isWatertight(r.mesh)).toBe(true);
    const tri = loopCut(s, ek(1, 2), 1); // ring edge next to the pole: cut runs pole to pole
    expect(isWatertight(tri.mesh)).toBe(true);
  });
  it('subdivides faces and keeps neighbours connected', () => {
    const m = cube();
    const r = subdivide(m, faceSel(m, [topFace(m)]));
    expect(r.mesh.faces.length).toBe(9);
    expect(isWatertight(r.mesh)).toBe(true);
    const all = subdivide(m, selectAll(m, 'face'));
    expect(all.mesh.faces.length).toBe(24);
    expect(isWatertight(all.mesh)).toBe(true);
  });
  it('deletes, merges, fills', () => {
    const m = cube();
    const del = deleteSelected(m, 'face', faceSel(m, [topFace(m)]));
    expect(del.mesh.faces.length).toBe(5);
    const top = m.faces[topFace(m)];
    const filled = fill(del.mesh, flush(del.mesh, 'vert', { ...EMPTY_SEL, verts: top }));
    expect(filled.mesh.faces.length).toBe(6);
    expect(isWatertight(filled.mesh)).toBe(true);
    expect(signedVolume(filled.mesh)).toBeCloseTo(8);
    const merged = mergeAtCenter(m, flush(m, 'vert', { ...EMPTY_SEL, verts: top }));
    expect(merged.mesh.vertices.length).toBe(5); // a pyramid
    expect(merged.mesh.faces.length).toBe(5);
    expect(isWatertight(merged.mesh)).toBe(true);
    const delV = deleteSelected(m, 'vert', flush(m, 'vert', { ...EMPTY_SEL, verts: [0] }));
    expect(delV.mesh.faces.length).toBe(3);
  });
  it('merges by distance', () => {
    const m = cube();
    const d = duplicateFaces(m, selectAll(m, 'face'));
    expect(d.mesh.vertices.length).toBe(16);
    const r = mergeByDistance(d.mesh, EMPTY_SEL, 0.001);
    expect(r.removed).toBe(8);
    expect(r.mesh.faces.length).toBe(6); // exact duplicates collapse
  });
  it('flips and recalculates normals', () => {
    const m = cube();
    const flipped = flipNormals(m, selectAll(m, 'face'), 'face');
    expect(signedVolume(flipped.mesh)).toBeLessThan(0);
    const mixed = flipNormals(m, faceSel(m, [0, 2]), 'face');
    expect(isWatertight(mixed.mesh)).toBe(false);
    const fixed = recalcNormals(mixed.mesh, EMPTY_SEL, 'face');
    expect(isWatertight(fixed.mesh)).toBe(true);
    expect(signedVolume(fixed.mesh)).toBeGreaterThan(0);
  });
  it('compacts degenerate faces', () => {
    const c = compact({ vertices: [[0, 0, 0], [1, 0, 0], [0, 1, 0], [5, 5, 5]], faces: [[0, 1, 2], [0, 0, 1]], smooth: false });
    expect(c.mesh.faces.length).toBe(1);
    expect(c.mesh.vertices.length).toBe(3);
  });
  it('triangulates concave polygons without overlap', () => {
    const L = { vertices: [[0, 0, 0], [2, 0, 0], [2, 1, 0], [1, 1, 0], [1, 2, 0], [0, 2, 0]] as [number, number, number][], faces: [[0, 1, 2, 3, 4, 5]], smooth: false };
    const tris = triangulate(L.vertices, L.faces[0]);
    expect(tris.length).toBe(4);
    const area = tris.reduce((s, [a, b, c]) => {
      const [p, q, r] = [L.vertices[a], L.vertices[b], L.vertices[c]];
      return s + ((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])) / 2;
    }, 0);
    expect(area).toBeCloseTo(3);
  });
});

describe('modifiers', () => {
  it('subdivision smooths a cube towards a sphere and stays closed', () => {
    const s1 = catmullClark(cube());
    expect(s1.faces.length).toBe(24);
    expect(isWatertight(s1)).toBe(true);
    const s2 = applyModifiers(cube(), { subdivision: { levels: 2 } });
    expect(s2.faces.length).toBe(96);
    const r = Math.max(...s2.vertices.map((v) => Math.hypot(...v)));
    expect(r).toBeLessThan(Math.sqrt(3));
  });
  it('mirror welds on the plane', () => {
    // Half a cube: the right half (x from 0 to 1), open at x = 0.
    const half: MeshData = { vertices: [[0, -1, -1], [1, -1, -1], [1, 1, -1], [0, 1, -1], [0, -1, 1], [1, -1, 1], [1, 1, 1], [0, 1, 1]], faces: [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6]], smooth: false };
    const m = mirror(half, 0);
    expect(m.vertices.length).toBe(12);
    expect(m.faces.length).toBe(10);
    expect(isWatertight(m)).toBe(true);
    expect(signedVolume(m)).toBeCloseTo(8);
    const both = applyModifiers(half, { mirror: { x: true, y: false, z: false }, subdivision: { levels: 1 } });
    expect(isWatertight(both)).toBe(true);
  });
});
