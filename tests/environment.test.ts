import { describe, expect, it } from 'vitest';
import { Document, WebIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS, EXTMeshGPUInstancing, KHRTextureTransform } from '@gltf-transform/extensions';
import { unzlibSync, zlibSync } from 'fflate';
import { applyCommand, validateCommand } from '../src/core/commands';
import { createDefaultDoc } from '../src/core/store';
import { generateTerrain, scatterOn, terrainSample } from '../src/core/terrain';
import { makePlant, PLANT_KINDS } from '../src/core/plants';
import { makeBuilding, ROOFS } from '../src/core/buildings';
import { isWatertight, signedVolume } from '../src/core/mesh/topology';
import { encodePng, ROBLOX_TERRAIN_COLORS, STUD, terrainHeightmap } from '../src/core/robloxTerrain';
import { ROBLOX_MAX_TRIS, toRobloxGlb } from '../src/engine/robloxExport';
import type { SceneDoc } from '../src/core/types';

const run = (doc: SceneDoc, cmd: unknown) => applyCommand(doc, validateCommand(cmd)).doc;
const at = (o: never, x: number, y: number) => terrainSample(o, x, y)!;
const tris = (faces: number[][]) => faces.reduce((s, f) => s + f.length - 2, 0);

describe('terrain', () => {
  const params = { size: [80, 60] as [number, number], resolution: 80, height: 12, seed: 4, flats: [{ center: [0, 0] as [number, number], radius: 8, height: 2 }], paths: [{ points: [[-40, -20], [0, 0], [40, 25]] as [number, number][], width: 3 }] };

  it('is deterministic, sized and has one splat triple per vertex', () => {
    const a = generateTerrain(params), b = generateTerrain(params);
    expect(a.mesh.vertices).toEqual(b.mesh.vertices);
    expect(a.terrain.nx * a.terrain.ny).toBe(a.mesh.vertices.length);
    expect(a.terrain.splat.length).toBe(a.mesh.vertices.length * 3);
    const xs = a.mesh.vertices.map((v) => v[0]), ys = a.mesh.vertices.map((v) => v[1]);
    expect(Math.min(...xs)).toBeCloseTo(-40);
    expect(Math.max(...ys)).toBeCloseTo(30);
  });

  it('levels flats and keeps paths on the ground (no causeways between far points)', () => {
    const { mesh, terrain } = generateTerrain(params);
    const o = { mesh, terrain, transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } } as never;
    expect(at(o, 0, 0).z).toBeCloseTo(2, 0);
    // Along the path, the surface stays within a metre or so of the ground beside it.
    for (const t of [0.25, 0.5, 0.75]) {
      const x = 40 * t, y = 25 * t;
      const on = at(o, x, y);
      expect(on.path).toBeGreaterThan(0.5);
      const side = (at(o, x - 4, y + 6).z + at(o, x + 4, y - 6).z) / 2;
      expect(Math.abs(on.z - side)).toBeLessThan(1.6);
    }
  });

  it('scatters on the surface, respecting avoid zones and paths', () => {
    const { mesh, terrain } = generateTerrain(params);
    const o = { mesh, terrain, transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } } as never;
    const items = scatterOn(o, { count: 200, seed: 3, spacing: 2, avoidPaths: true, avoid: [{ center: [0, 0], radius: 10 }] });
    expect(items.length).toBeGreaterThan(100);
    for (const [x, y, z] of items) {
      expect(Math.hypot(x, y)).toBeGreaterThanOrEqual(10);
      expect(Math.abs(z - at(o, x, y).z)).toBeLessThan(0.05);
      expect(at(o, x, y).path).toBeLessThan(0.5);
    }
  });
});

