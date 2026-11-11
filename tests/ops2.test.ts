import { describe, expect, it } from 'vitest';
import { bridgeLoops, connectVerts, dissolve, pokeFaces, shrinkFatten, smoothVerts, toSphere, triangulateFaces, trisToQuads } from '../src/core/mesh/ops2';
import { primitiveMesh } from '../src/core/mesh/primitives';
import { inset } from '../src/core/mesh/ops';
import { edgeMap, ek, isWatertight, signedVolume } from '../src/core/mesh/topology';
import { flush, selectAll } from '../src/core/mesh/select';
import type { MeshData } from '../src/core/types';

const cube = () => primitiveMesh('cube');
/** n × n grid of quads on z = 0, size 2, facing +Z. */
function grid(n: number): MeshData {
  const vertices: [number, number, number][] = [];
  for (let y = 0; y <= n; y++) for (let x = 0; x <= n; x++) vertices.push([-1 + (2 * x) / n, -1 + (2 * y) / n, 0]);
  const faces: number[][] = [];
  const id = (x: number, y: number) => y * (n + 1) + x;
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) faces.push([id(x, y), id(x + 1, y), id(x + 1, y + 1), id(x, y + 1)]);
  return { vertices, faces, smooth: false };
}
const consistent = (m: MeshData) => [...edgeMap(m).values()].every((e) => e.faces.length <= 2);

describe('Dissolve', () => {
  it('faces: a 2×2 patch becomes one face with the same outline', () => {
    const g = grid(2);
    const r = dissolve(g, 'face', flush(g, 'face', { verts: [], edges: [], faces: [0, 1, 2, 3] }));
    expect(r.mesh.faces.length).toBe(1);
    expect(r.mesh.faces[0].length).toBe(8); // the centre vertex goes, edge midpoints stay
    expect(r.mesh.vertices.length).toBe(8);
    expect(r.sel.faces).toEqual([0]);
  });

  it('edges: the two faces merge and in-line vertices go too', () => {
    const g = grid(2);
    // the middle vertical line: (1,0)-(1,1) and (1,1)-(1,2)
    const r = dissolve(g, 'edge', flush(g, 'edge', { verts: [], edges: [ek(1, 4), ek(4, 7)], faces: [] }));
    expect(r.mesh.faces.length).toBe(2);
    expect(r.mesh.faces.every((f) => f.length === 4 || f.length === 5)).toBe(true);
    expect(consistent(r.mesh)).toBe(true);
    // the cube: dissolving one edge leaves a closed solid with 5 faces
    const c = cube();
    const e = [...edgeMap(c).keys()][0];
    const rc = dissolve(c, 'edge', flush(c, 'edge', { verts: [], edges: [e], faces: [] }));
    expect(rc.mesh.faces.length).toBe(5);
    expect(isWatertight(rc.mesh)).toBe(true);
  });

  it('vertices: the four faces around the centre become one, without the centre vertex', () => {
    const g = grid(2);
    const r = dissolve(g, 'vert', flush(g, 'vert', { verts: [4], edges: [], faces: [] }));
    expect(r.mesh.faces.length).toBe(1);
    expect(r.mesh.vertices.length).toBe(8);
    expect(r.mesh.vertices.some((v) => v[0] === 0 && v[1] === 0)).toBe(false);
  });

  it('refuses a ring of faces (would need a hole)', () => {
    const g = grid(3);
    const ring = [0, 1, 2, 3, 5, 6, 7, 8];
    expect(() => dissolve(g, 'face', flush(g, 'face', { verts: [], edges: [], faces: ring }))).toThrow(/hole/);
  });
});

describe('Connect Vertex Path (J)', () => {
  it('splits a quad across its diagonal', () => {
    const g = grid(1);
    const r = connectVerts(g, flush(g, 'vert', { verts: [0, 3], edges: [], faces: [] }));
    expect(r.mesh.faces.length).toBe(2);
    expect(r.mesh.faces.every((f) => f.length === 3)).toBe(true);
    expect(r.sel.edges).toEqual([ek(0, 3)]);
    expect(consistent(r.mesh)).toBe(true);
  });

  it('refuses vertices already joined by an edge', () => {
    const g = grid(1);
    expect(() => connectVerts(g, flush(g, 'vert', { verts: [0, 1], edges: [], faces: [] }))).toThrow();
  });
});

