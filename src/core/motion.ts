// Built-in character actions (walk, run, idle, wave, jump, sit) for human rigs.
//
// Actions are described anatomically — hip flexion, knee bend, arm swing, spine lean —
// in the body's frame (character faces −Y, its left is +X, Z up). A small forward-
// kinematics solver turns them into each bone's local rotation for the rig at hand,
// so the same action works whatever the bones' rolls are. Limbs are aimed with
// direction goals on the joint segments (hip→knee, knee→ankle, shoulder→elbow…).

import type { M4 } from './rig';
import { I4, apply, boneRest, mul, poseBones, rotEuler, rotationOnly, sortBones, toEuler } from './rig';
import type { Bone, SceneDoc, SceneObject, Vec3 } from './types';
import type { Command } from './commands';
import { transformAt } from './animation';

export const ACTIONS = ['walk', 'run', 'idle', 'wave', 'jump', 'sit', 'stand'] as const;
export type ActionName = (typeof ACTIONS)[number];

type V = Vec3;
const D = Math.PI / 180;
const T = (m: M4): M4 => [m[0], m[4], m[8], 0, m[1], m[5], m[9], 0, m[2], m[6], m[10], 0, 0, 0, 0, 1];
const app = (m: M4, v: V): V => [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[4] * v[0] + m[5] * v[1] + m[6] * v[2], m[8] * v[0] + m[9] * v[1] + m[10] * v[2]];
const nrm = (v: V): V => {
  const l = Math.hypot(...v) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};
const sub = (a: V, b: V): V => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

/** Smallest rotation taking unit a onto unit b. */
function minRot(a: V, b: V): M4 {
  const c = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const v: V = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  if (c < -0.99999) {
    // 180°: any perpendicular axis
    const p = nrm(Math.abs(a[0]) < 0.9 ? [0, -a[2], a[1]] : [-a[1], a[0], 0]);
    return [2 * p[0] * p[0] - 1, 2 * p[0] * p[1], 2 * p[0] * p[2], 0, 2 * p[1] * p[0], 2 * p[1] * p[1] - 1, 2 * p[1] * p[2], 0, 2 * p[2] * p[0], 2 * p[2] * p[1], 2 * p[2] * p[2] - 1, 0, 0, 0, 0, 1];
  }
  const k = 1 / (1 + c);
  return [
    c + v[0] * v[0] * k, v[0] * v[1] * k - v[2], v[0] * v[2] * k + v[1], 0,
    v[1] * v[0] * k + v[2], c + v[1] * v[1] * k, v[1] * v[2] * k - v[0], 0,
    v[2] * v[0] * k - v[1], v[2] * v[1] * k + v[0], c + v[2] * v[2] * k, 0,
    0, 0, 0, 1,
  ];
}

/** A pose described anatomically (degrees). Sides: L = character's left (+X). */
export interface BodyPose {
  /** Pelvis: forward tilt, twist (turning left positive), side tilt. */
  hips?: { tilt?: number; twist?: number; side?: number };
  /** Whole spine (spread over the vertebrae): forward lean, twist, side bend. */
  spine?: { lean?: number; twist?: number; side?: number };
  /** Head: nod forward, turn left, tilt. */
  head?: { nod?: number; turn?: number; tilt?: number };
  legs?: Partial<Record<'L' | 'R', { flex?: number; knee?: number; ankle?: number; spread?: number }>>;
  arms?: Partial<Record<'L' | 'R', { forward?: number; out?: number; elbow?: number; raise?: V }>>;
}

interface RigInfo {
  bones: Bone[];
  rest: Map<string, M4>;
  has: (n: string) => boolean;
  seg: (from: string, to: string) => V;
}

function rigInfo(bones: Bone[]): RigInfo {
  const by = new Map(bones.map((b) => [b.name, b]));
  const rest = new Map(bones.map((b) => [b.name, rotationOnly(boneRest(b))]));
  return {
    bones,
    rest,
    has: (n) => by.has(n),
    seg: (from, to) => nrm(sub(by.get(to)!.tail, by.get(from)!.head)),
  };
}

