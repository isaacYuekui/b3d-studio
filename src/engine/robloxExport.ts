// Make a GLB that Roblox Studio's 3D Importer takes without complaint:
// - instanced copies (scatter) become real nodes sharing one mesh,
// - meshes over Roblox's 20,000-triangle limit are split into spatial chunks,
// - texture tiling (KHR_texture_transform, which Roblox ignores) is baked into the UVs,
// - everything is scaled from metres to studs (1 stud = 0.28 m) so the default
//   "Scale Unit: Studs" import is correct,
// - textures become JPEG (colour, roughness) / PNG (normal maps), at most 1024 px,
// and report what was produced.

import { WebIO } from '@gltf-transform/core';
import type { Document, Node, Primitive } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import type { InstancedMesh, Transform } from '@gltf-transform/extensions';
import { STUD } from '../core/robloxTerrain';

export const ROBLOX_MAX_TRIS = 20000;
export const ROBLOX_MAX_TEXTURE = 1024;

export interface RobloxReport {
  parts: number;
  meshes: number;
  triangles: number;
  maxTriangles: number;
  split: number;
  instancesExpanded: number;
  textures: number;
  bytes: number;
}

const triCount = (p: Primitive) => {
  const idx = p.getIndices();
  return (idx ? idx.getCount() : p.getAttribute('POSITION')?.getCount() ?? 0) / 3;
};

export interface RobloxOptions {
  /** Metres → output units factor (default metres → studs). */
  scale?: number;
  /** Skip texture conversion (tests / headless). */
  keepTextures?: boolean;
}

export async function toRobloxGlb(input: Uint8Array, opts: RobloxOptions = {}): Promise<{ glb: Uint8Array; report: RobloxReport }> {
  const io = new WebIO().registerExtensions(ALL_EXTENSIONS);
  const doc = await io.readBinary(input);
  const report: RobloxReport = { parts: 0, meshes: 0, triangles: 0, maxTriangles: 0, split: 0, instancesExpanded: 0, textures: 0, bytes: 0 };

  orientRoots(doc);
  report.instancesExpanded = expandInstances(doc);
  bakeTextureTransforms(doc);
  report.split = splitLargeMeshes(doc);
  scaleDocument(doc, opts.scale ?? 1 / STUD);
  if (!opts.keepTextures) report.textures = await convertTextures(doc);

  for (const ext of doc.getRoot().listExtensionsUsed()) {
    const name = ext.extensionName;
    if (['EXT_texture_webp', 'EXT_mesh_gpu_instancing', 'KHR_materials_variants', 'KHR_texture_transform', 'KHR_lights_punctual'].includes(name)) ext.dispose();
  }
  pruneEmpty(doc);
  for (const node of doc.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    report.parts++;
    const t = mesh.listPrimitives().reduce((s, p) => s + triCount(p), 0);
    report.triangles += t;
  }
  for (const mesh of doc.getRoot().listMeshes()) {
    report.meshes++;
    report.maxTriangles = Math.max(report.maxTriangles, mesh.listPrimitives().reduce((s, p) => s + triCount(p), 0));
  }
  const glb = await io.writeBinary(doc);
  report.bytes = glb.byteLength;
  return { glb, report };
}

/**
 * Babylon's exporter writes B3D's (x, y, z) as glTF (−x, z, y): a half turn about "up" from the
 * convention Blender and Roblox use, (x, z, −y). Turn the root nodes so imports face the same
 * way as in B3D (front = −Y in Blender terms).
 */
export function orientRoots(doc: Document) {
  for (const scene of doc.getRoot().listScenes())
    for (const n of scene.listChildren()) {
      const [x, y, z] = n.getTranslation();
      n.setTranslation([-x, y, -z]);
      const [qx, qy, qz, qw] = n.getRotation();
      // (0, 1, 0, 0) ⊗ q
      n.setRotation([qz, qw, -qx, -qy]);
    }
}

/** Fix the orientation of a plain GLB export (for Blender and other tools). */
export async function orientGlb(input: Uint8Array): Promise<Uint8Array> {
  const io = new WebIO().registerExtensions(ALL_EXTENSIONS);
  const doc = await io.readBinary(input);
  orientRoots(doc);
  return io.writeBinary(doc);
}

/** Drop nodes with no mesh, skin, camera or light anywhere below them (e.g. lights left out). */
function pruneEmpty(doc: Document) {
  const keep = (n: Node): boolean => {
    let any = !!n.getMesh() || !!n.getSkin() || !!n.getCamera() || !!n.getExtension('KHR_lights_punctual');
    for (const c of n.listChildren()) if (keep(c)) any = true;
    if (!any) n.dispose();
    return any;
  };
  for (const scene of doc.getRoot().listScenes()) for (const n of scene.listChildren()) keep(n);
}

