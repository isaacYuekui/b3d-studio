// Central action registry. Menus, keyboard shortcuts, context menus and
// (later) the command palette / AI operator all invoke the same actions.

import type { Store, ToolMode } from '../core/store';
import type { Viewport, ViewName } from '../engine/Viewport';
import { createDefaultDoc } from '../core/store';
import { loadLocal, parseProject, saveLocal, serializeProject } from '../core/serialize';
import type { LightType, ObjectType } from '../core/types';

export interface Ctx {
  store: Store;
  viewport: () => Viewport | null;
  /** In-app confirmation dialog (native confirm() is blocked in some embedded browsers). */
  confirm: (message: string, okLabel: string) => Promise<boolean>;
  /** Opens the Run Scene Script dialog. */
  openScript: () => void;
  /** Opens the asset library browser. */
  openLibrary: () => void;
}

export interface Action {
  id: string;
  label: string;
  /** Display string, e.g. "Shift D". */
  shortcut?: string;
  enabled?: (c: Ctx) => boolean;
  run: (c: Ctx) => void;
}

const hasSel = (c: Ctx) => c.store.getState().selection !== null;
const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
export const MOD = isMac ? '⌘' : 'Ctrl';

const add = (primitive: ObjectType): Action => ({
  id: `add.${primitive}`,
  label: primitive.charAt(0).toUpperCase() + primitive.slice(1),
  run: (c) => {
    c.store.dispatch({ type: 'add', primitive });
  },
});

// New lights appear above the origin so they light the default scene.
const addLight = (type: LightType, label: string): Action => ({
  id: `add.${type}Light`,
  label,
  run: (c) => {
    const transform = type === 'sun' ? { position: [4, -4, 8] as [number, number, number], rotation: [40, 0, 45] as [number, number, number] } : { position: [4, -4, 5] as [number, number, number] };
    c.store.dispatch({ type: 'add', primitive: 'light', light: { type }, transform });
  },
});

const view = (v: ViewName, label: string, shortcut?: string): Action => ({
  id: `view.${v}`,
  label,
  shortcut,
  run: (c) => c.viewport()?.setView(v),
});

const tool = (t: ToolMode, label: string, shortcut: string): Action => ({
  id: `tool.${t}`,
  label,
  shortcut,
  run: (c) => c.store.setTool(t),
});

export function downloadBlob(filename: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

const stamp = () => new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');

/**
 * Opens the system file picker. `accept` is omitted for 3D models: iOS greys out
 * .glb/.gltf files it doesn't recognise, so the type is checked after picking instead.
 */
export function pickFile(accept: string | null = '.json,.b3d,application/json'): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    if (accept) input.accept = accept;
    // Must be attached to the DOM: iOS Safari ignores clicks on detached file inputs.
    input.style.cssText = 'position:fixed;left:-9999px;opacity:0';
    document.body.appendChild(input);
    const done = (f: File | null) => {
      input.remove();
      resolve(f);
    };
    input.onchange = () => done(input.files?.[0] ?? null);
    input.addEventListener('cancel', () => done(null));
    input.click();
  });
}