/** Is this a human rig the action library understands (MakeHuman bone names)? */
export const isHumanRig = (bones: Bone[]) => ['upperleg01.L', 'lowerleg01.L', 'upperarm01.L', 'lowerarm01.L', 'spine05', 'head', 'root'].every((n) => bones.some((b) => b.name === n));

/** Solve a BodyPose into bone-local Euler rotations. */
export function solvePose(rig: RigInfo, pose: BodyPose): Record<string, V> {
  const motion = new Map<string, M4>();
  const extra = new Map<string, M4>(); // body-frame rotation added at the joint
  const aim = new Map<string, { dir: V; seg: V }>(); // direction goals
  const rot = (x = 0, y = 0, z = 0) => rotEuler([x, y, z]);

  if (pose.hips) extra.set('root', rot(pose.hips.tilt ?? 0, pose.hips.side ?? 0, pose.hips.twist ?? 0));
  const spineBones = ['spine05', 'spine04', 'spine03', 'spine02', 'spine01'].filter(rig.has);
  if (pose.spine) for (const b of spineBones) extra.set(b, rot((pose.spine.lean ?? 0) / spineBones.length, (pose.spine.side ?? 0) / spineBones.length, (pose.spine.twist ?? 0) / spineBones.length));
  if (pose.head) {
    const hb = ['neck01', 'neck02', 'neck03', 'head'].filter(rig.has);
    for (const b of hb) extra.set(b, rot((pose.head.nod ?? 0) / hb.length, (pose.head.tilt ?? 0) / hb.length, (pose.head.turn ?? 0) / hb.length));
  }
  for (const side of ['L', 'R'] as const) {
    const sx = side === 'L' ? 1 : -1;
    const leg = pose.legs?.[side];
    if (leg) {
      const flex = (leg.flex ?? 0) * D, knee = (leg.knee ?? 0) * D, spread = (leg.spread ?? 3) * D;
      const thigh: V = nrm([sx * Math.sin(spread), -Math.sin(flex) * Math.cos(spread), -Math.cos(flex) * Math.cos(spread)]);
      const shinA = flex - knee;
      const shin: V = nrm([sx * Math.sin(spread) * 0.6, -Math.sin(shinA), -Math.cos(shinA)]);
      aim.set(`upperleg01.${side}`, { dir: thigh, seg: rig.seg(`upperleg01.${side}`, `upperleg02.${side}`) });
      aim.set(`lowerleg01.${side}`, { dir: shin, seg: rig.seg(`lowerleg01.${side}`, `lowerleg02.${side}`) });
      // Foot: pitch relative to the floor (toes down positive); rest pitch is the foot bone's own.
      const fr = rig.seg(`foot.${side}`, `foot.${side}`);
      const restPitch = Math.atan2(-fr[2], Math.hypot(fr[0], fr[1]));
      const pitch = restPitch + (leg.ankle ?? 0) * D;
      aim.set(`foot.${side}`, { dir: nrm([fr[0] * 0.3, -Math.cos(pitch), -Math.sin(pitch)]), seg: fr });
    }
    const arm = pose.arms?.[side];
    if (arm) {
      const fwd = (arm.forward ?? 0) * D, out = (arm.out ?? 8) * D, el = (arm.elbow ?? 10) * D;
      const upper: V = arm.raise ? nrm([arm.raise[0] * sx, arm.raise[1], arm.raise[2]]) : nrm([sx * Math.sin(out), -Math.sin(fwd) * Math.cos(out), -Math.cos(fwd) * Math.cos(out)]);
      const fa = fwd + el;
      const fore: V = arm.raise
        ? nrm([upper[0] * Math.cos(el) + 0, upper[1] * Math.cos(el) - Math.sin(el), upper[2] * Math.cos(el) + Math.sin(el) * 0.2])
        : nrm([sx * Math.sin(out) * 0.7, -Math.sin(fa), -Math.cos(fa)]);
      aim.set(`upperarm01.${side}`, { dir: upper, seg: rig.seg(`upperarm01.${side}`, `upperarm02.${side}`) });
      aim.set(`lowerarm01.${side}`, { dir: fore, seg: rig.seg(`lowerarm01.${side}`, `lowerarm02.${side}`) });
      aim.set(`wrist.${side}`, { dir: fore, seg: rig.seg(`wrist.${side}`, `wrist.${side}`) });
    }
  }

  const out: Record<string, V> = {};
  for (const b of sortBones(rig.bones)) {
    const M = b.parent ? motion.get(b.parent) ?? I4() : I4();
    let B = extra.get(b.name) ?? I4();
    const goal = aim.get(b.name);
    if (goal) B = minRot(nrm(app(M, goal.seg)), goal.dir);
    motion.set(b.name, mul(B, M));
    if (!extra.has(b.name) && !goal) continue;
    const R = rig.rest.get(b.name)!;
    // local = Rᵀ · Mᵀ · B · M · R  (written even when ~0, so a new action resets the bone)
    const L = mul(mul(T(R), mul(mul(T(M), B), M)), R);
    out[b.name] = toEuler(L);
  }
  return out;
}

