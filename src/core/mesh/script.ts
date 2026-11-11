// Scripted modelling: `editMesh` runs a list of edit-mode steps on one mesh object.
// Each step picks elements with a query (by normal, box, sharpness, nearest point…) and
// applies an operator, so a script can model the way a person does in Edit Mode.

import type { MeshData, Vec3 } from '../types';
import type { MeshSelection, SelectMode } from './select';
import { EMPTY_SEL, edgeLoop, flush, selectAll, selectLinked } from './select';
import type { OpResult } from './ops';
import { MeshOpError, bevel, deleteSelected, duplicateFaces, extrude, fill, flipNormals, inset, loopCut, mergeAtCenter, mergeByDistance, recalcNormals, subdivide, transformVerts } from './ops';
import { bridgeLoops, connectVerts, dissolve, pokeFaces, shrinkFatten, smoothVerts, toSphere, triangulateFaces, trisToQuads } from './ops2';
import type { V } from './topology';
import { add, centroid, dist, dot, edgeMap, ekParse, faceNormal, lerp, norm, scale, sub } from './topology';

export interface SelectQuery {
  mode?: SelectMode;
  /** Keep the selection the previous step produced (e.g. extrude, then extrude again). */
  last?: boolean;
  all?: boolean;
  /** Faces whose normal is within `angle`° of this direction (edges/verts: of those faces). */
  normal?: Vec3;
  angle?: number;
  /** Elements whose vertices all lie inside the box (local coordinates). */
  box?: { min: Vec3; max: Vec3 };
  /** Edges whose faces meet at more than this many degrees (edge mode). */
  sharp?: number;
  /** The single element nearest this point (face centre, edge middle, vertex). */
  nearest?: Vec3;
  /** Extend to the edge loop through each selected edge. */
  loop?: boolean;
  /** Grow to whole connected pieces. */
  linked?: boolean;
  /** Raw indices (faces / vertices) or edge keys "a_b". */
  indices?: (number | string)[];
}

export type EditStep = { op: string; select?: SelectQuery } & Record<string, unknown>;

export const EDIT_OPS = ['select', 'extrude', 'inset', 'bevel', 'loopcut', 'subdivide', 'delete', 'merge', 'mergeDistance', 'fill', 'flip', 'recalc', 'duplicate', 'move', 'scale', 'rotate', 'smooth', 'dissolve', 'connect', 'bridge', 'smoothVerts', 'shrinkFatten', 'toSphere', 'triangulate', 'trisToQuads', 'poke'] as const;

const DEFAULT_MODE: Record<string, SelectMode> = { extrude: 'face', inset: 'face', subdivide: 'face', duplicate: 'face', fill: 'vert', merge: 'vert', bevel: 'edge', loopcut: 'edge' };

