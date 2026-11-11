import { beforeAll, describe, expect, it } from 'vitest';
import * as CANNON from 'cannon-es';
import { loadBooleans } from '../src/core/mesh/boolean';
import { fracturePieces, fractureSeeds, insideMesh } from '../src/core/fracture';
import { primitiveMesh } from '../src/core/mesh/primitives';
import { isWatertight, signedVolume } from '../src/core/mesh/topology';
import { registerPhysics, simulate } from '../src/core/physics';
import { applyCommand, validateCommand } from '../src/core/commands';
import { createDefaultDoc } from '../src/core/store';
import { transformAt } from '../src/core/animation';

registerPhysics(CANNON);

describe('Cell fracture', () => {
  beforeAll(() => loadBooleans());

  it('finds seed points inside the mesh only', () => {
    const cube = primitiveMesh('cube');
    expect(insideMesh(cube, [0, 0, 0])).toBe(true);
    expect(insideMesh(cube, [1.5, 0, 0])).toBe(false);
    const sphere = primitiveMesh('sphere');
    const seeds = fractureSeeds(sphere, 20, 7);
    expect(seeds.length).toBe(20);
    expect(seeds.every((p) => Math.hypot(...p) < 1)).toBe(true);
    expect(fractureSeeds(sphere, 20, 7)).toEqual(seeds); // same seed, same points
  });

  it('pieces are closed, convex-ish solids that add up to the whole', () => {
    const cube = primitiveMesh('cube');
    const pieces = fracturePieces(cube, 12, 3);
    expect(pieces.length).toBe(12);
    let vol = 0;
    for (const p of pieces) {
      expect(isWatertight(p.mesh)).toBe(true);
      const v = signedVolume(p.mesh);
      expect(v).toBeGreaterThan(0);
      vol += v;
    }
    expect(vol).toBeCloseTo(8, 3);
    expect(pieces.reduce((s, p) => s + p.share, 0)).toBeCloseTo(1, 6);
  });

  it('the fracture command replaces the object with rigid pieces that fall apart when hit', () => {
    let doc = createDefaultDoc();
    doc = applyCommand(doc, validateCommand({ type: 'delete', ids: [...doc.order] })).doc;
    for (const c of [
      { type: 'add', primitive: 'cube', id: 'ground', transform: { position: [0, 0, -0.5], scale: [8, 8, 0.5] } },
      { type: 'setRigidBody', id: 'ground', rigid: { type: 'passive' } },
      { type: 'add', primitive: 'cube', id: 'wall', name: 'Wall', transform: { position: [0, 0, 1], rotation: [0, 0, 30], scale: [1.5, 0.15, 1] } },
      { type: 'setRigidBody', id: 'wall', rigid: { mass: 100 } },
    ]) doc = applyCommand(doc, validateCommand(c)).doc;
    const r = applyCommand(doc, validateCommand({ type: 'fracture', id: 'wall', pieces: 10 }));
    doc = r.doc;
    expect(doc.objects.wall).toBeUndefined();
    expect(r.created.length).toBe(10);
    const pieces = r.created.map((id) => doc.objects[id]);
    expect(pieces.every((p) => p.rigid?.shape === 'hull' && p.rigid.type === 'active' && p.name.startsWith('Wall piece'))).toBe(true);
    expect(pieces.reduce((s, p) => s + p.rigid!.mass, 0)).toBeCloseTo(100, 0);
    // The pieces still make the wall: their centres stay inside its rotated, scaled box.
    for (const p of pieces) {
      const [x, y, z] = p.transform.position;
      const a = (-30 * Math.PI) / 180;
      const lx = x * Math.cos(a) - y * Math.sin(a), ly = x * Math.sin(a) + y * Math.cos(a);
      expect(Math.abs(lx)).toBeLessThan(1.5);
      expect(Math.abs(ly)).toBeLessThan(0.15);
      expect(z).toBeGreaterThan(0);
      expect(z).toBeLessThan(2);
    }
    // Standing pieces stay put (convex hulls fit together)…
    const still = simulate(doc, 1, 24, 24);
    for (const id of r.created) {
      const k = still.tracks[id];
      const [x0, y0, z0] = k[0].transform.position, [x1, y1, z1] = k[k.length - 1].transform.position;
      expect(Math.hypot(x1 - x0, y1 - y0, z1 - z0)).toBeLessThan(0.05);
    }
    // …until a ball smashes through.
    doc = applyCommand(doc, validateCommand({ type: 'add', primitive: 'sphere', id: 'ball', transform: { position: [-1.5, -2.6, 1], scale: [0.3, 0.3, 0.3] } })).doc;
    doc = applyCommand(doc, validateCommand({ type: 'setRigidBody', id: 'ball', rigid: { mass: 40, velocity: [6, 10.4, 0] } })).doc;
    doc = applyCommand(doc, validateCommand({ type: 'bakePhysics', start: 1, end: 48 })).doc;
    const moved = r.created.filter((id) => {
      const a = transformAt(doc, id, 1)!.position, b = transformAt(doc, id, 48)!.position;
      return Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) > 0.2;
    });
    expect(moved.length).toBeGreaterThan(2);
    expect(() => validateCommand({ type: 'fracture', id: 'x', pieces: 1 })).toThrow(/pieces/);
  });
});
