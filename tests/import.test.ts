import { describe, expect, it } from 'vitest';
import { Document, NodeIO } from '@gltf-transform/core';
import { zipSync } from 'fflate';
import { contentId, guessUnitScale, isGlb, toGlb } from '../src/engine/userModels';

async function sampleGltf() {
  const doc = new Document();
  const buf = doc.createBuffer();
  const pos = doc.createAccessor().setType('VEC3').setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0])).setBuffer(buf);
  const prim = doc.createPrimitive().setAttribute('POSITION', pos);
  const mesh = doc.createMesh('tri').addPrimitive(prim);
  doc.createScene().addChild(doc.createNode('tri').setMesh(mesh));
  const io = new NodeIO();
  const { json, resources } = await io.writeJSON(doc, { basename: 'car' });
  return { json, resources, glb: await io.writeBinary(doc) };
}

describe('model import', () => {
  it('guesses centimetre and millimetre exports', () => {
    expect(guessUnitScale(4.6)).toBe(1); // metres
    expect(guessUnitScale(40)).toBe(0.01); // a 40 cm vase in centimetres
    expect(guessUnitScale(460)).toBe(0.01); // centimetres
    expect(guessUnitScale(4600)).toBe(0.01);
    expect(guessUnitScale(46000)).toBe(0.001); // millimetres
    expect(guessUnitScale(NaN)).toBe(1);
  });

  it('passes a GLB through untouched', async () => {
    const { glb } = await sampleGltf();
    const out = await toGlb('car.glb', glb);
    expect(out.glb).toBe(glb);
    expect(out.name).toBe('car');
  });

  it('packs a ZIP of .gltf + .bin (Sketchfab-style folder) into one GLB', async () => {
    const { json, resources } = await sampleGltf();
    const zip = zipSync({
      'scene/license.txt': new TextEncoder().encode('CC-BY'),
      'scene/car.gltf': new TextEncoder().encode(JSON.stringify(json)),
      ...Object.fromEntries(Object.entries(resources).map(([k, v]) => [`scene/${k}`, v])),
      '__MACOSX/scene/._car.gltf': new Uint8Array([1, 2, 3]),
    });
    const out = await toGlb('my-car.zip', zip);
    expect(isGlb(out.glb)).toBe(true);
    expect(out.name).toBe('my-car');
  });

  it('explains what is missing when a .gltf is imported without its files', async () => {
    const { json } = await sampleGltf();
    await expect(toGlb('car.gltf', new TextEncoder().encode(JSON.stringify(json)))).rejects.toThrow(/missing.*whole ZIP/);
    await expect(toGlb('photo.png', new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).rejects.toThrow(/Unsupported file/);
    await expect(toGlb('empty.zip', zipSync({ 'readme.txt': new Uint8Array([65]) }))).rejects.toThrow(/No .gltf or .glb/);
  });

  it('gives the same id to the same file', async () => {
    const { glb } = await sampleGltf();
    const a = await contentId(glb);
    expect(a).toMatch(/^user-[0-9a-f]{16}$/);
    expect(await contentId(glb.slice())).toBe(a);
  });
});
