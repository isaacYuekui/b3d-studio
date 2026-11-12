import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import * as CANNON from 'cannon-es';
import { parseScript } from '../src/core/serialize';
import { applyCommand } from '../src/core/commands';
import { createDefaultDoc } from '../src/core/store';
import { registerPhysics } from '../src/core/physics';
import { soundEvents } from '../src/core/sound';

registerPhysics(CANNON);

const files = readdirSync('examples').filter((f) => f.endsWith('.b3d-script.json'));

describe('example scripts', () => {
  it.each(files)('%s validates', (f) => {
    const s = parseScript(readFileSync(`examples/${f}`, 'utf8'));
    expect(s.count).toBeGreaterThan(0);
  });

  it('the volcano runs: one mesh with rock + lava slots, a lit village, and eruption sounds', async () => {
    const { loadBooleans } = await import('../src/core/mesh/boolean');
    await loadBooleans();
    const s = parseScript(readFileSync('examples/volcano-eruption.b3d-script.json', 'utf8'));
    const doc = applyCommand(createDefaultDoc(), s.command).doc;
    const v = doc.objects.volcano;
    expect(v.materialSlots).toHaveLength(1);
    expect(v.materialSlots![0].pattern?.glow).toBeGreaterThan(0);
    const lava = v.mesh!.materialIndex!.filter((x) => x === 1).length;
    expect(lava).toBeGreaterThan(200);
    expect(lava).toBeLessThan(v.mesh!.faces.length / 2);
    expect(Object.values(doc.objects).filter((o) => /^village-b\d+$/.test(o.id)).every((o) => (o.material.pattern?.glow ?? 0) > 0)).toBe(true);
    const kinds = new Set(soundEvents(doc, 1, 168, 24).map((e) => e.kind));
    for (const k of ['boom', 'rumble', 'crackle'] as const) expect(kinds.has(k)).toBe(true);
  });
});
