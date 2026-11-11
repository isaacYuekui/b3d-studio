// Edit mode controller: entering/leaving edit mode, selection commands and mesh
// operators with an "Adjust Last Operation" panel (re-run with new parameters).

import type { Store } from '../core/store';
import type { MeshData, SceneObject } from '../core/types';
import { PRIMITIVES } from '../core/types';
import type { MeshSelection, SelectMode } from '../core/mesh/select';
import { EMPTY_SEL, convertMode, flush, invert, selectAll, selectLinked, selectLoop } from '../core/mesh/select';
import type { OpResult } from '../core/mesh/ops';
import { MeshOpError, bevel, deleteSelected, duplicateFaces, extrude, fill, flipNormals, inset, loopCut, mergeAtCenter, mergeByDistance, recalcNormals, selectionScale, subdivide } from '../core/mesh/ops';
import { bridgeLoops, connectVerts, dissolve, pokeFaces, shrinkFatten, smoothVerts, toSphere, triangulateFaces, trisToQuads } from '../core/mesh/ops2';

export const canEdit = (o?: SceneObject | null) => !!o && (o.type === 'mesh' || (PRIMITIVES as readonly string[]).includes(o.type));

export function enterEdit(store: Store): boolean {
  const st = store.getState();
  const o = st.selection ? st.doc.objects[st.selection] : null;
  if (!o) {
    store.notify('Select an object to edit');
    return false;
  }
  if (!canEdit(o)) {
    store.notify(`${o.name} can't be edited as a mesh (only shapes and meshes can)`);
    return false;
  }
  if (o.type !== 'mesh') store.dispatch({ type: 'convertToMesh', id: o.id }, { select: false });
  const mesh = store.getState().doc.objects[o.id]?.mesh;
  if (!mesh) return false;
  store.setEdit({ id: o.id, mode: 'vert', sel: selectAll(mesh, 'vert') });
  return true;
}

export function exitEdit(store: Store) {
  store.commitPreview();
  store.setEdit(null);
  clearLastOp();
}

export function toggleEdit(store: Store) {
  const st = store.getState();
  if (st.pose) return store.setPose(null);
  if (st.edit) return exitEdit(store);
  const o = st.selection ? st.doc.objects[st.selection] : null;
  if (o?.type === 'armature') return togglePose(store);
  enterEdit(store);
}

/** Pose Mode (Ctrl+Tab): select and rotate bones of the selected armature (or a skinned mesh's armature). */
export function togglePose(store: Store) {
  const st = store.getState();
  if (st.pose) return store.setPose(null);
  const o = st.selection ? st.doc.objects[st.selection] : null;
  const armId = o?.type === 'armature' ? o.id : o?.skin?.armature;
  const arm = armId ? st.doc.objects[armId] : null;
  if (!arm?.armature) {
    store.notify('Select an armature (or a character mesh) for Pose Mode');
    return;
  }
  if (st.edit) exitEdit(store);
  store.setPose({ id: arm.id, bone: arm.armature.bones[0]?.name ?? null });
  store.setTool('rotate');
}

/** The edited object's mesh and edit state, or null outside edit mode. */
export function editTarget(store: Store) {
  const st = store.getState();
  const e = st.edit;
  if (!e) return null;
  const o = st.doc.objects[e.id];
  if (!o?.mesh) return null;
  return { edit: e, obj: o, mesh: o.mesh };
}

export function setSelectMode(store: Store, mode: SelectMode) {
  const t = editTarget(store);
  if (!t) return;
  store.setEdit({ ...t.edit, mode, sel: convertMode(t.mesh, t.edit.mode, mode, t.edit.sel) });
}

export type SelectCmd = 'all' | 'none' | 'invert' | 'linked' | 'loop';

