// Object → Quick Effects, like Blender's: one tap sets up a whole effect on the selected object.
import type { Command } from '../core/commands';
import { PARTICLE_PRESETS } from '../core/particles';
import { applyModifiers } from '../core/mesh/modifiers';
import { primitiveMesh } from '../core/mesh/primitives';
import type { Store } from '../core/store';
import { PRIMITIVES } from '../core/types';
import type { PrimitiveType, SceneObject, Vec3 } from '../core/types';
import { transformAt } from '../core/animation';
import { prepareCommands } from './prepare';

const isSolid = (o: SceneObject | undefined) => !!o && (o.type === 'mesh' || (PRIMITIVES as readonly string[]).includes(o.type)) && !o.water;

/** Size of the object (longest side, metres) and its centre height. */
function extent(o: SceneObject, pos: Vec3, scale: Vec3): { size: number; low: number } {
  const geo = o.type === 'mesh' ? (o.mesh ? applyModifiers(o.mesh, o.modifiers) : null) : primitiveMesh(o.type as PrimitiveType, o.params);
  if (!geo?.vertices.length) return { size: 1, low: pos[2] };
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const v of geo.vertices)
    for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k], v[k] * scale[k]);
      hi[k] = Math.max(hi[k], v[k] * scale[k]);
    }
  return { size: Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]), low: pos[2] + lo[2] };
}

const freeId = (store: Store, base: string) => {
  const objs = store.getState().doc.objects;
  let id = base;
  for (let k = 2; objs[id]; k++) id = `${base}-${k}`;
  return id;
};

export const canQuick = (store: Store) => isSolid(store.getState().doc.objects[store.getState().selection ?? '']);

/** Quick Explode: break it into pieces, blast them apart at the current frame, fireball, shake, bake. */
export async function quickExplode(store: Store) {
  const st = store.getState();
  const id = st.selection;
  const o = id ? st.doc.objects[id] : undefined;
  if (!id || !isSolid(o)) return store.notify('Select a shape or mesh to explode');
  const t = transformAt(st.doc, id, st.frame) ?? o!.transform;
  const { size, low } = extent(o!, t.position, t.scale);
  const f = st.frame;
  const at: Vec3 = [...t.position] as Vec3;
  const cmds: Command[] = [];
  // Something to land on, if nothing is set up as a floor yet.
  if (!Object.values(st.doc.objects).some((x) => x.rigid?.type === 'passive')) {
    const g = freeId(store, 'ground');
    cmds.push({ type: 'add', primitive: 'mesh', id: g, name: 'Ground (physics)', mesh: { vertices: [[-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1], [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]], faces: [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]], smooth: false }, material: { baseColor: '#6b6b66', roughness: 0.9 }, transform: { position: [at[0], at[1], low - 0.25], scale: [size * 8, size * 8, 0.25] } });
    cmds.push({ type: 'setRigidBody', id: g, rigid: { type: 'passive', friction: 0.7 } });
  }
  if (!o!.rigid) cmds.push({ type: 'setRigidBody', id, rigid: { mass: Math.max(1, size * size * size * 200) } });
  cmds.push({ type: 'fracture', id, pieces: 24 });
  const blast = freeId(store, `${id}-blast`);
  cmds.push({ type: 'add', primitive: 'empty', id: blast, name: `${o!.name} blast`, transform: { position: at } });
  cmds.push({ type: 'setField', id: blast, field: { type: 'force', strength: 160 + 40 * size, radius: size * 2.5, start: f, end: f + 1 } });
  const fire = freeId(store, `${id}-fireball`);
  const ex = PARTICLE_PRESETS.find((p) => p.id === 'explosion')!;
  cmds.push({ type: 'add', primitive: 'sphere', id: fire, name: `${o!.name} fireball`, transform: { position: at, scale: [size * 0.3, size * 0.3, size * 0.3] } });
  cmds.push({ type: 'setParticles', id: fire, particles: { ...ex.settings, start: f, end: f + (ex.burst ?? 3), size: Math.max(0.3, size * 0.25), speed: 2 + size, hideEmitter: true } });
  cmds.push({ type: 'addCameraShake', start: f, end: f + 48, strength: Math.min(1.2, 0.2 + size * 0.1), frequency: 10 });
  cmds.push({ type: 'bakePhysics' });
  store.notify('Exploding… (breaking it up and simulating)');
  try {
    await prepareCommands(cmds);
  } catch {
    return store.notify("Couldn't load the physics engine — check the connection and try again");
  }
  const before = store.getState().doc;
  store.dispatch({ type: 'batch', commands: cmds }, { select: false });
  if (store.getState().doc !== before) store.notify(`Boom at frame ${f}: press Play (one undo removes it all)`);
}

/** Quick Fire / Quick Smoke: the preset emitting from the object's surface. */
export function quickParticles(store: Store, preset: 'fire' | 'smoke') {
  const st = store.getState();
  const id = st.selection;
  if (!id || !isSolid(st.doc.objects[id])) return store.notify('Select a shape or mesh first');
  const p = PARTICLE_PRESETS.find((x) => x.id === preset)!;
  const a = st.doc.animation;
  store.dispatch({ type: 'setParticles', id, particles: { ...p.settings, start: (a?.start ?? 1) - 60, end: a?.end ?? 250 } }, { select: false });
  store.notify(`${p.label} added: it shows in Rendered shading and videos (Physics tab → Particles to tune it)`);
}

/** Quick Float: ride the waves of the water under it (adds an ocean if there's none). */
export function quickFloat(store: Store) {
  const st = store.getState();
  const id = st.selection;
  const o = id ? st.doc.objects[id] : undefined;
  if (!id || !o || o.water) return store.notify('Select an object to float');
  const cmds: Command[] = [];
  if (!Object.values(st.doc.objects).some((x) => x.water)) {
    const t = transformAt(st.doc, id, st.frame) ?? o.transform;
    cmds.push({ type: 'addWater', id: freeId(store, 'sea'), size: [60, 60], level: 0, position: [t.position[0], t.position[1]], height: 0.8, waves: 1.6 });
  }
  cmds.push({ type: 'setFloat', id, float: { offset: 0 } });
  store.dispatch({ type: 'batch', commands: cmds }, { select: false });
  store.notify('Floating on the water: press Play to see it ride the waves');
}
