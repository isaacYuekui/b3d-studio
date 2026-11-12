// Shader Editor (Blender's node materials), evaluated as textures: a node graph feeds the inputs of
// a Principled BSDF. Texture-like inputs (patterns, images, mixes, ramps) are worked out once per
// texel over one repeating tile and baked into the material's maps, so a node material renders,
// exports and animates like any other material. Pure: images come in through a sampler.

import { PATTERNS, patternValues } from './patterns';
import type { PatternType } from './patterns';

export const NODE_TYPES = ['principled', 'texture', 'image', 'rgb', 'value', 'mix', 'ramp', 'math', 'invert', 'bump'] as const;
export type NodeType = (typeof NODE_TYPES)[number];
export const MIX_MODES = ['mix', 'multiply', 'add', 'subtract', 'screen', 'overlay', 'darken', 'lighten'] as const;
export const MATH_OPS = ['add', 'subtract', 'multiply', 'divide', 'power', 'minimum', 'maximum', 'greater', 'less'] as const;

export type SocketKind = 'color' | 'value' | 'normal';

export interface ShaderNode {
  id: string;
  type: NodeType;
  /** Position in the editor (px). */
  x: number;
  y: number;
  /** Settings and unconnected input values. */
  props: Record<string, number | string>;
}

export interface ShaderLink {
  /** From node id + output socket. */
  from: string;
  out: string;
  /** To node id + input socket. */
  to: string;
  in: string;
}

export interface ShaderGraph {
  nodes: ShaderNode[];
  links: ShaderLink[];
}

interface SocketDef {
  id: string;
  label: string;
  kind: SocketKind;
}

interface PropDef {
  id: string;
  label: string;
  kind: 'color' | 'number' | 'select' | 'image';
  min?: number;
  max?: number;
  step?: number;
  options?: readonly string[];
  /** The input socket this value stands in for when nothing is connected. */
  socket?: string;
}

export interface NodeDef {
  type: NodeType;
  label: string;
  group: 'Output' | 'Texture' | 'Input' | 'Color' | 'Converter' | 'Vector';
  inputs: SocketDef[];
  outputs: SocketDef[];
  props: PropDef[];
  defaults: Record<string, number | string>;
}