export function selectCmd(store: Store, cmd: SelectCmd) {
  const t = editTarget(store);
  if (!t) return;
  const { mesh, edit } = t;
  let sel: MeshSelection;
  switch (cmd) {
    case 'all':
      sel = selectAll(mesh, edit.mode);
      break;
    case 'none':
      sel = flush(mesh, edit.mode, EMPTY_SEL);
      break;
    case 'invert':
      sel = invert(mesh, edit.mode, edit.sel);
      break;
    case 'linked':
      sel = selectLinked(mesh, edit.mode, edit.sel);
      break;
    case 'loop':
      if (!edit.sel.edges.length) {
        store.notify('Select an edge first, then Select Loop');
        return;
      }
      sel = selectLoop(mesh, edit.mode === 'face' ? 'edge' : edit.mode, edit.sel);
      if (edit.mode === 'face') {
        store.setEdit({ ...edit, mode: 'edge', sel });
        return;
      }
      break;
  }
  store.setEdit({ ...edit, sel });
}

// ---------------------------------------------------------------- operators

export type ParamValue = number | boolean;
export interface ParamSpec {
  key: string;
  label: string;
  kind: 'number' | 'int' | 'bool';
  min?: number;
  max?: number;
  step?: number;
  suffix?: string;
}

export interface MeshOp {
  id: string;
  label: string;
  params: ParamSpec[];
  defaults: (mesh: MeshData, sel: MeshSelection, mode: SelectMode) => Record<string, ParamValue>;
  run: (mesh: MeshData, sel: MeshSelection, mode: SelectMode, p: Record<string, ParamValue>) => OpResult;
  /** Switch to the Move tool afterwards (extrude, duplicate), like Blender's auto-grab. */
  grab?: boolean;
}

const num = (p: Record<string, ParamValue>, k: string) => Number(p[k]);
const round = (x: number) => Math.round(x * 1000) / 1000;

