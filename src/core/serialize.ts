// Project file format + local persistence.
// Files are JSON: { format, version, savedAt, scene }. Always validated on load.

import { validateSceneDoc } from './commands';
import type { SceneDoc } from './types';

export const FORMAT = 'b3d-studio-project';
export const VERSION = 1;
const STORAGE_KEY = 'b3d-studio:autosave:v1';

export interface ProjectFile {
  format: typeof FORMAT;
  version: number;
  savedAt: string;
  scene: SceneDoc;
}

export function serializeProject(doc: SceneDoc): string {
  const file: ProjectFile = { format: FORMAT, version: VERSION, savedAt: new Date().toISOString(), scene: doc };
  return JSON.stringify(file, null, 2);
}

export function parseProject(text: string): SceneDoc {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('Not a valid JSON file');
  }
  if (typeof data !== 'object' || data === null) throw new Error('Not a B3D Studio project');
  const d = data as Record<string, unknown>;
  if (d.format !== FORMAT) throw new Error('Not a B3D Studio project file');
  if (typeof d.version !== 'number' || d.version > VERSION) throw new Error(`Unsupported project version ${String(d.version)}`);
  return validateSceneDoc(d.scene);
}

/** Minimal key-value interface so tests can pass a fake storage. */
export interface KV {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
}

function storage(): KV | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null; // Safari private mode / blocked storage
  }
}

export function saveLocal(doc: SceneDoc, kv: KV | null = storage()): boolean {
  if (!kv) return false;
  try {
    kv.setItem(STORAGE_KEY, serializeProject(doc));
    return true;
  } catch {
    return false;
  }
}

export function loadLocal(kv: KV | null = storage()): SceneDoc | null {
  if (!kv) return null;
  try {
    const text = kv.getItem(STORAGE_KEY);
    return text ? parseProject(text) : null;
  } catch {
    return null;
  }
}