// ---------------------------------------------------------------- the actions

interface Frame {
  pose: BodyPose;
  /** Root motion for this phase: forward distance (metres) and height offset. */
  fwd: number;
  up: number;
}

interface ActionDef {
  /** Frames per cycle at 24 fps, speed 1. */
  frames: number;
  /** Key every n frames. */
  step: number;
  loop: boolean;
  /** Distance travelled per cycle (metres) when travelling. */
  travel: number;
  at: (p: number) => Frame;
}

const sin = (p: number, off = 0) => Math.sin(2 * Math.PI * (p + off));
const cos = (p: number, off = 0) => Math.cos(2 * Math.PI * (p + off));
const smooth = (t: number) => t * t * (3 - 2 * t);
const relaxedArms = (L = 0, R = 0, elbow = 12): BodyPose['arms'] => ({ L: { forward: L, out: 7, elbow }, R: { forward: R, out: 7, elbow } });

const DEFS: Record<ActionName, ActionDef> = {
  stand: { frames: 24, step: 24, loop: false, travel: 0, at: () => ({ pose: { arms: relaxedArms(), legs: { L: {}, R: {} } }, fwd: 0, up: 0 }) },
  idle: {
    frames: 96, step: 8, loop: true, travel: 0,
    at: (p) => ({
      pose: {
        spine: { lean: 2 + 1.2 * sin(p * 2), side: 1.5 * sin(p) },
        hips: { side: -1.5 * sin(p) },
        head: { nod: 2 * sin(p * 2, 0.2), turn: 4 * sin(p, 0.3) },
        arms: relaxedArms(2 + sin(p * 2), 2 + sin(p * 2, 0.5), 14),
        legs: { L: { knee: 3 + 2 * sin(p) }, R: { knee: 3 - 2 * sin(p) } },
      },
      fwd: 0,
      up: -0.004 * (1 - cos(p * 2)),
    }),
  },
  walk: {
    frames: 30, step: 2, loop: true, travel: 1.45,
    at: (p) => {
      const leg = (off: number) => {
        const s = sin(p, off);
        const swing = Math.max(0, cos(p, off)); // leg moving forward
        return { flex: 24 * s + 4, knee: 6 + 55 * swing * swing + 8 * Math.max(0, -s), ankle: -14 * Math.max(0, s) + 22 * Math.max(0, -s) * Math.max(0, -cos(p, off)) };
      };
      return {
        pose: {
          hips: { twist: 6 * sin(p), side: 3 * cos(p * 2) },
          spine: { lean: 4, twist: -9 * sin(p) },
          head: { nod: -2, turn: 3 * sin(p) },
          legs: { L: leg(0), R: leg(0.5) },
          arms: { L: { forward: -20 * sin(p), out: 8, elbow: 16 + 14 * Math.max(0, -sin(p)) }, R: { forward: 20 * sin(p), out: 8, elbow: 16 + 14 * Math.max(0, sin(p)) } },
        },
        fwd: p,
        up: 0.018 * cos(p * 2) - 0.018,
      };
    },
  },
  run: {
    frames: 16, step: 1, loop: true, travel: 3.3,
    at: (p) => {
      const leg = (off: number) => {
        const s = sin(p, off);
        const swing = Math.max(0, cos(p, off));
        return { flex: 42 * s + 12, knee: 18 + 95 * swing + 20 * Math.max(0, -s), ankle: -18 * Math.max(0, s) + 30 * Math.max(0, -s) };
      };
      return {
        pose: {
          hips: { twist: 10 * sin(p), tilt: 6 },
          spine: { lean: 12, twist: -14 * sin(p) },
          head: { nod: -8 },
          legs: { L: leg(0), R: leg(0.5) },
          arms: { L: { forward: -45 * sin(p), out: 12, elbow: 85 }, R: { forward: 45 * sin(p), out: 12, elbow: 85 } },
        },
        fwd: p,
        up: 0.05 * Math.abs(cos(p)) - 0.03,
      };
    },
  },
  wave: {
    frames: 24, step: 2, loop: true, travel: 0,
    at: (p) => ({
      pose: {
        spine: { lean: 1, side: -3 },
        head: { tilt: 4, turn: -5 },
        arms: { L: { forward: 2, out: 7, elbow: 14 }, R: { raise: [0.55, -0.15, 0.82], elbow: 40 + 30 * sin(p) } },
        legs: { L: { knee: 3 }, R: { knee: 2 } },
      },
      fwd: 0,
      up: 0,
    }),
  },
  jump: {
    frames: 36, step: 1, loop: false, travel: 0.6,
    at: (p) => {
      // 0–0.3 crouch, 0.3–0.4 push, 0.4–0.75 air, 0.75–0.9 land, 0.9–1 recover
      const crouch = p < 0.3 ? smooth(p / 0.3) : p < 0.4 ? 1 - smooth((p - 0.3) / 0.1) : p < 0.75 ? 0 : p < 0.85 ? smooth((p - 0.75) / 0.1) * 0.8 : 0.8 * (1 - smooth((p - 0.85) / 0.15));
      const air = p >= 0.4 && p < 0.75 ? Math.sin(((p - 0.4) / 0.35) * Math.PI) : 0;
      const tuck = air * 0.6;
      const k = 110 * crouch + 50 * tuck;
      const armsUp = p > 0.3 && p < 0.75 ? smooth(Math.min(1, (p - 0.3) / 0.15)) : 0;
      return {
        pose: {
          spine: { lean: 30 * crouch + 5 },
          head: { nod: -10 * crouch },
          legs: { L: { flex: 70 * crouch + 30 * tuck, knee: k, ankle: 25 * crouch - 15 * air }, R: { flex: 70 * crouch + 30 * tuck, knee: k, ankle: 25 * crouch - 15 * air } },
          arms: { L: { forward: -35 * crouch + 150 * armsUp, out: 15, elbow: 20 }, R: { forward: -35 * crouch + 150 * armsUp, out: 15, elbow: 20 } },
        },
        fwd: p < 0.4 ? 0 : p > 0.75 ? 1 : (p - 0.4) / 0.35,
        up: 0.4 * air - 0.28 * crouch,
      };
    },
  },
  sit: {
    frames: 30, step: 2, loop: false, travel: 0,
    at: (p) => {
      const t = smooth(Math.min(1, p / 0.9));
      return {
        pose: {
          spine: { lean: 18 * t * (1 - t) * 4 * 0.6 + 4 * t },
          legs: { L: { flex: 88 * t, knee: 88 * t, spread: 5 }, R: { flex: 88 * t, knee: 88 * t, spread: 5 } },
          arms: { L: { forward: 35 * t, out: 10, elbow: 40 * t + 12 }, R: { forward: 35 * t, out: 10, elbow: 40 * t + 12 } },
        },
        fwd: 0,
        up: 0,
      };
    },
  },
};

