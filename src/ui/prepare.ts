// Load library data a script needs before its commands run (human presets).
import { loadHuman } from '../core/humans';

export async function prepareCommands(commands: unknown[]): Promise<void> {
  const presets = new Set<string>();
  const walk = (c: unknown) => {
    if (!c || typeof c !== 'object') return;
    const o = c as { type?: string; preset?: string; commands?: unknown[] };
    if (o.type === 'addHuman' && typeof o.preset === 'string') presets.add(o.preset);
    if (o.type === 'batch' && Array.isArray(o.commands)) o.commands.forEach(walk);
  };
  commands.forEach(walk);
  await Promise.all([...presets].map((p) => loadHuman(p)));
}
