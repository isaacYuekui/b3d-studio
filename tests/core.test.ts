import { describe, expect, it } from 'vitest';
import { applyCommand, CommandError, subtree, uniqueName, validateCommand, validateSceneDoc } from '../src/core/commands';
import { Store } from '../src/core/store';
import { loadLocal, parseProject, saveLocal, serializeProject } from '../src/core/serialize';
import type { SceneDoc } from '../src/core/types';

const seqId = () => {
  let n = 0;
  return () => `id${++n}`;
};
const empty = (): SceneDoc => ({ objects: {}, order: [] });

describe('commands', () => {
  it('adds primitives with Blender-style unique names', () => {
    const gen = seqId();
    let doc = applyCommand(empty(), { type: 'add', primitive: 'cube' }, gen).doc;
    doc = applyCommand(doc, { type: 'add', primitive: 'cube' }, gen).doc;
    doc = applyCommand(doc, { type: 'add', primitive: 'sphere' }, gen).doc;
    expect(doc.order).toEqual(['id1', 'id2', 'id3']);
    expect(doc.order.map((id) => doc.objects[id].name)).toEqual(['Cube', 'Cube.001', 'Sphere']);
  });

  it('is immutable — the input doc is never modified', () => {
    const gen = seqId();
    const a = applyCommand(empty(), { type: 'add', primitive: 'cube' }, gen).doc;
    const frozen = JSON.stringify(a);
    applyCommand(a, { type: 'transform', id: 'id1', position: [5, 5, 5] }, gen);
    applyCommand(a, { type: 'delete', ids: ['id1'] }, gen);
    expect(JSON.stringify(a)).toBe(frozen);
  });

  it('transforms only the given channels', () => {
    const gen = seqId();
    let doc = applyCommand(empty(), { type: 'add', primitive: 'cube' }, gen).doc;
    doc = applyCommand(doc, { type: 'transform', id: 'id1', rotation: [0, 45, 0] }, gen).doc;
    expect(doc.objects.id1.transform).toEqual({ position: [0, 0, 0], rotation: [0, 45, 0], scale: [1, 1, 1] });
  });

  it('deletes objects together with their children', () => {
    const gen = seqId();
    let doc = applyCommand(empty(), { type: 'add', primitive: 'cube' }, gen).doc;
    doc = applyCommand(doc, { type: 'add', primitive: 'sphere', parentId: 'id1' }, gen).doc;
    doc = applyCommand(doc, { type: 'add', primitive: 'plane' }, gen).doc;
    doc = applyCommand(doc, { type: 'delete', ids: ['id1'] }, gen).doc;
    expect(doc.order).toEqual(['id3']);
  });

  it('duplicates a subtree with remapped parents and offset root', () => {
    const gen = seqId();
    let doc = applyCommand(empty(), { type: 'add', primitive: 'cube' }, gen).doc;
    doc = applyCommand(doc, { type: 'add', primitive: 'sphere', parentId: 'id1' }, gen).doc;
    const r = applyCommand(doc, { type: 'duplicate', ids: ['id1', 'id2'] }, gen);
    expect(r.created).toEqual(['id3']);
    expect(r.doc.objects.id3.name).toBe('Cube.001');
    expect(r.doc.objects.id3.transform.position[0]).toBe(1);
    expect(r.doc.objects.id4.parentId).toBe('id3');
    expect(subtree(r.doc, 'id3')).toEqual(['id3', 'id4']);
  });

  it('rejects parenting cycles', () => {
    const gen = seqId();
    let doc = applyCommand(empty(), { type: 'add', primitive: 'cube' }, gen).doc;
    doc = applyCommand(doc, { type: 'add', primitive: 'sphere', parentId: 'id1' }, gen).doc;
    expect(() => applyCommand(doc, { type: 'setParent', id: 'id1', parentId: 'id2' }, gen)).toThrow(CommandError);
    expect(() => applyCommand(doc, { type: 'setParent', id: 'id1', parentId: 'id1' }, gen)).toThrow(CommandError);
  });

  it('uniqueName skips taken suffixes', () => {
    const gen = seqId();
    let doc = empty();
    for (let i = 0; i < 3; i++) doc = applyCommand(doc, { type: 'add', primitive: 'cube' }, gen).doc;
    expect(uniqueName(doc, 'Cube')).toBe('Cube.003');
    expect(uniqueName(doc, 'Lamp')).toBe('Lamp');
  });
});