export const actions = {
  'file.new': {
    id: 'file.new',
    label: 'New Scene',
    run: async (c) => {
      if (c.store.getState().doc.order.length > 1 && !(await c.confirm('Start a new scene? The current scene will be replaced. Export it first if you want to keep a copy.', 'New Scene'))) return;
      c.store.reset(createDefaultDoc(), 'New scene');
      c.store.select(c.store.getState().doc.order[0]);
    },
  },
  'file.save': {
    id: 'file.save',
    label: 'Save in Browser',
    shortcut: `${MOD} S`,
    run: (c) => c.store.notify(saveLocal(c.store.getState().doc) ? 'Saved in this browser' : 'Could not save — browser storage is blocked'),
  },
  'file.load': {
    id: 'file.load',
    label: 'Load Browser Save',
    shortcut: `${MOD} O`,
    run: (c) => {
      const doc = loadLocal();
      if (doc) c.store.reset(doc, 'Loaded browser save');
      else c.store.notify('No browser save found');
    },
  },
  'file.export': {
    id: 'file.export',
    label: 'Export Project File…',
    shortcut: `${MOD} E`,
    run: async (c) => {
      const doc = c.store.getState().doc;
      const { collectEmbeddedModels } = await import('../engine/userModels');
      const models = await collectEmbeddedModels(doc.order.map((id) => doc.objects[id].asset ?? ''));
      const json = serializeProject(doc);
      // Imported models travel inside the project file so it opens on any device.
      const text = Object.keys(models).length ? json.replace(/\n}$/, `,\n  "models": ${JSON.stringify(models)}\n}`) : json;
      downloadBlob(`b3d-scene-${stamp()}.b3d.json`, new Blob([text], { type: 'application/json' }));
      c.store.notify(Object.keys(models).length ? `Project exported with ${Object.keys(models).length} imported model(s)` : 'Project exported');
    },
  },
  'file.import': {
    id: 'file.import',
    label: 'Import Project File…',
    shortcut: `${MOD} I`,
    run: async (c) => {
      const file = await pickFile();
      if (!file) return;
      try {
        const text = await file.text();
        const doc = parseProject(text);
        const embedded = (JSON.parse(text) as { models?: unknown }).models;
        if (embedded) {
          const { restoreEmbeddedModels } = await import('../engine/userModels');
          await restoreEmbeddedModels(embedded);
        }
        c.store.reset(doc, `Imported ${file.name}`);
        c.viewport()?.frame(true);
      } catch (e) {
        c.store.notify(`Import failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  },

  'edit.undo': { id: 'edit.undo', label: 'Undo', shortcut: `${MOD} Z`, enabled: (c) => c.store.getState().canUndo, run: (c) => c.store.undo() },
  'edit.redo': { id: 'edit.redo', label: 'Redo', shortcut: `⇧ ${MOD} Z`, enabled: (c) => c.store.getState().canRedo, run: (c) => c.store.redo() },
  'edit.duplicate': {
    id: 'edit.duplicate',
    label: 'Duplicate',
    shortcut: '⇧ D',
    enabled: hasSel,
    run: (c) => {
      const s = c.store.getState().selection;
      if (s) c.store.dispatch({ type: 'duplicate', ids: [s] });
    },
  },
  'edit.delete': {
    id: 'edit.delete',
    label: 'Delete',
    shortcut: 'X',
    enabled: hasSel,
    run: (c) => {
      const s = c.store.getState().selection;
      if (s) c.store.dispatch({ type: 'delete', ids: [s] });
    },
  },
  'edit.deselect': { id: 'edit.deselect', label: 'Select None', shortcut: 'Esc', run: (c) => c.store.select(null) },
  'edit.hide': {
    id: 'edit.hide',
    label: 'Hide Selected',
    shortcut: 'H',
    enabled: hasSel,
    run: (c) => {
      const s = c.store.getState().selection;
      if (s) c.store.dispatch({ type: 'setVisible', id: s, visible: false });
    },
  },
  'edit.unhideAll': {
    id: 'edit.unhideAll',
    label: 'Reveal Hidden',
    shortcut: '⌥ H',
    run: (c) => {
      const { doc } = c.store.getState();
      const hidden = doc.order.filter((id) => !doc.objects[id].visible);
      // One undo step per object is acceptable for V0.1; batch commands come with the AI operator.
      hidden.forEach((id) => c.store.dispatch({ type: 'setVisible', id, visible: true }, { select: false }));
    },
  },

  'add.cube': add('cube'),
  'add.sphere': add('sphere'),
  'add.cylinder': add('cylinder'),
  'add.plane': add('plane'),
  'add.cone': add('cone'),
  'add.torus': add('torus'),
  'add.capsule': add('capsule'),
  'add.empty': add('empty'),
  'add.pointLight': addLight('point', 'Point'),
  'add.sunLight': addLight('sun', 'Sun'),
  'add.spotLight': addLight('spot', 'Spot'),

  'file.script': {
    id: 'file.script',
    label: 'Run Scene Script…',
    shortcut: `${MOD} R`,
    run: (c) => c.openScript(),
  },
  'add.library': {
    id: 'add.library',
    label: 'From Library…',
    shortcut: '⇧ L',
    run: (c) => c.openLibrary(),
  },
  'file.importModel': {
    id: 'file.importModel',
    label: 'Import 3D Model (GLB / glTF / ZIP)…',
    shortcut: `⇧ ${MOD} I`,
    run: async (c) => {
      const file = await pickFile(null);
      if (!file) return;
      try {
        c.store.notify(`Importing ${file.name}…`);
        const { toGlb, saveUserModel } = await import('../engine/userModels');
        const { glb, name } = await toGlb(file.name, new Uint8Array(await file.arrayBuffer()));
        const meta = await saveUserModel(glb, name);
        c.store.dispatch({ type: 'add', primitive: 'model', asset: meta.id, name: meta.name });
        c.store.notify(`Imported “${meta.name}” (${(glb.byteLength / 1e6).toFixed(1)} MB). Saved on this device under Library > My Models.`);
        const vp = c.viewport();
        void vp?.settle().then(async () => {
          vp.frame(false);
          const { userModelMetaNow, guessUnitScale } = await import('../engine/userModels');
          const m = userModelMetaNow(meta.id);
          if (m?.min && m.max) {
            const longest = Math.max(...m.max.map((v, i) => v - m.min![i]));
            const metres = longest * guessUnitScale(longest);
            c.store.notify(`Imported “${meta.name}”: ${metres < 1 ? `${Math.round(metres * 100)} cm` : `${metres.toFixed(2)} m`} across. If that's wrong, type the real size in Properties > Model.`);
          }
        });
      } catch (e) {
        c.store.notify(`Import failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  },
  'file.glb': {
    id: 'file.glb',
    label: 'Export GLB (for Blender)…',
    run: async (c) => {
      const vp = c.viewport();
      if (!vp) return;
      try {
        c.store.notify('Exporting GLB… scenes with photo textures can take up to a minute');
        downloadBlob(`b3d-scene-${stamp()}.glb`, await vp.exportGLB());
        c.store.notify('GLB exported');
      } catch (e) {
        c.store.notify(`GLB export failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  },
  'view.shading': {
    id: 'view.shading',
    label: 'Toggle Solid / Rendered',
    shortcut: 'Z',
    run: (c) => c.store.setShading(c.store.getState().shading === 'solid' ? 'rendered' : 'solid'),
  },

  'view.front': view('front', 'Front', '1'),
  'view.back': view('back', 'Back', `${MOD} 1`),
  'view.right': view('right', 'Right', '3'),
  'view.left': view('left', 'Left', `${MOD} 3`),
  'view.top': view('top', 'Top', '7'),
  'view.bottom': view('bottom', 'Bottom', `${MOD} 7`),
  'view.persp': view('persp', 'Perspective (default)', '5'),
  'view.camera': {
    id: 'view.camera',
    label: 'Scene Camera View',
    shortcut: '0',
    run: (c) => {
      if (!c.viewport()?.viewCamera()) c.store.notify('This scene has no camera yet. Use View > Set Scene Camera to View.');
    },
  },
  'view.setCamera': {
    id: 'view.setCamera',
    label: 'Set Scene Camera to View',
    shortcut: `${MOD} ⌥ 0`,
    run: (c) => {
      const v = c.viewport()?.currentView();
      if (!v) return;
      c.store.dispatch({ type: 'setCamera', ...v }, { select: false });
      c.store.notify('Scene camera saved — press 0 to return to this view');
    },
  },
  'view.frameSelected': { id: 'view.frameSelected', label: 'Frame Selected', shortcut: '.', run: (c) => c.viewport()?.frame(false) },
  'view.frameAll': { id: 'view.frameAll', label: 'Frame All', shortcut: 'Home', run: (c) => c.viewport()?.frame(true) },

  'tool.select': tool('select', 'Select', 'W'),
  'tool.move': tool('move', 'Move', 'G'),
  'tool.rotate': tool('rotate', 'Rotate', 'R'),
  'tool.scale': tool('scale', 'Scale', 'S'),

  'anim.play': {
    id: 'anim.play',
    label: 'Play / Pause',
    shortcut: 'Space',
    run: (c) => c.store.setPlaying(!c.store.getState().playing),
  },
} satisfies Record<string, Action>;

