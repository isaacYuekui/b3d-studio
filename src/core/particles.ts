// Particle systems, after Blender's Particles tab (Emitter type): an object emits many small
// shapes from its surface over a frame range; each flies off with a speed, falls with gravity and
// disappears after its lifetime. Motion is worked out in closed form for any frame, so particles
// scrub, play backwards and render to video exactly the same every time — no baking needed.

import { applyModifiers } from './mesh/modifiers';
import { primitiveMesh } from './mesh/primitives';
import { triangulate } from './mesh/topology';
import type { V } from './mesh/topology';
import { mulberry32 } from './fracture';
import { apply as applyM4, worldMatrix } from './rig';
import { oceanDisplace } from './ocean';
import type { M4 } from './rig';
import type { MeshData, PrimitiveType, SceneDoc, SceneObject, Vec3 } from './types';
import { PRIMITIVES } from './types';

export const PARTICLE_SHAPES = ['sphere', 'cube', 'drop', 'flake', 'fire', 'smoke'] as const;
/** Soft, camera-facing puffs that grow and fade over their life. */
export const isBillboard = (shape: ParticleShape) => shape === 'fire' || shape === 'smoke';
export type ParticleShape = (typeof PARTICLE_SHAPES)[number];
export const PARTICLE_GROUND = ['none', 'stop'] as const;

export interface ParticleSettings {
  /** How many particles in total. */
  count: number;
  /** Frames during which they are emitted. */
  start: number;
  end: number;
  /** How long each one lives, in frames. */
  lifetime: number;
  /** Starting speed (m/s) along the surface normal… */
  speed: number;
  /** …plus this much speed in a random direction (m/s). */
  random: number;
  /** Gravity as a multiple of Earth's (0 = floating, 1 = normal). */
  gravity: number;
  /** Size in metres, and how much it varies (0..1). */
  size: number;
  sizeRandom: number;
  shape: ParticleShape;
  color: string;
  /** Glow (for sparks, embers): 0..1. */
  glow: number;
  /** Steady wind: a push in m/s² along X, Y, Z (e.g. [1.5, 0, 0] blows smoke sideways). */
  wind?: Vec3;
  /** What happens at the ground (z = 0): pass through, or stop and lie there. */
  ground: (typeof PARTICLE_GROUND)[number];
  /** Hide the emitting object itself in renders (Blender's "Show Emitter"). */
  hideEmitter: boolean;
  seed: number;
  /**
   * Where particles come from: the object's surface (default), or — on water with a giant wave —
   * the top of the wave as it runs (spray thrown up and forward off the crest).
   */
  emit?: (typeof PARTICLE_EMIT)[number];
}

export const PARTICLE_EMIT = ['surface', 'crest'] as const;

export const DEFAULT_PARTICLES: ParticleSettings = {
  count: 500,
  start: 1,
  end: 100,
  lifetime: 50,
  speed: 2,
  random: 0.5,
  gravity: 1,
  size: 0.05,
  sizeRandom: 0.3,
  shape: 'sphere',
  color: '#e8e8e8',
  glow: 0,
  ground: 'none',
  hideEmitter: false,
  seed: 1,
};