export function runQuery(mesh: MeshData, q: SelectQuery, mode: SelectMode, prev: MeshSelection): MeshSelection {
  if (q.last) return flush(mesh, mode, prev.verts.length || prev.faces.length || prev.edges.length ? convert(mesh, prev, mode) : EMPTY_SEL);
  const vs = mesh.vertices;
  const em = edgeMap(mesh);
  const inBox = (p: V) => !q.box || p.every((x, i) => x >= q.box!.min[i] - 1e-9 && x <= q.box!.max[i] + 1e-9);
  const cosA = Math.cos(((q.angle ?? 30) * Math.PI) / 180);
  const n = q.normal ? norm(q.normal) : null;
  const faceOk = (f: number) => {
    const face = mesh.faces[f];
    if (n && dot(faceNormal(vs, face), n) < cosA) return false;
    if (q.box && !face.every((v) => inBox(vs[v]))) return false;
    if (q.indices && mode === 'face' && !q.indices.includes(f)) return false;
    return true;
  };
  let sel: MeshSelection;
  if (q.all) sel = selectAll(mesh, mode);
  else if (q.nearest) {
    const p = q.nearest;
    if (mode === 'face') {
      let best = -1, bd = Infinity;
      mesh.faces.forEach((f, i) => {
        const d = dist(centroid(vs, f), p);
        if (d < bd) (bd = d), (best = i);
      });
      sel = flush(mesh, 'face', { ...EMPTY_SEL, faces: best >= 0 ? [best] : [] });
    } else if (mode === 'edge') {
      let best = '', bd = Infinity;
      for (const k of em.keys()) {
        const [a, b] = ekParse(k);
        const d = dist(lerp(vs[a], vs[b], 0.5), p);
        if (d < bd) (bd = d), (best = k);
      }
      sel = flush(mesh, 'edge', { ...EMPTY_SEL, edges: best ? [best] : [] });
    } else {
      let best = -1, bd = Infinity;
      vs.forEach((v, i) => {
        const d = dist(v, p);
        if (d < bd) (bd = d), (best = i);
      });
      sel = flush(mesh, 'vert', { ...EMPTY_SEL, verts: best >= 0 ? [best] : [] });
    }
  } else if (mode === 'face' || n) {
    const faces = mesh.faces.map((_, i) => i).filter(faceOk);
    const fsel = flush(mesh, 'face', { ...EMPTY_SEL, faces });
    sel = mode === 'face' ? fsel : mode === 'edge' ? flush(mesh, 'edge', { ...EMPTY_SEL, edges: fsel.edges.filter((k) => edgeOk(k)) }) : flush(mesh, 'vert', { ...EMPTY_SEL, verts: fsel.verts });
  } else if (mode === 'edge') {
    sel = flush(mesh, 'edge', { ...EMPTY_SEL, edges: [...em.keys()].filter(edgeOk) });
  } else {
    const verts = vs.map((_, i) => i).filter((i) => inBox(vs[i]) && (!q.indices || q.indices.includes(i)));
    sel = flush(mesh, 'vert', { ...EMPTY_SEL, verts });
  }
  if (q.loop && sel.edges.length) {
    const edges = new Set<string>();
    sel.edges.forEach((e) => edgeLoop(mesh, e).forEach((x) => edges.add(x)));
    sel = flush(mesh, mode === 'face' ? 'edge' : mode, mode === 'vert' ? { ...EMPTY_SEL, verts: [...edges].flatMap(ekParse) } : { ...EMPTY_SEL, edges: [...edges] });
  }
  if (q.linked) sel = selectLinked(mesh, mode, sel);
  return sel;

  function edgeOk(k: string): boolean {
    const [a, b] = ekParse(k);
    if (q.box && !(inBox(vs[a]) && inBox(vs[b]))) return false;
    if (q.indices && !q.indices.includes(k)) return false;
    if (q.sharp !== undefined) {
      const fs = em.get(k)!.faces;
      if (fs.length !== 2) return false;
      const c = dot(faceNormal(vs, mesh.faces[fs[0]]), faceNormal(vs, mesh.faces[fs[1]]));
      if (c > Math.cos((q.sharp * Math.PI) / 180)) return false;
    }
    return true;
  }
}

function convert(mesh: MeshData, sel: MeshSelection, mode: SelectMode): MeshSelection {
  // A full (flushed) selection converts by re-flushing in the target mode.
  return flush(mesh, mode, sel);
}

/** Smooth falloff weight for proportional editing (1 at the selection, 0 at `radius`). */
const falloff = (d: number, r: number) => {
  const t = Math.max(0, 1 - d / r);
  return t * t * (3 - 2 * t);
};

/**
 * Transform the selected vertices; with `radius`, nearby vertices follow with a smooth
 * falloff (Blender's proportional editing).
 */
export function softTransform(mesh: MeshData, verts: number[], fn: (p: V) => V, radius = 0): MeshData {
  if (!radius) return transformVerts(mesh, verts, fn);
  const s = new Set(verts);
  const sel = verts.map((v) => mesh.vertices[v]);
  const all = mesh.vertices.map((_, i) => i);
  return transformVerts(mesh, all, (p, i) => {
    if (s.has(i)) return fn(p);
    let d = Infinity;
    for (const q of sel) d = Math.min(d, dist(p, q));
    const w = falloff(d, radius);
    return w > 0 ? lerp(p, fn(p), w) : p;
  });
}

/** Rotation matrix from Euler XYZ degrees (Blender convention). */
function rotFn(deg: Vec3): (p: V) => V {
  const [x, y, z] = deg.map((d) => (d * Math.PI) / 180);
  const cx = Math.cos(x), sx = Math.sin(x), cy = Math.cos(y), sy = Math.sin(y), cz = Math.cos(z), sz = Math.sin(z);
  return ([a, b, c]) => {
    // X
    let p: V = [a, b * cx - c * sx, b * sx + c * cx];
    // Y
    p = [p[0] * cy + p[2] * sy, p[1], -p[0] * sy + p[2] * cy];
    // Z
    return [p[0] * cz - p[1] * sz, p[0] * sz + p[1] * cz, p[2]];
  };
}

const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const vec = (v: unknown): Vec3 | null => (Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === 'number' && Number.isFinite(x)) ? (v as Vec3) : null);

