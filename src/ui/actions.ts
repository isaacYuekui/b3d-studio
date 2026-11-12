// Central action registry. Menus, keyboard shortcuts, context menus and
// (later) the command palette / AI operator all invoke the same actions.

import { DEFAULT_CURVE, curvePreset } from '../core/curve';
import type { Store, ToolMode } from '../core/store';
import type { Viewport, ViewName } from '../engine/Viewport';
import { createDefaultDoc } from '../core/store';
import { loadLocal, parseProject, saveLocal, serializeProject } from '../core/serialize';
import type { LightType, ObjectType } from '../core/types';
import { animationOf, keyFrames } from '../core/animation';
import { loadFont } from '../engine/fonts';
import { bakePhysics, freePhysics } from './physicsUi';
import { FIELD_PRESETS } from '../core/fields';
import { canQuick, quickExplode, quickFloat, quickParticles } from './quickEffects';
import { canEdit, enterEdit, exitEdit, runMeshOp, selectCmd, setSelectMode, setSmooth, setSubdivision, toggleEdit, togglePose } from './editing';
import { currentWeights, poseAt } from '../core/rig';
import { humanWeights } from '../core/humans';
import { subtree } from '../core/commands';
import { catmullClark } from '../core/mesh/modifiers';
import type { CameraMoveKind } from '../core/cameraMoves';
import type { MeshOpId } from './editing';

