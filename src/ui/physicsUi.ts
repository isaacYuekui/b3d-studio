// Rigid body bake / free, shared by the Animation menu and the Physics panels.
import type { Store } from '../core/store';
import { animationOf } from '../core/animation';
import { loadPhysics, rigidProblem } from '../core/physics';

export async function bakePhysics(store: Store) {
  const doc = store.getState().doc;
  const actives = Object.values(doc.objects).filter((o) => o.rigid?.type === 'active' && o.visible);
  if (!actives.length) {
    store.notify('Nothing to simulate: select an object and turn on Physics → Rigid body');
    return;
  }
  try {
    await loadPhysics();
  } catch {
    store.notify("Couldn't load the physics engine — check the connection and try again");
    return;
  }
  const a = animationOf(doc);
  store.dispatch({ type: 'bakePhysics' }, { select: false });
  const skipped = actives.map(rigidProblem).filter(Boolean);
  if (store.getState().doc !== doc)
    store.notify(`Simulated ${actives.length - skipped.length} object${actives.length - skipped.length === 1 ? '' : 's'}, frames ${a.start}–${a.end}: press Play${skipped.length ? ` (skipped: ${skipped[0]})` : ''}`);
}

/** Remove the baked keys of the active rigid bodies (Blender's Free Bake), back to their start pose. */
export function freePhysics(store: Store) {
  const doc = store.getState().doc;
  const ids = Object.values(doc.objects)
    .filter((o) => o.rigid?.type === 'active' && doc.animation?.tracks[o.id]?.length)
    .map((o) => o.id);
  if (!ids.length) {
    store.notify('No baked physics to free');
    return;
  }
  store.dispatch({ type: 'batch', commands: ids.map((id) => ({ type: 'clearAnimation' as const, id })) }, { select: false });
  store.notify(`Freed the bake of ${ids.length} object${ids.length === 1 ? '' : 's'}`);
}