/** Run a list of steps. Throws MeshOpError naming the failing step. */
export function runEditSteps(mesh0: MeshData, steps: EditStep[]): MeshData {
  let mesh = mesh0;
  let sel: MeshSelection = EMPTY_SEL;
  let mode: SelectMode = 'face';
  steps.forEach((step, i) => {
    try {
      const op = step.op;
      const want: SelectMode = step.select?.mode ?? DEFAULT_MODE[op] ?? (step.select?.last ? mode : 'vert');
      if (step.select) {
        sel = runQuery(mesh, step.select, want, sel);
        mode = want;
      } else if (mode !== want && DEFAULT_MODE[op]) {
        sel = flush(mesh, want, sel);
        mode = want;
      }
      const res = apply(mesh, op, step, sel, mode);
      mesh = res.mesh;
      sel = res.sel;
      mode = res.mode;
    } catch (e) {
      throw new MeshOpError(`step ${i + 1} (${step.op}): ${e instanceof Error ? e.message : String(e)}`);
    }
  });
  return mesh;
}

function apply(mesh: MeshData, op: string, p: Record<string, unknown>, sel: MeshSelection, mode: SelectMode): OpResult {
  const need = (what: string) => {
    if (!sel.verts.length) throw new MeshOpError(`selection is empty (check the select query) — ${what}`);
  };
  switch (op) {
    case 'select':
      return { mesh, sel, mode };
    case 'extrude':
      need('extrude');
      return extrude(mesh, sel, num(p.offset, 0.5));
    case 'inset':
      need('inset');
      return inset(mesh, sel, num(p.thickness, 0.1), num(p.depth, 0), p.individual === true);
    case 'bevel':
      need('bevel');
      return bevel(mesh, sel, num(p.width, 0.05), num(p.segments, 1));
    case 'loopcut':
      need('loopcut');
      return loopCut(mesh, sel.edges[0], num(p.cuts, 1), num(p.factor, 0));
    case 'subdivide':
      need('subdivide');
      return subdivide(mesh, sel);
    case 'delete':
      need('delete');
      return deleteSelected(mesh, mode, sel);
    case 'merge':
      return mergeAtCenter(mesh, sel);
    case 'mergeDistance':
      return mergeByDistance(mesh, sel, num(p.distance, 0.0001));
    case 'fill':
      return fill(mesh, sel);
    case 'flip':
      return flipNormals(mesh, sel, mode);
    case 'recalc':
      return recalcNormals(mesh, sel, mode);
    case 'duplicate':
      need('duplicate');
      return duplicateFaces(mesh, sel);
    case 'move':
    case 'scale':
    case 'rotate': {
      need(op);
      const pivot = vec(p.about) ?? centroid(mesh.vertices, sel.verts);
      let fn: (q: V) => V;
      if (op === 'move') {
        const by = vec(p.by);
        // `along: normal` moves along the selection's average normal by `distance`.
        if (p.along === 'normal') {
          let nn: V = [0, 0, 0];
          for (const f of sel.faces) nn = add(nn, faceNormal(mesh.vertices, mesh.faces[f]));
          const d = scale(norm(nn), num(p.distance, 0.1));
          fn = (q) => add(q, d);
        } else {
          if (!by) throw new MeshOpError('move needs "by": [x, y, z]');
          fn = (q) => add(q, by);
        }
      } else if (op === 'scale') {
        const by = vec(p.by) ?? ([num(p.by, 1), num(p.by, 1), num(p.by, 1)] as Vec3);
        fn = (q) => add(pivot, sub(q, pivot).map((x, k) => x * by[k]) as V);
      } else {
        const deg = vec(p.by);
        if (!deg) throw new MeshOpError('rotate needs "by": [x°, y°, z°]');
        const r = rotFn(deg);
        fn = (q) => add(pivot, r(sub(q, pivot)));
      }
      return { mesh: softTransform(mesh, sel.verts, fn, num(p.radius, 0)), sel, mode };
    }
    case 'smooth':
      return { mesh: { ...mesh, smooth: p.smooth !== false }, sel, mode };
    case 'dissolve':
      need('dissolve');
      return dissolve(mesh, mode, sel);
    case 'connect':
      return connectVerts(mesh, sel);
    case 'bridge':
      need('bridge');
      return bridgeLoops(mesh, sel, mode);
    case 'smoothVerts':
      need('smoothVerts');
      return smoothVerts(mesh, sel, mode, num(p.factor, 0.5), num(p.repeat, 1));
    case 'shrinkFatten':
      need('shrinkFatten');
      return shrinkFatten(mesh, sel, mode, num(p.offset, 0.05));
    case 'toSphere':
      need('toSphere');
      return toSphere(mesh, sel, mode, num(p.factor, 1));
    case 'triangulate':
      return triangulateFaces(mesh, sel);
    case 'trisToQuads':
      return trisToQuads(mesh, sel, num(p.angle, 40));
    case 'poke':
      return pokeFaces(mesh, sel, num(p.offset, 0));
    default:
      throw new MeshOpError(`unknown op "${op}" (use one of ${EDIT_OPS.join(', ')})`);
  }
}
