// Downloads the curated CC0 asset library from Poly Haven into public/library/
// and writes public/library/catalog.json (read by the app) and docs/LIBRARY.md
// (read by people and by Claude when writing scene scripts).
//
// Runs automatically before `npm run build` (prebuild). Files already present are
// skipped, so repeat runs are fast. Assets are NOT committed to git.
//
// Usage: node scripts/fetch-assets.mjs [--force]

import fs from 'node:fs/promises';
import path from 'node:path';
import { NodeIO, getBounds } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, prune, quantize, textureCompress, weld } from '@gltf-transform/functions';
import sharp from 'sharp';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const OUT = path.join(ROOT, 'public', 'library');
const TMP = path.join(ROOT, 'node_modules', '.cache', 'b3d-assets');
const API = 'https://api.polyhaven.com';
const FORCE = process.argv.includes('--force');
const manifest = JSON.parse(await fs.readFile(path.join(ROOT, 'library', 'manifest.json'), 'utf8'));
const RES = manifest.resolution;

const exists = (p) => fs.access(p).then(() => true, () => false);

async function getJSON(url) {
  for (let attempt = 1; ; attempt++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'B3D-Studio-asset-fetch' } });
      if (!r.ok) throw new Error(`${r.status} ${url}`);
      return await r.json();
    } catch (e) {
      if (attempt >= 3) throw e;
      await new Promise((res) => setTimeout(res, 1000 * attempt));
    }
  }
}

async function download(url, dest) {
  if (!FORCE && (await exists(dest))) return;
  await fs.mkdir(path.dirname(dest), { recursive: true });
  for (let attempt = 1; ; attempt++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'B3D-Studio-asset-fetch' } });
      if (!r.ok) throw new Error(`${r.status} ${url}`);
      await fs.writeFile(dest, Buffer.from(await r.arrayBuffer()));
      return;
    } catch (e) {
      if (attempt >= 3) throw e;
      await new Promise((res) => setTimeout(res, 1000 * attempt));
    }
  }
}

/** Run tasks with limited concurrency. */
async function pool(items, n, fn) {
  const out = [];
  let i = 0;
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx]).catch((e) => ({ error: String(e), id: items[idx] }));
      }
    }),
  );
  return out;
}

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const thumbUrl = (id) => `https://cdn.polyhaven.com/asset_img/thumbs/${id}.png?width=192&height=192`;
async function fetchThumb(id) {
  const dest = path.join(OUT, 'thumbs', `${id}.webp`);
  if (!FORCE && (await exists(dest))) return;
  const png = path.join(TMP, 'thumbs', `${id}.png`);
  await download(thumbUrl(id), png);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await sharp(png).resize(160, 160, { fit: 'inside' }).webp({ quality: 75 }).toFile(dest);
}
const authorsOf = (info) => Object.keys(info.authors ?? {}).join(', ');

async function fetchModel(id) {
  const glb = path.join(OUT, 'models', `${id}.glb`);
  const [info, files] = await Promise.all([getJSON(`${API}/info/${id}`), getJSON(`${API}/files/${id}`)]);
  const g = files.gltf?.[RES]?.gltf;
  if (!g) throw new Error(`no ${RES} glTF`);
  const total = g.size + Object.values(g.include ?? {}).reduce((s, f) => s + f.size, 0);
  if (total / 1e6 > manifest.maxModelMB) throw new Error(`too large (${(total / 1e6).toFixed(1)} MB)`);
  if (FORCE || !(await exists(glb))) {
    const dir = path.join(TMP, id);
    const gltfPath = path.join(dir, `${id}.gltf`);
    await download(g.url, gltfPath);
    await Promise.all(Object.entries(g.include ?? {}).map(([rel, f]) => download(f.url, path.join(dir, rel))));
    const doc = await io.read(gltfPath);
    // Shrink for phones/tablets: WebP textures (max 1024px), quantized geometry (KHR_mesh_quantization,
    // read natively by Babylon — no external decoder needed).
    await doc.transform(dedup(), prune(), weld(), quantize(), textureCompress({ encoder: sharp, targetFormat: 'webp', quality: 82, resize: [1024, 1024] }));
    await fs.mkdir(path.dirname(glb), { recursive: true });
    await io.write(glb, doc); // pack into one binary .glb
  }
  await fetchThumb(id);
  // Measure the real geometry (glTF is Y-up; report Blender X/Y/Z with Z up).
  const packed = await io.read(glb);
  const b = getBounds(packed.getRoot().listScenes()[0]);
  const r = (v) => Math.round(v * 1000) / 1000;
  const size = [r(b.max[0] - b.min[0]), r(b.max[2] - b.min[2]), r(b.max[1] - b.min[1])];
  const bottom = r(b.min[1]); // height of the lowest point above the origin (0 = sits on the ground)
  return {
    id,
    kind: 'model',
    name: info.name,
    categories: info.categories ?? [],
    size,
    bottom,
    authors: authorsOf(info),
    bytes: (await fs.stat(glb)).size,
  };
}

