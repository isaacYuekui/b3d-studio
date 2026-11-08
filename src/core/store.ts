// Application store: scene doc + undo history + UI state.
// Framework-agnostic; React reads it with useSyncExternalStore.

import { applyCommand, defaultIdGen } from './commands';
import type { Command, IdGen } from './commands';
import type { SceneDoc } from './types';

export type ToolMode = 'select' | 'move' | 'rotate' | 'scale';
export type Shading = 'solid' | 'rendered';

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
}

const HISTORY_LIMIT = 200;

export function createDefaultDoc(idGen: IdGen = defaultIdGen): SceneDoc {
  return applyCommand({ objects: {}, order: [] }, { type: 'add', primitive: 'cube', transform: { position: [0, 0, 0] } }, idGen).doc;
}

export class Store {
  private state: AppState;
  private past: SceneDoc[] = [];
  private future: SceneDoc[] = [];
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
    };
  }

  getState = (): AppState => this.state;

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  private set(patch: Partial<AppState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((l) => l());
  }

  /** Apply a command as one undoable step. Returns created ids. Errors become notices. */
  dispatch(cmd: Command, opts: { select?: boolean } = {}): string[] {
    this.commitPreview();
    try {
      const { doc, created } = applyCommand(this.state.doc, cmd, this.idGen);
      if (doc === this.state.doc) return created;
      this.past.push(this.state.doc);
      if (this.past.length > HISTORY_LIMIT) this.past.shift();
      this.future = [];
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

  /** Apply a command without recording history; repeated calls replace each other. */
  preview(cmd: Command) {
    const base = this.previewBase ?? this.state.doc;
    try {
      const { doc } = applyCommand(base, cmd, this.idGen);
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
    this.past.push(base);
    if (this.past.length > HISTORY_LIMIT) this.past.shift();
    this.future = [];
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
    this.future.push(this.state.doc);
    this.set({ doc: prev, selection: this.fixSel(prev), canUndo: this.past.length > 0, canRedo: true, notice: 'Undo' });
  }

  redo() {
    const next = this.future.pop();
    if (!next) return;
    this.past.push(this.state.doc);
    this.set({ doc: next, selection: this.fixSel(next), canUndo: true, canRedo: this.future.length > 0, notice: 'Redo' });
  }

  /** Replace the whole scene and clear history (used by New / Load). */
  reset(doc: SceneDoc, notice?: string) {
    this.past = [];
    this.future = [];
    this.set({ doc, selection: null, canUndo: false, canRedo: false, notice: notice ?? null });
  }

  private fixSel(doc: SceneDoc) {
    const s = this.state.selection;
    return s && doc.objects[s] ? s : null;
  }

  select(id: string | null) {
    if (id !== null && !this.state.doc.objects[id]) return;
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

  setPlaying(playing: boolean) {
    this.set({ playing });
  }
}