export const NODE_DEFS: Record<NodeType, NodeDef> = {
  principled: {
    type: 'principled',
    label: 'Principled BSDF',
    group: 'Output',
    inputs: [
      { id: 'base', label: 'Base Color', kind: 'color' },
      { id: 'metallic', label: 'Metallic', kind: 'value' },
      { id: 'roughness', label: 'Roughness', kind: 'value' },
      { id: 'emission', label: 'Emission Color', kind: 'color' },
      { id: 'alpha', label: 'Alpha', kind: 'value' },
      { id: 'normal', label: 'Normal', kind: 'normal' },
    ],
    outputs: [],
    props: [
      { id: 'base', label: 'Base Color', kind: 'color', socket: 'base' },
      { id: 'metallic', label: 'Metallic', kind: 'number', min: 0, max: 1, step: 0.01, socket: 'metallic' },
      { id: 'roughness', label: 'Roughness', kind: 'number', min: 0, max: 1, step: 0.01, socket: 'roughness' },
      { id: 'emission', label: 'Emission Color', kind: 'color', socket: 'emission' },
      { id: 'strength', label: 'Emission Str.', kind: 'number', min: 0, max: 100, step: 0.1 },
      { id: 'alpha', label: 'Alpha', kind: 'number', min: 0, max: 1, step: 0.01, socket: 'alpha' },
      { id: 'repeat', label: 'Repeat', kind: 'number', min: 0.01, max: 100, step: 0.05 },
    ],
    defaults: { base: '#cccccc', metallic: 0, roughness: 0.5, emission: '#000000', strength: 1, alpha: 1, repeat: 1 },
  },
  texture: {
    type: 'texture',
    label: 'Pattern Texture',
    group: 'Texture',
    inputs: [],
    outputs: [
      { id: 'fac', label: 'Fac', kind: 'value' },
      { id: 'color', label: 'Color', kind: 'color' },
    ],
    props: [
      { id: 'pattern', label: 'Type', kind: 'select', options: PATTERNS },
      { id: 'scale', label: 'Scale', kind: 'number', min: 1, max: 32, step: 1 },
      { id: 'seed', label: 'Seed', kind: 'number', min: 1, max: 99, step: 1 },
    ],
    defaults: { pattern: 'noise', scale: 1, seed: 1 },
  },
  image: {
    type: 'image',
    label: 'Image Texture',
    group: 'Texture',
    inputs: [],
    outputs: [
      { id: 'color', label: 'Color', kind: 'color' },
      { id: 'alpha', label: 'Alpha', kind: 'value' },
    ],
    props: [
      { id: 'image', label: 'Image', kind: 'image' },
      { id: 'scale', label: 'Scale', kind: 'number', min: 1, max: 32, step: 1 },
    ],
    defaults: { image: '', scale: 1 },
  },
  rgb: { type: 'rgb', label: 'RGB', group: 'Input', inputs: [], outputs: [{ id: 'color', label: 'Color', kind: 'color' }], props: [{ id: 'color', label: 'Color', kind: 'color' }], defaults: { color: '#ff8040' } },
  value: { type: 'value', label: 'Value', group: 'Input', inputs: [], outputs: [{ id: 'value', label: 'Value', kind: 'value' }], props: [{ id: 'value', label: 'Value', kind: 'number', min: -100, max: 100, step: 0.01 }], defaults: { value: 0.5 } },
  mix: {
    type: 'mix',
    label: 'Mix Color',
    group: 'Color',
    inputs: [
      { id: 'fac', label: 'Factor', kind: 'value' },
      { id: 'a', label: 'A', kind: 'color' },
      { id: 'b', label: 'B', kind: 'color' },
    ],
    outputs: [{ id: 'color', label: 'Result', kind: 'color' }],
    props: [
      { id: 'mode', label: 'Blend', kind: 'select', options: MIX_MODES },
      { id: 'fac', label: 'Factor', kind: 'number', min: 0, max: 1, step: 0.01, socket: 'fac' },
      { id: 'a', label: 'A', kind: 'color', socket: 'a' },
      { id: 'b', label: 'B', kind: 'color', socket: 'b' },
    ],
    defaults: { mode: 'mix', fac: 0.5, a: '#808080', b: '#ffffff' },
  },
  ramp: {
    type: 'ramp',
    label: 'Color Ramp',
    group: 'Converter',
    inputs: [{ id: 'fac', label: 'Fac', kind: 'value' }],
    outputs: [
      { id: 'color', label: 'Color', kind: 'color' },
      { id: 'alpha', label: 'Alpha', kind: 'value' },
    ],
    props: [
      { id: 'fac', label: 'Fac', kind: 'number', min: 0, max: 1, step: 0.01, socket: 'fac' },
      { id: 'c0', label: 'Stop 1', kind: 'color' },
      { id: 'p0', label: 'Stop 1 at', kind: 'number', min: 0, max: 1, step: 0.01 },
      { id: 'c1', label: 'Stop 2', kind: 'color' },
      { id: 'p1', label: 'Stop 2 at', kind: 'number', min: 0, max: 1, step: 0.01 },
    ],
    defaults: { fac: 0.5, c0: '#000000', p0: 0, c1: '#ffffff', p1: 1 },
  },
  math: {
    type: 'math',
    label: 'Math',
    group: 'Converter',
    inputs: [
      { id: 'a', label: 'Value', kind: 'value' },
      { id: 'b', label: 'Value', kind: 'value' },
    ],
    outputs: [{ id: 'value', label: 'Value', kind: 'value' }],
    props: [
      { id: 'op', label: 'Operation', kind: 'select', options: MATH_OPS },
      { id: 'a', label: 'A', kind: 'number', min: -1000, max: 1000, step: 0.01, socket: 'a' },
      { id: 'b', label: 'B', kind: 'number', min: -1000, max: 1000, step: 0.01, socket: 'b' },
    ],
    defaults: { op: 'multiply', a: 0.5, b: 0.5 },
  },
  invert: {
    type: 'invert',
    label: 'Invert Color',
    group: 'Color',
    inputs: [{ id: 'color', label: 'Color', kind: 'color' }],
    outputs: [{ id: 'color', label: 'Color', kind: 'color' }],
    props: [{ id: 'color', label: 'Color', kind: 'color', socket: 'color' }],
    defaults: { color: '#000000' },
  },
  bump: {
    type: 'bump',
    label: 'Bump',
    group: 'Vector',
    inputs: [{ id: 'height', label: 'Height', kind: 'value' }],
    outputs: [{ id: 'normal', label: 'Normal', kind: 'normal' }],
    props: [{ id: 'strength', label: 'Strength', kind: 'number', min: 0, max: 1, step: 0.01 }],
    defaults: { strength: 0.5 },
  },
};

