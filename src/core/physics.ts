// Rigid body physics, like Blender's Physics → Rigid Body and "Bake to Keyframes": active bodies
// fall, collide and settle; passive ones (floors, walls) stay put. The simulation runs once
// (cannon-es, MIT) and its result is written as ordinary keyframes, so it plays, scrubs and
// renders to video like any other animation. Blender space: metres, Z up, gravity −Z.

import type * as CannonNS from 'cannon-es';
import type { TransformKey } from './animation';
import { transformAt } from './animation';
import { applyModifiers } from './mesh/modifiers';
import { primitiveMesh } from './mesh/primitives';
import { m4ToQuat, quatToM4, rotEuler, toEuler } from './rig';
import type { MeshData, PrimitiveType, SceneDoc, SceneObject, Vec3 } from './types';
import { PRIMITIVES } from './types';

type Cannon = typeof CannonNS;
let C: Cannon | null = null;
let loading: Promise<void> | null = null;

/** Load the physics engine (once, on demand). */
export function loadPhysics(): Promise<void> {
  if (C) return Promise.resolve();
  loading ??= import('cannon-es').then((m) => {
    C = m;
  });
  return loading;
}
export const registerPhysics = (m: Cannon) => void (C = m);
export const isPhysicsLoaded = () => !!C;

export const RIGID_TYPES = ['active', 'passive'] as const;
export const RIGID_SHAPES = ['auto', 'box', 'sphere', 'cylinder'] as const;
export type RigidType = (typeof RIGID_TYPES)[number];
export type RigidShape = (typeof RIGID_SHAPES)[number];

export interface RigidBody {
  /** Active: moved by the simulation. Passive: an obstacle that stays where it is. */
  type: RigidType;
  /** Collision shape; auto = sphere for spheres, cylinder for cylinders and cones, else a box. */
  shape: RigidShape;
  /** kg (active only). */
  mass: number;
  /** 0..1, how much surfaces grip (Blender default 0.5). */
  friction: number;
  /** 0..1, how bouncy (Blender's Bounciness, default 0). */
  bounce: number;
  /** Starting velocity in m/s (e.g. a thrown ball). */
  velocity?: Vec3;
}

export const DEFAULT_RIGID: RigidBody = { type: 'active', shape: 'auto', mass: 1, friction: 0.5, bounce: 0 };
export const GRAVITY = 9.81;

export class PhysicsError extends Error {}

/** Can this object take part (a shape or mesh, not parented)? Returns why not, or null. */
export function rigidProblem(o: SceneObject): string | null {
  if (o.type !== 'mesh' && !(PRIMITIVES as readonly string[]).includes(o.type)) return `${o.name}: only shapes and meshes can be rigid bodies`;
  if (o.parentId) return `${o.name}: parented objects can't be simulated (clear the parent first)`;
  return null;
}

function localGeometry(o: SceneObject): MeshData | null {
  if (o.type === 'mesh') return o.mesh ? applyModifiers(o.mesh, o.modifiers) : null;
  if ((PRIMITIVES as readonly string[]).includes(o.type)) return primitiveMesh(o.type as PrimitiveType, o.params);
  return null;
}

const autoShape = (o: SceneObject): Exclude<RigidShape, 'auto'> => (o.type === 'sphere' ? 'sphere' : o.type === 'cylinder' || o.type === 'cone' ? 'cylinder' : 'box');

/** Keep each Euler angle within 180° of the previous frame's, so curves don't jump at ±180°. */
function unwrap(prev: Vec3 | null, e: Vec3): Vec3 {
  if (!prev) return e;
  return e.map((v, i) => {
    let x = v;
    while (x - prev[i] > 180) x -= 360;
    while (x - prev[i] < -180) x += 360;
    return Math.round(x * 1e4) / 1e4;
  }) as Vec3;
}

export interface BakeResult {
  /** New keys for each active body, frames start..end (stopping once it comes to rest). */
  tracks: Record<string, TransformKey[]>;
  bodies: number;
}