export interface Ctx {
  store: Store;
  viewport: () => Viewport | null;
  /** In-app confirmation dialog (native confirm() is blocked in some embedded browsers). */
  confirm: (message: string, okLabel: string) => Promise<boolean>;
  /** Opens the Run Scene Script dialog. */
  openScript: () => void;
  /** Opens the asset library browser. */
  openLibrary: () => void;
  /** Opens the Render Video dialog. */
  openVideo: () => void;
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
const editing = (c: Ctx) => c.store.getState().edit !== null;
const editable = (c: Ctx) => {
  const st = c.store.getState();
  return !!st.edit || canEdit(st.selection ? st.doc.objects[st.selection] : null);
};

const meshOp = (op: MeshOpId, label: string, shortcut?: string): Action => ({
  id: `mesh.${op}`,
  label,
  shortcut,
  enabled: editing,
  run: (c) => void runMeshOp(c.store, op),
});

const subdiv = (n: number): Action => ({
  id: `mod.subdiv${n}`,
  label: n ? `Subdivision Level ${n}` : 'Remove Subdivision',
  shortcut: `${MOD} ${n}`,
  enabled: editable,
  run: (c) => setSubdivision(c.store, n),
});
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

/** Add → Town: a street grid of buildings (village houses, town blocks or city towers). */
function addCurve(kind: 'bezier' | 'circle' | 'path'): Action {
  return {
    id: `add.curve.${kind}`,
    label: kind === 'bezier' ? 'Bezier' : kind === 'circle' ? 'Circle' : 'Path',
    run: (c) => {
      const p = curvePreset(kind);
      const name = kind === 'bezier' ? 'BezierCurve' : kind === 'circle' ? 'BezierCircle' : 'NurbsPath';
      // One undo step: the points and the curve setting together.
      const objs = c.store.getState().doc.objects;
      let n = 1;
      while (objs[`curve-${n}`]) n++;
      const id = `curve-${n}`;
      c.store.dispatch({
        type: 'batch',
        commands: [
          { type: 'add', primitive: 'mesh', id, name, mesh: { vertices: p.points, faces: [], smooth: true }, material: { baseColor: '#d9d9d9', roughness: 0.5 } },
          { type: 'setModifiers', id, modifiers: { curve: { ...DEFAULT_CURVE, cyclic: p.cyclic } } },
        ],
      });
      c.store.select(id);
      c.store.notify('Curve added — Tab to move its points (E adds a point at an end); Object → Follow Path makes things move along it');
    },
  };
}

function addTown(style: 'village' | 'town' | 'city'): Action {
  const size: Record<typeof style, [number, number]> = { village: [70, 70], town: [80, 80], city: [110, 110] };
  return {
    id: `add.town.${style}`,
    label: style === 'village' ? 'Village' : style === 'town' ? 'Town' : 'City',
    run: (c) => {
      const objs = c.store.getState().doc.objects;
      let prefix: string = style;
      for (let k = 2; objs[`${prefix}-b0`] || objs[`${prefix}-ground`]; k++) prefix = `${style}${k}`;
      const before = c.store.getState().doc;
      // After dark the windows come on.
      const dark = ['night', 'dusk'].includes(before.world?.time ?? '');
      c.store.dispatch({ type: 'addTown', style, prefix, size: size[style], seed: Math.floor(Math.random() * 1e6), ...(dark ? { lights: 3 } : {}) }, { select: false });
      if (c.store.getState().doc !== before) {
        c.viewport()?.frame(false);
        c.store.notify(`${style === 'city' ? 'City' : style === 'town' ? 'Town' : 'Village'} added${dark ? ' with lit windows' : ''} — each building is its own object (Quick Explode works on them)`);
      }
    },
  };
}

/** Add → Force Field: an empty carrying a field preset (explosions start at the current frame). */
function addField(preset: string): Action {
  const p = FIELD_PRESETS.find((x) => x.id === preset)!;
  return {
    id: `add.field.${preset}`,
    label: p.label,
    run: (c) => {
      const frame = c.store.getState().frame;
      const [id] = c.store.dispatch({ type: 'add', primitive: 'empty', name: `${p.label} field`, transform: { position: [0, 0, 1] } });
      if (id) c.store.dispatch({ type: 'setField', id, field: p.frames ? { ...p.field, start: frame, end: frame + p.frames } : p.field }, { select: false });
    },
  };
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
      const { collectEmbeddedImages, imagesInDoc } = await import('../engine/userImages');
      const models = await collectEmbeddedModels(doc.order.map((id) => doc.objects[id].asset ?? ''));
      const images = await collectEmbeddedImages(imagesInDoc(doc));
      const json = serializeProject(doc);
      // Imported models and your images travel inside the project file so it opens on any device.
      let text = json;
      if (Object.keys(models).length) text = text.replace(/\n}$/, `,\n  "models": ${JSON.stringify(models)}\n}`);
      if (Object.keys(images).length) text = text.replace(/\n}$/, `,\n  "images": ${JSON.stringify(images)}\n}`);
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
        const raw = JSON.parse(text) as { models?: unknown; images?: unknown };
        if (raw.models) {
          const { restoreEmbeddedModels } = await import('../engine/userModels');
          await restoreEmbeddedModels(raw.models);
        }
        if (raw.images) {
          const { restoreEmbeddedImages } = await import('../engine/userImages');
          await restoreEmbeddedImages(raw.images);
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
    enabled: (c) => hasSel(c) || editing(c),
    run: (c) => {
      if (editing(c)) return void runMeshOp(c.store, 'duplicate');
      const s = c.store.getState().selection;
      if (s) c.store.dispatch({ type: 'duplicate', ids: [s] });
    },
  },
  'edit.delete': {
    id: 'edit.delete',
    label: 'Delete',
    shortcut: 'X',
    enabled: (c) => hasSel(c) || editing(c),
    run: (c) => {
      if (editing(c)) return void runMeshOp(c.store, 'delete');
      const s = c.store.getState().selection;
      if (s) c.store.dispatch({ type: 'delete', ids: [s] });
    },
  },
  'edit.deselect': { id: 'edit.deselect', label: 'Select None', shortcut: 'Esc', run: (c) => (editing(c) ? selectCmd(c.store, 'none') : c.store.select(null)) },

  // ---- edit mode (Tab) ----
  'mode.edit': {
    id: 'mode.edit',
    label: 'Toggle Edit Mode',
    shortcut: 'Tab',
    enabled: (c) => editable(c) || !!c.store.getState().pose || (() => { const st = c.store.getState(); return st.selection ? st.doc.objects[st.selection]?.type === 'armature' : false; })(),
    run: (c) => toggleEdit(c.store),
  },
  'mode.sculpt': {
    id: 'mode.sculpt',
    label: 'Toggle Sculpt Mode',
    enabled: (c) => !!c.store.getState().sculpt || editable(c),
    run: (c) => {
      const st = c.store.getState();
      if (st.sculpt) return c.store.setSculpt(null);
      if (st.weightPaint) c.store.setWeightPaint(null);
      const o = st.selection ? st.doc.objects[st.selection] : null;
      if (!o) return c.store.notify('Select an object to sculpt');
      if (o.skin) return c.store.notify('Skinned characters can’t be sculpted yet');
      try {
        if (o.type !== 'mesh') c.store.dispatch({ type: 'convertToMesh', id: o.id }, { select: false });
      } catch (e) {
        return c.store.notify(e instanceof Error ? e.message : String(e));
      }
      c.store.setSculpt(o.id);
      const n = c.store.getState().doc.objects[o.id]?.mesh?.vertices.length ?? 0;
      c.store.notify(n < 3000 ? `Sculpt Mode. Only ${n} points: tap “Add detail” for smoother sculpting` : 'Sculpt Mode: drag on the model to sculpt, drag off it to turn the view');
    },
  },
  'mode.weight': {
    id: 'mode.weight',
    label: 'Toggle Weight Paint',
    enabled: (c) => !!c.store.getState().weightPaint || editable(c),
    run: (c) => {
      const st = c.store.getState();
      if (st.weightPaint) return c.store.setWeightPaint(null);
      const o = st.selection ? st.doc.objects[st.selection] : null;
      if (!o) return c.store.notify('Select a mesh to weight paint');
      try {
        if (o.type !== 'mesh') c.store.dispatch({ type: 'convertToMesh', id: o.id }, { select: false });
        const cur = c.store.getState().doc;
        const obj = cur.objects[o.id];
        const arm = obj.skin ? cur.objects[obj.skin.armature]?.armature : undefined;
        const boneGroups = !!arm && !!obj.vertexGroups?.groups.some((g) => arm.bones.some((b) => b.name === g.name));
        if (arm && !boneGroups) {
          // Start from the weights the character uses now (Blender: Automatic Weights), one group per bone.
          const w = currentWeights(cur, o.id, st.frame, obj.skin?.weights ? humanWeights(obj.skin.weights) : null);
          if (w) c.store.dispatch({ type: 'groupsFromWeights', id: o.id, weights: w }, { select: false });
        } else if (!obj.vertexGroups) c.store.dispatch({ type: 'addVertexGroup', id: o.id }, { select: false });
      } catch (e) {
        return c.store.notify(e instanceof Error ? e.message : String(e));
      }
      c.store.setWeightPaint(o.id);
      const vg = c.store.getState().doc.objects[o.id].vertexGroups;
      c.store.notify(`Weight Paint: painting “${vg?.groups[vg.active]?.name}”. Red = 1 (fully moved by it), blue = 0`);
    },
  },
  'sculpt.detail': {
    id: 'sculpt.detail',
    label: 'Add Detail (Subdivide)',
    enabled: (c) => !!c.store.getState().sculpt,
    run: (c) => {
      const st = c.store.getState();
      const o = st.sculpt ? st.doc.objects[st.sculpt.id] : null;
      if (!o?.mesh) return;
      const faces = o.mesh.faces.reduce((n, f) => n + f.length, 0);
      if (faces * 4 > 240_000) return c.store.notify('That is already very detailed: more would make it slow on a tablet');
      c.store.dispatch({ type: 'setMesh', id: o.id, mesh: { ...catmullClark(o.mesh), smooth: true } }, { select: false });
      c.store.notify(`Now ${c.store.getState().doc.objects[o.id].mesh!.vertices.length.toLocaleString()} points`);
    },
  },
  'mode.pose': {
    id: 'mode.pose',
    label: 'Toggle Pose Mode',
    shortcut: `${MOD} Tab`,
    enabled: (c) => {
      const st = c.store.getState();
      const o = st.selection ? st.doc.objects[st.selection] : null;
      return !!st.pose || o?.type === 'armature' || !!o?.skin;
    },
    run: (c) => togglePose(c.store),
  },
  'pose.reset': {
    id: 'pose.reset',
    label: 'Clear Pose (rest)',
    enabled: (c) => !!c.store.getState().pose,
    run: (c) => {
      const p = c.store.getState().pose;
      if (p) c.store.dispatch({ type: 'setPose', id: p.id, pose: {}, reset: true }, { select: false });
    },
  },
  'mode.enterEdit': { id: 'mode.enterEdit', label: 'Edit Mode', enabled: editable, run: (c) => void (!editing(c) && enterEdit(c.store)) },
  'mode.object': { id: 'mode.object', label: 'Object Mode', run: (c) => exitEdit(c.store) },
  'select.vert': { id: 'select.vert', label: 'Vertex Select', shortcut: '1', enabled: editing, run: (c) => setSelectMode(c.store, 'vert') },
  'select.edge': { id: 'select.edge', label: 'Edge Select', shortcut: '2', enabled: editing, run: (c) => setSelectMode(c.store, 'edge') },
  'select.face': { id: 'select.face', label: 'Face Select', shortcut: '3', enabled: editing, run: (c) => setSelectMode(c.store, 'face') },
  'select.all': { id: 'select.all', label: 'Select All', shortcut: 'A', enabled: editing, run: (c) => selectCmd(c.store, 'all') },
  'select.none': { id: 'select.none', label: 'Select None', shortcut: '⌥ A', enabled: editing, run: (c) => selectCmd(c.store, 'none') },
  'select.invert': { id: 'select.invert', label: 'Invert Selection', shortcut: `${MOD} I`, enabled: editing, run: (c) => selectCmd(c.store, 'invert') },
  'select.linked': { id: 'select.linked', label: 'Select Linked', shortcut: `${MOD} L`, enabled: editing, run: (c) => selectCmd(c.store, 'linked') },
  'select.loop': { id: 'select.loop', label: 'Select Edge Loop', shortcut: '⌥ click', enabled: editing, run: (c) => selectCmd(c.store, 'loop') },
  'select.box': { id: 'select.box', label: 'Box Select', shortcut: 'B', enabled: editing, run: (c) => c.store.setBoxMode(!c.store.getState().boxMode) },
  'view.snap': { id: 'view.snap', label: 'Toggle Snapping', shortcut: '⇧ Tab', run: (c) => {
    const on = !c.store.getState().snap;
    c.store.setSnap(on);
    c.store.notify(on ? 'Snapping on: moves in 0.25 m steps, rotations in 15°, scale in 0.1' : 'Snapping off');
  } },
  'edit.proportional': { id: 'edit.proportional', label: 'Toggle Proportional Editing', shortcut: 'O', run: (c) => {
    const p = c.store.getState().proportional;
    c.store.setProportional({ ...p, on: !p.on });
    c.store.notify(!p.on ? `Proportional editing on: vertices within ${p.radius} m follow smoothly` : 'Proportional editing off');
  } },
  'view.xray': { id: 'view.xray', label: 'Toggle X-Ray', shortcut: '⌥ Z', run: (c) => c.store.setXray(!c.store.getState().xray) },
  'mesh.extrude': meshOp('extrude', 'Extrude', 'E'),
  'mesh.inset': meshOp('inset', 'Inset Faces', 'I'),
  'mesh.bevel': meshOp('bevel', 'Bevel', `${MOD} B`),
  'mesh.loopcut': meshOp('loopcut', 'Loop Cut', `${MOD} R`),
  'mesh.subdivide': meshOp('subdivide', 'Subdivide'),
  'mesh.merge': meshOp('merge', 'Merge at Center', 'M'),
  'mesh.mergeDistance': meshOp('mergeDistance', 'Merge by Distance'),
  'mesh.fill': meshOp('fill', 'Fill (Make Face)', 'F'),
  'mesh.flip': meshOp('flip', 'Flip Normals', '⌥ N'),
  'mesh.recalc': meshOp('recalc', 'Recalculate Normals', '⇧ N'),
  'uv.smartProject': {
    id: 'uv.smartProject',
    label: 'Smart UV Project',
    shortcut: 'U',
    enabled: (c) => {
      const st = c.store.getState();
      const id = st.edit?.id ?? st.selection;
      return !!id && st.doc.objects[id]?.type === 'mesh';
    },
    run: (c) => {
      const st = c.store.getState();
      const id = st.edit?.id ?? st.selection;
      if (!id) return;
      c.store.dispatch({ type: 'unwrap', id }, { select: false });
      c.store.notify('Unwrapped: textures from your images now follow the UV map (Material tab → Texture)');
    },
  },
  'uv.clear': {
    id: 'uv.clear',
    label: 'Clear UV Map',
    enabled: (c) => {
      const st = c.store.getState();
      const id = st.edit?.id ?? st.selection;
      return !!id && !!st.doc.objects[id]?.mesh?.uv;
    },
    run: (c) => {
      const st = c.store.getState();
      const id = st.edit?.id ?? st.selection;
      if (id) c.store.dispatch({ type: 'clearUv', id }, { select: false });
    },
  },
  'mesh.dissolve': meshOp('dissolve', 'Dissolve', `${MOD} X`),
  'mesh.connect': meshOp('connect', 'Connect Vertex Path', 'J'),
  'mesh.bridge': meshOp('bridge', 'Bridge Edge Loops'),
  'mesh.smoothVerts': meshOp('smoothVerts', 'Smooth Vertices'),
  'mesh.shrinkFatten': meshOp('shrinkFatten', 'Shrink/Fatten', '⌥ S'),
  'mesh.toSphere': meshOp('toSphere', 'To Sphere', '⇧ ⌥ S'),
  'mesh.triangulate': meshOp('triangulate', 'Triangulate Faces', `${MOD} T`),
  'mesh.trisToQuads': meshOp('trisToQuads', 'Tris to Quads', '⌥ J'),
  'mesh.poke': meshOp('poke', 'Poke Faces'),
  'mesh.separate': {
    id: 'mesh.separate',
    label: 'Separate Selection',
    shortcut: 'P',
    enabled: (c) => !!c.store.getState().edit?.sel.faces.length,
    run: (c) => {
      const ed = c.store.getState().edit;
      if (!ed) return;
      if (!ed.sel.faces.length) return c.store.notify('Select faces to separate (face select mode helps: 3)');
      try {
        c.store.dispatch({ type: 'separate', id: ed.id, faces: ed.sel.faces, mode: 'selection' }, { select: false });
        c.store.setEdit({ ...ed, sel: { verts: [], edges: [], faces: [] } });
        c.store.notify('Separated into a new object (see the Outliner)');
      } catch (e) {
        c.store.notify(e instanceof Error ? e.message : String(e));
      }
    },
  },
  'object.separateLoose': {
    id: 'object.separateLoose',
    label: 'Separate by Loose Parts',
    enabled: (c) => { const s = c.store.getState(); const o = s.selection ? s.doc.objects[s.selection] : null; return !!o?.mesh; },
    run: (c) => {
      const id = c.store.getState().selection;
      if (!id) return;
      try {
        c.store.dispatch({ type: 'separate', id, mode: 'loose' }, { select: false });
        c.store.notify('Each loose part is now its own object');
      } catch (e) {
        c.store.notify(e instanceof Error ? e.message : String(e));
      }
    },
  },
  'mesh.smooth': { id: 'mesh.smooth', label: 'Shade Smooth', enabled: editable, run: (c) => setSmooth(c.store, true) },
  'mesh.flat': { id: 'mesh.flat', label: 'Shade Flat', enabled: editable, run: (c) => setSmooth(c.store, false) },
  'mod.subdiv0': subdiv(0),
  'mod.subdiv1': subdiv(1),
  'mod.subdiv2': subdiv(2),
  'mod.subdiv3': subdiv(3),
  'mod.mirrorX': {
    id: 'mod.mirrorX',
    label: 'Mirror X (symmetry)',
    enabled: editable,
    run: (c) => {
      const st = c.store.getState();
      const id = st.edit?.id ?? st.selection;
      if (!id) return;
      const on = !st.doc.objects[id].modifiers?.mirror?.x;
      c.store.dispatch({ type: 'setModifiers', id, modifiers: { mirror: on ? { x: true, y: false, z: false, clip: true } : null } }, { select: false });
      c.store.notify(on ? 'Mirror X on: edit one side, the other follows' : 'Mirror removed');
    },
  },
  'mod.apply': {
    id: 'mod.apply',
    label: 'Apply Modifiers',
    enabled: (c) => {
      const st = c.store.getState();
      const id = st.edit?.id ?? st.selection;
      return !!id && !!st.doc.objects[id]?.modifiers;
    },
    run: (c) => {
      const st = c.store.getState();
      const id = st.edit?.id ?? st.selection;
      if (id) c.store.dispatch({ type: 'applyModifiers', id }, { select: false });
    },
  },
  'object.moveToCollection': {
    id: 'object.moveToCollection',
    label: 'Move to Collection…',
    shortcut: 'M',
    enabled: (c) => hasSel(c) && !editing(c),
    run: (c) => c.store.setMoveMenu(true),
  },
  'object.newCollection': {
    id: 'object.newCollection',
    label: 'New Collection',
    run: (c) => {
      const id = `coll-${Math.random().toString(36).slice(2, 8)}`;
      const sel = c.store.getState().selection;
      // With an object selected it moves into the new collection (Blender: M → New Collection).
      c.store.dispatch(
        { type: 'batch', commands: [{ type: 'addCollection', id }, ...(sel && !c.store.getState().edit ? [{ type: 'moveToCollection' as const, ids: [sel], collection: id }] : [])] },
        { select: false },
      );
      c.store.setActiveCollection(id);
    },
  },
  'edit.hide': {
    id: 'edit.hide',
    label: 'Hide Selected',
    shortcut: 'H',
    enabled: (c) => hasSel(c) && !editing(c),
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
  'add.curve.bezier': addCurve('bezier'),
  'add.curve.circle': addCurve('circle'),
  'add.curve.path': addCurve('path'),
  'physics.bake': {
    id: 'physics.bake',
    label: 'Bake Rigid Body Physics',
    run: (c) => void bakePhysics(c.store),
  },
  'physics.free': {
    id: 'physics.free',
    label: 'Free Physics Bake',
    run: (c) => freePhysics(c.store),
  },
  'quick.explode': { id: 'quick.explode', label: 'Quick Explode', enabled: (c) => canQuick(c.store), run: (c) => void quickExplode(c.store) },
  'quick.fire': { id: 'quick.fire', label: 'Quick Fire', enabled: (c) => canQuick(c.store), run: (c) => quickParticles(c.store, 'fire') },
  'quick.smoke': { id: 'quick.smoke', label: 'Quick Smoke', enabled: (c) => canQuick(c.store), run: (c) => quickParticles(c.store, 'smoke') },
  'quick.float': { id: 'quick.float', label: 'Quick Float (on water)', enabled: (c) => hasSel(c), run: (c) => quickFloat(c.store) },
  'add.town.village': addTown('village'),
  'add.town.town': addTown('town'),
  'add.town.city': addTown('city'),
  'add.field.blast': addField('blast'),
  'add.field.push': addField('push'),
  'add.field.wind': addField('wind'),
  'add.field.vortex': addField('vortex'),
  'add.water': {
    id: 'add.water',
    label: 'Water / Ocean',
    run: (c) => {
      const doc = c.store.getState().doc;
      let id = 'water';
      for (let k = 2; doc.objects[id]; k++) id = `water-${k}`;
      c.store.dispatch({ type: 'addWater', id, size: [40, 40], level: 0, height: 0.6, waves: 1.5 });
    },
  },
  'add.text': {
    id: 'add.text',
    label: 'Text',
    run: async (c) => {
      try {
        await loadFont('sans');
      } catch {
        c.store.notify("Couldn't load the font — check the connection and try again");
        return;
      }
      c.store.dispatch({ type: 'addText', text: { body: 'Text' } });
    },
  },
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
  'file.video': {
    id: 'file.video',
    label: 'Render Video (MP4)…',
    shortcut: `${MOD} F12`,
    run: (c) => c.openVideo(),
  },
  'file.glb': {
    id: 'file.glb',
    label: 'Export GLB (for Blender)…',
    run: async (c) => {
      const vp = c.viewport();
      if (!vp) return;
      try {
        c.store.notify('Exporting GLB… scenes with photo textures can take up to a minute');
        const raw = new Uint8Array(await (await vp.exportGLB()).arrayBuffer());
        const { orientGlb } = await import('../engine/robloxExport');
        downloadBlob(`b3d-scene-${stamp()}.glb`, new Blob([(await orientGlb(raw)) as BlobPart], { type: 'model/gltf-binary' }));
        c.store.notify('GLB exported');
      } catch (e) {
        c.store.notify(`GLB export failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  },
  'file.roblox': {
    id: 'file.roblox',
    label: 'Export for Roblox (.zip)…',
    run: async (c) => {
      const vp = c.viewport();
      if (!vp) return;
      const st = c.store.getState();
      const ids = st.selection ? new Set(subtree(st.doc, st.selection)) : undefined;
      try {
        c.store.notify(`Preparing ${ids ? 'the selection' : 'the scene'} for Roblox… this can take a minute`);
        const { blob, report, terrains } = await vp.exportRoblox(ids);
        downloadBlob(`b3d-${ids ? 'model' : 'scene'}-roblox-${stamp()}.zip`, blob);
        const parts = [
          report ? `${report.parts} parts, ${report.triangles.toLocaleString()} triangles (largest mesh ${report.maxTriangles.toLocaleString()} ≤ 20,000)` : '',
          terrains ? `${terrains} terrain heightmap${terrains > 1 ? 's' : ''}` : '',
        ].filter(Boolean);
        c.store.notify(`Roblox pack ready: ${parts.join(' + ')}, ${(blob.size / 1048576).toFixed(1)} MB. Open README.txt in the zip for the Studio steps.`);
      } catch (e) {
        c.store.notify(`Roblox export failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  },
  'view.shading': {
    id: 'view.shading',
    label: 'Toggle Solid / Rendered',
    shortcut: 'Z',
    run: (c) => c.store.setShading(c.store.getState().shading === 'solid' ? 'rendered' : 'solid'),
  },
  'view.wireframe': {
    id: 'view.wireframe',
    label: 'Toggle Wireframe',
    shortcut: '⇧ Z',
    run: (c) => c.store.setShading(c.store.getState().shading === 'wireframe' ? 'solid' : 'wireframe'),
  },

  'view.front': view('front', 'Front', '1'),
  'view.back': view('back', 'Back', `${MOD} Numpad 1`),
  'view.right': view('right', 'Right', '3'),
  'view.left': view('left', 'Left', `${MOD} Numpad 3`),
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

  'anim.insertKey': {
    id: 'anim.insertKey',
    label: 'Insert Keyframe',
    shortcut: 'I',
    enabled: hasSel,
    run: (c) => {
      const { selection, frame, doc, pose } = c.store.getState();
      if (pose?.bone) {
        // Pose Mode: key the selected bone's current pose.
        const p = poseAt(doc, pose.id, frame)[pose.bone] ?? { rotation: [0, 0, 0] };
        c.store.dispatch({ type: 'setPoseKey', id: pose.id, bone: pose.bone, frame, rotation: p.rotation, ...(p.location ? { location: p.location } : {}) }, { select: false });
        c.store.notify(`Keyframe for bone ${pose.bone} at frame ${frame}`);
        return;
      }
      if (!selection) return;
      c.store.dispatch({ type: 'setKeyframe', id: selection, frame }, { select: false });
      c.store.notify(`Keyframe for ${doc.objects[selection].name} at frame ${frame}`);
    },
  },
  'anim.deleteKey': {
    id: 'anim.deleteKey',
    label: 'Delete Keyframe',
    shortcut: '⌥ I',
    enabled: hasSel,
    run: (c) => {
      const { selection, frame, pose } = c.store.getState();
      if (pose?.bone) return void c.store.dispatch({ type: 'deletePoseKey', id: pose.id, bone: pose.bone, frame }, { select: false });
      if (selection) c.store.dispatch({ type: 'deleteKeyframe', id: selection, frame }, { select: false });
    },
  },
  'anim.clear': {
    id: 'anim.clear',
    label: 'Clear Animation of Selected',
    enabled: (c) => {
      const { selection, doc } = c.store.getState();
      return !!selection && !!doc.animation?.tracks[selection];
    },
    run: (c) => {
      const { selection } = c.store.getState();
      if (selection) c.store.dispatch({ type: 'clearAnimation', id: selection }, { select: false });
    },
  },
  'anim.cameraKey': {
    id: 'anim.cameraKey',
    label: 'Key Camera at Current View',
    run: (c) => {
      const v = c.viewport()?.currentView();
      if (!v) return;
      const { frame, doc } = c.store.getState();
      c.store.dispatch({ type: 'batch', commands: [{ type: 'setCameraKey', frame, ...v }, ...(doc.camera ? [] : [{ type: 'setCamera' as const, ...v }])] }, { select: false });
      c.store.notify(`Camera keyframe at frame ${frame}`);
    },
  },
  'anim.camOrbit': cameraMoveAction('anim.camOrbit', 'Camera Move: Orbit', 'orbit'),
  'anim.camDolly': cameraMoveAction('anim.camDolly', 'Camera Move: Dolly In', 'dollyIn'),
  'anim.camFlyover': cameraMoveAction('anim.camFlyover', 'Camera Move: Flyover', 'flyover'),
  'anim.camCrane': cameraMoveAction('anim.camCrane', 'Camera Move: Crane Up', 'crane'),
  'anim.nextKey': {
    id: 'anim.nextKey',
    label: 'Jump to Next Keyframe',
    shortcut: '↑',
    run: (c) => {
      const { doc, frame, selection } = c.store.getState();
      const anim = animationOf(doc);
      const frames = keyFrames(anim, selection && anim.tracks[selection] ? [selection] : null);
      const f = frames.find((x) => x > frame);
      if (f !== undefined) c.store.setFrame(f);
    },
  },
  'anim.prevKey': {
    id: 'anim.prevKey',
    label: 'Jump to Previous Keyframe',
    shortcut: '↓',
    run: (c) => {
      const { doc, frame, selection } = c.store.getState();
      const anim = animationOf(doc);
      const frames = keyFrames(anim, selection && anim.tracks[selection] ? [selection] : null);
      const f = [...frames].reverse().find((x) => x < frame);
      if (f !== undefined) c.store.setFrame(f);
    },
  },
  'anim.nextFrame': { id: 'anim.nextFrame', label: 'Next Frame', shortcut: '→', run: (c) => c.store.setFrame(Math.min(animationOf(c.store.getState().doc).end, c.store.getState().frame + 1)) },
  'anim.prevFrame': { id: 'anim.prevFrame', label: 'Previous Frame', shortcut: '←', run: (c) => c.store.setFrame(Math.max(animationOf(c.store.getState().doc).start, c.store.getState().frame - 1)) },
  'anim.toStart': { id: 'anim.toStart', label: 'Jump to Start', shortcut: '⇧ ←', run: (c) => c.store.setFrame(animationOf(c.store.getState().doc).start) },
  'anim.toEnd': { id: 'anim.toEnd', label: 'Jump to End', shortcut: '⇧ →', run: (c) => c.store.setFrame(animationOf(c.store.getState().doc).end) },
  'anim.play': {
    id: 'anim.play',
    label: 'Play / Pause',
    shortcut: 'Space',
    run: (c) => c.store.setPlaying(!c.store.getState().playing),
  },
} satisfies Record<string, Action>;

export type ActionId = keyof typeof actions;

/**
 * A ready-made camera move over the whole timeline, starting from the current view: it circles
 * (or pushes in, flies over, cranes up to) the selected object, or the point the view looks at.
 */
function cameraMoveAction(id: string, label: string, move: CameraMoveKind): Action {
  return {
    id,
    label,
    run: (c) => {
      const vp = c.viewport();
      const v = vp?.currentView();
      if (!v) return;
      const { doc, selection } = c.store.getState();
      const anim = animationOf(doc);
      const target = selection && doc.objects[selection] ? (vp!.objectCenter?.(selection) ?? doc.objects[selection].transform.position) : v.target;
      const dx = v.position[0] - target[0], dy = v.position[1] - target[1];
      const distance = Math.max(0.5, Math.hypot(dx, dy));
      c.store.dispatch(
        { type: 'cameraMove', move, target, start: anim.start, end: anim.end, distance, height: v.position[2] - target[2], heading: (Math.atan2(dy, dx) * 180) / Math.PI, degrees: 120 },
        { select: false },
      );
      c.store.setFrame(anim.start);
      vp!.viewCamera();
      c.store.notify(`${label.replace('Camera Move: ', '')} over frames ${anim.start}–${anim.end}. Press play, or File → Export Video.`);
    },
  };
}

export function runAction(c: Ctx, id: ActionId) {
  const a: Action = actions[id];
  if (a.enabled && !a.enabled(c)) return;
  void a.run(c);
}

/** Map a keyboard event to an action id (null if unbound). */
export function shortcutFor(e: KeyboardEvent, editMode = false): ActionId | null {
  const mod = e.metaKey || e.ctrlKey;
  const k = e.key.toLowerCase();
  const code = e.code;
  if (code === 'Tab' && e.shiftKey && !mod && !e.altKey) return 'view.snap';
  if (code === 'Tab' && mod && !e.altKey) return 'mode.pose';
  if (code === 'Tab' && !mod && !e.altKey) return 'mode.edit';
  if (mod && !e.shiftKey && !e.altKey && /^Digit[0-3]$/.test(code)) return `mod.subdiv${code.slice(5)}` as ActionId;
  if (e.altKey && !mod && code === 'KeyZ') return 'view.xray';
  if (editMode) {
    if (mod && !e.shiftKey) {
      if (k === 'b') return 'mesh.bevel';
      if (k === 'r') return 'mesh.loopcut';
      if (k === 'x') return 'mesh.dissolve';
      if (k === 't') return 'mesh.triangulate';
      if (k === 'i') return 'select.invert';
      if (k === 'l') return 'select.linked';
    }
    if (e.altKey && !mod) {
      if (code === 'KeyA') return 'select.none';
      if (code === 'KeyN') return 'mesh.flip';
      if (code === 'KeyJ') return 'mesh.trisToQuads';
      if (code === 'KeyS') return e.shiftKey ? 'mesh.toSphere' : 'mesh.shrinkFatten';
    }
    if (e.shiftKey && !mod && !e.altKey && code === 'KeyN') return 'mesh.recalc';
    if (!mod && !e.altKey && !e.shiftKey) {
      switch (code) {
        case 'Digit1': return 'select.vert';
        case 'Digit2': return 'select.edge';
        case 'Digit3': return 'select.face';
        case 'KeyA': return 'select.all';
        case 'KeyE': return 'mesh.extrude';
        case 'KeyI': return 'mesh.inset';
        case 'KeyM': return 'mesh.merge';
        case 'KeyF': return 'mesh.fill';
        case 'KeyB': return 'select.box';
        case 'KeyL': return 'select.linked';
        case 'KeyO': return 'edit.proportional';
        case 'KeyU': return 'uv.smartProject';
        case 'KeyP': return 'mesh.separate';
        case 'KeyJ': return 'mesh.connect';
        case 'KeyH': return null;
      }
    }
  }
  if (mod) {
    if (k === 'z') return e.shiftKey ? 'edit.redo' : 'edit.undo';
    if (k === 'y') return 'edit.redo';
    if (k === 's') return 'file.save';
    if (k === 'o') return 'file.load';
    if (k === 'e') return 'file.export';
    if (k === 'i') return e.shiftKey ? 'file.importModel' : 'file.import';
    if (k === 'r') return 'file.script';
    if (code === 'F12') return 'file.video';
    if (code === 'Numpad1') return 'view.back';
    if (code === 'Numpad3') return 'view.left';
    if (code === 'Digit7' || code === 'Numpad7') return 'view.bottom';
    if (e.altKey && (code === 'Digit0' || code === 'Numpad0')) return 'view.setCamera';
    return null;
  }
  if (e.altKey) {
    if (code === 'KeyI') return 'anim.deleteKey';
    if (code === 'KeyH') return 'edit.unhideAll';
    if (code === 'KeyA') return 'edit.deselect';
    return null;
  }
  if (e.shiftKey) {
    if (code === 'KeyZ') return 'view.wireframe';
    if (code === 'KeyD') return 'edit.duplicate';
    if (code === 'KeyL') return 'add.library';
    if (code === 'ArrowLeft') return 'anim.toStart';
    if (code === 'ArrowRight') return 'anim.toEnd';
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
    case 'KeyM': return 'object.moveToCollection';
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
    case 'KeyI': return 'anim.insertKey';
    case 'ArrowRight': return 'anim.nextFrame';
    case 'ArrowLeft': return 'anim.prevFrame';
    case 'ArrowUp': return 'anim.nextKey';
    case 'ArrowDown': return 'anim.prevKey';
  }
  return null;
}
