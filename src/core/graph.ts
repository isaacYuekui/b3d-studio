// Graph Editor data: the animation of one object (or the scene camera) as value-over-time curves,
// one per channel (Location X…Scale Z, like Blender's F-curves). Keys here hold every channel at
// once, so moving a key in time moves all its channels; changing a value changes just one.

import type { Command } from './commands';
import type { SceneDoc, Vec3 } from './types';
import { animationOf, evaluateCamera, evaluateTransform } from './animation';
import type { Easing } from './animation';

export type GraphTarget = { kind: 'object'; id: string } | { kind: 'camera' };

export interface GraphChannel {
  key: string;
  group: string;
  label: string;
  axis: 0 | 1 | 2;
  /** Unit shown with values. */
  unit: string;
  color: string;
}

const AXIS_COLOR = ['#ff5f5f', '#86d65a', '#5f9dff'] as const;
const AXIS = ['X', 'Y', 'Z'] as const;
const make = (group: string, prefix: string, unit: string): GraphChannel[] =>
  [0, 1, 2].map((a) => ({ key: `${prefix}${a}`, group, label: `${group} ${AXIS[a]}`, axis: a as 0 | 1 | 2, unit, color: AXIS_COLOR[a] }));

const OBJECT_CHANNELS = [...make('Location', 'loc', ' m'), ...make('Rotation', 'rot', '°'), ...make('Scale', 'scl', '')];
const CAMERA_CHANNELS = [...make('Position', 'pos', ' m'), ...make('Target', 'tgt', ' m')];

export function graphChannels(t: GraphTarget): GraphChannel[] {
  return t.kind === 'object' ? OBJECT_CHANNELS : CAMERA_CHANNELS;
}

export interface GraphKey {
  frame: number;
  values: number[];
  easing: Easing;
}

/** Keys of the target, each with the value of every channel. */
export function graphKeys(doc: SceneDoc, t: GraphTarget): GraphKey[] {
  const a = animationOf(doc);
  if (t.kind === 'camera') return a.camera.map((k) => ({ frame: k.frame, values: [...k.position, ...k.target], easing: k.easing }));
  return (a.tracks[t.id] ?? []).map((k) => ({ frame: k.frame, values: [...k.transform.position, ...k.transform.rotation, ...k.transform.scale], easing: k.easing }));
}

/** Every channel's value at a frame (null when the target has no keys). */
export function graphValuesAt(doc: SceneDoc, t: GraphTarget, frame: number): number[] | null {
  const a = animationOf(doc);
  if (t.kind === 'camera') {
    const c = evaluateCamera(a.camera, frame);
    return c ? [...c.position, ...c.target] : null;
  }
  const tr = evaluateTransform(a.tracks[t.id] ?? [], frame);
  return tr ? [...tr.position, ...tr.rotation, ...tr.scale] : null;
}

/** Curves for the given channels between two frames: one [frame, value] list per channel. */
export function sampleCurves(doc: SceneDoc, t: GraphTarget, channels: number[], from: number, to: number, samples = 300): [number, number][][] {
  const out: [number, number][][] = channels.map(() => []);
  const step = Math.max(1 / 8, (to - from) / samples);
  const keys = graphKeys(doc, t).map((k) => k.frame);
  // Sample evenly, plus exactly at keys and just before them (so Constant holds show their step).
  const frames = new Set<number>();
  for (let f = from; f <= to + 1e-9; f += step) frames.add(Math.round(f * 1000) / 1000);
  for (const k of keys) {
    if (k >= from && k <= to) {
      frames.add(k);
      if (k - 1e-3 >= from) frames.add(k - 1e-3);
    }
  }
  for (const f of [...frames].sort((x, y) => x - y)) {
    const v = graphValuesAt(doc, t, f);
    if (!v) continue;
    channels.forEach((c, i) => out[i].push([f, v[c]]));
  }
  return out;
}

/** Channels whose value changes between keys (shown by default, like Blender's "Only Show Selected" curves). */
export function changingChannels(keys: GraphKey[]): boolean[] {
  if (!keys.length) return [];
  return keys[0].values.map((v0, c) => keys.some((k) => Math.abs(k.values[c] - v0) > 1e-9));
}

/** Command that sets one channel's value at an existing key, keeping its other channels and easing. */
export function setKeyValue(doc: SceneDoc, t: GraphTarget, frame: number, channel: number, value: number): Command | null {
  const key = graphKeys(doc, t).find((k) => k.frame === frame);
  if (!key) return null;
  const v = [...key.values];
  v[channel] = value;
  const vec = (i: number) => [v[i], v[i + 1], v[i + 2]] as Vec3;
  if (t.kind === 'camera') return { type: 'setCameraKey', frame, position: vec(0), target: vec(3), easing: key.easing };
  return { type: 'setKeyframe', id: t.id, frame, transform: { position: vec(0), rotation: vec(3), scale: vec(6) }, easing: key.easing };
}

/** The channel name the Dope Sheet / editKeys use for the target. */
export const keyChannel = (t: GraphTarget) => (t.kind === 'camera' ? 'camera' : `obj:${t.id}`);

/** Command that moves a key (all its channels) in time. */
export function moveKeyCmd(t: GraphTarget, frame: number, offset: number): Command {
  return { type: 'editKeys', op: 'move', offset, keys: [{ channel: keyChannel(t), frame }] };
}

/** Command that changes how the curve leaves a key (Blender's Interpolation / Easing). */
export function easingCmd(t: GraphTarget, frame: number, easing: Easing): Command {
  return { type: 'editKeys', op: 'easing', easing, keys: [{ channel: keyChannel(t), frame }] };
}

/** Value range of curves, padded; a flat curve gets a small window around its value. */
export function valueRange(curves: [number, number][][]): [number, number] {
  let lo = Infinity, hi = -Infinity;
  for (const c of curves)
    for (const [, v] of c) {
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
  if (!Number.isFinite(lo)) return [-1, 1];
  if (hi - lo < 1e-6) return [lo - 1, hi + 1];
  const pad = (hi - lo) * 0.1;
  return [lo - pad, hi + pad];
}