/** EXT_mesh_gpu_instancing → one child node per instance, all sharing the mesh. */
function expandInstances(doc: Document): number {
  let n = 0;
  for (const node of doc.getRoot().listNodes()) {
    const inst = node.getExtension<InstancedMesh>('EXT_mesh_gpu_instancing');
    const mesh = node.getMesh();
    if (!inst || !mesh) continue;
    const T = inst.getAttribute('TRANSLATION'), R = inst.getAttribute('ROTATION'), S = inst.getAttribute('SCALE');
    const count = (T ?? R ?? S)?.getCount() ?? 0;
    const t = [0, 0, 0], r = [0, 0, 0, 1], s = [1, 1, 1];
    for (let i = 0; i < count; i++) {
      const child = doc.createNode(`${node.getName() || 'item'}_${i + 1}`).setMesh(mesh);
      if (T) child.setTranslation(T.getElement(i, t) as [number, number, number]);
      if (R) child.setRotation(R.getElement(i, r) as [number, number, number, number]);
      if (S) child.setScale(S.getElement(i, s) as [number, number, number]);
      node.addChild(child);
      n++;
    }
    node.setMesh(null);
    node.setExtension('EXT_mesh_gpu_instancing', null);
  }
  return n;
}

/** Split meshes over the triangle limit into spatially coherent chunks (one mesh / node each). */
function splitLargeMeshes(doc: Document): number {
  let split = 0;
  const done = new Map<object, ReturnType<Document['createMesh']>[]>();
  for (const node of doc.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    const total = mesh.listPrimitives().reduce((s, p) => s + triCount(p), 0);
    if (total <= ROBLOX_MAX_TRIS) continue;
    let chunks = done.get(mesh);
    if (!chunks) {
      chunks = [];
      for (const prim of mesh.listPrimitives()) for (const c of splitPrimitive(doc, prim)) chunks.push(doc.createMesh(`${mesh.getName()}_part${chunks.length + 1}`).addPrimitive(c));
      done.set(mesh, chunks);
      split++;
    }
    chunks.forEach((m, i) => node.addChild(doc.createNode(`${node.getName() || 'mesh'}_part${i + 1}`).setMesh(m)));
    node.setMesh(null);
  }
  for (const mesh of done.keys()) (mesh as { listParents(): unknown[]; dispose(): void }).listParents().length <= 1 && (mesh as { dispose(): void }).dispose();
  return split;
}

function splitPrimitive(doc: Document, prim: Primitive): Primitive[] {
  const pos = prim.getAttribute('POSITION')!;
  const P = pos.getArray()!;
  const idxAcc = prim.getIndices();
  const nv = pos.getCount();
  const idx: ArrayLike<number> = idxAcc ? idxAcc.getArray()! : Array.from({ length: nv }, (_, i) => i);
  const ntri = idx.length / 3;
  if (ntri <= ROBLOX_MAX_TRIS) return [prim];
  // Order triangles along a coarse 3D grid so each chunk is a compact piece of the surface.
  let min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < nv; i++) for (let k = 0; k < 3; k++) {
    min[k] = Math.min(min[k], P[i * 3 + k]);
    max[k] = Math.max(max[k], P[i * 3 + k]);
  }
  const cells = Math.ceil(Math.cbrt(ntri / ROBLOX_MAX_TRIS)) * 2;
  const cell = (v: number, k: number) => Math.min(cells - 1, Math.floor(((v - min[k]) / (max[k] - min[k] || 1)) * cells));
  const order = Array.from({ length: ntri }, (_, t) => t);
  const key = order.map((t) => {
    const c = [0, 1, 2].map((k) => (P[idx[t * 3] * 3 + k] + P[idx[t * 3 + 1] * 3 + k] + P[idx[t * 3 + 2] * 3 + k]) / 3);
    const [x, y, z] = [cell(c[0], 0), cell(c[1], 1), cell(c[2], 2)];
    // serpentine order keeps consecutive cells adjacent
    const yy = x % 2 ? cells - 1 - y : y;
    const zz = (x * cells + yy) % 2 ? cells - 1 - z : z;
    return (x * cells + yy) * cells + zz;
  });
  order.sort((a, b) => key[a] - key[b]);
  const out: Primitive[] = [];
  const semantics = prim.listSemantics();
  for (let start = 0; start < ntri; start += ROBLOX_MAX_TRIS) {
    const tris = order.slice(start, start + ROBLOX_MAX_TRIS);
    const remap = new Map<number, number>();
    const newIdx = new Uint32Array(tris.length * 3);
    tris.forEach((t, j) => {
      for (let k = 0; k < 3; k++) {
        const v = idx[t * 3 + k];
        let m = remap.get(v);
        if (m === undefined) remap.set(v, (m = remap.size));
        newIdx[j * 3 + k] = m;
      }
    });
    const p = doc.createPrimitive().setMaterial(prim.getMaterial()).setMode(prim.getMode());
    const buffer = pos.getBuffer();
    for (const sem of semantics) {
      const a = prim.getAttribute(sem)!;
      const size = a.getElementSize();
      const src = a.getArray()!;
      const Ctor = src.constructor as new (n: number) => typeof src;
      const dst = new Ctor(remap.size * size);
      for (const [o, nw] of remap) for (let k = 0; k < size; k++) (dst as unknown as number[])[nw * size + k] = (src as unknown as number[])[o * size + k];
      p.setAttribute(sem, doc.createAccessor().setType(a.getType()).setArray(dst).setNormalized(a.getNormalized()).setBuffer(buffer));
    }
    p.setIndices(doc.createAccessor().setType('SCALAR').setArray(newIdx).setBuffer(buffer));
    out.push(p);
  }
  return out;
}

