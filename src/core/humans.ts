// Realistic human presets (built from MakeHuman CC0 assets by scripts/build-humans.mjs).
// The data is loaded asynchronously into this registry; `addHuman` then expands into
// ordinary objects: an armature, a skinned body, garments, hair and eyes.

import type { Bone, MeshData, Vec3 } from './types';
import type { Weights } from './rig';

export const HUMAN_PRESETS = ['male', 'female'] as const;
export type HumanPreset = (typeof HUMAN_PRESETS)[number];
export const HUMAN_PARTS = ['body', 'shirt', 'pants', 'shoes', 'hair'] as const;
export type HumanPart = (typeof HUMAN_PARTS)[number];

export interface HumanData {
  gender: string;
  bones: Bone[];
  parts: Record<HumanPart, { mesh: MeshData; weights: [number, number][][] }>;
  eyes: { bone: string; center: Vec3; forward: Vec3 }[];
}

const registry = new Map<string, HumanData>();
const loading = new Map<string, Promise<HumanData | null>>();

export const humanPreset = (p: string) => registry.get(p) ?? null;
export function registerHuman(p: string, d: HumanData) {
  registry.set(p, d);
}

/** Fetch a preset into the registry (browser). Base URL is the app's library folder. */
export function loadHuman(p: string, base = 'library/'): Promise<HumanData | null> {
  if (registry.has(p)) return Promise.resolve(registry.get(p)!);
  if (!(HUMAN_PRESETS as readonly string[]).includes(p)) return Promise.resolve(null);
  let job = loading.get(p);
  if (!job) {
    job = fetch(`${base}humans/${p}.json`)
      .then((r) => (r.ok ? (r.json() as Promise<HumanData>) : null))
      .then((d) => (d && registerHuman(p, d), d))
      .catch(() => null);
    loading.set(p, job);
  }
  return job;
}

/** Explicit weights for a skin weight reference like "humans/male#body". */
export function humanWeights(ref: string): Weights | null {
  const m = /^humans\/([a-z0-9_-]+)#([a-z0-9_-]+)$/.exec(ref);
  if (!m) return null;
  const d = registry.get(m[1]);
  const part = d?.parts[m[2] as HumanPart];
  if (!d || !part) return null;
  return { bones: d.bones.map((b) => b.name), w: part.weights };
}

export interface Outfit {
  skin?: string;
  shirt?: string | null;
  pants?: string | null;
  shoes?: string | null;
  hair?: string | null;
  eyes?: string;
}

export const DEFAULT_OUTFIT: Required<Outfit> = { skin: '#c99a7c', shirt: '#3f5f8a', pants: '#2b2d33', shoes: '#1c1c1e', hair: '#2a1d14', eyes: '#4a3020' };
