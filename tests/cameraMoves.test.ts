import { describe, expect, it } from 'vitest';
import { applyCommand, validateCommand } from '../src/core/commands';
import { createDefaultDoc } from '../src/core/store';
import { evaluateCamera } from '../src/core/animation';
import { sampleCameraMove, sceneObstacles } from '../src/core/cameraMoves';
import { terrainSample } from '../src/core/terrain';
import type { SceneDoc } from '../src/core/types';

const run = (doc: SceneDoc, cmd: unknown) => applyCommand(doc, validateCommand(cmd)).doc;
const flat = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1]);

describe('camera moves', () => {
  it('orbit keeps distance and height and sweeps the requested angle smoothly', () => {
    const s = sampleCameraMove({ move: 'orbit', target: [1, 2, 0], start: 1, end: 121, distance: 10, height: 4, heading: 270, degrees: 180 });
    expect(s[0].frame).toBe(1);
    expect(s[s.length - 1].frame).toBe(121);
    for (const k of s) {
      expect(flat(k.position, [1, 2])).toBeCloseTo(10, 2);
      expect(k.position[2]).toBeCloseTo(4, 3);
      expect(k.target).toEqual([1, 2, 0]);
    }
    // starts at the front (−Y) and ends at the back (+Y)
    expect(s[0].position[1]).toBeCloseTo(-8, 2);
    expect(s[s.length - 1].position[1]).toBeCloseTo(12, 2);
    // eased: slow at the ends, faster in the middle
    const d = (i: number) => flat(s[i].position, s[i + 1].position);
    expect(d(0)).toBeLessThan(d(Math.floor(s.length / 2)) / 3);
  });

  it('dolly in gets closer; flyover passes over the target; crane rises', () => {
    const dolly = sampleCameraMove({ move: 'dollyIn', target: [0, 0, 0], start: 0, end: 48, distance: 10 });
    expect(flat(dolly[dolly.length - 1].position, [0, 0])).toBeLessThan(flat(dolly[0].position, [0, 0]) * 0.5);
    const fly = sampleCameraMove({ move: 'flyover', target: [0, 0, 0], start: 0, end: 48, distance: 20, heading: 270 });
    expect(fly[0].position[1]).toBeLessThan(-15);
    expect(fly[fly.length - 1].position[1]).toBeGreaterThan(15);
    expect(Math.min(...fly.map((k) => flat(k.position, [0, 0])))).toBeLessThan(1);
    const crane = sampleCameraMove({ move: 'crane', target: [0, 0, 0], start: 0, end: 48, distance: 10, height: 4 });
    expect(crane[crane.length - 1].position[2]).toBeGreaterThan(crane[0].position[2] + 5);
  });

  it('cameraMove replaces camera keys in its range, keeps others, extends the timeline and sets the start view', () => {
    let doc = run(createDefaultDoc(), { type: 'setCameraKey', frame: 1, position: [9, 9, 9], target: [0, 0, 0] });
    doc = run(doc, { type: 'setCameraKey', frame: 400, position: [5, 5, 5], target: [0, 0, 0] });
    doc = run(doc, { type: 'cameraMove', move: 'orbit', target: [0, 0, 1], start: 10, end: 300, distance: 8 });
    const keys = doc.animation!.camera;
    expect(keys.find((k) => k.frame === 1)).toBeTruthy();
    expect(keys.find((k) => k.frame === 400)).toBeTruthy();
    expect(keys.filter((k) => k.frame >= 10 && k.frame <= 300).length).toBeGreaterThan(50);
    expect(doc.animation!.end).toBeGreaterThanOrEqual(300);
    const mid = evaluateCamera(keys, 155)!;
    expect(flat(mid.position, [0, 0])).toBeCloseTo(8, 1);
    expect(doc.camera!.position).toEqual(keys.find((k) => k.frame === 10)!.position);
  });

  it('can target an object and rejects bad input', () => {
    let doc = run(createDefaultDoc(), { type: 'add', primitive: 'cube', id: 'box', transform: { position: [3, 4, 1] } });
    doc = run(doc, { type: 'cameraMove', move: 'orbit', on: 'box', start: 1, end: 50, distance: 5 });
    expect(doc.animation!.camera[0].target).toEqual([3, 4, 1]);
    expect(() => validateCommand({ type: 'cameraMove', move: 'spin' })).toThrow(/move must be/);
    expect(() => applyCommand(doc, validateCommand({ type: 'cameraMove', move: 'orbit', start: 50, end: 10 }))).toThrow(/after start/);
  });
});

describe('camera moves over terrain', () => {
  it('keep the camera above the ground', () => {
    let doc = run(createDefaultDoc(), { type: 'addTerrain', id: 'land', size: [100, 100], resolution: 60, height: 30, seed: 3, rim: 25 });
    doc = run(doc, { type: 'cameraMove', move: 'orbit', target: [0, 0, 0], start: 1, end: 100, distance: 45, height: 1, degrees: 360 });

    for (const k of doc.animation!.camera) {
      const g = terrainSample(doc.objects.land, k.position[0], k.position[1]);
      if (g) expect(k.position[2]).toBeGreaterThanOrEqual(g.z + 1.99);
    }
  });
});

describe('camera clearance', () => {
  it('flies over a scatter forest and houses on its path, smoothly, and not over the subject', () => {
    let doc = run(createDefaultDoc(), { type: 'addTerrain', id: 'land', size: [120, 120], resolution: 60, height: 0.5, seed: 1 });
    doc = run(doc, { type: 'addPlant', id: 'pine', kind: 'pine', seed: 1, height: 10 });
    doc = run(doc, { type: 'scatter', id: 'trees', source: 'pine', on: 'land', count: 300, seed: 2, spacing: 3, avoid: [{ center: [0, 0], radius: 12 }] });
    doc = run(doc, { type: 'addBuilding', id: 'house', width: 6, depth: 6, floors: 2, transform: { position: [0, 0, 0] } });
    const free = run(doc, { type: 'cameraMove', move: 'orbit', target: [0, 0, 2], start: 1, end: 200, distance: 25, height: 2, degrees: 360, clearance: false });
    const lifted = run(doc, { type: 'cameraMove', move: 'orbit', target: [0, 0, 2], start: 1, end: 200, distance: 25, height: 2, degrees: 360 });
    const zFree = free.animation!.camera.map((k) => k.position[2]);
    const z = lifted.animation!.camera.map((k) => k.position[2]);
    expect(Math.max(...zFree)).toBeLessThan(6);
    // Wherever a pine (or the house) is under or beside the camera, the camera is above it.
    const obs = sceneObstacles(doc).filter((ob) => Math.hypot(ob.x, ob.y) > ob.r + 0.5);
    let near = 0;
    for (const k of lifted.animation!.camera)
      for (const ob of obs)
        if (Math.hypot(k.position[0] - ob.x, k.position[1] - ob.y) < ob.r + 1) {
          near++;
          expect(k.position[2]).toBeGreaterThanOrEqual(ob.top + 1.49);
        }
    expect(near).toBeGreaterThan(20);
    expect(Math.max(...z)).toBeGreaterThan(10);
    for (let i = 1; i < z.length; i++) expect(Math.abs(z[i] - z[i - 1])).toBeLessThan(3); // no sudden jumps
    // A close orbit of the house itself is not lifted over the house.
    const close = run(doc, { type: 'cameraMove', move: 'orbit', target: [0, 0, 2], start: 1, end: 60, distance: 7, height: 1, degrees: 90 });
    expect(Math.max(...close.animation!.camera.map((k) => k.position[2]))).toBeLessThan(4);
  });
});
