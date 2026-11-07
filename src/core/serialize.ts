// Project file format + local persistence.
// Files are JSON: { format, version, savedAt, scene }. Always validated on load.

import { validateCommand, validateSceneDoc } from './commands';
import type { Command } from './commands';
import type { SceneDoc } from './types';

export const FORMAT = 'b3d-studio-project';
export const VERSION = 2; // v2: materials, lights, custom meshes. v1 files are migrated on load.
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

// ---------------------------------------------------------------- scene scripts
// A script is a list of commands, usually written by Claude in chat:
//   { "format": "b3d-studio-script", "version": 1, "title": "...", "commands": [ ... ] }
// It runs as ONE undoable step and either fully succeeds or changes nothing.

export const SCRIPT_FORMAT = 'b3d-studio-script';

export interface ParsedScript {
  title: string | null;
  command: Command; // always a batch
  count: number;
}

/** Accepts a script object, a bare command array, or text with ``` fences around the JSON. */
export function parseScript(text: string): ParsedScript {
  let src = text.trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(src);
  if (fence) src = fence[1].trim();
  let data: unknown;
  try {
    data = JSON.parse(src);
  } catch {
    throw new Error('That is not valid JSON. Copy the whole script, from the first { to the last }.');
  }
  let title: string | null = null;
  let commands: unknown;
  if (Array.isArray(data)) commands = data;
  else if (typeof data === 'object' && data !== null) {
    const d = data as Record<string, unknown>;
    if (d.format === FORMAT) throw new Error('This is a project file. Use File > Import Project File instead.');
    if (d.format !== SCRIPT_FORMAT) throw new Error(`Not a B3D Studio script (expected "format": "${SCRIPT_FORMAT}")`);
    if (typeof d.version !== 'number' || d.version > 1) throw new Error(`Unsupported script version ${String(d.version)}`);
    title = typeof d.title === 'string' ? d.title.slice(0, 120) : null;
    commands = d.commands;
  }
  const command = validateCommand({ type: 'batch', commands });
  return { title, command, count: (command as { commands: Command[] }).commands.length };
}
