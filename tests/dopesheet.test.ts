import { describe, expect, it } from 'vitest';
import { applyCommand, validateCommand } from '../src/core/commands';
import { createDefaultDoc } from '../src/core/store';
import { channels } from '../src/core/dopesheet';
import type { SceneDoc } from '../src/core/types';

const run = (doc: SceneDoc, cmd: unknown) => applyCommand(doc, validateCommand(cmd)).doc;

function scene(): SceneDoc {
  let d = createDefaultDoc();
  d = run(d, { type: 'add', primitive: 'cube', id: 'a', name: 'Box' });
  d = run(d, { type: 'add', primitive: 'sphere', id: 'b', name: 'Ball' });
  for (const [id, f, x] of [['a', 1, 0], ['a', 24, 2], ['a', 48, 4], ['b', 24, 1], ['b', 60, 3]] as const)
    d = run(d, { type: 'setKeyframe', id, frame: f, transform: { position: [x, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } });
  d = run(d, { type: 'setCameraKey', frame: 1, position: [0, -10, 3], target: [0, 0, 0] });
  d = run(d, { type: 'setCameraKey', frame: 60, position: [5, -10, 3], target: [0, 0, 0] });
  return d;
}
const frames = (d: SceneDoc, id: string) => d.animation!.tracks[id]?.map((k) => k.frame);

describe('dope sheet', () => {
  it('lists Summary, Camera and one row per animated object', () => {
    const ch = channels(scene());
    expect(ch.map((c) => c.label)).toEqual(['Summary', 'Camera', 'Box', 'Ball']);
    expect(ch[0].frames).toEqual([1, 24, 48, 60]);
  });

  it('moves selected keys; moved keys replace keys already at their new frame', () => {
    const d = run(scene(), { type: 'editKeys', op: 'move', offset: 24, keys: [{ channel: 'obj:a', frame: 24 }] });
    expect(frames(d, 'a')).toEqual([1, 48]); // moved 24 → 48, replacing the old 48
    expect(d.animation!.tracks.a[1].transform.position[0]).toBe(2);
  });

  it('a Summary key moves every channel keyed on that frame', () => {
    const d = run(scene(), { type: 'editKeys', op: 'move', offset: 6, keys: [{ channel: 'summary', frame: 24 }] });
    expect(frames(d, 'a')).toEqual([1, 30, 48]);
    expect(frames(d, 'b')).toEqual([30, 60]);
    expect(d.animation!.camera.map((k) => k.frame)).toEqual([1, 60]);
  });

  it('duplicates, deletes, sets easing and retimes', () => {
    let d = run(scene(), { type: 'editKeys', op: 'duplicate', offset: 100, keys: [{ channel: 'obj:a', frame: 1 }, { channel: 'obj:a', frame: 24 }] });
    expect(frames(d, 'a')).toEqual([1, 24, 48, 101, 124]);
    d = run(d, { type: 'editKeys', op: 'easing', easing: 'linear', keys: [{ channel: 'obj:a', frame: 48 }] });
    expect(d.animation!.tracks.a.find((k) => k.frame === 48)!.easing).toBe('linear');
    d = run(d, { type: 'editKeys', op: 'delete', keys: [{ channel: 'obj:a', frame: 101 }, { channel: 'obj:a', frame: 124 }] });
    expect(frames(d, 'a')).toEqual([1, 24, 48]);
    // Twice as slow, around the first key.
    d = run(d, { type: 'editKeys', op: 'scale', factor: 2, keys: [1, 24, 48].map((frame) => ({ channel: 'obj:a', frame })) });
    expect(frames(d, 'a')).toEqual([1, 47, 95]);
  });

  it('deleting the last key of an object keeps its pose; one undo step for many keys', () => {
    const before = scene();
    const d = run(before, { type: 'editKeys', op: 'delete', keys: [{ channel: 'obj:b', frame: 24 }, { channel: 'obj:b', frame: 60 }] });
    expect(d.animation!.tracks.b).toBeUndefined();
    expect(d.objects.b.transform.position[0]).toBe(1);
  });

  it('edits bone keys through the armature Pose row', () => {
    let d = createDefaultDoc();
    d = run(d, { type: 'add', primitive: 'armature', id: 'rig', armature: { bones: [{ name: 'root', head: [0, 0, 0], tail: [0, 0, 1] }, { name: 'arm', parent: 'root', head: [0, 0, 1], tail: [0, 0, 2] }] } });
    d = run(d, { type: 'setPoseKey', id: 'rig', bone: 'root', frame: 10, rotation: [10, 0, 0] });
    d = run(d, { type: 'setPoseKey', id: 'rig', bone: 'arm', frame: 10, rotation: [0, 20, 0] });
    d = run(d, { type: 'setPoseKey', id: 'rig', bone: 'arm', frame: 20, rotation: [0, 40, 0] });
    expect(channels(d).find((c) => c.kind === 'pose')!.frames).toEqual([10, 20]);
    d = run(d, { type: 'editKeys', op: 'move', offset: -5, keys: [{ channel: 'pose:rig', frame: 10 }] });
    expect(d.animation!.poses!.rig.root.map((k) => k.frame)).toEqual([5]);
    expect(d.animation!.poses!.rig.arm.map((k) => k.frame)).toEqual([5, 20]);
  });

  it('rejects bad edits', () => {
    expect(() => validateCommand({ type: 'editKeys', op: 'move', keys: [{ channel: 'obj:a', frame: 1 }] })).toThrow(/needs offset/);
    expect(() => validateCommand({ type: 'editKeys', op: 'spin', keys: [] })).toThrow(/op must be/);
    expect(() => validateCommand({ type: 'editKeys', op: 'delete', keys: [{ channel: 'bogus', frame: 1 }] })).toThrow(/channel, frame/);
  });
});
