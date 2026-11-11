// Turn a procedural pattern into GPU textures: a colour map (colour A → colour B by the mix
// value) and a tileable normal map from the same values as height. Shared and cached, so
// many objects with the same pattern cost one upload.

import { RawTexture } from '@babylonjs/core/Materials/Textures/rawTexture';
import { Texture } from '@babylonjs/core/Materials/Textures/texture';
import type { Scene } from '@babylonjs/core/scene';
import { patternValues } from '../core/patterns';
import type { Pattern, PatternType } from '../core/patterns';

const SIZE = 256;
const values = new Map<PatternType, Float32Array>();
const colorCache = new Map<string, RawTexture>();
const normalCache = new Map<string, RawTexture>();

const vals = (t: PatternType) => {
  let v = values.get(t);
  if (!v) values.set(t, (v = patternValues(t, SIZE)));
  return v;
};

const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

function finish(tex: RawTexture, name: string, gamma: boolean) {
  tex.wrapU = tex.wrapV = Texture.WRAP_ADDRESSMODE;
  tex.anisotropicFilteringLevel = 8;
  tex.gammaSpace = gamma;
  tex.name = name;
  (tex as { metadata?: unknown }).metadata = { shared: true };
  return tex;
}

export function patternColorTexture(scene: Scene, p: Pattern): RawTexture {
  // Scale lives on the texture, so each scale is its own (small, 256²) texture.
  const key = `${p.type}|${p.colorA}|${p.colorB}|${p.scale}`;
  const hit = colorCache.get(key);
  if (hit && hit.getInternalTexture()) return hit;
  const v = vals(p.type);
  const a = rgb(p.colorA), b = rgb(p.colorB);
  const data = new Uint8Array(SIZE * SIZE * 4);
  for (let i = 0; i < v.length; i++) {
    const t = v[i];
    data[i * 4] = Math.round(a[0] + (b[0] - a[0]) * t);
    data[i * 4 + 1] = Math.round(a[1] + (b[1] - a[1]) * t);
    data[i * 4 + 2] = Math.round(a[2] + (b[2] - a[2]) * t);
    data[i * 4 + 3] = 255;
  }
  const tex = finish(RawTexture.CreateRGBATexture(data, SIZE, SIZE, scene, true, false, Texture.TRILINEAR_SAMPLINGMODE), `pattern-${key}`, true);
  tex.uScale = tex.vScale = p.scale;
  colorCache.set(key, tex);
  return tex;
}

export function patternNormalTexture(scene: Scene, type: PatternType, scale: number, bump: number): RawTexture {
  // Bump strength lives on the texture too (its level).
  const key = `${type}|${scale}|${bump}`;
  const hit = normalCache.get(key);
  if (hit && hit.getInternalTexture()) return hit;
  const v = vals(type);
  const at = (i: number, j: number) => v[(((j % SIZE) + SIZE) % SIZE) * SIZE + (((i % SIZE) + SIZE) % SIZE)];
  const data = new Uint8Array(SIZE * SIZE * 4);
  const k = 6; // height → slope strength at bump 1 (the material's bump level scales it)
  for (let j = 0; j < SIZE; j++)
    for (let i = 0; i < SIZE; i++) {
      const dx = (at(i + 1, j) - at(i - 1, j)) * k, dy = (at(i, j + 1) - at(i, j - 1)) * k;
      const l = Math.hypot(dx, dy, 1);
      const o = (j * SIZE + i) * 4;
      data[o] = Math.round((-dx / l * 0.5 + 0.5) * 255);
      data[o + 1] = Math.round((-dy / l * 0.5 + 0.5) * 255);
      data[o + 2] = Math.round((1 / l * 0.5 + 0.5) * 255);
      data[o + 3] = 255;
    }
  const tex = finish(RawTexture.CreateRGBATexture(data, SIZE, SIZE, scene, true, false, Texture.TRILINEAR_SAMPLINGMODE), `pattern-normal-${key}`, false);
  tex.uScale = tex.vScale = scale;
  tex.level = bump * 1.5;
  normalCache.set(key, tex);
  return tex;
}

export const isSharedTexture = (t: unknown) => !!(t as { metadata?: { shared?: boolean } } | null)?.metadata?.shared;
