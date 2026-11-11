// Application store: scene doc + undo history + UI state.
// Framework-agnostic; React reads it with useSyncExternalStore.

import { applyCommand, defaultIdGen } from './commands';
import type { Command, IdGen } from './commands';
import type { SceneDoc } from './types';
import type { MeshSelection, SelectMode } from './mesh/select';
import { flush } from './mesh/select';

/** Edit mode on one mesh object (Tab), like Blender. */
export interface EditState {
  id: string;
  mode: SelectMode;
  sel: MeshSelection;
}

export type ToolMode = 'select' | 'move' | 'rotate' | 'scale';
export type Shading = 'solid' | 'rendered';

export const QUALITIES = ['fast', 'balanced', 'best'] as const;
export type Quality = (typeof QUALITIES)[number];
const QUALITY_KEY = 'b3d.quality';

/** Small per-device preferences (snap, proportional editing). Storage may be unavailable. */
function loadPref<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    if (v === null) return fallback;
    const parsed = JSON.parse(v) as T;
    return typeof parsed === typeof fallback ? parsed : fallback;
  } catch {
    return fallback;
  }
}
function savePref(key: string, v: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* per session only */
  }
}
function loadQuality(): Quality {
  try {
    const q = localStorage.getItem(QUALITY_KEY);
    if (q && (QUALITIES as readonly string[]).includes(q)) return q as Quality;
  } catch {
    /* storage blocked */
  }
  return 'balanced';
}

export interface AppState {
  doc: SceneDoc;
  selection: string | null;
  tool: ToolMode;
  canUndo: boolean;
  canRedo: boolean;
  /** Short status/notice shown in the status bar. */
  notice: string | null;
  frame: number;
  playing: boolean;
  /** Solid = studio lighting for modelling; Rendered = the scene's own lights, materials and shadows. */
  shading: Shading;
  /** Looking through the scene camera (follows its animation during playback). */
  cameraView: boolean;
  /** Render quality on this device (not saved in the scene): resolution, shadows, AO, bloom. */
  quality: Quality;
  /** Edit mode (null = Object mode). */
  edit: EditState | null;
  /** See-through display: select hidden vertices too. */
  xray: boolean;
  /** Snap moves / rotations / scales to increments (0.25 m, 15°, 0.1). Saved per device. */
  snap: boolean;
  /** Edit mode: proportional editing, nearby vertices follow within `radius` metres. Saved per device. */
  proportional: { on: boolean; radius: number };
  /** Edit mode, touch: taps add to / remove from the selection (Shift does this on a keyboard). */
  addSelect: boolean;
  /** Edit mode: next drag on the viewport draws a selection box (B). */
  boxMode: boolean;
  /** Pose Mode on an armature, with the selected bone. */
  pose: { id: string; bone: string | null } | null;
}

interface Snapshot {
  doc: SceneDoc;
  edit: EditState | null;
}

const HISTORY_LIMIT = 200;

export function createDefaultDoc(idGen: IdGen = defaultIdGen): SceneDoc {
  return applyCommand({ objects: {}, order: [] }, { type: 'add', primitive: 'cube', transform: { position: [0, 0, 0] } }, idGen).doc;
}

export class Store {
  private state: AppState;
  private past: Snapshot[] = [];
  private future: Snapshot[] = [];
  private listeners = new Set<() => void>();
  private idGen: IdGen;

  constructor(doc?: SceneDoc, idGen: IdGen = defaultIdGen) {
    this.idGen = idGen;
    const initial = doc ?? createDefaultDoc(idGen);
    this.state = {
      doc: initial,
      selection: initial.order[0] ?? null,
      tool: 'move',
      canUndo: false,
      canRedo: false,
      notice: null,
      frame: 1,
      playing: false,
      shading: 'solid',
      cameraView: false,
      quality: loadQuality(),
      edit: null,
      xray: false,
      snap: loadPref('b3d.snap', false),
      proportional: loadPref('b3d.proportional', { on: false, radius: 1 }),
      addSelect: false,
      boxMode: false,
      pose: null,
    };
  }

  getState = (): AppState => this.state;

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  private set(patch: Partial<AppState>) {
    const next = { ...this.state, ...patch };
    if (next.doc !== this.state.doc && next.edit && !('edit' in patch)) next.edit = this.fixEdit(next.doc, next.edit);
    if (next.pose && next.doc.objects[next.pose.id]?.type !== 'armature') next.pose = null;
    this.state = next;
    this.listeners.forEach((l) => l());
  }

  /** Keep the edit selection valid when the mesh changes (and leave edit mode if the object went away). */
  private fixEdit(doc: SceneDoc, edit: EditState | null): EditState | null {
    if (!edit) return null;
    const o = doc.objects[edit.id];
    if (!o || o.type !== 'mesh' || !o.mesh) return null;
    const prev = this.state.doc.objects[edit.id]?.mesh;
    if (prev && prev.vertices.length === o.mesh.vertices.length && prev.faces.length === o.mesh.faces.length) return edit;
    return { ...edit, sel: flush(o.mesh, edit.mode, edit.sel) };
  }

  private snap(): Snapshot {
    return { doc: this.state.doc, edit: this.state.edit };
  }

  private pushPast(s: Snapshot) {
    this.past.push(s);
    if (this.past.length > HISTORY_LIMIT) this.past.shift();
    this.future = [];
  }