/** Quick setups. `burst`: emit everything within this many frames from the current frame (explosions). */
export const PARTICLE_PRESETS: { id: string; label: string; settings: Partial<ParticleSettings>; burst?: number }[] = [
  { id: 'sparks', label: 'Sparks', settings: { count: 600, lifetime: 24, speed: 4, random: 3, gravity: 1, size: 0.025, sizeRandom: 0.5, shape: 'sphere', color: '#ffb347', glow: 1, ground: 'stop' } },
  { id: 'fountain', label: 'Fountain', settings: { count: 1500, lifetime: 40, speed: 6, random: 0.6, gravity: 1, size: 0.04, sizeRandom: 0.3, shape: 'drop', color: '#9fd3ff', glow: 0, ground: 'none' } },
  { id: 'rain', label: 'Rain', settings: { count: 3000, lifetime: 40, speed: 0, random: 0.2, gravity: 1.2, size: 0.03, sizeRandom: 0.2, shape: 'drop', color: '#cfe4ff', glow: 0, ground: 'none', hideEmitter: true } },
  { id: 'snow', label: 'Snow', settings: { count: 2500, lifetime: 160, speed: 0, random: 0.4, gravity: 0.06, size: 0.04, sizeRandom: 0.5, shape: 'flake', color: '#ffffff', glow: 0, ground: 'stop', hideEmitter: true } },
  { id: 'fire', label: 'Fire', settings: { count: 1800, lifetime: 26, speed: 0.6, random: 0.35, gravity: -0.3, size: 0.32, sizeRandom: 0.4, shape: 'fire', color: '#ff7a1a', glow: 1, ground: 'none' } },
  { id: 'smoke', label: 'Smoke', settings: { count: 700, lifetime: 130, speed: 0.5, random: 0.3, gravity: -0.12, size: 0.7, sizeRandom: 0.4, shape: 'smoke', color: '#5d5d5d', glow: 0, ground: 'none', wind: [0.35, 0, 0] } },
  { id: 'explosion', label: 'Explosion', burst: 3, settings: { count: 900, lifetime: 34, speed: 5, random: 5, gravity: 0.3, size: 0.55, sizeRandom: 0.5, shape: 'fire', color: '#ff8a2a', glow: 1, ground: 'none' } },
  { id: 'dust', label: 'Dust cloud', burst: 4, settings: { count: 450, lifetime: 140, speed: 2.5, random: 3, gravity: -0.03, size: 1.1, sizeRandom: 0.5, shape: 'smoke', color: '#8a7f72', glow: 0, ground: 'none', wind: [0.3, 0, 0] } },
  { id: 'spray', label: 'Wave spray', settings: { count: 5000, lifetime: 34, speed: 7, random: 2.5, gravity: 0.7, size: 1.8, sizeRandom: 0.6, shape: 'smoke', color: '#eef3f5', glow: 0, ground: 'none', hideEmitter: false, emit: 'crest' } },
  { id: 'debris', label: 'Debris', settings: { count: 400, lifetime: 120, speed: 5, random: 4, gravity: 1, size: 0.12, sizeRandom: 0.7, shape: 'cube', color: '#7d746a', glow: 0, ground: 'stop' } },
];

/** Emission points: random spots on the surface (by area) with their normals, in the object's space. */
function emissionPoints(geo: MeshData, n: number, rnd: () => number): { p: V; n: V }[] {
  const tris: { a: V; b: V; c: V; area: number; n: V }[] = [];
  for (const f of geo.faces)
    for (const [i, j, k] of triangulate(geo.vertices, f)) {
      const a = geo.vertices[i], b = geo.vertices[j], c = geo.vertices[k];
      const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
      const cr: V = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
      const area = Math.hypot(...cr) / 2;
      if (area > 1e-12) tris.push({ a, b, c, area, n: cr.map((x) => x / (2 * area)) as V });
    }
  if (!tris.length) return [];
  const cum: number[] = [];
  let total = 0;
  for (const t of tris) cum.push((total += t.area));
  const out: { p: V; n: V }[] = [];
  for (let i = 0; i < n; i++) {
    const r = rnd() * total;
    let lo = 0, hi = cum.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cum[mid] < r) lo = mid + 1;
      else hi = mid;
    }
    const t = tris[lo];
    let s = rnd(), q = rnd();
    if (s + q > 1) [s, q] = [1 - s, 1 - q];
    out.push({ p: [0, 1, 2].map((k) => t.a[k] + (t.b[k] - t.a[k]) * s + (t.c[k] - t.a[k]) * q) as V, n: t.n });
  }
  return out;
}

export function emitterGeometry(o: SceneObject): MeshData | null {
  if (o.type === 'mesh' && o.mesh) return applyModifiers(o.mesh, o.modifiers);
  if ((PRIMITIVES as readonly string[]).includes(o.type)) return primitiveMesh(o.type as PrimitiveType, o.params);
  return null;
}

