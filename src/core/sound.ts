// Automatic sound effects for videos: the scene already says when things happen — an explosion
// field goes off, the camera shakes, a giant wave runs in, fire burns, rain falls, broken pieces
// crash down — so the soundtrack is worked out from it (like a Foley artist watching the cut).
// This file only finds the events and how loud they are over time; the engine synthesises them.

import { animationOf, evaluateCamera, transformAt } from './animation';
import { activeFields } from './fields';
import { crestFrames } from './particles';
import { worldMatrix, apply as applyM4 } from './rig';
import type { SceneDoc, Vec3 } from './types';

export const SOUND_KINDS = ['boom', 'rumble', 'roar', 'crackle', 'whoosh', 'rain', 'wind', 'debris', 'sea'] as const;
export type SoundKind = (typeof SOUND_KINDS)[number];

export interface SoundEvent {
  kind: SoundKind;
  /** Seconds from the start of the video. */
  start: number;
  end: number;
  /** Overall loudness 0..1. */
  gain: number;
  /** Loudness over time, [seconds, 0..1] (straight lines between points); none = steady. */
  env?: [number, number][];
  /** Where it was (for a debug list / labels). */
  source: string;
}

export const SOUND_LABEL: Record<SoundKind, string> = {
  boom: 'Explosion',
  rumble: 'Rumble',
  roar: 'Wave roar',
  crackle: 'Fire',
  whoosh: 'Whoosh',
  rain: 'Rain',
  wind: 'Wind',
  debris: 'Debris',
  sea: 'Sea',
};

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const dist = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** Where the scene camera is at a frame (null without a camera). */
function cameraAt(doc: SceneDoc, frame: number): Vec3 | null {
  const a = animationOf(doc);
  return (a.camera.length ? evaluateCamera(a.camera, frame)?.position : null) ?? doc.camera?.position ?? null;
}

/** Closer is louder: 1 within `near` metres, fading with distance. */
const nearness = (d: number, near = 15) => clamp01(near / Math.max(near, d)) ** 0.7;

/**
 * The sound events of a video from frame `from` to `to` (inclusive). Deterministic; quiet scenes
 * give an empty list.
 */
export function soundEvents(doc: SceneDoc, from: number, to: number, fps: number): SoundEvent[] {
  const out: SoundEvent[] = [];
  const sec = (f: number) => (f - from) / fps;
  const dur = (to - from + 1) / fps;
  const inRange = (s: number, e: number) => e >= 0 && s <= dur;
  const a = animationOf(doc);

  for (const id of doc.order) {
    const o = doc.objects[id];
    if (!o?.visible) continue;

    // Explosions: a short, strong push-out force field.
    const f = o.field;
    if (f && f.type === 'force' && f.strength >= 80 && f.start !== undefined && (f.end ?? f.start) - f.start <= 6) {
      const t = sec(f.start);
      const cam = cameraAt(doc, f.start);
      const at = (transformAt(doc, id, f.start) ?? o.transform).position;
      const loud = clamp01(0.45 + Math.log10(Math.max(1, f.strength * Math.max(1, f.radius))) / 10) * (cam ? 0.55 + 0.45 * nearness(dist(cam, at), 40) : 1);
      if (inRange(t, t + 5)) out.push({ kind: 'boom', start: t, end: t + 5, gain: loud, source: o.name });
    }
    // Wind fields blow for as long as they're on.
    if (f && f.type === 'wind' && Math.abs(f.strength) > 2) {
      const s = f.start !== undefined ? sec(f.start) : 0, e = f.end !== undefined ? sec(f.end) : dur;
      if (inRange(s, e)) out.push({ kind: 'wind', start: Math.max(0, s), end: Math.min(dur, e), gain: clamp01(Math.abs(f.strength) / 30), source: o.name });
    }

    // Water: a giant wave roars in; a stormy sea washes all the time.
    const w = o.water;
    if (w?.surge) {
      const span = crestFrames(o, fps);
      if (span) {
        const s = Math.max(0, sec(span.start)), e = Math.min(dur, sec(span.end) + 2);
        if (s < e) {
          // Louder as the front comes closer to the camera.
          const g = w.surge;
          const ang = ((w.direction ?? 0) * Math.PI) / 180;
          const ux = Math.cos(ang), uy = Math.sin(ang);
          const env: [number, number][] = [];
          for (let t = s; t <= e + 1e-9; t += 0.25) {
            const frame = from + t * fps;
            const front = g.from + g.speed * Math.max(0, frame / fps - (g.start - 1) / fps);
            const wt = transformAt(doc, id, Math.round(frame)) ?? o.transform;
            const cam = cameraAt(doc, Math.round(frame));
            let level = 0.6;
            if (cam) {
              const along = ux * (cam[0] - wt.position[0]) + uy * (cam[1] - wt.position[1]);
              level = nearness(Math.abs(along - front), 25);
            }
            // Swells in over the first seconds.
            env.push([t, level * clamp01((t - s) / 2 + 0.2)]);
          }
          out.push({ kind: 'roar', start: s, end: e, gain: clamp01(0.5 + g.height / 20), env, source: o.name });
        }
      }
    }
    if (w && ((w.height ?? 0) >= 1 || w.surge)) out.push({ kind: 'sea', start: 0, end: dur, gain: clamp01(0.25 + (w.height ?? 0.5) / 6), source: o.name });

    // Particles: fire crackles (a fast-moving fire is a whoosh), rain hisses.
    const p = o.particles;
    if (p) {
      const s = sec(p.start), e = sec(p.end + p.lifetime);
      const burst = p.end - p.start <= 6;
      if (p.shape === 'fire' && !burst && inRange(s, e)) {
        // Average speed of the emitter while it emits.
        let travelled = 0;
        let prev: Vec3 | null = null;
        const step = Math.max(1, Math.round((p.end - p.start) / 24));
        for (let fr = p.start; fr <= p.end; fr += step) {
          const pos = applyM4(worldMatrix(doc, id, fr), [0, 0, 0]);
          if (prev) travelled += dist(pos, prev);
          prev = pos;
        }
        const speed = travelled / Math.max(1e-6, (p.end - p.start) / fps);
        if (speed > 12) {
          // A meteor / fireball flying in: a rising whoosh until it stops emitting.
          const env: [number, number][] = [];
          const se = sec(p.end);
          for (let t = Math.max(0, s); t <= Math.min(dur, se) + 1e-9; t += 0.2) {
            const fr = Math.round(from + t * fps);
            const cam = cameraAt(doc, fr);
            const pos = applyM4(worldMatrix(doc, id, fr), [0, 0, 0]);
            // Builds up as it comes in: faint at first, screaming just before it lands.
            const progress = clamp01((t - s) / Math.max(0.1, se - s)) ** 2;
            env.push([t, (0.12 + 0.88 * progress) * (cam ? 0.45 + 0.55 * nearness(dist(cam, pos), 20) : 1)]);
          }
          if (env.length) out.push({ kind: 'whoosh', start: Math.max(0, s), end: Math.min(dur, se + 0.15), gain: clamp01(0.35 + p.count / 12000), env, source: o.name });
        } else out.push({ kind: 'crackle', start: Math.max(0, s), end: Math.min(dur, e), gain: clamp01(0.25 + p.count / 4000), source: o.name });
      }
      if (p.shape === 'fire' && burst && p.count >= 300 && inRange(s, s + 3)) out.push({ kind: 'boom', start: s, end: s + 4, gain: clamp01(0.35 + p.count / 6000), source: o.name });
      if (p.shape === 'drop' && p.gravity >= 0.8 && p.count >= 1000 && inRange(s, e)) out.push({ kind: 'rain', start: Math.max(0, s), end: Math.min(dur, e), gain: clamp01(0.2 + p.count / 15000), source: o.name });
    }
  }

  // Camera shakes rumble for as long as they last.
  for (const sh of a.shakes ?? []) {
    const s = sec(sh.start), e = sec(sh.end);
    if (inRange(s, e)) out.push({ kind: 'rumble', start: Math.max(0, s), end: Math.min(dur, e + 0.5), gain: clamp01(0.3 + sh.strength * 0.6), env: [[Math.max(0, s), 1], [Math.min(dur, e + 0.5), 0]], source: 'Camera shake' });
  }

  // Broken pieces and falling things: loud where baked bodies suddenly slow down (they hit something).
  const debris = impacts(doc, from, to, fps);
  if (debris) out.push({ kind: 'debris', start: 0, end: dur, gain: debris.gain, env: debris.env, source: 'Physics' });

  // Fields that are always on (no frames) also count as wind when they blow.
  void activeFields;
  return out.filter((e) => e.end > e.start && e.gain > 0.01);
}