describe('plants and buildings', () => {
  it.each(PLANT_KINDS)('%s is light enough for games and deterministic', (kind) => {
    const a = makePlant(kind, 3), b = makePlant(kind, 3);
    expect(a).toEqual(b);
    const n = tris(a.wood?.faces ?? []) + tris(a.leaves?.faces ?? []);
    expect(n).toBeGreaterThan(0);
    expect(n).toBeLessThan(3000);
  });

  it('pine trunks stay inside the canopy', () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const p = makePlant('pine', seed);
      const top = Math.max(...p.wood!.vertices.map((v) => v[2]));
      const crown = Math.max(...p.leaves!.vertices.map((v) => v[2]));
      expect(top).toBeLessThan(crown);
    }
  });

  it.each(ROOFS)('%s-roof house parts are closed and outward', (roof) => {
    const b = makeBuilding({ width: 8, depth: 6, floors: 2, roof, seed: 2 });
    for (const part of [b.walls, b.roof, b.base]) {
      expect(isWatertight(part)).toBe(true);
      expect(signedVolume(part)).toBeGreaterThan(0);
    }
    expect(b.glass.faces.length).toBeGreaterThan(0);
    expect(b.door.faces.length).toBeGreaterThan(0);
  });

  it('script commands build a small valley scene', () => {
    let doc = createDefaultDoc();
    doc = run(doc, { type: 'addTerrain', id: 'land', size: [60, 60], resolution: 60, height: 8, seed: 2 });
    doc = run(doc, { type: 'addPlant', id: 'pine', kind: 'pine', seed: 1 });
    doc = run(doc, { type: 'scatter', id: 'pines', source: 'pine', on: 'land', count: 40, seed: 1 });
    doc = run(doc, { type: 'addBuilding', id: 'h', width: 6, depth: 5, floors: 1, roof: 'hip' });
    expect(doc.objects.pines.scatter!.items.length).toBeGreaterThan(20);
    expect(doc.objects.pine.visible).toBe(false); // template hidden
    expect(Object.values(doc.objects).filter((o) => o.parentId === 'h').length).toBeGreaterThanOrEqual(6);
  });
});

describe('Roblox terrain heightmap', () => {
  const doc = run(createDefaultDoc(), { type: 'addTerrain', id: 'land', size: [112, 56], resolution: 80, height: 10, seed: 5, position: [10, 20, 1], paths: [{ points: [[-56, 0], [56, 0]], width: 4 }] });
  const hm = terrainHeightmap(doc.objects.land);

  it('sizes the import region in studs at 2 studs per pixel', () => {
    expect(hm.sizeStuds[0]).toBeCloseTo(112 / STUD, 0);
    expect(hm.sizeStuds[2]).toBeCloseTo(56 / STUD, 0);
    expect(hm.width).toBe(Math.round(112 / STUD / 2));
    expect(hm.height).toBe(Math.round(56 / STUD / 2));
    // Roblox (X, Z) = (x, −y) / STUD
    expect(hm.positionStuds[0]).toBeCloseTo(10 / STUD, 0);
    expect(hm.positionStuds[2]).toBeCloseTo(-20 / STUD, 0);
  });

  it('spans black to white and paints the path with the Ground colour', () => {
    expect(Math.min(...hm.heights)).toBe(0);
    expect(Math.max(...hm.heights)).toBe(255);
    const mid = Math.floor(hm.height / 2) * hm.width + Math.floor(hm.width / 2);
    expect([...hm.colors.subarray(mid * 3, mid * 3 + 3)]).toEqual([...ROBLOX_TERRAIN_COLORS.Ground]);
    const keys = new Set(Object.values(ROBLOX_TERRAIN_COLORS).map((c) => c.join()));
    for (let i = 0; i < hm.colors.length; i += 3 * 97) expect(keys.has([...hm.colors.subarray(i, i + 3)].join())).toBe(true);
  });

  it('encodes valid PNGs', () => {
    const png = encodePng(hm.width, hm.height, hm.heights, 1, (b) => zlibSync(b));
    expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    // IDAT round-trips to the filtered rows.
    const len = new DataView(png.buffer, png.byteOffset + 33).getUint32(0);
    const raw = unzlibSync(png.subarray(41, 41 + len));
    expect(raw.length).toBe((hm.width + 1) * hm.height);
    expect(raw[1]).toBe(hm.heights[0]);
  });
});

