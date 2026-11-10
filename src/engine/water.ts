// Water ripples: a tileable normal map made once in the browser (sums of sine waves with
// integer frequencies, so it wraps seamlessly), scrolled over time on each water surface.

import { RawTexture } from '@babylonjs/core/Materials/Textures/rawTexture';
import { Texture } from '@babylonjs/core/Materials/Textures/texture';
import type { Scene } from '@babylonjs/core/scene';

const SIZE = 256;
let pixels: Uint8Array | null = null;

/** A new ripple normal map (own offsets / scale per water surface; pixels computed once). */
export function rippleNormalTexture(scene: Scene): RawTexture {
  pixels ??= ripplePixels();
  const tex = RawTexture.CreateRGBATexture(pixels, SIZE, SIZE, scene, true, false, Texture.TRILINEAR_SAMPLINGMODE);
  tex.wrapU = tex.wrapV = Texture.WRAP_ADDRESSMODE;
  tex.name = 'water-ripples';
  return tex;
}

function ripplePixels(): Uint8Array {
  // Height field h(x, y) = Σ a·sin(2π(kx·x + ky·y) + φ), derivatives analytically.
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const waves = Array.from({ length: 24 }, (_, i) => {
    const f = 2 + Math.floor(rnd() * (3 + i * 1.5)); // integer frequencies → tileable
    const a = rnd() * Math.PI * 2;
    const kx = Math.round(Math.cos(a) * f), ky = Math.round(Math.sin(a) * f) || 1;
    return { kx, ky, amp: 1 / Math.hypot(kx, ky) ** 1.6, ph: rnd() * Math.PI * 2 };
  });
  const data = new Uint8Array(SIZE * SIZE * 4);
  const strength = 0.09;
  for (let j = 0; j < SIZE; j++)
    for (let i = 0; i < SIZE; i++) {
      const u = i / SIZE, v = j / SIZE;
      let dx = 0, dy = 0;
      for (const w of waves) {
        const c = Math.cos(2 * Math.PI * (w.kx * u + w.ky * v) + w.ph) * w.amp * 2 * Math.PI;
        dx += c * w.kx;
        dy += c * w.ky;
      }
      let nx = -dx * strength, ny = -dy * strength, nz = 1;
      const l = Math.hypot(nx, ny, nz);
      nx /= l;
      ny /= l;
      nz /= l;
      const k = (j * SIZE + i) * 4;
      data[k] = Math.round((nx * 0.5 + 0.5) * 255);
      data[k + 1] = Math.round((ny * 0.5 + 0.5) * 255);
      data[k + 2] = Math.round((nz * 0.5 + 0.5) * 255);
      data[k + 3] = 255;
    }
  return data;
}