/** Crash loudness over time from the baked rigid bodies (speed lost per frame, heavier = louder). */
function impacts(doc: SceneDoc, from: number, to: number, fps: number): { gain: number; env: [number, number][] } | null {
  const a = animationOf(doc);
  const bodies = doc.order.filter((id) => doc.objects[id]?.rigid?.type === 'active' && (a.tracks[id]?.length ?? 0) > 3);
  if (!bodies.length) return null;
  const n = to - from + 1;
  const hit = new Float64Array(n);
  for (const id of bodies) {
    const mass = doc.objects[id].rigid!.mass ?? 1;
    const w = Math.cbrt(Math.max(0.01, mass));
    let p0: Vec3 | null = null, v0 = 0;
    for (let i = 0; i < n; i++) {
      const p = (transformAt(doc, id, from + i) ?? doc.objects[id].transform).position;
      if (p0) {
        const v = dist(p, p0) * fps;
        // A sudden loss of speed (more than gravity would explain) is an impact.
        const loss = v0 - v;
        if (loss > 1.5) hit[i] += loss * w;
        v0 = v;
      }
      p0 = p;
    }
  }
  let peak = 0;
  for (const h of hit) peak = Math.max(peak, h);
  if (peak < 1) return null;
  // Smooth a little, sample every frame (a crash is short).
  const env: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const h = (hit[i] + 0.5 * (hit[i - 1] ?? 0) + 0.25 * (hit[i - 2] ?? 0)) / peak;
    env.push([i / fps, clamp01(h)]);
  }
  return { gain: clamp01(0.4 + Math.log10(peak) / 5), env };
}

/** Loudness of an event at time t (seconds): its gain times its envelope, 0 outside it. */
export function levelAt(e: SoundEvent, t: number): number {
  if (t < e.start || t > e.end) return 0;
  if (!e.env?.length) return e.gain;
  const env = e.env;
  if (t <= env[0][0]) return e.gain * env[0][1];
  for (let i = 1; i < env.length; i++) {
    if (t <= env[i][0]) {
      const [t0, v0] = env[i - 1], [t1, v1] = env[i];
      return e.gain * (v0 + ((v1 - v0) * (t - t0)) / Math.max(1e-9, t1 - t0));
    }
  }
  return e.gain * env[env.length - 1][1];
}