describe('validation (untrusted input / future AI tool calls)', () => {
  it('accepts well-formed commands', () => {
    expect(validateCommand({ type: 'add', primitive: 'sphere', color: '#ff0000', transform: { position: [1, 2, 3] } })).toMatchObject({ type: 'add', primitive: 'sphere' });
    expect(validateCommand({ type: 'transform', id: 'a', scale: [2, 2, 2] })).toMatchObject({ scale: [2, 2, 2] });
  });

  it('rejects malformed or dangerous commands', () => {
    expect(() => validateCommand({ type: 'eval', code: 'alert(1)' })).toThrow(CommandError);
    expect(() => validateCommand({ type: 'add', primitive: 'teapot' })).toThrow(/primitive/);
    expect(() => validateCommand({ type: 'transform', id: 'a', position: [1, 2] })).toThrow();
    expect(() => validateCommand({ type: 'transform', id: 'a', position: [1, NaN, 2] })).toThrow();
    expect(() => validateCommand({ type: 'setColor', id: 'a', color: 'red;background:url(x)' })).toThrow();
    expect(() => validateCommand(null)).toThrow();
  });

  it('rejects scenes with parent cycles or dangling parents', () => {
    const obj = (id: string, parentId: string | null) => ({ id, name: id, type: 'cube', parentId, transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }, color: '#ffffff', visible: true });
    expect(() => validateSceneDoc({ objects: { a: obj('a', 'b'), b: obj('b', 'a') }, order: ['a', 'b'] })).toThrow(/cycle/);
    expect(() => validateSceneDoc({ objects: { a: obj('a', 'zzz') }, order: ['a'] })).toThrow(/missing/);
  });
});

describe('store: undo / redo / selection', () => {
  it('undoes and redoes in order', () => {
    const s = new Store(empty(), seqId());
    s.dispatch({ type: 'add', primitive: 'cube' });
    s.dispatch({ type: 'transform', id: 'id1', position: [3, 0, 0] });
    expect(s.getState().doc.objects.id1.transform.position).toEqual([3, 0, 0]);
    s.undo();
    expect(s.getState().doc.objects.id1.transform.position).toEqual([0, 0, 0]);
    s.undo();
    expect(s.getState().doc.order).toEqual([]);
    expect(s.getState().canUndo).toBe(false);
    s.redo();
    s.redo();
    expect(s.getState().doc.objects.id1.transform.position).toEqual([3, 0, 0]);
    expect(s.getState().canRedo).toBe(false);
  });

  it('a new edit clears the redo stack', () => {
    const s = new Store(empty(), seqId());
    s.dispatch({ type: 'add', primitive: 'cube' });
    s.undo();
    s.dispatch({ type: 'add', primitive: 'plane' });
    expect(s.getState().canRedo).toBe(false);
  });

  it('selects created objects and clears selection on delete', () => {
    const s = new Store(empty(), seqId());
    s.dispatch({ type: 'add', primitive: 'cube' });
    expect(s.getState().selection).toBe('id1');
    s.dispatch({ type: 'delete', ids: ['id1'] });
    expect(s.getState().selection).toBe(null);
    s.undo();
    expect(s.getState().doc.objects.id1).toBeDefined();
  });

  it('previews edits live and commits them as a single undo step', () => {
    const s = new Store(empty(), seqId());
    s.dispatch({ type: 'add', primitive: 'cube' });
    for (let x = 1; x <= 5; x++) s.preview({ type: 'transform', id: 'id1', position: [x, 0, 0] });
    expect(s.getState().doc.objects.id1.transform.position).toEqual([5, 0, 0]);
    s.commitPreview();
    s.undo();
    expect(s.getState().doc.objects.id1.transform.position).toEqual([0, 0, 0]);
    s.preview({ type: 'transform', id: 'id1', position: [9, 9, 9] });
    s.cancelPreview();
    expect(s.getState().doc.objects.id1.transform.position).toEqual([0, 0, 0]);
  });

  it('turns command errors into notices instead of crashing', () => {
    const s = new Store(empty(), seqId());
    s.dispatch({ type: 'transform', id: 'nope', position: [0, 0, 0] });
    expect(s.getState().notice).toMatch(/not found/);
    expect(s.getState().canUndo).toBe(false);
  });
});

describe('serialization', () => {
  it('round-trips a project', () => {
    const s = new Store(undefined, seqId());
    s.dispatch({ type: 'add', primitive: 'cylinder', parentId: s.getState().doc.order[0] });
    const doc = s.getState().doc;
    expect(parseProject(serializeProject(doc))).toEqual(doc);
  });

  it('rejects foreign files', () => {
    expect(() => parseProject('not json')).toThrow(/JSON/);
    expect(() => parseProject('{"format":"something-else"}')).toThrow(/B3D/);
    expect(() => parseProject(JSON.stringify({ format: 'b3d-studio-project', version: 99, scene: {} }))).toThrow(/version/);
  });

  it('saves and loads through a storage backend', () => {
    const mem = new Map<string, string>();
    const kv = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
    const doc = new Store(undefined, seqId()).getState().doc;
    expect(saveLocal(doc, kv)).toBe(true);
    expect(loadLocal(kv)).toEqual(doc);
    expect(loadLocal(null)).toBe(null);
  });
});