/** Run the simulation from `start` to `end` at `fps` and return keyframes for the active bodies. */
export function simulate(doc: SceneDoc, start: number, end: number, fps: number): BakeResult {
  if (!C) throw new PhysicsError('The physics engine is not loaded yet');
  const world = new C.World({ gravity: new C.Vec3(0, 0, -GRAVITY), allowSleep: true });
  world.broadphase = new C.SAPBroadphase(world);
  (world.solver as CannonNS.GSSolver).iterations = 20;
  world.defaultContactMaterial.friction = 0.5;
  world.defaultContactMaterial.restitution = 0;

  const actives: { id: string; body: CannonNS.Body; scale: Vec3 }[] = [];
  let count = 0;
  for (const id of doc.order) {
    const o = doc.objects[id];
    if (!o?.rigid || !o.visible || rigidProblem(o)) continue;
    const geo = localGeometry(o);
    if (!geo?.vertices.length) continue;
    const r = o.rigid;
    const t = transformAt(doc, id, start) ?? o.transform;
    const s = t.scale;
    const lo: Vec3 = [Infinity, Infinity, Infinity], hi: Vec3 = [-Infinity, -Infinity, -Infinity];
    for (const v of geo.vertices)
      for (let k = 0; k < 3; k++) {
        lo[k] = Math.min(lo[k], v[k] * s[k]);
        hi[k] = Math.max(hi[k], v[k] * s[k]);
      }
    const half = [0, 1, 2].map((k) => Math.max(0.005, (hi[k] - lo[k]) / 2));
    const center = new C.Vec3((lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2);
    const material = new C.Material({ friction: r.friction, restitution: r.bounce });
    const active = r.type === 'active';
    const body = new C.Body({ mass: active ? Math.max(0.001, r.mass) : 0, type: active ? C.Body.DYNAMIC : C.Body.STATIC, material });
    const shape = r.shape === 'auto' ? autoShape(o) : r.shape;
    if (shape === 'sphere') body.addShape(new C.Sphere(Math.max(...half)), center);
    else if (shape === 'cylinder') {
      // Cannon's cylinders run along Y; ours (Blender's) along Z.
      const q = new C.Quaternion();
      q.setFromAxisAngle(new C.Vec3(1, 0, 0), Math.PI / 2);
      const top = o.type === 'cone' ? 0.02 * Math.max(half[0], half[1]) : Math.max(half[0], half[1]);
      body.addShape(new C.Cylinder(top, Math.max(half[0], half[1]), half[2] * 2, 20), center, q);
    } else body.addShape(new C.Box(new C.Vec3(half[0], half[1], half[2])), center);
    body.position.set(t.position[0], t.position[1], t.position[2]);
    const [qx, qy, qz, qw] = m4ToQuat(rotEuler(t.rotation));
    body.quaternion.set(qx, qy, qz, qw);
    if (active && r.velocity) body.velocity.set(r.velocity[0], r.velocity[1], r.velocity[2]);
    body.sleepSpeedLimit = 0.02;
    body.sleepTimeLimit = 1;
    world.addBody(body);
    count++;
    if (active) actives.push({ id, body, scale: [...s] as Vec3 });
  }

  const tracks: Record<string, TransformKey[]> = {};
  const lastRot = new Map<string, Vec3>();
  const resting = new Set<string>();
  const record = (frame: number) => {
    for (const a of actives) {
      const keys = (tracks[a.id] ??= []);
      const p = a.body.position, q = a.body.quaternion;
      const position: Vec3 = [p.x, p.y, p.z].map((v) => Math.round(v * 1e5) / 1e5) as Vec3;
      const rotation = unwrap(lastRot.get(a.id) ?? null, toEuler(quatToM4([q.x, q.y, q.z, q.w])));
      lastRot.set(a.id, rotation);
      const prev = keys[keys.length - 1];
      // Once a body has settled, its last key holds it there: no need for more.
      if (prev && keys.length > 1 && prev.transform.position.every((v, k) => Math.abs(v - position[k]) < 1e-5) && prev.transform.rotation.every((v, k) => Math.abs(v - rotation[k]) < 1e-3)) {
        resting.add(a.id);
        continue;
      }
      // Knocked back into motion: hold still until the frame before, then move.
      if (resting.has(a.id) && prev && prev.frame < frame - 1) keys.push({ ...prev, frame: frame - 1 });
      resting.delete(a.id);
      keys.push({ frame, transform: { position, rotation, scale: a.scale }, easing: 'linear' });
    }
  };
  record(start);
  // Fixed small steps (≈240 per second) keep stacks stable whatever the frame rate.
  const sub = Math.max(1, Math.ceil(240 / fps));
  const dt = 1 / (fps * sub);
  for (let f = start + 1; f <= end; f++) {
    for (let i = 0; i < sub; i++) world.step(dt);
    record(f);
  }
  // A body that settled early gets one more key at the end, so later keys can't pull it along.
  for (const keys of Object.values(tracks)) {
    const last = keys[keys.length - 1];
    if (last.frame < end) keys.push({ ...last, frame: end });
  }
  return { tracks, bodies: count };
}
