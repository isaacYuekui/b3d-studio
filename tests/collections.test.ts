import { describe, expect, it } from 'vitest';
import { applyCommand, validateCommand, validateSceneDoc } from '../src/core/commands';
import { Store, createDefaultDoc } from '../src/core/store';
import { isRendered, isShown } from '../src/core/collections';
import { activeFields } from '../src/core/fields';
import type { SceneDoc } from '../src/core/types';

function scene(cmds: unknown[]): SceneDoc {
  let doc = createDefaultDoc();
  doc = applyCommand(doc, validateCommand({ type: 'delete', ids: [...doc.order] })).doc;
  for (const c of cmds) doc = applyCommand(doc, validateCommand(c)).doc;
  return doc;
}

describe('collections', () => {
  it('add, move (with children), hide, leave out of renders, rename, remove', () => {
    let doc = scene([
      { type: 'add', primitive: 'cube', id: 'car' },
      { type: 'add', primitive: 'sphere', id: 'wheel' },
      { type: 'setParent', id: 'wheel', parentId: 'car' },
      { type: 'add', primitive: 'cone', id: 'tree' },
      { type: 'addCollection', id: 'vehicles', name: 'Vehicles' },
      { type: 'moveToCollection', ids: ['car'], collection: 'vehicles' },
    ]);
    expect(doc.objects.car.collection).toBe('vehicles');
    expect(doc.objects.wheel.collection).toBe('vehicles');
    expect(doc.objects.tree.collection).toBeUndefined();
    doc = applyCommand(doc, validateCommand({ type: 'setCollection', id: 'vehicles', visible: false })).doc;
    expect(isShown(doc, doc.objects.car)).toBe(false);
    expect(isShown(doc, doc.objects.tree)).toBe(true);
    doc = applyCommand(doc, validateCommand({ type: 'setCollection', id: 'vehicles', visible: true, render: false, name: 'Cars' })).doc;
    expect(isShown(doc, doc.objects.car)).toBe(true);
    expect(isRendered(doc, doc.objects.car)).toBe(false);
    expect(doc.collections![0].name).toBe('Cars');
    // Saved and loaded
    const back = validateSceneDoc(JSON.parse(JSON.stringify(doc)));
    expect(back.collections).toEqual(doc.collections);
    expect(back.objects.wheel.collection).toBe('vehicles');
    // Second collection gets a fresh name
    doc = applyCommand(doc, validateCommand({ type: 'addCollection', id: 'c2' })).doc;
    expect(doc.collections![1].name).toBe('Collection');
    // Back to the Scene Collection
    const moved = applyCommand(doc, validateCommand({ type: 'moveToCollection', ids: ['car'], collection: null })).doc;
    expect(moved.objects.car.collection).toBeUndefined();
    // Remove keeps objects…
    const kept = applyCommand(doc, validateCommand({ type: 'removeCollection', id: 'vehicles' })).doc;
    expect(kept.objects.car.collection).toBeUndefined();
    expect(kept.collections!.map((c) => c.id)).toEqual(['c2']);
    // …or deletes them
    const gone = applyCommand(doc, validateCommand({ type: 'removeCollection', id: 'vehicles', deleteObjects: true })).doc;
    expect(gone.objects.car).toBeUndefined();
    expect(gone.objects.wheel).toBeUndefined();
    expect(gone.objects.tree).toBeTruthy();
    expect(() => applyCommand(doc, validateCommand({ type: 'moveToCollection', ids: ['tree'], collection: 'nope' }))).toThrow(/collection/);
    expect(() => applyCommand(doc, validateCommand({ type: 'addCollection', id: 'vehicles' }))).toThrow(/already/);
  });

  it('a stale collection on load falls back to the Scene Collection', () => {
    const doc = scene([{ type: 'add', primitive: 'cube', id: 'a' }]);
    const raw = JSON.parse(JSON.stringify(doc));
    raw.objects.a.collection = 'missing';
    expect(validateSceneDoc(raw).objects.a.collection).toBeUndefined();
  });

  it('hidden collections switch off their physics, fields and particles; duplicates and fractures stay in', () => {
    let doc = scene([
      { type: 'addCollection', id: 'fx' },
      { type: 'add', primitive: 'empty', id: 'blast', collection: 'fx' },
      { type: 'setField', id: 'blast', field: { type: 'force', strength: 200, radius: 5 } },
      { type: 'duplicate', ids: ['blast'] },
    ]);
    expect(Object.values(doc.objects).every((o) => o.collection === 'fx')).toBe(true);
    expect(activeFields(doc, 1).length).toBe(2);
    doc = applyCommand(doc, validateCommand({ type: 'setCollection', id: 'fx', visible: false })).doc;
    expect(activeFields(doc, 1).length).toBe(0);
  });

  it('new objects go into the active collection (same undo step)', () => {
    const store = new Store();
    store.dispatch({ type: 'addCollection', id: 'props' });
    store.setActiveCollection('props');
    const [id] = store.dispatch({ type: 'add', primitive: 'cube' });
    expect(store.getState().doc.objects[id].collection).toBe('props');
    store.undo();
    expect(store.getState().doc.objects[id]).toBeUndefined();
    store.setActiveCollection(null);
    const [id2] = store.dispatch({ type: 'add', primitive: 'cube' });
    expect(store.getState().doc.objects[id2].collection).toBeUndefined();
  });
});