  /** Apply a command as one undoable step. Returns created ids. Errors become notices. */
  dispatch(cmd: Command, opts: { select?: boolean } = {}): string[] {
    this.commitPreview();
    try {
      const { doc, created } = applyCommand(this.state.doc, cmd, this.idGen);
      if (doc === this.state.doc) return created;
      this.pushPast(this.snap());
      let selection = this.state.selection;
      if (opts.select !== false && created.length) selection = created[created.length - 1];
      if (selection && !doc.objects[selection]) selection = null;
      this.set({ doc, selection, canUndo: true, canRedo: false, notice: null });
      return created;
    } catch (e) {
      this.set({ notice: e instanceof Error ? e.message : String(e) });
      return [];
    }
  }

  // ---- transient edits (live preview while scrubbing a field) -------------
  private previewBase: SceneDoc | null = null;
  private previewEdit: EditState | null = null;

  /** Apply a command without recording history; repeated calls replace each other. */
  preview(cmd: Command) {
    const base = this.previewBase ?? this.state.doc;
    try {
      const { doc } = applyCommand(base, cmd, this.idGen);
      if (!this.previewBase) this.previewEdit = this.state.edit;
      this.previewBase = base;
      this.set({ doc });
    } catch {
      /* ignore invalid preview */
    }
  }

  /** Turn the current preview into one undo step. */
  commitPreview() {
    const base = this.previewBase;
    if (!base) return;
    this.previewBase = null;
    if (base === this.state.doc) return;
    this.pushPast({ doc: base, edit: this.previewEdit });
    this.set({ canUndo: true, canRedo: false });
  }

  cancelPreview() {
    const base = this.previewBase;
    if (!base) return;
    this.previewBase = null;
    this.set({ doc: base });
  }

  undo() {
    this.commitPreview();
    const prev = this.past.pop();
    if (!prev) return;
    this.future.push(this.snap());
    this.restore(prev, 'Undo');
    this.set({ canUndo: this.past.length > 0, canRedo: true });
  }

  redo() {
    const next = this.future.pop();
    if (!next) return;
    this.past.push(this.snap());
    this.restore(next, 'Redo');
    this.set({ canUndo: true, canRedo: this.future.length > 0 });
  }

  /** Restore a snapshot; stay in edit mode on the same object when its selection was recorded. */
  private restore(s: Snapshot, notice: string) {
    const cur = this.state.edit;
    let edit: EditState | null = null;
    if (cur) {
      const recorded = s.edit && s.edit.id === cur.id ? { ...s.edit, mode: cur.mode } : { ...cur };
      const o = s.doc.objects[cur.id];
      edit = o?.type === 'mesh' && o.mesh ? { ...recorded, sel: flush(o.mesh, recorded.mode, recorded.sel) } : null;
    }
    this.set({ doc: s.doc, selection: this.fixSel(s.doc), edit, notice });
  }

  /** Replace the whole scene and clear history (used by New / Load). */
  reset(doc: SceneDoc, notice?: string) {
    this.past = [];
    this.future = [];
    this.set({ doc, selection: null, edit: null, pose: null, canUndo: false, canRedo: false, notice: notice ?? null });
  }

  private fixSel(doc: SceneDoc) {
    const s = this.state.selection;
    return s && doc.objects[s] ? s : null;
  }

  select(id: string | null) {
    if (id !== null && !this.state.doc.objects[id]) return;
    // Picking another object (Outliner) leaves edit mode, like Blender.
    if (this.state.edit && id !== this.state.edit.id) this.set({ edit: null, boxMode: false });
    if (this.state.pose && id !== this.state.pose.id) this.set({ pose: null });
    if (id !== this.state.selection) this.set({ selection: id });
  }

  setTool(tool: ToolMode) {
    this.set({ tool });
  }

  notify(notice: string | null) {
    this.set({ notice });
  }

  setFrame(frame: number) {
    this.set({ frame });
  }

  setCameraView(cameraView: boolean) {
    if (cameraView !== this.state.cameraView) this.set({ cameraView });
  }

  setShading(shading: Shading) {
    this.set({ shading });
  }

  setQuality(quality: Quality) {
    try {
      localStorage.setItem(QUALITY_KEY, quality);
    } catch {
      /* private mode: per session only */
    }
    this.set({ quality });
  }

  setPlaying(playing: boolean) {
    this.set({ playing });
  }

  /** Replace the last undo step's result: apply cmd to the state before it (Adjust Last Operation). */
  amend(cmd: Command, edit?: EditState | null) {
    this.commitPreview();
    const base = this.past[this.past.length - 1];
    if (!base) return;
    try {
      const { doc } = applyCommand(base.doc, cmd, this.idGen);
      this.future = [];
      this.set({ doc, ...(edit !== undefined ? { edit } : {}), canRedo: false });
    } catch (e) {
      this.set({ notice: e instanceof Error ? e.message : String(e) });
    }
  }

  /** Enter / leave edit mode, or change the edit selection / select mode. */
  setEdit(edit: EditState | null) {
    this.set({ edit });
  }

  setXray(xray: boolean) {
    this.set({ xray });
  }

  setSnap(snap: boolean) {
    savePref('b3d.snap', snap);
    this.set({ snap });
  }

  setProportional(p: { on: boolean; radius: number }) {
    const v = { on: p.on, radius: Math.min(100, Math.max(0.01, p.radius)) };
    savePref('b3d.proportional', v);
    this.set({ proportional: v });
  }

  setPose(pose: AppState['pose']) {
    this.set({ pose, ...(pose ? { selection: pose.id, edit: null } : {}) });
  }

  setAddSelect(addSelect: boolean) {
    this.set({ addSelect });
  }

  setBoxMode(boxMode: boolean) {
    this.set({ boxMode });
  }
}
