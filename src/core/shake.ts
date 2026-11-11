// Camera shake: a burst of smooth jitter on the scene camera — like adding a Noise modifier to the
// camera's F-curves in Blender's Graph Editor, packaged for impacts, explosions and earthquakes.
// Deterministic per frame, so videos and scrubbing match.

import type { Vec3 } from './types';

export interface CameraShake {
  /** Frame the shake hits. */
  start: number;
  /** Frame it has died down by. */
  end: number;
  /** How far the view jolts, in metres at the target (0.05 subtle … 1 violent). */
  strength: number;
  /** Jolts per second (default 8: an impact; 3 for a rumbling quake). */
  frequency?: number;
}

export const SHAKE_PRESETS: { id: string; label: string; shake: Omit<CameraShake, 'start' | 'end'>; seconds: number }[] = [
  { id: 'impact', label: 'Impact', shake: { strength: 0.35, frequency: 9 }, seconds: 1.2 },
  { id: 'explosion', label: 'Explosion', shake: { strength: 0.8, frequency: 11 }, seconds: 2 },
  { id: 'quake', label: 'Earthquake', shake: { strength: 0.45, frequency: 3.5 }, seconds: 5 },
  { id: 'rumble', label: 'Rumble', shake: { strength: 0.08, frequency: 6 }, seconds: 4 },
];

// Three sine layers per axis at unrelated rates; phases differ per shake so two shakes don't match.
const RATES = [1, 2.31, 4.17];
const WEIGHTS = [1, 0.5, 0.25];
const noise = (t: number, axis: number, seed: number) => {
  let s = 0;
  for (let i = 0; i < 3; i++) s += WEIGHTS[i] * Math.sin(2 * Math.PI * RATES[i] * t + seed * 1.37 + axis * 2.11 + i * 0.73);
  return s / 1.75;
};

/** How strong a shake is at a frame: a sharp hit (3 frames), then dying away by `end`. */
export function shakeEnvelope(s: CameraShake, frame: number): number {
  if (frame < s.start || frame > s.end || s.end <= s.start) return 0;
  const attack = Math.min(1, (frame - s.start) / 3);
  const left = 1 - (frame - s.start) / (s.end - s.start);
  return attack * left * left;
}

/** Offsets for the camera position and target at a frame (metres, Blender space). */
export function shakeOffsets(shakes: CameraShake[] | undefined, frame: number, fps: number): { position: Vec3; target: Vec3 } | null {
  if (!shakes?.length) return null;
  const pos: Vec3 = [0, 0, 0], tgt: Vec3 = [0, 0, 0];
  let any = false;
  for (const s of shakes) {
    const e = shakeEnvelope(s, frame);
    if (!e) continue;
    any = true;
    const t = (frame / fps) * (s.frequency ?? 8);
    for (let k = 0; k < 3; k++) {
      // Mostly the aim wobbles (reads as the camera being knocked); the body moves a little.
      tgt[k] += noise(t, k, s.start) * s.strength * e;
      pos[k] += noise(t + 11.3, k, s.start) * s.strength * 0.3 * e;
    }
  }
  return any ? { position: pos, target: tgt } : null;
}

/** A camera (position + target) with the shakes added. */
export function shakeCamera<T extends { position: Vec3; target: Vec3 }>(cam: T, shakes: CameraShake[] | undefined, frame: number, fps: number): T {
  const o = shakeOffsets(shakes, frame, fps);
  if (!o) return cam;
  return {
    ...cam,
    position: [cam.position[0] + o.position[0], cam.position[1] + o.position[1], cam.position[2] + o.position[2]],
    target: [cam.target[0] + o.target[0], cam.target[1] + o.target[1], cam.target[2] + o.target[2]],
  };
}