describe('Bridge Edge Loops', () => {
  it('two inset cube faces become a square hole through the solid', () => {
    const c = cube();
    const top = c.faces.findIndex((f) => f.every((v) => c.vertices[v][2] === 1));
    const bottom = c.faces.findIndex((f) => f.every((v) => c.vertices[v][2] === -1));
    const ins = inset(c, flush(c, 'face', { verts: [], edges: [], faces: [top, bottom] }), 0.5, 0, true);
    expect(ins.sel.faces.length).toBe(2);
    const r = bridgeLoops(ins.mesh, ins.sel, 'face');
    expect(isWatertight(r.mesh)).toBe(true);
    expect(r.sel.faces.length).toBe(4);
    // 2 × 2 × 2 minus the 1 × 1 × 2 hole
    expect(signedVolume(r.mesh)).toBeCloseTo(6, 6);
  });

  it('joins two open-ended tubes into one closed band', () => {
    // Two square rings (open tubes would be similar); here: two separate quads facing each other, open edges bridged.
    const m: MeshData = {
      vertices: [
        [-1, -1, 0], [1, -1, 0], [1, 1, 0], [-1, 1, 0],
        [-1, -1, 2], [1, -1, 2], [1, 1, 2], [-1, 1, 2],
      ],
      faces: [[3, 2, 1, 0], [4, 5, 6, 7]], // bottom faces down, top faces up
      smooth: false,
    };
    const all = selectAll(m, 'edge');
    const r = bridgeLoops(m, all, 'edge');
    expect(r.mesh.faces.length).toBe(6);
    expect(isWatertight(r.mesh)).toBe(true);
    expect(signedVolume(r.mesh)).toBeCloseTo(8, 9);
  });

  it('asks for matching loops', () => {
    const m: MeshData = { vertices: [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 2], [1, 0, 2], [1, 1, 2], [0, 1, 2]], faces: [[0, 2, 1], [3, 4, 5, 6]], smooth: false };
    expect(() => bridgeLoops(m, selectAll(m, 'edge'), 'edge')).toThrow(/same number/);
  });
});

describe('deform tools', () => {
  it('Smooth Vertices pulls a spike back in', () => {
    const g = grid(2);
    g.vertices[4] = [0, 0, 1];
    const r = smoothVerts(g, flush(g, 'vert', { verts: [4], edges: [], faces: [] }), 'vert', 1, 1);
    expect(r.mesh.vertices[4][2]).toBeCloseTo(0, 9);
  });

  it('Shrink/Fatten moves along normals; To Sphere rounds a cube', () => {
    const c = cube();
    const all = selectAll(c, 'vert');
    const fat = shrinkFatten(c, all, 'vert', 0.5);
    expect(signedVolume(fat.mesh)).toBeGreaterThan(signedVolume(c));
    const g = grid(4);
    const sph = toSphere(g, selectAll(g, 'vert'), 'vert', 1);
    const c0 = [0, 0, 0];
    const r = sph.mesh.vertices.map((v) => Math.hypot(v[0] - c0[0], v[1] - c0[1], v[2] - c0[2]));
    // all on one circle around the centre (the centre vertex itself stays)
    const rs = r.filter((x) => x > 1e-9);
    expect(Math.max(...rs) - Math.min(...rs)).toBeLessThan(1e-9);
  });
});

describe('triangles and quads', () => {
  it('Triangulate then Tris to Quads round-trips a cube', () => {
    const c = cube();
    const t = triangulateFaces(c, selectAll(c, 'face'));
    expect(t.mesh.faces.length).toBe(12);
    expect(t.sel.faces.length).toBe(12);
    const q = trisToQuads(t.mesh, t.sel);
    expect(q.mesh.faces.length).toBe(6);
    expect(q.mesh.faces.every((f) => f.length === 4)).toBe(true);
    expect(isWatertight(q.mesh)).toBe(true);
    expect(signedVolume(q.mesh)).toBeCloseTo(8, 9);
  });

  it('Tris to Quads leaves a bent pair alone', () => {
    const m: MeshData = { vertices: [[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 1]], faces: [[0, 1, 2], [2, 1, 3]], smooth: false };
    m.vertices[3] = [1, 1, 3];
    expect(() => trisToQuads(m, selectAll(m, 'face'))).toThrow();
  });

  it('Poke Faces fans each face to its centre', () => {
    const c = cube();
    const p = pokeFaces(c, selectAll(c, 'face'), 0.2);
    expect(p.mesh.faces.length).toBe(24);
    expect(p.mesh.vertices.length).toBe(14);
    expect(isWatertight(p.mesh)).toBe(true);
    expect(signedVolume(p.mesh)).toBeGreaterThan(8);
  });
});
