// Rigid body physics, like Blender's Physics → Rigid Body and "Bake to Keyframes": active bodies
// fall, collide and settle; passive ones (floors, walls) stay put. The simulation runs once
// (cannon-es, MIT) and its result is written as ordinary keyframes, so it plays, scrubs and
// renders to video like any other animation. Blender space: metres, Z up, gravity −Z.

import type * as CannonNS from 'cannon-es';
import type { TransformKey } from './animation';
import { transformAt } from './animation';
import { activeFields, fieldAcceleration } from './fields';
import { applyModifiers } from './mesh/modifiers';
import { primitiveMesh } from './mesh/primitives';
import { m4ToQuat, quatToM4, rotEuler, toEuler } from './rig';
import quickhull from 'quickhull3d';
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
export const RIGID_SHAPES = ['auto', 'box', 'sphere', 'cylinder', 'hull'] as const;
export type RigidType = (typeof RIGID_TYPES)[number];
export type RigidShape = (typeof RIGID_SHAPES)[number];

export interface RigidBody {
  /** Active: moved by the simulation. Passive: an obstacle that stays where it is. */
  type: RigidType;
  /** Collision shape; auto = sphere for spheres, cylinder for cylinders and cones, else a box. Hull = the convex hull (Blender's default). */
  shape: RigidShape;
  /** kg (active only). */
  mass: number;
  /** 0..1, how much surfaces grip (Blender default 0.5). */
  friction: number;
  /** 0..1, how bouncy (Blender's Bounciness, default 0). */
  bounce: number;
  /** Starting velocity in m/s (e.g. a thrown ball). */
  velocity?: Vec3;
  /** Passive only: follows its own keyframes and shoves active bodies out of the way (Blender's "Animated"). */
  animated?: boolean;
}

export const DEFAULT_RIGID: RigidBody = { type: 'active', shape: 'auto', mass: 1, friction: 0.5, bounce: 0 };
export const GRAVITY = 9.81;
/** Physics steps per second, fixed whatever the frame rate (Blender: 10 substeps at 24 fps). */
export const STEP_HZ = 240;
/** Most a body's speed can grow in one step (m/s) from contacts alone (≈ 240 m/s², 25 g). */
const SPEED_GAIN = 1;

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

