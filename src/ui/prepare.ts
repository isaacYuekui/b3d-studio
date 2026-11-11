// Load library data a script needs before its commands run (human presets, the boolean engine).
import { loadHuman } from '../core/humans';
import { loadBooleans } from '../core/mesh/boolean';

/** Load the boolean engine's WebAssembly from our own build (no third-party fetch). */
export async function prepareBooleans(): Promise<void> {
  const { default: url } = await import('manifold-3d/manifold.wasm?url');
  await loadBooleans(() => url);
}

export async function prepareCommands(commands: unknown[]): Promise<void> {
  const presets = new Set<string>();
  let needBooleans = false;
  const walk = (c: unknown) => {
    if (!c || typeof c !== 'object') return;
    const o = c as { type?: string; preset?: string; commands?: unknown[] };
    if (o.type === 'addHuman' && typeof o.preset === 'string') presets.add(o.preset);
    if (o.type === 'boolean') needBooleans = true;
    if (o.type === 'batch' && Array.isArray(o.commands)) o.commands.forEach(walk);
  };
  commands.forEach(walk);
  await Promise.all([...[...presets].map((p) => loadHuman(p)), ...(needBooleans ? [prepareBooleans()] : [])]);
}