interface Seeds {
  /** Per particle: emission point and normal (object space), random direction, size factor, spin axis. */
  p: V[];
  n: V[];
  dir: V[];
  size: number[];
  spin: number[];
}
const seedCache = new WeakMap<object, Map<string, Seeds>>();

function seedsFor(o: SceneObject, s: ParticleSettings): Seeds | null {
  const geo = emitterGeometry(o);
  if (!geo) return null;
  const owner = (o.mesh ?? o.params ?? o) as object;
  const key = `${s.count}|${s.seed}|${o.type}|${JSON.stringify(o.modifiers ?? null)}|${JSON.stringify(o.params ?? null)}`;
  let m = seedCache.get(owner);
  const hit = m?.get(key);
  if (hit) return hit;
  const rnd = mulberry32(s.seed * 7919 + 13);
  const pts = emissionPoints(geo, s.count, rnd);
  const out: Seeds = { p: [], n: [], dir: [], size: [], spin: [] };
  for (const { p, n } of pts) {
    // Uniform random direction.
    const z = rnd() * 2 - 1, a = rnd() * Math.PI * 2, r = Math.sqrt(1 - z * z);
    out.p.push(p);
    out.n.push(n);
    out.dir.push([r * Math.cos(a), r * Math.sin(a), z]);
    out.size.push(1 + (rnd() * 2 - 1));
    out.spin.push(rnd() * 360);
  }
  if (!m) seedCache.set(owner, (m = new Map()));
  m.set(key, out);
  return out;
}

export interface ParticleFrame {
  /** World positions (Blender space). */
  positions: Vec3[];
  /** Uniform scale of each particle (metres). */
  sizes: number[];
  /** Rotation about Z (degrees), for variety. */
  spins: number[];
  /** Direction of travel (for stretched raindrops), unit vectors. */
  dirs: Vec3[];
  /** How far through its life each particle is (0 = just born, 1 = about to vanish). */
  life: number[];
}

const G = 9.81;

/**
 * The crest of a water object's giant wave: where a spray particle starts (object space), given a
 * surface point (for its place across the wave) and a 0..1 number (for how far over the top).
 */
function crestOf(o: SceneObject) {
  const w = o.water!, g = w.surge!;
  const a = ((w.direction ?? 0) * Math.PI) / 180;
  const ux = Math.cos(a), uy = Math.sin(a);
  // The water's extent along the wave's direction.
  let lo = Infinity, hi = -Infinity;
  for (const p of o.mesh?.vertices ?? []) {
    const d = ux * p[0] + uy * p[1];
    lo = Math.min(lo, d);
    hi = Math.max(hi, d);
  }
  const half = Math.max(0.5, g.width / 2);
  return {
    ux,
    uy,
    speed: g.speed,
    point(p: V, r: number, frame: number, fps: number): Vec3 | null {
      const t = frame / fps;
      const front = g.from + g.speed * Math.max(0, t - (g.start - 1) / fps);
      // Mostly on top and just ahead of the crest, where a breaking wave throws water.
      const along = front + half * (-0.25 + 0.6 * r);
      if (along < lo || along > hi) return null;
      const side = -uy * p[0] + ux * p[1];
      const x = ux * along - uy * side, y = uy * along + ux * side;
      const [dx, dy, dz] = oceanDisplace(x, y, t, w, fps);
      return [x + dx, y + dy, dz];
    },
  };
}

/** Frames while a water object's giant wave is over the water (for spray), or null. */
export function crestFrames(o: SceneObject, fps: number): { start: number; end: number } | null {
  const g = o.water?.surge;
  if (!g || !o.mesh?.vertices.length) return null;
  const a = ((o.water!.direction ?? 0) * Math.PI) / 180;
  let lo = Infinity, hi = -Infinity;
  for (const p of o.mesh.vertices) {
    const d = Math.cos(a) * p[0] + Math.sin(a) * p[1];
    lo = Math.min(lo, d);
    hi = Math.max(hi, d);
  }
  // front(f) = from + speed × (f − start + 1) / fps, from `start` on.
  const at = (d: number) => g.start - 1 + ((d - g.from) / g.speed) * fps;
  const start = Math.max(g.start, Math.floor(at(lo)));
  const end = Math.ceil(at(hi));
  return end > start ? { start, end } : null;
}