/** Commands that key an action on an armature from `start`. */
export function playAction(doc: SceneDoc, arm: SceneObject, action: ActionName, start: number, opts: { cycles?: number; speed?: number; travel?: boolean } = {}): Command[] {
  const bones = arm.armature!.bones;
  if (!isHumanRig(bones)) throw new Error(`${arm.name} is not a human rig (add one with addHuman)`);
  const def = DEFS[action];
  const rig = rigInfo(bones);
  const speed = opts.speed ?? 1;
  const cycles = def.loop ? opts.cycles ?? 2 : 1;
  const len = Math.max(2, Math.round(def.frames / speed));
  const total = Math.round(len * cycles);
  const step = Math.max(1, Math.round(def.step / Math.max(speed, 0.5)));
  const out: Command[] = [];
  // Root motion relative to where the armature is at the start frame, along its facing (−Y local).
  const t0 = transformAt(doc, arm.id, start) ?? arm.transform;
  const heading = (t0.rotation[2] * Math.PI) / 180;
  const dir: V = [Math.sin(heading), -Math.cos(heading), 0];
  const travel = (opts.travel ?? true) ? def.travel : 0;
  // Sitting lowers the hips to knee height and moves them back by the thigh length.
  const by = new Map(bones.map((b) => [b.name, b]));
  const thighLen = Math.hypot(...sub(by.get('lowerleg01.L')!.head, by.get('upperleg01.L')!.head));
  // Ground contact: heel, ball and toe tip of each foot, so feet stay on the floor whatever
  // the legs do (the "up" of an action is then only real flight, e.g. a jump).
  const contacts: [string, V][] = [];
  for (const side of ['L', 'R']) {
    const f = by.get(`foot.${side}`)!;
    contacts.push([f.name, [f.head[0], f.head[1] + 0.035, f.head[2] - 0.065]], [f.name, f.tail]);
    const toe = by.get(`toe2-1.${side}`) ?? by.get(`toe1-1.${side}`);
    if (toe) contacts.push([toe.name, toe.tail]);
  }
  const groundOf = (pose: Record<string, V>) => {
    const { skin } = poseBones(bones, Object.fromEntries(Object.entries(pose).map(([b, r]) => [b, { rotation: r }])));
    return Math.min(...contacts.map(([b, p]) => apply(skin.get(b)!, p)[2]));
  };
  const restGround = Math.min(...contacts.map(([, p]) => p[2]));
  for (let f = 0; f <= total; f += step) {
    const g = f + step > total ? total : f;
    const ph = def.loop ? (g / len) % 1 : Math.min(1, g / len);
    const fr = def.at(ph);
    const frame = start + g;
    // Every action keys the whole body, so actions played one after another don't mix.
    const full: BodyPose = { hips: {}, spine: {}, head: {}, ...fr.pose, legs: { L: {}, R: {}, ...fr.pose.legs }, arms: { ...relaxedArms(), ...fr.pose.arms } };
    const pose = solvePose(rig, full);
    for (const [bone, rotation] of Object.entries(pose)) out.push({ type: 'setPoseKey', id: arm.id, bone, frame, rotation, easing: 'linear' });
    let fwd = travel * ((def.loop ? Math.floor(g / len) : 0) + fr.fwd);
    const up = restGround - groundOf(pose) + Math.max(0, fr.up);
    if (action === 'sit') fwd -= thighLen * smooth(Math.min(1, ph / 0.9)) * 0.95;
    const pos: V = [t0.position[0] + dir[0] * fwd, t0.position[1] + dir[1] * fwd, t0.position[2] + up];
    out.push({ type: 'setKeyframe', id: arm.id, frame, easing: 'linear', transform: { position: pos.map((x) => Math.round(x * 1e4) / 1e4) as V, rotation: [...t0.rotation], scale: [...t0.scale] } });
    if (g === total) break;
  }
  return out;
}

/** A relaxed standing pose (arms down) for a human rig, as bone rotations. */
export function standPose(bones: Bone[]): Record<string, { rotation: V }> {
  if (!isHumanRig(bones)) return {};
  const r = solvePose(rigInfo(bones), DEFS.stand.at(0).pose);
  return Object.fromEntries(Object.entries(r).map(([b, rotation]) => [b, { rotation }]));
}