export type ActionId = keyof typeof actions;

export function runAction(c: Ctx, id: ActionId) {
  const a: Action = actions[id];
  if (a.enabled && !a.enabled(c)) return;
  void a.run(c);
}

/** Map a keyboard event to an action id (null if unbound). */
export function shortcutFor(e: KeyboardEvent): ActionId | null {
  const mod = e.metaKey || e.ctrlKey;
  const k = e.key.toLowerCase();
  const code = e.code;
  if (mod) {
    if (k === 'z') return e.shiftKey ? 'edit.redo' : 'edit.undo';
    if (k === 'y') return 'edit.redo';
    if (k === 's') return 'file.save';
    if (k === 'o') return 'file.load';
    if (k === 'e') return 'file.export';
    if (k === 'i') return e.shiftKey ? 'file.importModel' : 'file.import';
    if (k === 'r') return 'file.script';
    if (code === 'Digit1' || code === 'Numpad1') return 'view.back';
    if (code === 'Digit3' || code === 'Numpad3') return 'view.left';
    if (code === 'Digit7' || code === 'Numpad7') return 'view.bottom';
    if (e.altKey && (code === 'Digit0' || code === 'Numpad0')) return 'view.setCamera';
    return null;
  }
  if (e.altKey) {
    if (code === 'KeyH') return 'edit.unhideAll';
    if (code === 'KeyA') return 'edit.deselect';
    return null;
  }
  if (e.shiftKey) {
    if (code === 'KeyD') return 'edit.duplicate';
    if (code === 'KeyL') return 'add.library';
    return null;
  }
  switch (code) {
    case 'KeyW': return 'tool.select';
    case 'KeyG': return 'tool.move';
    case 'KeyR': return 'tool.rotate';
    case 'KeyS': return 'tool.scale';
    case 'KeyX':
    case 'Delete':
    case 'Backspace': return 'edit.delete';
    case 'KeyH': return 'edit.hide';
    case 'Escape': return 'edit.deselect';
    case 'Digit1':
    case 'Numpad1': return 'view.front';
    case 'Digit3':
    case 'Numpad3': return 'view.right';
    case 'Digit7':
    case 'Numpad7': return 'view.top';
    case 'Digit5':
    case 'Numpad5': return 'view.persp';
    case 'Digit0':
    case 'Numpad0': return 'view.camera';
    case 'Period':
    case 'NumpadDecimal': return 'view.frameSelected';
    case 'Home': return 'view.frameAll';
    case 'Space': return 'anim.play';
    case 'KeyZ': return 'view.shading';
  }
  return null;
}