export const MESH_OPS: Record<string, MeshOp> = {
  extrude: {
    id: 'extrude',
    label: 'Extrude',
    params: [{ key: 'offset', label: 'Offset', kind: 'number', step: 0.05, suffix: ' m' }],
    defaults: (m, s) => ({ offset: round(Math.max(0.05, selectionScale(m, s) * 0.5)) }),
    run: (m, s, _mode, p) => extrude(m, s, num(p, 'offset')),
    grab: true,
  },
  inset: {
    id: 'inset',
    label: 'Inset Faces',
    params: [
      { key: 'thickness', label: 'Thickness', kind: 'number', min: 0, step: 0.01, suffix: ' m' },
      { key: 'depth', label: 'Depth', kind: 'number', step: 0.01, suffix: ' m' },
      { key: 'individual', label: 'Individual', kind: 'bool' },
    ],
    defaults: (m, s) => ({ thickness: round(Math.max(0.02, selectionScale(m, s) * 0.15)), depth: 0, individual: false }),
    run: (m, s, _mode, p) => inset(m, s, num(p, 'thickness'), num(p, 'depth'), !!p.individual),
  },
  bevel: {
    id: 'bevel',
    label: 'Bevel',
    params: [
      { key: 'width', label: 'Width', kind: 'number', min: 0, step: 0.01, suffix: ' m' },
      { key: 'segments', label: 'Segments', kind: 'int', min: 1, max: 16, step: 1 },
    ],
    defaults: (m, s) => ({ width: round(Math.max(0.01, selectionScale(m, s) * 0.1)), segments: 1 }),
    run: (m, s, _mode, p) => bevel(m, s, num(p, 'width'), num(p, 'segments')),
  },
  loopcut: {
    id: 'loopcut',
    label: 'Loop Cut',
    params: [
      { key: 'cuts', label: 'Number of Cuts', kind: 'int', min: 1, max: 32, step: 1 },
      { key: 'factor', label: 'Slide', kind: 'number', min: -1, max: 1, step: 0.05 },
    ],
    defaults: () => ({ cuts: 1, factor: 0 }),
    run: (m, s, _mode, p) => {
      if (!s.edges.length) throw new MeshOpError('Select an edge (Edge mode, 2), then Loop Cut');
      return loopCut(m, s.edges[0], num(p, 'cuts'), num(p, 'factor'));
    },
  },
  subdivide: {
    id: 'subdivide',
    label: 'Subdivide',
    params: [],
    defaults: () => ({}),
    run: (m, s) => subdivide(m, s),
  },
  delete: {
    id: 'delete',
    label: 'Delete',
    params: [],
    defaults: () => ({}),
    run: (m, s, mode) => {
      if (!s.verts.length) throw new MeshOpError('Nothing selected to delete');
      return deleteSelected(m, mode, s);
    },
  },
  merge: {
    id: 'merge',
    label: 'Merge at Center',
    params: [],
    defaults: () => ({}),
    run: (m, s) => mergeAtCenter(m, s),
  },
  mergeDistance: {
    id: 'mergeDistance',
    label: 'Merge by Distance',
    params: [{ key: 'distance', label: 'Distance', kind: 'number', min: 0, step: 0.001, suffix: ' m' }],
    defaults: () => ({ distance: 0.0001 }),
    run: (m, s, _mode, p) => mergeByDistance(m, s, num(p, 'distance')),
  },
  fill: {
    id: 'fill',
    label: 'Fill (Make Face)',
    params: [],
    defaults: () => ({}),
    run: (m, s) => fill(m, s),
  },
  duplicate: {
    id: 'duplicate',
    label: 'Duplicate',
    params: [],
    defaults: () => ({}),
    run: (m, s) => duplicateFaces(m, s),
    grab: true,
  },
  flip: {
    id: 'flip',
    label: 'Flip Normals',
    params: [],
    defaults: () => ({}),
    run: (m, s, mode) => flipNormals(m, s, mode),
  },
  recalc: {
    id: 'recalc',
    label: 'Recalculate Normals',
    params: [],
    defaults: () => ({}),
    run: (m, s, mode) => recalcNormals(m, s, mode),
  },
  dissolve: {
    id: 'dissolve',
    label: 'Dissolve',
    params: [],
    defaults: () => ({}),
    run: (m, s, mode) => dissolve(m, mode, s),
  },
  connect: {
    id: 'connect',
    label: 'Connect Vertex Path',
    params: [],
    defaults: () => ({}),
    run: (m, s) => connectVerts(m, s),
  },
  bridge: {
    id: 'bridge',
    label: 'Bridge Edge Loops',
    params: [],
    defaults: () => ({}),
    run: (m, s, mode) => bridgeLoops(m, s, mode),
  },
  smoothVerts: {
    id: 'smoothVerts',
    label: 'Smooth Vertices',
    params: [
      { key: 'factor', label: 'Smoothing', kind: 'number', min: 0, max: 1, step: 0.05 },
      { key: 'repeat', label: 'Repeat', kind: 'int', min: 1, max: 100, step: 1 },
    ],
    defaults: () => ({ factor: 0.5, repeat: 1 }),
    run: (m, s, mode, p) => smoothVerts(m, s, mode, num(p, 'factor'), num(p, 'repeat')),
  },
  shrinkFatten: {
    id: 'shrinkFatten',
    label: 'Shrink/Fatten',
    params: [{ key: 'offset', label: 'Offset', kind: 'number', step: 0.01, suffix: ' m' }],
    defaults: (m, s) => ({ offset: round(Math.max(0.01, selectionScale(m, s) * 0.1)) }),
    run: (m, s, mode, p) => shrinkFatten(m, s, mode, num(p, 'offset')),
  },
  toSphere: {
    id: 'toSphere',
    label: 'To Sphere',
    params: [{ key: 'factor', label: 'Factor', kind: 'number', min: 0, max: 1, step: 0.05 }],
    defaults: () => ({ factor: 1 }),
    run: (m, s, mode, p) => toSphere(m, s, mode, num(p, 'factor')),
  },
  triangulate: {
    id: 'triangulate',
    label: 'Triangulate Faces',
    params: [],
    defaults: () => ({}),
    run: (m, s) => triangulateFaces(m, s),
  },
  trisToQuads: {
    id: 'trisToQuads',
    label: 'Tris to Quads',
    params: [{ key: 'angle', label: 'Max Angle', kind: 'number', min: 0, max: 180, step: 5, suffix: '°' }],
    defaults: () => ({ angle: 40 }),
    run: (m, s, _mode, p) => trisToQuads(m, s, num(p, 'angle')),
  },
  poke: {
    id: 'poke',
    label: 'Poke Faces',
    params: [{ key: 'offset', label: 'Offset', kind: 'number', step: 0.01, suffix: ' m' }],
    defaults: () => ({ offset: 0 }),
    run: (m, s, _mode, p) => pokeFaces(m, s, num(p, 'offset')),
  },
};