describe('Roblox GLB post-processing', () => {
  const io = new WebIO().registerExtensions(ALL_EXTENSIONS);

  /** A grid mesh with `n` × `n` quads (2n² triangles) and UVs. */
  const grid = (doc: Document, n: number) => {
    const pos: number[] = [], uv: number[] = [], idx: number[] = [];
    for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) pos.push(i, 0, j), uv.push(i / n, j / n);
    for (let j = 0; j < n; j++)
      for (let i = 0; i < n; i++) {
        const a = j * (n + 1) + i;
        idx.push(a, a + n + 1, a + 1, a + 1, a + n + 1, a + n + 2);
      }
    const buf = doc.getRoot().listBuffers()[0] ?? doc.createBuffer();
    return doc
      .createPrimitive()
      .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(new Float32Array(pos)).setBuffer(buf))
      .setAttribute('TEXCOORD_0', doc.createAccessor().setType('VEC2').setArray(new Float32Array(uv)).setBuffer(buf))
      .setIndices(doc.createAccessor().setType('SCALAR').setArray(new Uint32Array(idx)).setBuffer(buf));
  };

  it('splits big meshes, expands instances, bakes tiling, scales to studs and turns to face −Y', async () => {
    const doc = new Document();
    doc.createBuffer();
    const scene = doc.createScene();
    // 1) a 120×120 grid = 28,800 triangles, with tiled texture (scale 2)
    const tt = doc.createExtension(KHRTextureTransform);
    const mat = doc.createMaterial('m').setBaseColorTexture(doc.createTexture('t').setImage(new Uint8Array([1])).setMimeType('image/png'));
    mat.getBaseColorTextureInfo()!.setExtension('KHR_texture_transform', tt.createTransform().setScale([2, 2]));
    const big = doc.createMesh('big').addPrimitive(grid(doc, 120).setMaterial(mat));
    scene.addChild(doc.createNode('Ground').setMesh(big).setTranslation([1, 0, 2]));
    // 2) three instances of a small mesh
    const inst = doc.createExtension(EXTMeshGPUInstancing);
    const buf = doc.getRoot().listBuffers()[0];
    const T = doc.createAccessor().setType('VEC3').setArray(new Float32Array([0, 0, 0, 5, 0, 0, 0, 0, 5])).setBuffer(buf);
    scene.addChild(doc.createNode('Trees').setMesh(doc.createMesh('tree').addPrimitive(grid(doc, 2))).setExtension('EXT_mesh_gpu_instancing', inst.createInstancedMesh().setAttribute('TRANSLATION', T)));
    const input = await io.writeBinary(doc);

    const { glb, report } = await toRobloxGlb(input, { keepTextures: true });
    const out = await io.readBinary(glb);
    expect(out.getRoot().listExtensionsUsed().map((e) => e.extensionName)).not.toContain('EXT_mesh_gpu_instancing');
    expect(out.getRoot().listExtensionsUsed().map((e) => e.extensionName)).not.toContain('KHR_texture_transform');
    expect(report.split).toBe(1);
    expect(report.instancesExpanded).toBe(3);
    expect(report.maxTriangles).toBeLessThanOrEqual(ROBLOX_MAX_TRIS);
    expect(report.triangles).toBe(28800 + 3 * 8);
    expect(report.parts).toBe(2 + 3);

    // Ground: tiling baked (UVs now run to 2), positions in studs, turned half a turn about up.
    const ground = out.getRoot().listNodes().find((n) => n.getName() === 'Ground')!;
    const [gx, , gz] = ground.getTranslation();
    expect(gx).toBeCloseTo(-1 / STUD);
    expect(gz).toBeCloseTo(-2 / STUD);
    const prims = ground.listChildren().flatMap((c) => c.getMesh()!.listPrimitives());
    const maxUv = Math.max(...prims.flatMap((p) => Array.from(p.getAttribute("TEXCOORD_0")!.getArray()! as Float32Array)));
    expect(maxUv).toBeCloseTo(2);
    const maxX = Math.max(...prims.flatMap((p) => Array.from(p.getAttribute("POSITION")!.getArray()! as Float32Array).filter((_, i) => i % 3 === 0)));
    expect(maxX).toBeCloseTo(120 / STUD, 3);
    // Instances: one node each, sharing one mesh, placed in studs.
    const trees = out.getRoot().listNodes().find((n) => n.getName() === 'Trees')!.listChildren();
    expect(trees).toHaveLength(3);
    expect(new Set(trees.map((t) => t.getMesh())).size).toBe(1);
    expect(trees[1].getTranslation()[0]).toBeCloseTo(5 / STUD);
  });
});

describe('pasting scripts', () => {
  it('accepts scripts without the header, single commands, and explains glTF files', async () => {
    const { parseScript } = await import('../src/core/serialize');
    expect(parseScript('{"commands":[{"type":"add","primitive":"cube"}]}').count).toBe(1);
    expect(parseScript('{"type":"addPlant","id":"p","kind":"pine","seed":1}').count).toBe(1);
    expect(parseScript('```json\n[{"type":"add","primitive":"sphere"}]\n```').count).toBe(1);
    expect(() => parseScript('{"asset":{"version":"2.0"},"nodes":[]}')).toThrow(/Import Model/);
    expect(() => parseScript('{"hello":1}')).toThrow(/No commands found/);
  });
});