export const MAX_NODES = 40;

export class ShaderError extends Error {}

// ---------------------------------------------------------------- graph helpers

export const nodeDef = (t: NodeType) => NODE_DEFS[t];
export const propOf = (n: ShaderNode, k: string) => n.props[k] ?? NODE_DEFS[n.type].defaults[k];

/** Graph a "Use Nodes" material starts with: one Principled BSDF with the material's values. */
export function defaultGraph(m: { baseColor: string; metallic: number; roughness: number; emission: string; emissionStrength: number; alpha: number; texture: string | null; textureScale: number }): ShaderGraph {
  const out: ShaderNode = { id: 'out', type: 'principled', x: 480, y: 20, props: { base: m.baseColor, metallic: m.metallic, roughness: m.roughness, emission: m.emission, strength: m.emissionStrength || 1, alpha: m.alpha, repeat: m.textureScale || 1 } };
  if (!m.texture?.startsWith('img-')) return { nodes: [out], links: [] };
  return { nodes: [{ id: 'img', type: 'image', x: 40, y: 40, props: { image: m.texture, scale: 1 } }, out], links: [{ from: 'img', out: 'color', to: 'out', in: 'base' }] };
}

/** Would linking from → to make a loop? */
export function makesCycle(g: ShaderGraph, from: string, to: string): boolean {
  if (from === to) return true;
  const seen = new Set<string>();
  const stack = [from];
  while (stack.length) {
    const id = stack.pop()!;
    if (id === to) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const l of g.links) if (l.to === id) stack.push(l.from);
  }
  return false;
}

/** Connect an output to an input (an input takes one link: an old one is replaced). */
export function connect(g: ShaderGraph, l: ShaderLink): ShaderGraph {
  const a = g.nodes.find((n) => n.id === l.from), b = g.nodes.find((n) => n.id === l.to);
  if (!a || !b) throw new ShaderError('Those nodes are not there');
  if (!NODE_DEFS[a.type].outputs.some((s) => s.id === l.out) || !NODE_DEFS[b.type].inputs.some((s) => s.id === l.in)) throw new ShaderError('No such socket');
  const inKind = NODE_DEFS[b.type].inputs.find((s) => s.id === l.in)!.kind;
  const outKind = NODE_DEFS[a.type].outputs.find((s) => s.id === l.out)!.kind;
  if ((inKind === 'normal') !== (outKind === 'normal')) throw new ShaderError('Normal goes from a Bump node into Normal');
  if (makesCycle(g, l.from, l.to)) throw new ShaderError('That link would make a loop');
  return { ...g, links: [...g.links.filter((x) => !(x.to === l.to && x.in === l.in)), l] };
}

// ---------------------------------------------------------------- validation

const isColor = (v: unknown): v is string => typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v);