/** Where every living particle of an emitter is at `frame` (seconds = frames / fps). */
export function particlesAt(doc: SceneDoc, id: string, frame: number, fps: number): ParticleFrame {
  const out: ParticleFrame = { positions: [], sizes: [], spins: [], dirs: [], life: [] };
  const o = doc.objects[id];
  const s = o?.particles;
  if (!o || !s || !o.visible) return out;
  const seeds = seedsFor(o, s);
  if (!seeds) return out;
  const n = seeds.p.length;
  const span = Math.max(0, s.end - s.start);
  const g = s.gravity * G;
  const w: Vec3 = s.wind ?? [0, 0, 0];
  let lastBirth = -Infinity;
  let M: M4 | null = null;
  const crest = s.emit === 'crest' && o.water?.surge ? crestOf(o) : null;
  for (let i = 0; i < n; i++) {
    const birth = s.start + (n > 1 ? (span * i) / (n - 1) : 0);
    const age = frame - birth;
    if (age < 0 || age >= s.lifetime) continue;
    // The emitter's placement when this particle was born (moving emitters leave trails).
    if (!M || Math.abs(birth - lastBirth) >= 0.5) {
      M = worldMatrix(doc, id, Math.round(birth));
      lastBirth = birth;
    }
    let p0: Vec3, v: Vec3;
    if (crest) {
      // Spray: born on top of the giant wave where it was at that moment, thrown up and forward.
      const at = crest.point(seeds.p[i], seeds.spin[i] / 360, birth, fps);
      if (!at) continue; // the wave isn't over the water then
      p0 = applyM4(M, at);
      const fwd = crest.speed * 0.45;
      v = [crest.ux * fwd + seeds.dir[i][0] * s.random, crest.uy * fwd + seeds.dir[i][1] * s.random, s.speed + seeds.dir[i][2] * s.random];
    } else {
      p0 = applyM4(M, seeds.p[i]);
      const nW = applyM4(M, seeds.n[i]);
      const o0 = applyM4(M, [0, 0, 0]);
      const nn: Vec3 = [nW[0] - o0[0], nW[1] - o0[1], nW[2] - o0[2]];
      const nl = Math.hypot(...nn) || 1;
      v = [0, 1, 2].map((k) => (nn[k] / nl) * s.speed + seeds.dir[i][k] * s.random) as Vec3;
    }
    let t = age / fps;
    // Stop at the ground: find when it reaches z = 0 going down and hold it there.
    if (s.ground === 'stop' && p0[2] >= 0) {
      const a = (w[2] - g) / 2, b = v[2], c = p0[2];
      let hit = Infinity;
      if (Math.abs(a) > 1e-9) {
        const d = b * b - 4 * a * c;
        if (d >= 0) {
          const r1 = (-b + Math.sqrt(d)) / (2 * a), r2 = (-b - Math.sqrt(d)) / (2 * a);
          hit = Math.min(...[r1, r2].filter((x) => x > 1e-6), Infinity);
        }
      } else if (b < 0) hit = -c / b;
      if (t > hit) t = hit;
    }
    const pos: Vec3 = [p0[0] + v[0] * t + (w[0] * t * t) / 2, p0[1] + v[1] * t + (w[1] * t * t) / 2, p0[2] + v[2] * t + ((w[2] - g) * t * t) / 2];
    const vel: Vec3 = [v[0] + w[0] * t, v[1] + w[1] * t, v[2] + (w[2] - g) * t];
    const vl = Math.hypot(...vel) || 1;
    out.positions.push(pos);
    out.sizes.push(Math.max(0.001, s.size * (1 + (seeds.size[i] - 1) * s.sizeRandom)));
    out.spins.push(seeds.spin[i] + age * 3);
    out.dirs.push([vel[0] / vl, vel[1] / vl, vel[2] / vl]);
    out.life.push(age / s.lifetime);
  }
  return out;
}
