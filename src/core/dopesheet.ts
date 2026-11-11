// Dope Sheet: every keyframe in the scene as rows (channels) of diamonds, and edits on any
// selection of them (move, duplicate, retime, delete, easing) as one undoable step, like
// Blender's Dope Sheet. Channels: Summary, Camera, one per animated object, and one "Pose"
// row per armature (all its bone keys; a diamond there stands for every bone keyed on that
// frame).

import type { Animation, Easing } from './animation';
import type { SceneDoc } from './types';

export type ChannelKind = 'summary' | 'camera' | 'object' | 'pose';

export interface Channel {
  /** Stable key: "summary", "camera", "obj:<id>", "pose:<id>". */
  key: string;
  kind: ChannelKind;
  id?: string;
  label: string;
  frames: number[];
}

/** A keyframe (or, on Summary / Pose rows, every key in that row at that frame). */
export interface KeyRef {
  channel: string;
  frame: number;
}

export const KEY_OPS = ['move', 'duplicate', 'delete', 'easing', 'scale'] as const;
export type KeyOp = (typeof KEY_OPS)[number];

export interface KeyEdit {
  op: KeyOp;
  /** move / duplicate: frames to shift by (integer). */
  offset?: number;
  /** scale: stretch factor around `pivot` (default: the earliest selected frame). */
  factor?: number;
  pivot?: number;
  easing?: Easing;
}

const uniq = (xs: number[]) => [...new Set(xs)].sort((a, b) => a - b);

export function channels(doc: SceneDoc): Channel[] {
  const a = doc.animation;
  if (!a) return [];
  const out: Channel[] = [];
  const all: number[] = [];
  if (a.camera.length) {
    const f = a.camera.map((k) => k.frame);
    out.push({ key: 'camera', kind: 'camera', label: 'Camera', frames: f });
    all.push(...f);
  }
  for (const id of doc.order) {
    const t = a.tracks[id];
    if (t?.length) {
      const f = t.map((k) => k.frame);
      out.push({ key: `obj:${id}`, kind: 'object', id, label: doc.objects[id]?.name ?? id, frames: f });
      all.push(...f);
    }
    const bones = a.poses?.[id];
    if (bones) {
      const f = uniq(Object.values(bones).flatMap((ks) => ks.map((k) => k.frame)));
      if (f.length) {
        out.push({ key: `pose:${id}`, kind: 'pose', id, label: `${doc.objects[id]?.name ?? id} · Pose`, frames: f });
        all.push(...f);
      }
    }
  }
  // Tracks for objects that are not in the order (shouldn't happen, but keep them editable).
  for (const id of Object.keys(a.tracks)) if (!doc.order.includes(id) && a.tracks[id].length) out.push({ key: `obj:${id}`, kind: 'object', id, label: id, frames: a.tracks[id].map((k) => k.frame) });
  if (out.length) out.unshift({ key: 'summary', kind: 'summary', label: 'Summary', frames: uniq(all) });
  return out;
}

/** Expand Summary refs into the real channels that have a key on that frame. */
export function expandRefs(doc: SceneDoc, refs: KeyRef[]): KeyRef[] {
  const chs = channels(doc).filter((c) => c.kind !== 'summary');
  const out = new Map<string, KeyRef>();
  for (const r of refs) {
    if (r.channel === 'summary') {
      for (const c of chs) if (c.frames.includes(r.frame)) out.set(`${c.key}@${r.frame}`, { channel: c.key, frame: r.frame });
    } else out.set(`${r.channel}@${r.frame}`, r);
  }
  return [...out.values()];
}

type AnyKey = { frame: number; easing: Easing };

/** Apply an edit to one sorted key list. `picked` = frames of the selected keys in this list. */
function editList<K extends AnyKey>(keys: K[], picked: Set<number>, e: KeyEdit, pivot: number): K[] {
  if (!picked.size) return keys;
  const sel = keys.filter((k) => picked.has(k.frame));
  const rest = keys.filter((k) => !picked.has(k.frame));
  const map = (f: number) =>
    e.op === 'scale' ? Math.round(pivot + (f - pivot) * (e.factor ?? 1)) : f + Math.round(e.offset ?? 0);
  switch (e.op) {
    case 'delete':
      return rest;
    case 'easing':
      return keys.map((k) => (picked.has(k.frame) ? { ...k, easing: e.easing ?? k.easing } : k));
    case 'move':
    case 'scale':
    case 'duplicate': {
      // Moved (or copied) keys win over keys already at their new frame, like Blender.
      const moved = sel.map((k) => ({ ...k, frame: map(k.frame) }));
      const keep = e.op === 'duplicate' ? keys : rest;
      const taken = new Set(moved.map((k) => k.frame));
      const merged = [...keep.filter((k) => !taken.has(k.frame)), ...dedupe(moved)];
      return merged.sort((a, b) => a.frame - b.frame);
    }
  }
}

/** If scaling squashes two keys onto one frame, keep the later one. */
function dedupe<K extends AnyKey>(keys: K[]): K[] {
  const by = new Map<number, K>();
  for (const k of keys) by.set(k.frame, k);
  return [...by.values()];
}

/** Edit the selected keys. Pure: returns the new animation. */
export function editKeys(doc: SceneDoc, refs: KeyRef[], e: KeyEdit): Animation {
  const a = doc.animation!;
  const real = expandRefs(doc, refs);
  const pivot = e.pivot ?? Math.min(...real.map((r) => r.frame));
  const by = new Map<string, Set<number>>();
  for (const r of real) {
    if (!by.has(r.channel)) by.set(r.channel, new Set());
    by.get(r.channel)!.add(r.frame);
  }
  const tracks = { ...a.tracks };
  let camera = a.camera;
  let poses = a.poses ? { ...a.poses } : undefined;
  for (const [ch, frames] of by) {
    if (ch === 'camera') camera = editList(camera, frames, e, pivot);
    else if (ch.startsWith('obj:')) {
      const id = ch.slice(4);
      if (tracks[id]) {
        tracks[id] = editList(tracks[id], frames, e, pivot);
        if (!tracks[id].length) delete tracks[id];
      }
    } else if (ch.startsWith('pose:') && poses) {
      const id = ch.slice(5);
      const bones = poses[id];
      if (!bones) continue;
      const next: typeof bones = {};
      for (const [bone, ks] of Object.entries(bones)) {
        const r = editList(ks, frames, e, pivot);
        if (r.length) next[bone] = r;
      }
      if (Object.keys(next).length) poses[id] = next;
      else delete poses[id];
    }
  }
  if (poses && !Object.keys(poses).length) poses = undefined;
  const out: Animation = { ...a, tracks, camera };
  if (poses) out.poses = poses;
  else delete out.poses;
  return out;
}