async function fetchHdri(id) {
  const dest = path.join(OUT, 'hdri', `${id}.hdr`);
  const [info, files] = await Promise.all([getJSON(`${API}/info/${id}`), getJSON(`${API}/files/${id}`)]);
  const f = files.hdri?.[RES]?.hdr;
  if (!f) throw new Error(`no ${RES} hdr`);
  await download(f.url, dest);
  await fetchThumb(id);
  return { id, kind: 'hdri', name: info.name, categories: info.categories ?? [], authors: authorsOf(info), bytes: (await fs.stat(dest)).size };
}

async function fetchTexture(id) {
  const dir = path.join(OUT, 'textures', id);
  const [info, files] = await Promise.all([getJSON(`${API}/info/${id}`), getJSON(`${API}/files/${id}`)]);
  const pick = (key) => files[key]?.[RES]?.jpg?.url;
  const maps = { diff: pick('Diffuse'), nor: pick('nor_gl'), arm: pick('arm'), rough: pick('Rough') };
  if (!maps.diff) throw new Error('no diffuse map');
  const have = {};
  for (const [k, url] of Object.entries(maps)) {
    if (!url || (k === 'rough' && maps.arm)) continue; // prefer packed ARM (AO/rough/metal)
    const webp = path.join(dir, `${k}.webp`);
    if (FORCE || !(await exists(webp))) {
      const jpg = path.join(TMP, 'tex', id, `${k}.jpg`);
      await download(url, jpg);
      await fs.mkdir(dir, { recursive: true });
      await sharp(jpg).resize(1024, 1024, { fit: 'inside' }).webp({ quality: k === 'nor' ? 88 : 80 }).toFile(webp);
    }
    have[k] = true;
  }
  await fetchThumb(id);
  // Real-world tile size in metres, when Poly Haven provides it.
  const tile = info.dimensions ? Math.round(info.dimensions[0]) / 1000 : 2;
  return { id, kind: 'texture', name: info.name, categories: info.categories ?? [], maps: Object.keys(have), tile, authors: authorsOf(info) };
}

console.log(`Fetching asset library (${RES}) into ${path.relative(ROOT, OUT)}…`);
const t0 = Date.now();
const results = [
  ...(await pool(manifest.models, 6, fetchModel)),
  ...(await pool(manifest.hdris, 4, fetchHdri)),
  ...(await pool(manifest.textures, 6, fetchTexture)),
];
const ok = results.filter((r) => !r.error);
const failed = results.filter((r) => r.error);
for (const f of failed) console.warn(`  skipped ${f.id}: ${f.error}`);

const catalog = {
  source: manifest.source,
  license: 'CC0',
  generated: new Date().toISOString(),
  models: ok.filter((r) => r.kind === 'model'),
  hdris: ok.filter((r) => r.kind === 'hdri'),
  textures: ok.filter((r) => r.kind === 'texture'),
};
await fs.writeFile(path.join(OUT, 'catalog.json'), JSON.stringify(catalog, null, 1));

// Human/Claude-readable reference
const md = [
  '# Asset library',
  '',
  'Generated by `scripts/fetch-assets.mjs` from `library/manifest.json`. All assets are CC0 from [Poly Haven](https://polyhaven.com).',
  'Use the id in scene scripts: models with `{"type":"add","primitive":"model","asset":"<id>"}`, textures with `"material":{"texture":"<id>"}`, skies with `{"type":"setWorld","world":{"hdri":"<id>"}}`.',
  '',
  '## Models',
  'Size is the real-world bounding box in metres (X × Y × Z, Z up) at scale 1. Models sit on the ground at their origin.',
  '',
  '| id | name | category | size (m) | bottom |',
  '|---|---|---|---|---|',
  ...catalog.models.map((m) => `| \`${m.id}\` | ${m.name} | ${m.categories.slice(0, 2).join(', ')} | ${m.size.map((v) => v.toFixed(2)).join(' × ')} | ${m.bottom} |`),
  '',
  '## HDRI skies (world lighting)',
  '',
  '| id | name | category |',
  '|---|---|---|',
  ...catalog.hdris.map((h) => `| \`${h.id}\` | ${h.name} | ${h.categories.slice(0, 3).join(', ')} |`),
  '',
  '## Textures (PBR materials)',
  '',
  '| id | name | real tile size (m) |',
  '|---|---|---|',
  ...catalog.textures.map((t) => `| \`${t.id}\` | ${t.name} | ${t.tile} |`),
  '',
  '## Credits',
  '',
  ...[...new Set(ok.flatMap((r) => r.authors.split(', ')).filter(Boolean))].sort().map((a) => `- ${a}`),
  '',
].join('\n');
await fs.writeFile(path.join(ROOT, 'docs', 'LIBRARY.md'), md);

const mb = ok.reduce((s, r) => s + (r.bytes ?? 0), 0) / 1e6;
console.log(`Done in ${((Date.now() - t0) / 1000).toFixed(0)}s: ${catalog.models.length} models, ${catalog.hdris.length} HDRIs, ${catalog.textures.length} textures (${mb.toFixed(0)} MB models+HDRIs), ${failed.length} skipped.`);
