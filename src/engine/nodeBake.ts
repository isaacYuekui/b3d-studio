// Turns a node material (core/shaderNodes.ts) into Babylon textures: base colour (+ alpha),
// roughness/metal (ARM layout), emission and a normal map from the Bump height. Images are decoded
// once per size; a material whose image is still loading is baked again when it arrives.

import { RawTexture } from '@babylonjs/core/Materials/Textures/rawTexture';
import { Texture } from '@babylonjs/core/Materials/Textures/texture';
import type { Scene } from '@babylonjs/core/scene';
import { bakeGraph } from '../core/shaderNodes';
import type { BakeResult, ShaderGraph } from '../core/shaderNodes';
import { catalogNow, textureUrl } from './library';
import { isUserImage, userImageUrl } from './userImages';

export const BAKE_SIZE = 512;

const pixels = new Map<string, Uint8ClampedArray>();
const loading = new Set<string>();
const waiting = new Set<() => void>();

/** Decode an image (yours, or a library texture's colour map) to size × size RGBA. */
function sample(id: string, size: number): Uint8ClampedArray | null {
  const key = `${id}@${size}`;
  const hit = pixels.get(key);
  if (hit) return hit;
  if (!loading.has(key)) {
    loading.add(key);
    void (async () => {
      try {
        const url = isUserImage(id) ? await userImageUrl(id) : catalogNow()?.textures.some((t) => t.id === id) ? textureUrl(id, 'diff') : null;
        if (!url) return;
        const blob = await (await fetch(url)).blob();
        const bmp = await createImageBitmap(blob);
        const c = document.createElement('canvas');
        c.width = c.height = size;
        const g = c.getContext('2d', { willReadFrequently: true })!;
        g.drawImage(bmp, 0, 0, size, size);
        bmp.close?.();
        pixels.set(key, g.getImageData(0, 0, size, size).data);
        const fns = [...waiting];
        waiting.clear();
        fns.forEach((f) => f());
      } catch {
        /* unreadable image: stays magenta */
      } finally {
        loading.delete(key);
      }
    })();
  }
  return null;
}

export interface BakedMaps {
  result: BakeResult;
  albedo: RawTexture | null;
  arm: RawTexture | null;
  emissive: RawTexture | null;
  normal: RawTexture | null;
  /** Some image wasn't decoded yet: bake again when it is. */
  pending: boolean;
}

const tex = (scene: Scene, data: Uint8Array, size: number, gamma: boolean, repeat: number, name: string) => {
  const t = RawTexture.CreateRGBATexture(data, size, size, scene, true, false, Texture.TRILINEAR_SAMPLINGMODE);
  t.wrapU = t.wrapV = Texture.WRAP_ADDRESSMODE;
  t.anisotropicFilteringLevel = 8;
  t.gammaSpace = gamma;
  t.uScale = t.vScale = repeat;
  t.name = name;
  return t;
};

const b = (x: number) => Math.round(Math.max(0, Math.min(1, x)) * 255);

/** Bake a graph into textures; `onReady` runs when an image it needed has loaded. */
export function bakeMaps(scene: Scene, g: ShaderGraph, onReady: () => void): BakedMaps {
  let pending = false;
  const result = bakeGraph(g, BAKE_SIZE, (id, size) => {
    const px = sample(id, size);
    if (!px) pending = true;
    return px;
  });
  if (pending) waiting.add(onReady);
  const S = result.size, n = S * S;
  const rep = result.repeat;
  let albedo: RawTexture | null = null;
  if (typeof result.base !== 'string' || typeof result.alpha !== 'number') {
    const d = new Uint8Array(n * 4);
    const base = typeof result.base === 'string' ? [1, 3, 5].map((i) => parseInt((result.base as string).slice(i, i + 2), 16) / 255) : null;
    for (let i = 0; i < n; i++) {
      for (let k = 0; k < 3; k++) d[i * 4 + k] = b(base ? base[k] : (result.base as Float32Array)[i * 3 + k]);
      d[i * 4 + 3] = b(typeof result.alpha === 'number' ? 1 : result.alpha[i]);
    }
    albedo = tex(scene, d, S, true, rep, 'nodes-base');
    albedo.hasAlpha = typeof result.alpha !== 'number';
  }
  let arm: RawTexture | null = null;
  if (typeof result.roughness !== 'number' || typeof result.metallic !== 'number') {
    const d = new Uint8Array(n * 4);
    for (let i = 0; i < n; i++) {
      d[i * 4] = 255;
      d[i * 4 + 1] = b(typeof result.roughness === 'number' ? result.roughness : result.roughness[i]);
      d[i * 4 + 2] = b(typeof result.metallic === 'number' ? result.metallic : result.metallic[i]);
      d[i * 4 + 3] = 255;
    }
    arm = tex(scene, d, S, false, rep, 'nodes-arm');
  }
  let emissive: RawTexture | null = null;
  if (typeof result.emission !== 'string') {
    const d = new Uint8Array(n * 4);
    for (let i = 0; i < n; i++) {
      for (let k = 0; k < 3; k++) d[i * 4 + k] = b(result.emission[i * 3 + k]);
      d[i * 4 + 3] = 255;
    }
    emissive = tex(scene, d, S, true, rep, 'nodes-emission');
  }
  let normal: RawTexture | null = null;
  if (result.height) {
    const h = result.height.field;
    const at = (i: number, j: number) => h[(((j % S) + S) % S) * S + (((i % S) + S) % S)];
    const d = new Uint8Array(n * 4);
    const k = 8;
    for (let j = 0; j < S; j++)
      for (let i = 0; i < S; i++) {
        const dx = (at(i + 1, j) - at(i - 1, j)) * k, dy = (at(i, j + 1) - at(i, j - 1)) * k;
        const l = Math.hypot(dx, dy, 1);
        const o = (j * S + i) * 4;
        d[o] = Math.round((-dx / l) * 127.5 + 127.5);
        d[o + 1] = Math.round((-dy / l) * 127.5 + 127.5);
        d[o + 2] = Math.round((1 / l) * 127.5 + 127.5);
        d[o + 3] = 255;
      }
    normal = tex(scene, d, S, false, rep, 'nodes-normal');
    normal.level = result.height.strength * 1.5;
  }
  return { result, albedo, arm, emissive, normal, pending };
}
