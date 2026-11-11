// Load library data a script needs before its commands run (human presets, the boolean engine).
import { loadHuman } from '../core/humans';
import { loadBooleans } from '../core/mesh/boolean';
import { loadFont } from '../engine/fonts';
import { loadPhysics } from '../core/physics';
import { FONTS } from '../core/text';
import type { FontId } from '../core/text';

/** Load the boolean engine's WebAssembly from our own build (no third-party fetch). */
export async function prepareBooleans(): Promise<void> {
  const { default: url } = await import('manifold-3d/manifold.wasm?url');
  await loadBooleans(() => url);
}

export async function prepareCommands(commands: unknown[]): Promise<void> {
  const presets = new Set<string>();
  const fonts = new Set<FontId>();
  let needBooleans = false;
  let needPhysics = false;
  const walk = (c: unknown) => {
    if (!c || typeof c !== 'object') return;
    const o = c as { type?: string; preset?: string; commands?: unknown[]; text?: { font?: unknown } };
    if (o.type === 'addHuman' && typeof o.preset === 'string') presets.add(o.preset);
    if (o.type === 'boolean') needBooleans = true;
    if (o.type === 'bakePhysics') needPhysics = true;
    // setText without a font keeps the object's font; loading all three covers it (they're small).
    if (o.type === 'addText') fonts.add((FONTS as readonly unknown[]).includes(o.text?.font) ? (o.text!.font as FontId) : 'sans');
    if (o.type === 'setText') FONTS.forEach((f) => fonts.add(f));
    if (o.type === 'batch' && Array.isArray(o.commands)) o.commands.forEach(walk);
  };
  commands.forEach(walk);
  await Promise.all([...[...presets].map((p) => loadHuman(p)), ...(needBooleans ? [prepareBooleans()] : []), ...[...fonts].map((f) => loadFont(f)), ...(needPhysics ? [loadPhysics()] : [])]);
}