/** KHR_texture_transform → baked into TEXCOORD_0 (per primitive, so shared UVs stay correct). */
function bakeTextureTransforms(doc: Document) {
  const touched = new Set<object>();
  for (const mesh of doc.getRoot().listMeshes())
    for (const prim of mesh.listPrimitives()) {
      const mat = prim.getMaterial();
      if (!mat) continue;
      const infos = [mat.getBaseColorTextureInfo(), mat.getNormalTextureInfo(), mat.getMetallicRoughnessTextureInfo(), mat.getOcclusionTextureInfo(), mat.getEmissiveTextureInfo()];
      const tr = infos.map((i) => i?.getExtension<Transform>('KHR_texture_transform')).find(Boolean);
      touched.add(mat);
      const uv = prim.getAttribute('TEXCOORD_0');
      if (!tr || !uv) continue;
      const [su, sv] = tr.getScale(), [ou, ov] = tr.getOffset(), a = tr.getRotation();
      const c = Math.cos(a), s = Math.sin(a);
      const baked = uv.clone();
      const arr = new Float32Array(uv.getCount() * 2);
      const el = [0, 0];
      for (let k = 0; k < uv.getCount(); k++) {
        uv.getElement(k, el);
        const u = el[0] * su, v = el[1] * sv;
        arr[k * 2] = c * u - s * v + ou;
        arr[k * 2 + 1] = s * u + c * v + ov;
      }
      prim.setAttribute('TEXCOORD_0', baked.setArray(arr).setNormalized(false));
    }
  for (const mat of touched) {
    const m = mat as ReturnType<Document['createMaterial']>;
    for (const i of [m.getBaseColorTextureInfo(), m.getNormalTextureInfo(), m.getMetallicRoughnessTextureInfo(), m.getOcclusionTextureInfo(), m.getEmissiveTextureInfo()]) i?.setExtension('KHR_texture_transform', null);
  }
}

/** Uniformly scale the whole scene: node translations, vertex positions, skin bind matrices. */
function scaleDocument(doc: Document, k: number) {
  if (k === 1) return;
  for (const node of doc.getRoot().listNodes()) {
    const [x, y, z] = node.getTranslation();
    node.setTranslation([x * k, y * k, z * k]);
  }
  const done = new Set<object>();
  for (const mesh of doc.getRoot().listMeshes())
    for (const prim of mesh.listPrimitives()) {
      const targets = [prim.getAttribute('POSITION'), ...prim.listTargets().map((t) => t.getAttribute('POSITION'))];
      for (const pos of targets) {
        if (!pos || done.has(pos)) continue;
        done.add(pos);
        const a = pos.getArray()!;
        const out = new Float32Array(a.length);
        for (let i = 0; i < a.length; i++) out[i] = a[i] * k;
        pos.setArray(out).setNormalized(false);
      }
    }
  for (const skin of doc.getRoot().listSkins()) {
    const ibm = skin.getInverseBindMatrices();
    if (!ibm || done.has(ibm)) continue;
    done.add(ibm);
    const a = Float32Array.from(ibm.getArray()!);
    for (let m = 0; m < a.length; m += 16) for (const i of [12, 13, 14]) a[m + i] *= k;
    ibm.setArray(a);
  }
}

/** Textures → at most 1024 px; JPEG for colour / roughness maps (small), PNG for normal maps. */
async function convertTextures(doc: Document): Promise<number> {
  const normals = new Set<object>();
  for (const m of doc.getRoot().listMaterials()) {
    const t = m.getNormalTexture();
    if (t) normals.add(t);
  }
  let n = 0;
  for (const tex of doc.getRoot().listTextures()) {
    const img = tex.getImage();
    if (!img) continue;
    const type = tex.getMimeType() || 'image/png';
    const bmp = await createImageBitmap(new Blob([img as BlobPart], { type }));
    const k = Math.min(1, ROBLOX_MAX_TEXTURE / Math.max(bmp.width, bmp.height));
    const w = Math.max(1, Math.round(bmp.width * k)), h = Math.max(1, Math.round(bmp.height * k));
    const canvas = new OffscreenCanvas(w, h);
    canvas.getContext('2d')!.drawImage(bmp, 0, 0, w, h);
    bmp.close();
    const png = normals.has(tex);
    const out = new Uint8Array(await (await canvas.convertToBlob(png ? { type: 'image/png' } : { type: 'image/jpeg', quality: 0.9 })).arrayBuffer());
    const base = (tex.getName() || tex.getURI() || 'texture').replace(/^.*\/(?=[^/]+\/[^/]+$)/, '').replace(/\.[a-z0-9]+$/i, '').replace(/[^a-z0-9_]+/gi, '_');
    tex.setImage(out).setMimeType(png ? 'image/png' : 'image/jpeg').setURI(`${base}.${png ? 'png' : 'jpg'}`);
    n++;
  }
  return n;
}

export type { Node };