export function validateGraph(v: unknown, fail: (msg: string) => never): ShaderGraph {
  if (typeof v !== 'object' || v === null) fail('nodes must be {nodes, links}');
  const r = v as Record<string, unknown>;
  if (!Array.isArray(r.nodes) || !Array.isArray(r.links)) fail('nodes must be {nodes: [...], links: [...]}');
  if ((r.nodes as unknown[]).length > MAX_NODES) fail(`at most ${MAX_NODES} nodes`);
  const nodes: ShaderNode[] = [];
  for (const raw of r.nodes as unknown[]) {
    const n = raw as Record<string, unknown>;
    if (typeof n?.id !== 'string' || !/^[A-Za-z0-9_-]{1,40}$/.test(n.id) || nodes.some((x) => x.id === n.id)) fail('each node needs a unique id');
    if (!(NODE_TYPES as readonly unknown[]).includes(n.type)) fail(`node type must be one of ${NODE_TYPES.join(', ')}`);
    const def = NODE_DEFS[n.type as NodeType];
    const props: Record<string, number | string> = {};
    const p = (n.props ?? {}) as Record<string, unknown>;
    for (const pd of def.props) {
      const x = p[pd.id];
      if (x === undefined) continue;
      if (pd.kind === 'color') props[pd.id] = isColor(x) ? x : fail(`${def.label} ${pd.label} must be #rrggbb`);
      else if (pd.kind === 'number') props[pd.id] = typeof x === 'number' && Number.isFinite(x) && x >= (pd.min ?? -Infinity) && x <= (pd.max ?? Infinity) ? x : fail(`${def.label} ${pd.label} must be ${pd.min}..${pd.max}`);
      else if (pd.kind === 'select') props[pd.id] = (pd.options as readonly unknown[]).includes(x) ? (x as string) : fail(`${def.label} ${pd.label} must be one of ${pd.options!.join(', ')}`);
      else props[pd.id] = typeof x === 'string' && /^[A-Za-z0-9_.-]{0,80}$/.test(x) ? x : fail(`${def.label} image must be an image id`);
    }
    nodes.push({ id: n.id as string, type: n.type as NodeType, x: Number.isFinite(n.x) ? Math.round(n.x as number) : 0, y: Number.isFinite(n.y) ? Math.round(n.y as number) : 0, props });
  }
  if (nodes.filter((n) => n.type === 'principled').length !== 1) fail('a node material needs exactly one Principled BSDF');
  let g: ShaderGraph = { nodes, links: [] };
  for (const raw of r.links as unknown[]) {
    const l = raw as Record<string, unknown>;
    if (![l?.from, l?.out, l?.to, l?.in].every((x) => typeof x === 'string')) fail('links need from, out, to, in');
    try {
      g = connect(g, { from: l.from as string, out: l.out as string, to: l.to as string, in: l.in as string });
    } catch (e) {
      fail(`link ${String(l.from)}.${String(l.out)} → ${String(l.to)}.${String(l.in)}: ${e instanceof Error ? e.message : e}`);
    }
  }
  return g;
}

// ---------------------------------------------------------------- evaluation

/** Values over the tile: a number (constant) or one value per texel. */
type Field = number | Float32Array;
/** Colours: three fields (linear 0..1 per channel, in sRGB as picked). */
type CField = [Field, Field, Field];

export interface ImageSampler {
  /** RGBA bytes of a square-resampled image (size × size), or null when not available. */
  (id: string, size: number): Uint8ClampedArray | null;
}

export interface BakeResult {
  size: number;
  /** Baked colour (RGB 0..1), or a constant hex when nothing varies. */
  base: Float32Array | string;
  roughness: Float32Array | number;
  metallic: Float32Array | number;
  emission: Float32Array | string;
  strength: number;
  alpha: Float32Array | number;
  /** Bump: height field and strength, when the Normal input is connected. */
  height?: { field: Float32Array; strength: number };
  /** How often the tile repeats (per metre; per UV map with one). */
  repeat: number;
}

const hex = (c: string): [number, number, number] => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16) / 255) as [number, number, number];
const toHex = (c: [number, number, number]) => `#${c.map((x) => Math.round(Math.max(0, Math.min(1, x)) * 255).toString(16).padStart(2, '0')).join('')}`;

