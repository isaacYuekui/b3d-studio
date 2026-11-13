// Drivers (Blender's Drivers): a property computed every frame from a maths expression of other
// objects' values — a wheel that turns as the car moves, a door that opens as a hand gets near,
// a mouth shape key driven by a jaw bone's rotation. Expressions use core/expr.ts (safe maths,
// never eval).

import { exprProblem, runExpr } from './expr';
import type { Transform } from './types';

export const CHANNELS = ['location.x', 'location.y', 'location.z', 'rotation.x', 'rotation.y', 'rotation.z', 'scale.x', 'scale.y', 'scale.z'] as const;
export type Channel = (typeof CHANNELS)[number];
export const MAX_DRIVERS = 16;
export const MAX_DRIVER_VARS = 8;

export const CHANNEL_LABELS: Record<Channel, string> = {
  'location.x': 'X Location',
  'location.y': 'Y Location',
  'location.z': 'Z Location',
  'rotation.x': 'X Rotation (°)',
  'rotation.y': 'Y Rotation (°)',
  'rotation.z': 'Z Rotation (°)',
  'scale.x': 'X Scale',
  'scale.y': 'Y Scale',
  'scale.z': 'Z Scale',
};

export interface DriverVar {
  /** Name used in the expression (letters, digits, _). */
  name: string;
  /** The object it reads. */
  object: string;
  channel: Channel;
}

export interface Driver {
  /** What it drives: a transform channel, or `shape:<key name>` for a shape key's value. */
  property: string;
  expression: string;
  vars: DriverVar[];
  mute?: boolean;
}

const KEY = { location: 'position', rotation: 'rotation', scale: 'scale' } as const;
const AX = { x: 0, y: 1, z: 2 } as const;

export function channelOf(t: Transform, c: Channel): number {
  const [k, a] = c.split('.') as [keyof typeof KEY, keyof typeof AX];
  return t[KEY[k]][AX[a]];
}

export function isChannel(p: string): p is Channel {
  return (CHANNELS as readonly string[]).includes(p);
}

export const isVarName = (s: unknown): s is string => typeof s === 'string' && /^[A-Za-z_][A-Za-z0-9_]{0,31}$/.test(s) && !['frame', 'time', 'pi', 'e', 'tau'].includes(s);

/** The value a driver gives now, or null (muted, bad expression, missing variable). */
export function driverValue(d: Driver, frame: number, fps: number, read: (object: string, c: Channel) => number | null): number | null {
  if (d.mute) return null;
  const vars: Record<string, number> = { frame, time: frame / (fps || 24) };
  for (const v of d.vars) {
    const x = read(v.object, v.channel);
    if (x === null) return null;
    vars[v.name] = x;
  }
  return runExpr(d.expression, vars);
}

/** Apply transform drivers to a transform. */
export function driveTransform(t: Transform, drivers: Driver[] | undefined, frame: number, fps: number, read: (object: string, c: Channel) => number | null): Transform {
  if (!drivers?.some((d) => isChannel(d.property))) return t;
  const out: Transform = { position: [...t.position], rotation: [...t.rotation], scale: [...t.scale] };
  for (const d of drivers) {
    if (!isChannel(d.property)) continue;
    const v = driverValue(d, frame, fps, read);
    if (v === null) continue;
    const [k, a] = d.property.split('.') as [keyof typeof KEY, keyof typeof AX];
    out[KEY[k]][AX[a]] = Math.round(v * 1e5) / 1e5;
  }
  return out;
}

/** A readable problem with a driver, or null. */
export function driverProblem(d: Driver): string | null {
  if (!isChannel(d.property) && !(d.property.startsWith('shape:') && d.property.length > 6)) return 'Drive a location, rotation or scale channel, or a shape key';
  const names = d.vars.map((v) => v.name);
  if (new Set(names).size !== names.length) return 'Variable names must be different';
  return exprProblem(d.expression, names);
}
