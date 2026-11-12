// Force fields, like Blender's Physics → Force Field on an empty: Force (pushes away from the
// centre, or pulls with a negative strength), Wind (blows along the empty's Z axis) and Vortex
// (swirls around it). They act on rigid bodies during the physics bake; give a short frame window
// and a big strength for an explosion.

import { transformAt } from './animation';
import { apply as applyM4, rotEuler } from './rig';
import type { SceneDoc, Vec3 } from './types';

export const FIELD_TYPES = ['force', 'wind', 'vortex'] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

export interface ForceField {
  type: FieldType;
  /** Push in m/s² (the same for light and heavy objects); negative pulls / reverses. */
  strength: number;
  /** Reach in metres: full strength at the centre, fading to nothing at this distance. 0 = everywhere. */
  radius: number;
  /** Frames it is active (inclusive); unset = always. */
  start?: number;
  end?: number;
  /**
   * Explosion light: a point light at the field (watts, like a lamp's Power) that flares when the
   * field starts and fades over about two seconds, lighting up everything around it. 0 / unset = none.
   */
  flash?: number;
  /** Colour of the flash (default fire orange). */
  flashColor?: string;
}

export const DEFAULT_FLASH_COLOR = '#ff9a45';

/**
 * How bright the flash is at a frame, 0..1: nothing before the field starts, full at the start,
 * then a flickering fade (half-life about 0.4 s), gone after 3 s.
 */
export function flashLevel(f: ForceField, frame: number, fps = 24, firstFrame = 1): number {
  if (!f.flash) return 0;
  const dt = (frame - (f.start ?? firstFrame)) / fps;
  if (dt < 0 || dt > 3) return 0;
  const fade = Math.exp(-dt / 0.55) * (1 - dt / 3);
  // Flames flicker: a few unrelated wobbles, stronger as the light dies down.
  const flicker = 1 - 0.18 * Math.min(1, dt * 1.5) * (0.5 + 0.5 * Math.sin(dt * 37) * Math.sin(dt * 23 + 1.3));
  return Math.max(0, fade * flicker);
}

export const DEFAULT_FIELD: ForceField = { type: 'force', strength: 30, radius: 10 };

export const FIELD_PRESETS: { id: string; label: string; field: ForceField; frames?: number }[] = [
  { id: 'blast', label: 'Explosion', field: { type: 'force', strength: 400, radius: 14, flash: 60000 }, frames: 2 },
  { id: 'push', label: 'Push', field: { type: 'force', strength: 30, radius: 10 } },
  { id: 'wind', label: 'Wind', field: { type: 'wind', strength: 12, radius: 0 } },
  { id: 'vortex', label: 'Tornado', field: { type: 'vortex', strength: 40, radius: 12 } },
];

/** Fields active at a frame, with where they are and which way they point. */
export function activeFields(doc: SceneDoc, frame: number): { field: ForceField; at: Vec3; axis: Vec3 }[] {
  const out: { field: ForceField; at: Vec3; axis: Vec3 }[] = [];
  for (const id of doc.order) {
    const o = doc.objects[id];
    const f = o?.field;
    if (!f || !o.visible) continue;
    if (f.start !== undefined && frame < f.start) continue;
    if (f.end !== undefined && frame > f.end) continue;
    const t = transformAt(doc, id, frame) ?? o.transform;
    const axis = applyM4(rotEuler(t.rotation), [0, 0, 1]);
    out.push({ field: f, at: [...t.position] as Vec3, axis });
  }
  return out;
}

/** Acceleration (m/s²) the fields give a point. */
export function fieldAcceleration(fields: { field: ForceField; at: Vec3; axis: Vec3 }[], p: Vec3): Vec3 {
  const a: Vec3 = [0, 0, 0];
  for (const { field: f, at, axis } of fields) {
    const d: Vec3 = [p[0] - at[0], p[1] - at[1], p[2] - at[2]];
    const dist = Math.hypot(d[0], d[1], d[2]);
    const fall = f.radius > 0 ? Math.max(0, 1 - dist / f.radius) : 1;
    if (!fall) continue;
    const s = f.strength * fall;
    if (f.type === 'wind') {
      for (let k = 0; k < 3; k++) a[k] += axis[k] * s;
    } else if (f.type === 'force') {
      if (dist < 1e-6) continue;
      for (let k = 0; k < 3; k++) a[k] += (d[k] / dist) * s;
    } else {
      // Vortex: around the axis, perpendicular to both the axis and the direction to the point.
      const t: Vec3 = [axis[1] * d[2] - axis[2] * d[1], axis[2] * d[0] - axis[0] * d[2], axis[0] * d[1] - axis[1] * d[0]];
      const l = Math.hypot(t[0], t[1], t[2]);
      if (l < 1e-6) continue;
      for (let k = 0; k < 3; k++) a[k] += (t[k] / l) * s;
    }
  }
  return a;
}