function map(fs: Field[], fn: (...xs: number[]) => number, n: number): Field {
  if (fs.every((f) => typeof f === 'number')) return fn(...(fs as number[]));
  const out = new Float32Array(n);
  const arrs = fs.map((f) => (typeof f === 'number' ? null : f));
  const xs = new Array<number>(fs.length);
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < fs.length; k++) xs[k] = arrs[k] ? arrs[k]![i] : (fs[k] as number);
    out[i] = fn(...xs);
  }
  return out;
}

const lum = (c: CField, n: number): Field => map(c, (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b, n);

function blend(mode: string, a: number, b: number): number {
  switch (mode) {
    case 'multiply': return a * b;
    case 'add': return Math.min(1, a + b);
    case 'subtract': return Math.max(0, a - b);
    case 'screen': return 1 - (1 - a) * (1 - b);
    case 'overlay': return a < 0.5 ? 2 * a * b : 1 - 2 * (1 - a) * (1 - b);
    case 'darken': return Math.min(a, b);
    case 'lighten': return Math.max(a, b);
    default: return b;
  }
}

function mathOp(op: string, a: number, b: number): number {
  switch (op) {
    case 'add': return a + b;
    case 'subtract': return a - b;
    case 'multiply': return a * b;
    case 'divide': return b === 0 ? 0 : a / b;
    case 'power': return a < 0 ? 0 : Math.pow(a, b);
    case 'minimum': return Math.min(a, b);
    case 'maximum': return Math.max(a, b);
    case 'greater': return a > b ? 1 : 0;
    case 'less': return a < b ? 1 : 0;
    default: return a;
  }
}

/** Bake the graph over a size × size tile. */
export function bakeGraph(g: ShaderGraph, size: number, images: ImageSampler): BakeResult {
  const n = size * size;
  const byId = new Map(g.nodes.map((x) => [x.id, x]));
  const memo = new Map<string, Field | CField>();
  const patCache = new Map<string, Float32Array>();
  const linkTo = (id: string, input: string) => g.links.find((l) => l.to === id && l.in === input);

  /** Repeat a tile `k` times across this tile (k whole). */
  const tiled = (src: Float32Array, srcSize: number, k: number) => {
    const out = new Float32Array(n);
    for (let j = 0; j < size; j++)
      for (let i = 0; i < size; i++) {
        const u = Math.floor(((i * k) / size) * srcSize) % srcSize;
        const v = Math.floor(((j * k) / size) * srcSize) % srcSize;
        out[j * size + i] = src[v * srcSize + u];
      }
    return out;
  };

  const output = (nodeId: string, socket: string, stack: Set<string>): Field | CField => {
    const key = `${nodeId}.${socket}`;
    const hit = memo.get(key);
    if (hit !== undefined) return hit;
    const node = byId.get(nodeId);
    if (!node || stack.has(nodeId)) return 0;
    stack.add(nodeId);
    const val = (input: string): Field => {
      const l = linkTo(nodeId, input);
      if (!l) return Number(propOf(node, input) ?? 0);
      const r = output(l.from, l.out, stack);
      return Array.isArray(r) ? lum(r, n) : r;
    };
    const col = (input: string): CField => {
      const l = linkTo(nodeId, input);
      if (!l) {
        const c = hex(String(propOf(node, input) ?? '#000000'));
        return [c[0], c[1], c[2]];
      }
      const r = output(l.from, l.out, stack);
      return Array.isArray(r) ? r : [r, r, r];
    };
    let res: Field | CField = 0;
    switch (node.type) {
      case 'texture': {
        const type = String(propOf(node, 'pattern')) as PatternType;
        const seed = Number(propOf(node, 'seed'));
        const k = Math.max(1, Math.round(Number(propOf(node, 'scale'))));
        const pk = `${type}|${seed}`;
        let src = patCache.get(pk);
        if (!src) patCache.set(pk, (src = patternValues(type, 256, seed)));
        const f = tiled(src, 256, k);
        res = socket === 'color' ? [f, f, f] : f;
        break;
      }
      case 'image': {
        const id = String(propOf(node, 'image'));
        const k = Math.max(1, Math.round(Number(propOf(node, 'scale'))));
        const px = id ? images(id, size) : null;
        if (!px) {
          res = socket === 'alpha' ? 1 : [1, 0, 1]; // missing image: magenta, like Blender
          break;
        }
        const ch = (c: number) => {
          const a = new Float32Array(n);
          for (let j = 0; j < size; j++)
            for (let i = 0; i < size; i++) {
              const u = ((i * k) % size), v = ((j * k) % size);
              // Image rows run top-down; the tile's v runs up.
              a[j * size + i] = px[((size - 1 - v) * size + u) * 4 + c] / 255;
            }
          return a;
        };
        res = socket === 'alpha' ? ch(3) : [ch(0), ch(1), ch(2)];
        break;
      }
      case 'rgb': {
        const c = hex(String(propOf(node, 'color')));
        res = [c[0], c[1], c[2]];
        break;
      }
      case 'value':
        res = Number(propOf(node, 'value'));
        break;
      case 'mix': {
        const f = val('fac'), a = col('a'), b = col('b');
        const mode = String(propOf(node, 'mode'));
        res = [0, 1, 2].map((c) => map([f, a[c], b[c]], (t, x, y) => x + (blend(mode, x, y) - x) * Math.max(0, Math.min(1, t)), n)) as CField;
        break;
      }
      case 'ramp': {
        const f = val('fac');
        const c0 = hex(String(propOf(node, 'c0'))), c1 = hex(String(propOf(node, 'c1')));
        const p0 = Number(propOf(node, 'p0')), p1 = Number(propOf(node, 'p1'));
        const t = map([f], (x) => Math.max(0, Math.min(1, (x - p0) / Math.max(1e-6, p1 - p0))), n);
        res = socket === 'alpha' ? t : ([0, 1, 2].map((c) => map([t], (x) => c0[c] + (c1[c] - c0[c]) * x, n)) as CField);
        break;
      }
      case 'math': {
        const op = String(propOf(node, 'op'));
        res = map([val('a'), val('b')], (a, b) => mathOp(op, a, b), n);
        break;
      }
      case 'invert': {
        const c = col('color');
        res = c.map((f) => map([f], (x) => 1 - x, n)) as CField;
        break;
      }
      case 'bump':
        res = val('height');
        break;
      default:
        res = 0;
    }
    stack.delete(nodeId);
    memo.set(key, res);
    return res;
  };

  const out = g.nodes.find((x) => x.type === 'principled');
  if (!out) throw new ShaderError('No Principled BSDF');
  const stack = new Set<string>();
  const valueIn = (input: string): Field => {
    const l = linkTo(out.id, input);
    if (!l) return Number(propOf(out, input));
    const r = output(l.from, l.out, stack);
    return Array.isArray(r) ? lum(r, n) : r;
  };
  const colorIn = (input: string): Float32Array | string => {
    const l = linkTo(out.id, input);
    if (!l) return String(propOf(out, input));
    const r = output(l.from, l.out, stack);
    const c: CField = Array.isArray(r) ? r : [r, r, r];
    if (c.every((x) => typeof x === 'number')) return toHex(c as [number, number, number]);
    const a = new Float32Array(n * 3);
    for (let k = 0; k < 3; k++) {
      const f = c[k];
      for (let i = 0; i < n; i++) a[i * 3 + k] = typeof f === 'number' ? f : f[i];
    }
    return a;
  };
  const scalar = (f: Field): Float32Array | number => f;
  const bumpLink = linkTo(out.id, 'normal');
  let height: BakeResult['height'];
  if (bumpLink) {
    const bn = byId.get(bumpLink.from)!;
    const h = output(bn.id, 'normal', stack);
    const f = Array.isArray(h) ? lum(h, n) : h;
    if (typeof f !== 'number') height = { field: f, strength: Number(propOf(bn, 'strength')) };
  }
  return {
    size,
    base: colorIn('base'),
    roughness: scalar(valueIn('roughness')),
    metallic: scalar(valueIn('metallic')),
    emission: colorIn('emission'),
    strength: Number(propOf(out, 'strength')),
    alpha: scalar(valueIn('alpha')),
    height,
    repeat: Number(propOf(out, 'repeat')),
  };
}