/** Convex hull of the (scaled) geometry as a cannon shape; big meshes are thinned to 200 points first. */
function hullShape(Cn: Cannon, geo: MeshData, s: Vec3): CannonNS.ConvexPolyhedron {
  let pts = geo.vertices.map((v) => [v[0] * s[0], v[1] * s[1], v[2] * s[2]] as Vec3);
  if (pts.length > 200) {
    const step = pts.length / 200;
    pts = Array.from({ length: 200 }, (_, i) => pts[Math.floor(i * step)]);
  }
  // Hull polygons (fewer faces and edges than triangles keep convex collisions fast), with
  // corners on a straight line removed and each face turned outwards: cannon reads a face's
  // normal from its first corners.
  const cen = [0, 1, 2].map((k) => pts.reduce((a, p) => a + p[k], 0) / pts.length);
  // A small collision margin: the hull is pulled in by 1% (at most 2 cm) all round, so pieces
  // that start out touching (the cells of a fracture) don't count as overlapping and get flung.
  let size = 0;
  for (const p of pts) size = Math.max(size, Math.abs(p[0] - cen[0]), Math.abs(p[1] - cen[1]), Math.abs(p[2] - cen[2]));
  const k = size > 0 ? 1 - Math.min(0.01 * size, 0.02) / size : 1;
  pts = pts.map((p) => [cen[0] + (p[0] - cen[0]) * k, cen[1] + (p[1] - cen[1]) * k, cen[2] + (p[2] - cen[2]) * k] as Vec3);
  const cross = (o: Vec3, a: Vec3, b: Vec3) => {
    const u = [a[0] - o[0], a[1] - o[1], a[2] - o[2]], v = [b[0] - o[0], b[1] - o[1], b[2] - o[2]];
    return [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  };
  const faces: number[][] = [];
  for (const raw of quickhull(pts, { skipTriangulation: true })) {
    let f = raw.filter((v, i) => {
      const prev = raw[(i + raw.length - 1) % raw.length], next = raw[(i + 1) % raw.length];
      const c = cross(pts[prev], pts[v], pts[next]);
      return Math.hypot(c[0], c[1], c[2]) > 1e-10;
    });
    if (f.length < 3) continue;
    let n = [0, 0, 0];
    for (let i = 1; i < f.length - 1; i++) {
      const c = cross(pts[f[0]], pts[f[i]], pts[f[i + 1]]);
      n = [n[0] + c[0], n[1] + c[1], n[2] + c[2]];
    }
    const a = pts[f[0]];
    if (n[0] * (a[0] - cen[0]) + n[1] * (a[1] - cen[1]) + n[2] * (a[2] - cen[2]) < 0) f = [...f].reverse();
    faces.push(f);
  }
  // Only the points on the hull, re-indexed.
  const used = [...new Set(faces.flat())];
  const map = new Map(used.map((v, i) => [v, i]));
  const poly = new Cn.ConvexPolyhedron({ vertices: used.map((i) => new Cn.Vec3(pts[i][0], pts[i][1], pts[i][2])), faces: faces.map((f) => f.map((v) => map.get(v)!)) });
  // Separating-axis tests on face normals only (skipping every edge × edge pair): several times
  // faster for piles of debris, at the cost of slightly early contacts at sharp edges.
  poly.uniqueEdges = [];
  return poly;
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
  world.defaultContactMaterial.contactEquationStiffness = 1e8;
  world.defaultContactMaterial.contactEquationRelaxation = 3;
  world.defaultContactMaterial.frictionEquationStiffness = 1e8;

  const actives: { id: string; body: CannonNS.Body; scale: Vec3 }[] = [];
  const movers: { id: string; body: CannonNS.Body }[] = [];
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
    const kinematic = !active && !!r.animated && (doc.animation?.tracks[id]?.length ?? 0) > 0;
    const body = new C.Body({ mass: active ? Math.max(0.001, r.mass) : 0, type: active ? C.Body.DYNAMIC : kinematic ? C.Body.KINEMATIC : C.Body.STATIC, material });
    const shape = r.shape === 'auto' ? autoShape(o) : r.shape;
    if (shape === 'hull') body.addShape(hullShape(C, geo, s));
    else if (shape === 'sphere') body.addShape(new C.Sphere(Math.max(...half)), center);
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
    if (kinematic) movers.push({ id, body });
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
  const sub = Math.max(1, Math.ceil(STEP_HZ / fps));
  const dt = 1 / (fps * sub);
  const hasFields = Object.values(doc.objects).some((o) => o.field);
  for (let f = start + 1; f <= end; f++) {
    // Force fields push the active bodies during this frame (Blender's Force Field effectors).
    const fields = hasFields ? activeFields(doc, f) : [];
    const pushed = new Set<string>();
    for (let i = 0; i < sub; i++) {
      // Animated passive bodies follow their keys; their velocity is what pushes others.
      for (const m of movers) {
        const ft = f - 1 + (i + 1) / sub;
        const tr = transformAt(doc, m.id, ft);
        if (!tr) continue;
        const b = m.body;
        b.velocity.set((tr.position[0] - b.position.x) / dt, (tr.position[1] - b.position.y) / dt, (tr.position[2] - b.position.z) / dt);
        const [qx, qy, qz, qw] = m4ToQuat(rotEuler(tr.rotation));
        // Angular velocity from the rotation step: q_new · q_old⁻¹ → axis × angle / dt.
        const q0 = b.quaternion;
        const dq = new C.Quaternion(qx, qy, qz, qw).mult(new C.Quaternion(-q0.x, -q0.y, -q0.z, q0.w));
        const sgn = dq.w < 0 ? -1 : 1;
        const sinH = Math.hypot(dq.x, dq.y, dq.z);
        const ang = 2 * Math.atan2(sinH, sgn * dq.w);
        if (sinH > 1e-9) b.angularVelocity.set((sgn * dq.x / sinH) * (ang / dt), (sgn * dq.y / sinH) * (ang / dt), (sgn * dq.z / sinH) * (ang / dt));
        else b.angularVelocity.set(0, 0, 0);
      }
      if (fields.length)
        for (const a of actives) {
          const p = a.body.position;
          const acc = fieldAcceleration(fields, [p.x, p.y, p.z]);
          if (!acc[0] && !acc[1] && !acc[2]) continue;
          pushed.add(a.id);
          if (a.body.sleepState === C.Body.SLEEPING) a.body.wakeUp();
          a.body.applyForce(new C.Vec3(acc[0] * a.body.mass, acc[1] * a.body.mass, acc[2] * a.body.mass));
        }
      const before = actives.map((a) => a.body.velocity.length());
      world.step(dt);
      // Cannon can resolve a deep box-on-box overlap with a huge kick that flings light debris
      // into the air. Real knocks don't add speed that fast, so a body's speed may grow by at
      // most SPEED_GAIN per step — unless a force field is pushing it (explosions are meant to).
      actives.forEach((a, j) => {
        const v = a.body.velocity;
        const len = v.length();
        const max = before[j] + SPEED_GAIN;
        if (len <= max || (fields.length && pushed.has(a.id))) return;
        v.scale(max / len, v);
      });
    }
    record(f);
  }
  // A body that settled early gets one more key at the end, so later keys can't pull it along.
  for (const keys of Object.values(tracks)) {
    const last = keys[keys.length - 1];
    if (last.frame < end) keys.push({ ...last, frame: end });
  }
  return { tracks, bodies: count };
}
