// Builds test files for the import flow from a library model:
//  - vase-cm.glb: the vase exported in centimetres and placed off-centre (like many downloads)
//  - vase-gltf.zip: the same as a Sketchfab-style ZIP (scene.gltf + scene.bin + textures)
import fs from 'node:fs/promises';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { zipSync } from 'fflate';
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const doc = await io.read('public/library/models/ceramic_vase_01.glb');
const scene = doc.getRoot().listScenes()[0];
const wrap = doc.createNode('cm_root').setScale([100, 100, 100]).setTranslation([350, 120, -80]);
for (const n of scene.listChildren()) { scene.removeChild(n); wrap.addChild(n); }
scene.addChild(wrap);
await fs.mkdir('tests/fixtures', { recursive: true });
await io.write('tests/fixtures/vase-cm.glb', doc);
// The ZIP variant is a different model (stretched taller), so it imports as a second asset.
wrap.setScale([100, 160, 100]);
const { json, resources } = await io.writeJSON(doc, { basename: 'scene' });
const files = { 'vase/scene.gltf': new TextEncoder().encode(JSON.stringify(json)) };
for (const [k, v] of Object.entries(resources)) files[`vase/${k}`] = v;
await fs.writeFile('tests/fixtures/vase-gltf.zip', zipSync(files));
console.log('fixtures written', Object.keys(files).length, 'files in zip');