export type MeshOpId = keyof typeof MESH_OPS;

export interface LastOp {
  op: MeshOp;
  params: Record<string, ParamValue>;
  base: { mesh: MeshData; sel: MeshSelection; mode: SelectMode };
  objId: string;
  /** The doc the op produced: the panel only stays while nothing else has changed. */
  doc: unknown;
}

let lastOp: LastOp | null = null;
const listeners = new Set<() => void>();
export const getLastOp = () => lastOp;
export const subscribeLastOp = (fn: () => void) => (listeners.add(fn), () => listeners.delete(fn));
function setLastOp(v: LastOp | null) {
  lastOp = v;
  listeners.forEach((l) => l());
}
export const clearLastOp = () => lastOp && setLastOp(null);

export function runMeshOp(store: Store, id: MeshOpId, params?: Record<string, ParamValue>): boolean {
  const t = editTarget(store);
  if (!t) {
    store.notify('Mesh tools work in Edit Mode (Tab)');
    return false;
  }
  const op = MESH_OPS[id];
  const p = { ...op.defaults(t.mesh, t.edit.sel, t.edit.mode), ...params };
  let res: OpResult;
  try {
    res = op.run(t.mesh, t.edit.sel, t.edit.mode, p);
  } catch (e) {
    store.notify(e instanceof MeshOpError ? e.message : `${op.label} failed: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
  store.dispatch({ type: 'setMesh', id: t.obj.id, mesh: res.mesh }, { select: false });
  store.setEdit({ id: t.obj.id, mode: res.mode, sel: res.sel });
  if (op.grab && store.getState().tool === 'select') store.setTool('move');
  setLastOp({ op, params: p, base: { mesh: t.mesh, sel: t.edit.sel, mode: t.edit.mode }, objId: t.obj.id, doc: store.getState().doc });
  return true;
}

/** Re-run the last operator from its starting point with changed parameters (one undo step). */
export function adjustLastOp(store: Store, patch: Record<string, ParamValue>) {
  const lo = lastOp;
  if (!lo || store.getState().doc !== lo.doc) return clearLastOp();
  const params = { ...lo.params, ...patch };
  let res: OpResult;
  try {
    res = lo.op.run(lo.base.mesh, lo.base.sel, lo.base.mode, params);
  } catch (e) {
    store.notify(e instanceof Error ? e.message : String(e));
    return;
  }
  store.amend({ type: 'setMesh', id: lo.objId, mesh: res.mesh }, { id: lo.objId, mode: res.mode, sel: res.sel });
  setLastOp({ ...lo, params, doc: store.getState().doc });
}

/** Shade the whole mesh smooth or flat. */
export function setSmooth(store: Store, smooth: boolean) {
  const st = store.getState();
  const id = st.edit?.id ?? st.selection;
  const o = id ? st.doc.objects[id] : null;
  if (!o || !canEdit(o)) return;
  const mesh = o.mesh;
  if (!mesh) {
    store.dispatch({ type: 'convertToMesh', id: o.id }, { select: false });
    const m = store.getState().doc.objects[o.id].mesh!;
    store.dispatch({ type: 'setMesh', id: o.id, mesh: { ...m, smooth } }, { select: false });
    return;
  }
  if (mesh.smooth !== smooth) store.dispatch({ type: 'setMesh', id: o.id, mesh: { ...mesh, smooth } }, { select: false });
}

/** Subdivision Surface levels (Ctrl+0..3 in Object Mode); also shades smooth, like Blender's quick shortcut. */
export function setSubdivision(store: Store, levels: number) {
  const st = store.getState();
  const id = st.edit?.id ?? st.selection;
  const o = id ? st.doc.objects[id] : null;
  if (!o || !canEdit(o)) {
    store.notify('Select a shape or mesh to add Subdivision Surface');
    return;
  }
  store.dispatch({ type: 'setModifiers', id: o.id, modifiers: { subdivision: levels > 0 ? { levels } : null } }, { select: false });
  if (levels > 0) setSmooth(store, true);
  store.notify(levels > 0 ? `Subdivision Surface: level ${levels}` : 'Subdivision Surface removed');
}
