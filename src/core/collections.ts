// Collections (Blender's Outliner folders): objects belong to at most one collection (or to the
// Scene Collection when they have none). A collection can be hidden in the viewport (eye) or left
// out of renders (camera) — the objects keep their own Hide setting underneath.

import type { SceneDoc, SceneObject } from './types';

export interface Collection {
  id: string;
  name: string;
  /** Shown in the viewport (Blender's eye). */
  visible: boolean;
  /** Included in videos / renders (Blender's camera icon). */
  render: boolean;
}

export const MAX_COLLECTIONS = 64;

export const collectionsOf = (doc: SceneDoc): Collection[] => doc.collections ?? [];

export function collectionById(doc: SceneDoc, id: string | undefined | null): Collection | undefined {
  return id ? doc.collections?.find((c) => c.id === id) : undefined;
}

/** Shown in the viewport: the object isn't hidden and neither is its collection. */
export function isShown(doc: SceneDoc, o: SceneObject | undefined): boolean {
  if (!o || !o.visible) return false;
  const c = collectionById(doc, o.collection);
  return !c || c.visible;
}

/** Drawn in videos: shown, and its collection is renderable. */
export function isRendered(doc: SceneDoc, o: SceneObject | undefined): boolean {
  if (!isShown(doc, o)) return false;
  const c = collectionById(doc, o!.collection);
  return !c || c.render;
}

/** The object and everything parented under it (they move together between collections). */
export function withDescendants(doc: SceneDoc, ids: string[]): string[] {
  const out = new Set(ids);
  let grew = true;
  while (grew) {
    grew = false;
    for (const id of doc.order) {
      const p = doc.objects[id]?.parentId;
      if (p && out.has(p) && !out.has(id)) {
        out.add(id);
        grew = true;
      }
    }
  }
  return doc.order.filter((id) => out.has(id));
}

/** A name not used by another collection ("Collection", "Collection 2"…). */
export function uniqueCollectionName(doc: SceneDoc, base = 'Collection'): string {
  const names = new Set(collectionsOf(doc).map((c) => c.name));
  if (!names.has(base)) return base;
  for (let i = 2; ; i++) if (!names.has(`${base} ${i}`)) return `${base} ${i}`;
}
