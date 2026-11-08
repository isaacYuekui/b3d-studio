// The command system: the ONLY way the scene changes.
//
// Every edit (UI click, keyboard shortcut, gizmo drag, file import, scene scripts
// written by Claude) is expressed as a plain JSON command, validated, then applied
// by a pure function. This gives us:
//   - undo/redo for free (snapshots of immutable docs)
//   - a safe surface for AI: Claude emits JSON commands, never JavaScript
//   - easy unit testing

import { BACKGROUNDS, DEFAULT_LIGHT, DEFAULT_MATERIAL, DEFAULT_WORLD, IDENTITY, LIGHT_TYPES, OBJECT_TYPES, PRIMITIVES } from './types';
import { DEFAULT_ANIMATION, EASINGS, animationOf, transformAt, upsertKey } from './animation';
import type { Animation, Easing, PoseKey } from './animation';
import type { ArmatureData, Bone, BonePose, Background, LightData, LightType, Material, MeshData, Modifiers, ObjectType, PrimitiveParams, PrimitiveType, SceneDoc, SceneObject, Transform, Vec3, World } from './types';
import { primitiveMesh } from './mesh/primitives';
import { applyModifiers } from './mesh/modifiers';
import { EDIT_OPS, runEditSteps } from './mesh/script';
import type { EditStep } from './mesh/script';
import { MeshOpError } from './mesh/ops';

export interface AddCommand {
  type: 'add';
  /** Object type: a primitive, 'mesh' (custom geometry), 'light' or 'empty'. */
  primitive: ObjectType;
  /** Optional stable id so later commands in a script can refer to this object. */
  id?: string;
  name?: string;
  transform?: Partial<Transform>;
  /** Shorthand for material.baseColor. */
  color?: string;
  material?: Partial<Material>;
  params?: PrimitiveParams;
  mesh?: MeshData;
  light?: Partial<LightData>;
  /** Library model id (type 'model'). */
  asset?: string;
  /** Bones (type 'armature'). */
  armature?: ArmatureData;
  parentId?: string | null;
}

export type Command =
  | AddCommand
  | { type: 'delete'; ids: string[] }
  | { type: 'duplicate'; ids: string[] }
  | { type: 'transform'; id: string; position?: Vec3; rotation?: Vec3; scale?: Vec3 }
  | { type: 'rename'; id: string; name: string }
  | { type: 'setParent'; id: string; parentId: string | null }
  | { type: 'setColor'; id: string; color: string }
  | { type: 'setMaterial'; id: string; material: Partial<Material> }
  | { type: 'setLight'; id: string; light: Partial<LightData> }
  | { type: 'setVisible'; id: string; visible: boolean }
  /** Replace an object's geometry. A primitive becomes an editable 'mesh' object. */
  | { type: 'setMesh'; id: string; mesh: MeshData }
  /** Turn a primitive into an editable polygon mesh (Blender topology). */
  | { type: 'convertToMesh'; id: string }
  /** Set modifiers (merged per modifier; null removes one). Mesh objects only; primitives are converted. */
  | { type: 'setModifiers'; id: string; modifiers: { mirror?: Modifiers['mirror'] | null; subdivision?: Modifiers['subdivision'] | null } }
  /** Bake the modifiers into the mesh. */
  | { type: 'applyModifiers'; id: string }
  /** Replace an armature's bones. */
  | { type: 'setArmature'; id: string; armature: ArmatureData }
  /** Pose bones (merged per bone; `reset` clears the rest first). */
  | { type: 'setPose'; id: string; pose: Record<string, BonePose>; reset?: boolean }
  /** Key a bone's pose at a frame. */
  | { type: 'setPoseKey'; id: string; bone: string; frame: number; rotation: Vec3; location?: Vec3; easing?: Easing }
  | { type: 'deletePoseKey'; id: string; bone: string; frame: number }
  /** Remove a bone's keys (or all of the armature's with bone null). */
  | { type: 'clearPoseKeys'; id: string; bone: string | null }
  /** Deform a mesh (or shape, converted) with an armature, or stop (null). */
  | { type: 'setSkin'; id: string; armature: string | null }
  /** Model with Edit Mode operators: each step selects elements by a query and applies an op. */
  | { type: 'editMesh'; id: string; steps: EditStep[] }
  | { type: 'setWorld'; world: Partial<World> }
  | { type: 'setCamera'; position: Vec3; target: Vec3 }
  | { type: 'setKeyframe'; id: string; frame: number; transform?: Transform; easing?: Easing }
  | { type: 'deleteKeyframe'; id: string; frame: number }
  | { type: 'setCameraKey'; frame: number; position: Vec3; target: Vec3; easing?: Easing }
  | { type: 'deleteCameraKey'; frame: number }
  | { type: 'clearAnimation'; id: string | null }
  | { type: 'setAnimation'; fps?: number; start?: number; end?: number }
  | { type: 'batch'; commands: Command[] }
  | { type: 'replaceScene'; doc: SceneDoc };

export interface ApplyResult {
  doc: SceneDoc;
  /** Ids created by the command (add / duplicate), so the UI can select them. */
  created: string[];
}

export class CommandError extends Error {}

export type IdGen = () => string;

let counter = 0;
export const defaultIdGen: IdGen = () =>
  `obj_${Date.now().toString(36)}_${(counter++).toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

export const LIMITS = { vertices: 200_000, faces: 200_000, commands: 5_000, objects: 10_000 };

// ---------------------------------------------------------------- helpers

/** Blender-style unique names: Cube, Cube.001, Cube.002 ... */
export function uniqueName(doc: SceneDoc, base: string): string {
  const taken = new Set(Object.values(doc.objects).map((o) => o.name));
  if (!taken.has(base)) return base;
  const stem = base.replace(/\.\d{3}$/, '');
  for (let i = 1; i < 10000; i++) {
    const candidate = `${stem}.${String(i).padStart(3, '0')}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${stem}.${Date.now()}`;
}

export function childrenOf(doc: SceneDoc, id: string | null): string[] {
  return doc.order.filter((oid) => doc.objects[oid]?.parentId === id);
}

/** id plus all descendants, parents before children. */
export function subtree(doc: SceneDoc, id: string): string[] {
  const out: string[] = [id];
  for (let i = 0; i < out.length; i++) out.push(...childrenOf(doc, out[i]));
  return out;
}

function isAncestor(doc: SceneDoc, maybeAncestor: string, id: string): boolean {
  let cur = doc.objects[id]?.parentId ?? null;
  while (cur) {
    if (cur === maybeAncestor) return true;
    cur = doc.objects[cur]?.parentId ?? null;
  }
  return false;
}

function requireObj(doc: SceneDoc, id: string): SceneObject {
  const o = doc.objects[id];
  if (!o) throw new CommandError(`Object not found: ${id}`);
  return o;
}

function withObject(doc: SceneDoc, obj: SceneObject): SceneDoc {
  return { ...doc, objects: { ...doc.objects, [obj.id]: obj } };
}

function withAnimation(doc: SceneDoc, animation: Animation): SceneDoc {
  return { ...doc, animation };
}

function requireArmature(doc: SceneDoc, id: string): SceneObject {
  const o = requireObj(doc, id);
  if (o.type !== 'armature' || !o.armature) throw new CommandError(`${o.name} is not an armature`);
  return o;
}

/** A mesh-object version of o: primitives are converted to their polygon mesh. */
function asMesh(o: SceneObject): SceneObject {
  if (o.type === 'mesh') return o;
  if (!(PRIMITIVES as readonly string[]).includes(o.type)) throw new CommandError(`${o.name} cannot be edited as a mesh`);
  const next: SceneObject = { ...o, type: 'mesh', mesh: primitiveMesh(o.type as PrimitiveType, o.params) };
  delete next.params;
  return next;
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function defaultName(cmd: AddCommand): string {
  if (cmd.primitive === 'model' && cmd.asset) return cmd.asset.replace(/_\d+$/, '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  if (cmd.primitive === 'light') return `${capitalize(cmd.light?.type ?? 'point')} Light`;
  return capitalize(cmd.primitive);
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

// ---------------------------------------------------------------- apply

export function applyCommand(doc: SceneDoc, cmd: Command, idGen: IdGen = defaultIdGen): ApplyResult {
  switch (cmd.type) {
    case 'add': {
      if (cmd.parentId) requireObj(doc, cmd.parentId);
      if (cmd.id !== undefined && doc.objects[cmd.id]) throw new CommandError(`Id already in use: ${cmd.id}`);
      if (cmd.primitive === 'mesh' && !cmd.mesh) throw new CommandError('A mesh object needs mesh data');
      if (cmd.primitive === 'model' && !cmd.asset) throw new CommandError('A model object needs an asset id from the library');
      const id = cmd.id ?? idGen();
      const lightType: LightType = cmd.light?.type ?? 'point';
      const obj: SceneObject = {
        id,
        name: uniqueName(doc, cmd.name?.trim() || defaultName(cmd)),
        type: cmd.primitive,
        parentId: cmd.parentId ?? null,
        transform: {
          position: cmd.transform?.position ?? [...IDENTITY.position],
          rotation: cmd.transform?.rotation ?? [...IDENTITY.rotation],
          scale: cmd.transform?.scale ?? [...IDENTITY.scale],
        },
        visible: true,
        material: { ...DEFAULT_MATERIAL, ...(cmd.color ? { baseColor: cmd.color } : {}), ...cmd.material },
      };
      if (cmd.params) obj.params = { ...cmd.params };
      if (cmd.primitive === 'mesh' && cmd.mesh) obj.mesh = clone(cmd.mesh);
      if (cmd.primitive === 'light') obj.light = { ...DEFAULT_LIGHT[lightType], ...cmd.light, type: lightType };
      if (cmd.primitive === 'model') obj.asset = cmd.asset;
      if (cmd.primitive === 'armature') obj.armature = clone(cmd.armature ?? { bones: [{ name: 'Bone', parent: null, head: [0, 0, 0], tail: [0, 0, 1] }] });
      return { doc: { ...doc, objects: { ...doc.objects, [id]: obj }, order: [...doc.order, id] }, created: [id] };
    }

    case 'delete': {
      const doomed = new Set<string>();
      for (const id of cmd.ids) if (doc.objects[id]) subtree(doc, id).forEach((x) => doomed.add(x));
      if (doomed.size === 0) return { doc, created: [] };
      const objects: Record<string, SceneObject> = {};
      for (const [id, o] of Object.entries(doc.objects)) if (!doomed.has(id)) objects[id] = o;
      let animation = doc.animation;
      if (animation && [...doomed].some((id) => animation!.tracks[id] || animation!.poses?.[id])) {
        const tracks = { ...animation.tracks };
        const poses = { ...animation.poses };
        doomed.forEach((id) => (delete tracks[id], delete poses[id]));
        animation = { ...animation, tracks, poses };
      }
      // Meshes skinned to a deleted armature keep their rest shape.
      for (const [id, o] of Object.entries(objects)) if (o.skin && doomed.has(o.skin.armature)) {
        const { skin: _drop, ...rest } = o;
        void _drop;
        objects[id] = rest;
      }
      return { doc: { ...doc, objects, order: doc.order.filter((id) => !doomed.has(id)), ...(animation ? { animation } : {}) }, created: [] };
    }

    case 'duplicate': {
      let next = doc;
      const created: string[] = [];
      // Skip ids whose ancestor is also being duplicated (it comes along with the subtree).
      const roots = cmd.ids.filter((id) => doc.objects[id] && !cmd.ids.some((o) => o !== id && isAncestor(doc, o, id)));
      for (const rootId of roots) {
        const map = new Map<string, string>();
        for (const srcId of subtree(doc, rootId)) {
          const src = doc.objects[srcId];
          const newId = idGen();
          map.set(srcId, newId);
          const isRoot = srcId === rootId;
          const copy: SceneObject = {
            ...clone(src),
            id: newId,
            name: uniqueName(next, src.name),
            parentId: isRoot ? src.parentId : map.get(src.parentId!) ?? null,
          };
          if (isRoot) copy.transform.position[0] += 1;
          next = { ...next, objects: { ...next.objects, [newId]: copy }, order: [...next.order, newId] };
          const srcKeys = doc.animation?.tracks[srcId];
          if (srcKeys?.length) {
            const keys = clone(srcKeys);
            if (isRoot) keys.forEach((k) => (k.transform.position[0] += 1));
            const anim = animationOf(next);
            next = { ...next, animation: { ...anim, tracks: { ...anim.tracks, [newId]: keys } } };
          }
          const srcPoses = doc.animation?.poses?.[srcId];
          if (srcPoses) {
            const anim = animationOf(next);
            next = { ...next, animation: { ...anim, poses: { ...anim.poses, [newId]: clone(srcPoses) } } };
          }
          if (isRoot) created.push(newId);
        }
        // Copies skinned to a copied armature follow the copy.
        for (const newId of map.values()) {
          const o = next.objects[newId];
          if (o.skin && map.has(o.skin.armature)) next = withObject(next, { ...o, skin: { armature: map.get(o.skin.armature)! } });
        }
      }
      return { doc: next, created };
    }

    case 'transform': {
      const o = requireObj(doc, cmd.id);
      const transform: Transform = {
        position: cmd.position ? [...cmd.position] : o.transform.position,
        rotation: cmd.rotation ? [...cmd.rotation] : o.transform.rotation,
        scale: cmd.scale ? [...cmd.scale] : o.transform.scale,
      };
      return { doc: withObject(doc, { ...o, transform }), created: [] };
    }

    case 'rename': {
      const o = requireObj(doc, cmd.id);
      const trimmed = cmd.name.trim();
      if (!trimmed || trimmed === o.name) return { doc, created: [] };
      const others = { ...doc, objects: { ...doc.objects } };
      delete others.objects[o.id];
      return { doc: withObject(doc, { ...o, name: uniqueName(others, trimmed) }), created: [] };
    }

    case 'setParent': {
      const o = requireObj(doc, cmd.id);
      if (cmd.parentId !== null) {
        requireObj(doc, cmd.parentId);
        if (cmd.parentId === cmd.id || isAncestor(doc, cmd.id, cmd.parentId))
          throw new CommandError('Cannot parent an object to itself or its own child');
      }
      return { doc: withObject(doc, { ...o, parentId: cmd.parentId }), created: [] };
    }

    case 'setColor': {
      const o = requireObj(doc, cmd.id);
      return { doc: withObject(doc, { ...o, material: { ...o.material, baseColor: cmd.color } }), created: [] };
    }

    case 'setMaterial': {
      const o = requireObj(doc, cmd.id);
      return { doc: withObject(doc, { ...o, material: { ...o.material, ...cmd.material } }), created: [] };
    }

    case 'setLight': {
      const o = requireObj(doc, cmd.id);
      if (!o.light) throw new CommandError(`${o.name} is not a light`);
      return { doc: withObject(doc, { ...o, light: { ...o.light, ...cmd.light } }), created: [] };
    }

    case 'setVisible': {
      const o = requireObj(doc, cmd.id);
      return { doc: withObject(doc, { ...o, visible: cmd.visible }), created: [] };
    }

    case 'setMesh': {
      const o = asMesh(requireObj(doc, cmd.id));
      return { doc: withObject(doc, { ...o, mesh: clone(cmd.mesh) }), created: [] };
    }

    case 'convertToMesh': {
      const o = requireObj(doc, cmd.id);
      if (o.type === 'mesh') return { doc, created: [] };
      return { doc: withObject(doc, asMesh(o)), created: [] };
    }

    case 'setModifiers': {
      const o = asMesh(requireObj(doc, cmd.id));
      const mods: Modifiers = { ...o.modifiers };
      for (const k of ['mirror', 'subdivision'] as const) {
        const v = cmd.modifiers[k];
        if (v === null) delete mods[k];
        else if (v !== undefined) (mods as Record<string, unknown>)[k] = { ...(mods[k] ?? {}), ...v };
      }
      const next: SceneObject = { ...o, modifiers: mods };
      if (!Object.keys(mods).length) delete next.modifiers;
      return { doc: withObject(doc, next), created: [] };
    }

    case 'setArmature': {
      const o = requireArmature(doc, cmd.id);
      return { doc: withObject(doc, { ...o, armature: clone(cmd.armature) }), created: [] };
    }

    case 'setPose': {
      const o = requireArmature(doc, cmd.id);
      const names = new Set(o.armature!.bones.map((b) => b.name));
      for (const b of Object.keys(cmd.pose)) if (!names.has(b)) throw new CommandError(`${o.name} has no bone "${b}"`);
      const pose = { ...(cmd.reset ? {} : o.pose), ...clone(cmd.pose) };
      return { doc: withObject(doc, { ...o, pose }), created: [] };
    }

    case 'setPoseKey': {
      const o = requireArmature(doc, cmd.id);
      if (!o.armature!.bones.some((b) => b.name === cmd.bone)) throw new CommandError(`${o.name} has no bone "${cmd.bone}"`);
      const anim = animationOf(doc);
      const arm = { ...anim.poses?.[cmd.id] };
      const prev = arm[cmd.bone]?.find((k) => k.frame === cmd.frame);
      const key: PoseKey = { frame: cmd.frame, rotation: [...cmd.rotation], easing: cmd.easing ?? prev?.easing ?? 'ease', ...(cmd.location ? { location: [...cmd.location] as Vec3 } : {}) };
      arm[cmd.bone] = upsertKey(arm[cmd.bone] ?? [], key);
      return { doc: { ...doc, animation: { ...anim, poses: { ...anim.poses, [cmd.id]: arm } } }, created: [] };
    }

    case 'deletePoseKey': {
      const anim = animationOf(doc);
      const keys = anim.poses?.[cmd.id]?.[cmd.bone];
      if (!keys?.some((k) => k.frame === cmd.frame)) return { doc, created: [] };
      const arm = { ...anim.poses![cmd.id], [cmd.bone]: keys.filter((k) => k.frame !== cmd.frame) };
      if (!arm[cmd.bone].length) delete arm[cmd.bone];
      return { doc: { ...doc, animation: { ...anim, poses: { ...anim.poses, [cmd.id]: arm } } }, created: [] };
    }

    case 'clearPoseKeys': {
      const anim = animationOf(doc);
      if (!anim.poses?.[cmd.id]) return { doc, created: [] };
      const poses = { ...anim.poses };
      if (cmd.bone === null) delete poses[cmd.id];
      else {
        const arm = { ...poses[cmd.id] };
        delete arm[cmd.bone];
        poses[cmd.id] = arm;
      }
      return { doc: { ...doc, animation: { ...anim, poses } }, created: [] };
    }

    case 'setSkin': {
      if (cmd.armature === null) {
        const o = requireObj(doc, cmd.id);
        const { skin: _drop, ...rest } = o;
        void _drop;
        return { doc: withObject(doc, rest), created: [] };
      }
      requireArmature(doc, cmd.armature);
      const o = asMesh(requireObj(doc, cmd.id));
      return { doc: withObject(doc, { ...o, skin: { armature: cmd.armature } }), created: [] };
    }

    case 'editMesh': {
      const o = asMesh(requireObj(doc, cmd.id));
      let mesh: MeshData;
      try {
        mesh = runEditSteps(o.mesh!, cmd.steps);
      } catch (e) {
        throw new CommandError(`editMesh ${o.name}: ${e instanceof MeshOpError || e instanceof Error ? e.message : String(e)}`);
      }
      if (mesh.vertices.length > LIMITS.vertices || mesh.faces.length > LIMITS.faces) throw new CommandError(`editMesh ${o.name}: mesh too large`);
      return { doc: withObject(doc, { ...o, mesh }), created: [] };
    }

    case 'applyModifiers': {
      const o = requireObj(doc, cmd.id);
      if (o.type !== 'mesh' || !o.modifiers) return { doc, created: [] };
      const next: SceneObject = { ...o, mesh: applyModifiers(o.mesh!, o.modifiers) };
      delete next.modifiers;
      return { doc: withObject(doc, next), created: [] };
    }

    case 'setWorld':
      return { doc: { ...doc, world: { ...DEFAULT_WORLD, ...doc.world, ...cmd.world } }, created: [] };

    case 'setCamera':
      return { doc: { ...doc, camera: { position: [...cmd.position], target: [...cmd.target] } }, created: [] };

    case 'setKeyframe': {
      requireObj(doc, cmd.id);
      const anim = animationOf(doc);
      const transform = cmd.transform ?? transformAt(doc, cmd.id, cmd.frame)!;
      const prev = anim.tracks[cmd.id]?.find((k) => k.frame === cmd.frame);
      const key = { frame: cmd.frame, transform: clone(transform), easing: cmd.easing ?? prev?.easing ?? 'ease' };
      return { doc: withAnimation(doc, { ...anim, tracks: { ...anim.tracks, [cmd.id]: upsertKey(anim.tracks[cmd.id] ?? [], key) } }), created: [] };
    }

    case 'deleteKeyframe': {
      const anim = animationOf(doc);
      const keys = anim.tracks[cmd.id];
      if (!keys?.some((k) => k.frame === cmd.frame)) return { doc, created: [] };
      const rest = keys.filter((k) => k.frame !== cmd.frame);
      const tracks = { ...anim.tracks };
      if (rest.length) tracks[cmd.id] = rest;
      else delete tracks[cmd.id];
      // The object keeps the pose of its last remaining key, so nothing jumps.
      const o = doc.objects[cmd.id];
      const base = !rest.length && o ? withObject(doc, { ...o, transform: clone(keys[0].transform) }) : doc;
      return { doc: withAnimation(base, { ...anim, tracks }), created: [] };
    }

    case 'setCameraKey': {
      const anim = animationOf(doc);
      const prev = anim.camera.find((k) => k.frame === cmd.frame);
      const key = { frame: cmd.frame, position: [...cmd.position] as Vec3, target: [...cmd.target] as Vec3, easing: cmd.easing ?? prev?.easing ?? 'ease' };
      return { doc: withAnimation(doc, { ...anim, camera: upsertKey(anim.camera, key) }), created: [] };
    }

    case 'deleteCameraKey': {
      const anim = animationOf(doc);
      if (!anim.camera.some((k) => k.frame === cmd.frame)) return { doc, created: [] };
      return { doc: withAnimation(doc, { ...anim, camera: anim.camera.filter((k) => k.frame !== cmd.frame) }), created: [] };
    }

    case 'clearAnimation': {
      const anim = animationOf(doc);
      if (cmd.id === null) return { doc: withAnimation(doc, { ...anim, camera: [] }), created: [] };
      if (!anim.tracks[cmd.id]) return { doc, created: [] };
      const tracks = { ...anim.tracks };
      delete tracks[cmd.id];
      return { doc: withAnimation(doc, { ...anim, tracks }), created: [] };
    }

    case 'setAnimation': {
      const anim = animationOf(doc);
      const next = { ...anim, ...(cmd.fps !== undefined ? { fps: cmd.fps } : {}), ...(cmd.start !== undefined ? { start: cmd.start } : {}), ...(cmd.end !== undefined ? { end: cmd.end } : {}) };
      if (next.end <= next.start) throw new CommandError('The end frame must be after the start frame');
      return { doc: withAnimation(doc, next), created: [] };
    }

    case 'batch': {
      // Atomic: any failure throws and the original doc is untouched (we never mutate).
      let next = doc;
      const created: string[] = [];
      cmd.commands.forEach((c, i) => {
        try {
          const r = applyCommand(next, c, idGen);
          next = r.doc;
          created.push(...r.created);
        } catch (e) {
          throw new CommandError(`Command ${i + 1} (${c.type}): ${e instanceof Error ? e.message : String(e)}`);
        }
      });
      return { doc: next, created };
    }

    case 'replaceScene':
      return { doc: cmd.doc, created: [] };
  }
}

// ---------------------------------------------------------------- validation
// Validates untrusted input (imported files, scene scripts, future AI tool calls).
// Returns typed data or throws CommandError with a readable reason.

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isVec3 = (v: unknown): v is Vec3 => Array.isArray(v) && v.length === 3 && v.every(isNum);
const isStr = (v: unknown, max = 200): v is string => typeof v === 'string' && v.length <= max;
const isId = (v: unknown): v is string => isStr(v, 100) && v.length > 0;
const isColor = (v: unknown): v is string => typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v);
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const inRange = (v: unknown, lo: number, hi: number): v is number => isNum(v) && v >= lo && v <= hi;

function fail(msg: string): never {
  throw new CommandError(msg);
}

function validateMaterial(v: unknown, partial: boolean): Partial<Material> {
  if (!isRecord(v)) fail('material must be an object');
  const m: Partial<Material> = {};
  const req = (k: keyof Material) => !partial && v[k] === undefined && fail(`material.${k} missing`);
  (['baseColor', 'metallic', 'roughness', 'emission', 'emissionStrength', 'alpha'] as const).forEach(req);
  if (v.texture !== undefined) m.texture = v.texture === null || (typeof v.texture === 'string' && ASSET_ID.test(v.texture)) ? (v.texture as string | null) : fail('material.texture must be a library texture id or null');
  if (v.textureScale !== undefined) m.textureScale = inRange(v.textureScale, 0.01, 1000) ? v.textureScale : fail('material.textureScale must be 0.01..1000');
  if (v.baseColor !== undefined) m.baseColor = isColor(v.baseColor) ? v.baseColor : fail('material.baseColor must be #rrggbb');
  if (v.emission !== undefined) m.emission = isColor(v.emission) ? v.emission : fail('material.emission must be #rrggbb');
  if (v.metallic !== undefined) m.metallic = inRange(v.metallic, 0, 1) ? v.metallic : fail('material.metallic must be 0..1');
  if (v.roughness !== undefined) m.roughness = inRange(v.roughness, 0, 1) ? v.roughness : fail('material.roughness must be 0..1');
  if (v.alpha !== undefined) m.alpha = inRange(v.alpha, 0, 1) ? v.alpha : fail('material.alpha must be 0..1');
  if (v.emissionStrength !== undefined)
    m.emissionStrength = inRange(v.emissionStrength, 0, 1000) ? v.emissionStrength : fail('material.emissionStrength must be 0..1000');
  return m;
}

const ASSET_ID = /^[A-Za-z0-9_.-]{1,80}$/;

export function validateWorld(v: unknown): Partial<World> {
  if (!isRecord(v)) fail('world must be an object');
  const w: Partial<World> = {};
  if (v.hdri !== undefined) w.hdri = v.hdri === null || (typeof v.hdri === 'string' && ASSET_ID.test(v.hdri)) ? (v.hdri as string | null) : fail('world.hdri must be a library HDRI id or null');
  if (v.strength !== undefined) w.strength = inRange(v.strength, 0, 100) ? v.strength : fail('world.strength must be 0..100');
  if (v.rotation !== undefined) w.rotation = inRange(v.rotation, -3600, 3600) ? v.rotation : fail('world.rotation must be degrees');
  if (v.background !== undefined) w.background = BACKGROUNDS.includes(v.background as Background) ? (v.background as Background) : fail(`world.background must be one of ${BACKGROUNDS.join(', ')}`);
  if (v.color !== undefined) w.color = isColor(v.color) ? v.color : fail('world.color must be #rrggbb');
  if (v.exposure !== undefined) w.exposure = inRange(v.exposure, 0, 20) ? v.exposure : fail('world.exposure must be 0..20');
  if (v.bloom !== undefined) w.bloom = inRange(v.bloom, 0, 1) ? v.bloom : fail('world.bloom must be 0..1');
  if (v.ao !== undefined) w.ao = typeof v.ao === 'boolean' ? v.ao : fail('world.ao must be true/false');
  return w;
}

function validateLight(v: unknown, partial: boolean): Partial<LightData> {
  if (!isRecord(v)) fail('light must be an object');
  const l: Partial<LightData> = {};
  if (v.type !== undefined) l.type = LIGHT_TYPES.includes(v.type as LightType) ? (v.type as LightType) : fail(`light.type must be one of ${LIGHT_TYPES.join(', ')}`);
  else if (!partial) fail('light.type missing');
  if (v.color !== undefined) l.color = isColor(v.color) ? v.color : fail('light.color must be #rrggbb');
  if (v.power !== undefined) l.power = inRange(v.power, 0, 1_000_000) ? v.power : fail('light.power must be 0..1000000');
  if (v.spotAngle !== undefined) l.spotAngle = inRange(v.spotAngle, 1, 179) ? v.spotAngle : fail('light.spotAngle must be 1..179');
  if (v.shadows !== undefined) l.shadows = typeof v.shadows === 'boolean' ? v.shadows : fail('light.shadows must be true/false');
  return l;
}

function validateParams(v: unknown): PrimitiveParams {
  if (!isRecord(v)) fail('params must be an object');
  const p: PrimitiveParams = {};
  if (v.segments !== undefined) p.segments = Number.isInteger(v.segments) && inRange(v.segments, 3, 256) ? (v.segments as number) : fail('params.segments must be an integer 3..256');
  for (const k of ['radiusTop', 'radiusBottom', 'majorRadius', 'minorRadius'] as const) {
    if (v[k] !== undefined) p[k] = inRange(v[k], 0, 10000) ? (v[k] as number) : fail(`params.${k} must be 0..10000`);
  }
  return p;
}

export function validateMeshData(v: unknown): MeshData {
  if (!isRecord(v) || !Array.isArray(v.vertices) || !Array.isArray(v.faces)) fail('mesh needs vertices and faces arrays');
  if (v.vertices.length > LIMITS.vertices) fail(`mesh has too many vertices (max ${LIMITS.vertices})`);
  if (v.faces.length > LIMITS.faces) fail(`mesh has too many faces (max ${LIMITS.faces})`);
  const n = v.vertices.length;
  const vertices = v.vertices.map((p, i) => (isVec3(p) ? ([p[0], p[1], p[2]] as Vec3) : fail(`mesh vertex ${i} must be [x,y,z]`)));
  const faces = v.faces.map((f, i) => {
    if (!Array.isArray(f) || f.length < 3 || f.length > 1024) fail(`mesh face ${i} must list 3..1024 vertex indices`);
    return f.map((idx) => (Number.isInteger(idx) && idx >= 0 && idx < n ? (idx as number) : fail(`mesh face ${i} has invalid index ${String(idx)}`)));
  });
  return { vertices, faces, smooth: v.smooth === true };
}

const BONE_NAME = /^[A-Za-z0-9 _.\-]{1,64}$/;

export function validateArmature(v: unknown): ArmatureData {
  if (!isRecord(v) || !Array.isArray(v.bones) || !v.bones.length || v.bones.length > 256) fail('armature needs 1..256 bones');
  const names = new Set<string>();
  const bones: Bone[] = v.bones.map((b, i) => {
    if (!isRecord(b) || typeof b.name !== 'string' || !BONE_NAME.test(b.name)) fail(`bone ${i}: name invalid (letters, digits, space _ . -)`);
    if (names.has(b.name)) fail(`bone "${b.name}" appears twice`);
    names.add(b.name);
    if (!isVec3(b.head) || !isVec3(b.tail)) fail(`bone "${b.name}": head and tail must be [x,y,z]`);
    if (Math.hypot(b.tail[0] - b.head[0], b.tail[1] - b.head[1], b.tail[2] - b.head[2]) < 1e-5) fail(`bone "${b.name}" has zero length`);
    const out: Bone = { name: b.name, parent: null, head: [...b.head] as Vec3, tail: [...b.tail] as Vec3 };
    if (b.parent !== undefined && b.parent !== null) {
      if (typeof b.parent !== 'string') fail(`bone "${b.name}": parent must be a bone name`);
      out.parent = b.parent;
    }
    if (b.roll !== undefined) out.roll = inRange(b.roll, -360, 360) ? (b.roll as number) : fail(`bone "${b.name}": roll must be -360..360`);
    if (b.deform !== undefined) out.deform = typeof b.deform === 'boolean' ? b.deform : fail(`bone "${b.name}": deform must be true/false`);
    return out;
  });
  for (const b of bones) if (b.parent && !names.has(b.parent)) fail(`bone "${b.name}": parent "${b.parent}" not found`);
  // No cycles
  const byName = new Map(bones.map((b) => [b.name, b]));
  for (const b of bones) {
    let cur = b.parent, steps = 0;
    while (cur && steps++ <= bones.length) cur = byName.get(cur)?.parent ?? null;
    if (steps > bones.length) fail(`bone "${b.name}": parent loop`);
  }
  return { bones };
}

function validatePose(v: unknown): Record<string, BonePose> {
  if (!isRecord(v)) fail('pose must be { boneName: { rotation: [x,y,z] } }');
  const out: Record<string, BonePose> = {};
  for (const [name, p] of Object.entries(v)) {
    if (!BONE_NAME.test(name) || !isRecord(p)) fail(`pose.${name} invalid`);
    const rotation = p.rotation === undefined ? ([0, 0, 0] as Vec3) : isVec3(p.rotation) ? ([...p.rotation] as Vec3) : fail(`pose.${name}.rotation must be [x,y,z] degrees`);
    out[name] = { rotation };
    if (p.location !== undefined) out[name].location = isVec3(p.location) ? ([...p.location] as Vec3) : fail(`pose.${name}.location must be [x,y,z]`);
  }
  return out;
}

const SELECT_MODES_ = ['vert', 'edge', 'face'];

function validateEditStep(raw: unknown, i: number): EditStep {
  const at = `step ${i + 1}`;
  if (!isRecord(raw) || typeof raw.op !== 'string' || !(EDIT_OPS as readonly string[]).includes(raw.op)) fail(`${at}: op must be one of ${EDIT_OPS.join(', ')}`);
  const step: EditStep = { op: raw.op };
  for (const [k, val] of Object.entries(raw)) {
    if (k === 'op') continue;
    if (k === 'select') {
      if (!isRecord(val)) fail(`${at}: select must be an object`);
      const q: Record<string, unknown> = {};
      for (const [qk, qv] of Object.entries(val)) {
        switch (qk) {
          case 'mode':
            if (!SELECT_MODES_.includes(qv as string)) fail(`${at}: select.mode must be vert, edge or face`);
            break;
          case 'last': case 'all': case 'loop': case 'linked':
            if (typeof qv !== 'boolean') fail(`${at}: select.${qk} must be true/false`);
            break;
          case 'normal': case 'nearest':
            if (!isVec3(qv)) fail(`${at}: select.${qk} must be [x,y,z]`);
            break;
          case 'angle': case 'sharp':
            if (!inRange(qv, 0, 180)) fail(`${at}: select.${qk} must be 0..180 degrees`);
            break;
          case 'box':
            if (!isRecord(qv) || !isVec3(qv.min) || !isVec3(qv.max)) fail(`${at}: select.box needs min and max [x,y,z]`);
            break;
          case 'indices':
            if (!Array.isArray(qv) || qv.length > 100000 || !qv.every((x) => (Number.isInteger(x) && (x as number) >= 0) || (typeof x === 'string' && /^\d+_\d+$/.test(x)))) fail(`${at}: select.indices must be vertex/face numbers or edge keys "a_b"`);
            break;
          default:
            fail(`${at}: unknown select field "${qk}"`);
        }
        q[qk] = qv;
      }
      step.select = q;
      continue;
    }
    if (typeof val === 'number') {
      if (!Number.isFinite(val) || Math.abs(val) > 1e5) fail(`${at}: ${k} out of range`);
    } else if (isVec3(val)) {
      if (val.some((x) => Math.abs(x) > 1e5)) fail(`${at}: ${k} out of range`);
    } else if (typeof val !== 'boolean' && !(k === 'along' && val === 'normal')) fail(`${at}: ${k} must be a number, [x,y,z] or true/false`);
    step[k] = val;
  }
  for (const k of ['cuts', 'segments'] as const) if (step[k] !== undefined && !inRange(step[k], 1, 32)) fail(`${at}: ${k} must be 1..32`);
  return step;
}

export function validateModifiers(v: unknown): Modifiers {
  if (!isRecord(v)) fail('modifiers must be an object');
  const out: Modifiers = {};
  if (v.mirror !== undefined) {
    const m = v.mirror;
    if (!isRecord(m)) fail('modifiers.mirror must be an object');
    const b = (k: string) => (m[k] === undefined ? false : typeof m[k] === 'boolean' ? (m[k] as boolean) : fail(`modifiers.mirror.${k} must be true/false`));
    out.mirror = { x: b('x'), y: b('y'), z: b('z') };
    if (m.clip !== undefined) out.mirror.clip = b('clip');
    if (m.merge !== undefined) out.mirror.merge = inRange(m.merge, 0, 1) ? (m.merge as number) : fail('modifiers.mirror.merge must be 0..1');
  }
  if (v.subdivision !== undefined) {
    const s = v.subdivision;
    if (!isRecord(s) || !(Number.isInteger(s.levels) && inRange(s.levels, 0, 4))) fail('modifiers.subdivision.levels must be 0..4');
    out.subdivision = { levels: s.levels as number };
  }
  return out;
}

/** Upgrade a v1 object (single `color` field) to the current shape before validation. */
function migrateObject(v: Record<string, unknown>): Record<string, unknown> {
  if (v.material === undefined && isColor(v.color)) {
    const { color, ...rest } = v;
    return { ...rest, material: { ...DEFAULT_MATERIAL, baseColor: color } };
  }
  return v;
}

export function validateSceneObject(raw: unknown): SceneObject {
  if (!isRecord(raw)) fail('object must be a record');
  const v = migrateObject(raw);
  const t = v.transform;
  if (!isId(v.id)) fail('object.id invalid');
  if (!isStr(v.name) || !v.name) fail(`object ${v.id}: name invalid`);
  if (!OBJECT_TYPES.includes(v.type as ObjectType)) fail(`object ${v.id}: unknown type ${String(v.type)}`);
  if (!(v.parentId === null || isId(v.parentId))) fail(`object ${v.id}: parentId invalid`);
  if (!isRecord(t) || !isVec3(t.position) || !isVec3(t.rotation) || !isVec3(t.scale)) fail(`object ${v.id}: transform invalid`);
  if (typeof v.visible !== 'boolean') fail(`object ${v.id}: visible invalid`);
  const obj: SceneObject = {
    id: v.id,
    name: v.name,
    type: v.type as ObjectType,
    parentId: v.parentId as string | null,
    transform: { position: [...t.position], rotation: [...t.rotation], scale: [...t.scale] },
    visible: v.visible,
    material: { ...DEFAULT_MATERIAL, ...validateMaterial(v.material, false) },
  };
  if (v.params !== undefined) obj.params = validateParams(v.params);
  if (obj.type === 'mesh') obj.mesh = validateMeshData(v.mesh);
  if (obj.type === 'mesh' && v.modifiers !== undefined) obj.modifiers = validateModifiers(v.modifiers);
  if (obj.type === 'light') obj.light = { ...DEFAULT_LIGHT.point, ...validateLight(v.light, false) } as LightData;
  if (obj.type === 'model') obj.asset = typeof v.asset === 'string' && ASSET_ID.test(v.asset) ? v.asset : fail(`object ${v.id}: asset invalid`);
  if (obj.type === 'armature') {
    obj.armature = validateArmature(v.armature);
    if (v.pose !== undefined) obj.pose = validatePose(v.pose);
  }
  if (obj.type === 'mesh' && v.skin !== undefined) {
    if (!isRecord(v.skin) || !isId(v.skin.armature)) fail(`object ${v.id}: skin invalid`);
    obj.skin = { armature: v.skin.armature as string };
  }
  return obj;
}

export function validateSceneDoc(v: unknown): SceneDoc {
  if (!isRecord(v) || !isRecord(v.objects) || !Array.isArray(v.order)) fail('scene must have objects and order');
  if (Object.keys(v.objects).length > LIMITS.objects) fail('scene too large');
  const objects: Record<string, SceneObject> = {};
  for (const [key, raw] of Object.entries(v.objects)) {
    const o = validateSceneObject(raw);
    if (o.id !== key) fail(`object key ${key} does not match id ${o.id}`);
    objects[key] = o;
  }
  const order = v.order.filter((id): id is string => typeof id === 'string' && id in objects);
  for (const id of Object.keys(objects)) if (!order.includes(id)) order.push(id);
  for (const o of Object.values(objects)) {
    if (o.parentId && !objects[o.parentId]) fail(`object ${o.id}: parent ${o.parentId} missing`);
  }
  for (const o of Object.values(objects)) {
    const seen = new Set<string>();
    let cur: string | null = o.id;
    while (cur) {
      if (seen.has(cur)) fail(`parent cycle at ${o.id}`);
      seen.add(cur);
      cur = objects[cur].parentId;
    }
  }
  const doc: SceneDoc = { objects, order };
  if (v.world !== undefined) doc.world = { ...DEFAULT_WORLD, ...validateWorld(v.world) };
  if (v.animation !== undefined) doc.animation = validateAnimation(v.animation, objects);
  if (v.camera !== undefined) {
    const c = v.camera;
    if (!isRecord(c) || !isVec3(c.position) || !isVec3(c.target)) fail('camera needs position and target [x,y,z]');
    doc.camera = { position: [...c.position], target: [...c.target] };
  }
  return doc;
}

const isFrame = (v: unknown): v is number => isNum(v) && v >= -100000 && v <= 1000000;
const isEasing = (v: unknown): v is Easing => EASINGS.includes(v as Easing);
const isTransform = (v: unknown): v is Transform => isRecord(v) && isVec3(v.position) && isVec3(v.rotation) && isVec3(v.scale);

export function validateAnimation(v: unknown, objects: Record<string, SceneObject>): Animation {
  if (!isRecord(v)) fail('animation must be an object');
  const fps = v.fps === undefined ? DEFAULT_ANIMATION.fps : inRange(v.fps, 1, 240) ? v.fps : fail('animation.fps must be 1..240');
  const start = v.start === undefined ? DEFAULT_ANIMATION.start : isFrame(v.start) ? v.start : fail('animation.start invalid');
  const end = v.end === undefined ? DEFAULT_ANIMATION.end : isFrame(v.end) && v.end > start ? v.end : fail('animation.end must be after start');
  const tracks: Animation['tracks'] = {};
  if (v.tracks !== undefined) {
    if (!isRecord(v.tracks)) fail('animation.tracks invalid');
    for (const [id, keys] of Object.entries(v.tracks)) {
      if (!objects[id]) continue; // drop tracks of objects that no longer exist
      if (!Array.isArray(keys) || keys.length > 100000) fail(`animation track ${id} invalid`);
      tracks[id] = keys
        .map((k, i) => {
          if (!isRecord(k) || !isFrame(k.frame) || !isTransform(k.transform)) fail(`animation track ${id}, key ${i} invalid`);
          const t = k.transform;
          return { frame: k.frame, transform: { position: [...t.position] as Vec3, rotation: [...t.rotation] as Vec3, scale: [...t.scale] as Vec3 }, easing: isEasing(k.easing) ? k.easing : 'ease' as Easing };
        })
        .sort((a, b) => a.frame - b.frame);
    }
  }
  const camera = v.camera === undefined ? [] : Array.isArray(v.camera)
    ? v.camera.map((k, i) => {
        if (!isRecord(k) || !isFrame(k.frame) || !isVec3(k.position) || !isVec3(k.target)) fail(`camera key ${i} invalid`);
        return { frame: k.frame, position: [...k.position] as Vec3, target: [...k.target] as Vec3, easing: isEasing(k.easing) ? k.easing : 'ease' as Easing };
      }).sort((a, b) => a.frame - b.frame)
    : fail('animation.camera invalid');
  let poses: Animation['poses'];
  if (v.poses !== undefined) {
    if (!isRecord(v.poses)) fail('animation.poses invalid');
    poses = {};
    for (const [id, bones] of Object.entries(v.poses)) {
      if (!objects[id] || !isRecord(bones)) continue;
      poses[id] = {};
      for (const [bone, keys] of Object.entries(bones)) {
        if (!Array.isArray(keys) || keys.length > 100000) fail(`pose keys ${id}.${bone} invalid`);
        poses[id][bone] = keys
          .map((k, i) => {
            if (!isRecord(k) || !isFrame(k.frame) || !isVec3(k.rotation) || (k.location !== undefined && !isVec3(k.location))) fail(`pose key ${id}.${bone}[${i}] invalid`);
            return { frame: k.frame, rotation: [...k.rotation] as Vec3, ...(k.location ? { location: [...(k.location as Vec3)] as Vec3 } : {}), easing: isEasing(k.easing) ? k.easing : ('ease' as Easing) };
          })
          .sort((a, b) => a.frame - b.frame);
      }
    }
  }
  return { fps, start, end, tracks, camera, ...(poses ? { poses } : {}) };
}

const REF_ID = /^[A-Za-z0-9_.-]{1,64}$/;

export function validateCommand(v: unknown, depth = 0): Command {
  if (!isRecord(v) || typeof v.type !== 'string') fail('command must be an object with a type');
  const optVec = (k: string) => (v[k] === undefined ? undefined : isVec3(v[k]) ? (v[k] as Vec3) : fail(`${k} must be [x,y,z]`));
  switch (v.type) {
    case 'add': {
      const type = v.primitive ?? v.object;
      if (!OBJECT_TYPES.includes(type as ObjectType)) fail(`primitive must be one of ${OBJECT_TYPES.join(', ')}`);
      if (v.id !== undefined && !(typeof v.id === 'string' && REF_ID.test(v.id))) fail('id may only use letters, digits, _ . - (max 64)');
      if (v.name !== undefined && !isStr(v.name, 100)) fail('name invalid');
      if (v.color !== undefined && !isColor(v.color)) fail('color must be #rrggbb');
      if (v.parentId !== undefined && v.parentId !== null && !isId(v.parentId)) fail('parentId invalid');
      let transform: Partial<Transform> | undefined;
      if (v.transform !== undefined) {
        if (!isRecord(v.transform)) fail('transform invalid');
        const t = v.transform;
        transform = {};
        for (const k of ['position', 'rotation', 'scale'] as const) {
          if (t[k] !== undefined) {
            if (!isVec3(t[k])) fail(`transform.${k} must be [x,y,z]`);
            transform[k] = t[k] as Vec3;
          }
        }
      }
      const cmd: AddCommand = { type: 'add', primitive: type as ObjectType };
      if (v.id !== undefined) cmd.id = v.id as string;
      if (v.name !== undefined) cmd.name = v.name as string;
      if (v.color !== undefined) cmd.color = v.color as string;
      if (v.parentId !== undefined) cmd.parentId = v.parentId as string | null;
      if (transform) cmd.transform = transform;
      if (v.material !== undefined) cmd.material = validateMaterial(v.material, true);
      if (v.params !== undefined) cmd.params = validateParams(v.params);
      if (cmd.primitive === 'mesh') cmd.mesh = validateMeshData(v.mesh);
      if (cmd.primitive === 'model') cmd.asset = typeof v.asset === 'string' && ASSET_ID.test(v.asset) ? v.asset : fail('model needs an asset id from the library (see docs/LIBRARY.md)');
      if (v.light !== undefined) cmd.light = validateLight(v.light, true);
      if (cmd.primitive === 'armature' && v.armature !== undefined) cmd.armature = validateArmature(v.armature);
      return cmd;
    }
    case 'delete':
    case 'duplicate':
      if (!Array.isArray(v.ids) || !v.ids.every(isId) || v.ids.length > 1000) fail('ids must be a list of object ids');
      return { type: v.type, ids: [...(v.ids as string[])] };
    case 'transform':
      if (!isId(v.id)) fail('id invalid');
      return { type: 'transform', id: v.id, position: optVec('position'), rotation: optVec('rotation'), scale: optVec('scale') };
    case 'rename':
      if (!isId(v.id) || !isStr(v.name, 100)) fail('rename needs id and name');
      return { type: 'rename', id: v.id, name: v.name };
    case 'setParent':
      if (!isId(v.id) || !(v.parentId === null || isId(v.parentId))) fail('setParent needs id and parentId (or null)');
      return { type: 'setParent', id: v.id, parentId: v.parentId as string | null };
    case 'setColor':
      if (!isId(v.id) || !isColor(v.color)) fail('setColor needs id and #rrggbb color');
      return { type: 'setColor', id: v.id, color: v.color };
    case 'setMaterial':
      if (!isId(v.id)) fail('setMaterial needs id');
      return { type: 'setMaterial', id: v.id, material: validateMaterial(v.material, true) };
    case 'setLight':
      if (!isId(v.id)) fail('setLight needs id');
      return { type: 'setLight', id: v.id, light: validateLight(v.light, true) };
    case 'setVisible':
      if (!isId(v.id) || typeof v.visible !== 'boolean') fail('setVisible needs id and boolean');
      return { type: 'setVisible', id: v.id, visible: v.visible };
    case 'setMesh':
      if (!isId(v.id)) fail('setMesh needs id');
      return { type: 'setMesh', id: v.id, mesh: validateMeshData(v.mesh) };
    case 'convertToMesh':
      if (!isId(v.id)) fail('convertToMesh needs id');
      return { type: 'convertToMesh', id: v.id };
    case 'setModifiers': {
      if (!isId(v.id) || !isRecord(v.modifiers)) fail('setModifiers needs id and modifiers');
      const m = v.modifiers;
      const out: { mirror?: Modifiers['mirror'] | null; subdivision?: Modifiers['subdivision'] | null } = {};
      if (m.mirror === null) out.mirror = null;
      else if (m.mirror !== undefined) out.mirror = validateModifiers({ mirror: m.mirror }).mirror;
      if (m.subdivision === null) out.subdivision = null;
      else if (m.subdivision !== undefined) out.subdivision = validateModifiers({ subdivision: m.subdivision }).subdivision;
      return { type: 'setModifiers', id: v.id, modifiers: out };
    }
    case 'setArmature':
      if (!isId(v.id)) fail('setArmature needs id');
      return { type: 'setArmature', id: v.id, armature: validateArmature(v.armature) };
    case 'setPose':
      if (!isId(v.id)) fail('setPose needs id');
      return { type: 'setPose', id: v.id, pose: validatePose(v.pose), ...(v.reset === true ? { reset: true } : {}) };
    case 'setPoseKey': {
      if (!isId(v.id) || typeof v.bone !== 'string' || !isFrame(v.frame)) fail('setPoseKey needs id, bone and frame');
      const p = validatePose({ [v.bone]: { rotation: v.rotation, location: v.location } })[v.bone];
      return { type: 'setPoseKey', id: v.id, bone: v.bone, frame: v.frame as number, rotation: p.rotation, ...(p.location ? { location: p.location } : {}), ...(isEasing(v.easing) ? { easing: v.easing } : {}) };
    }
    case 'deletePoseKey':
      if (!isId(v.id) || typeof v.bone !== 'string' || !isFrame(v.frame)) fail('deletePoseKey needs id, bone and frame');
      return { type: 'deletePoseKey', id: v.id, bone: v.bone, frame: v.frame as number };
    case 'clearPoseKeys':
      if (!isId(v.id) || !(v.bone === null || v.bone === undefined || typeof v.bone === 'string')) fail('clearPoseKeys needs id');
      return { type: 'clearPoseKeys', id: v.id, bone: (v.bone as string | undefined) ?? null };
    case 'setSkin':
      if (!isId(v.id) || !(v.armature === null || isId(v.armature))) fail('setSkin needs id and armature (or null)');
      return { type: 'setSkin', id: v.id, armature: v.armature as string | null };
    case 'editMesh': {
      if (!isId(v.id) || !Array.isArray(v.steps) || !v.steps.length || v.steps.length > 500) fail('editMesh needs id and 1..500 steps');
      const steps = v.steps.map((raw, i) => validateEditStep(raw, i));
      return { type: 'editMesh', id: v.id, steps };
    }
    case 'applyModifiers':
      if (!isId(v.id)) fail('applyModifiers needs id');
      return { type: 'applyModifiers', id: v.id };
    case 'setWorld':
      return { type: 'setWorld', world: validateWorld(v.world) };
    case 'setCamera':
      if (!isVec3(v.position) || !isVec3(v.target)) fail('setCamera needs position and target as [x,y,z]');
      return { type: 'setCamera', position: [...v.position], target: [...v.target] };
    case 'setKeyframe': {
      if (!isId(v.id) || !isFrame(v.frame)) fail('setKeyframe needs id and frame');
      if (v.easing !== undefined && !isEasing(v.easing)) fail(`easing must be one of ${EASINGS.join(', ')}`);
      let transform: Transform | undefined;
      if (v.transform !== undefined) {
        if (!isTransform(v.transform)) fail('setKeyframe transform needs position, rotation and scale as [x,y,z]');
        transform = { position: [...v.transform.position] as Vec3, rotation: [...v.transform.rotation] as Vec3, scale: [...v.transform.scale] as Vec3 };
      }
      return { type: 'setKeyframe', id: v.id, frame: v.frame, ...(transform ? { transform } : {}), ...(v.easing ? { easing: v.easing as Easing } : {}) };
    }
    case 'deleteKeyframe':
      if (!isId(v.id) || !isFrame(v.frame)) fail('deleteKeyframe needs id and frame');
      return { type: 'deleteKeyframe', id: v.id, frame: v.frame };
    case 'setCameraKey':
      if (!isFrame(v.frame) || !isVec3(v.position) || !isVec3(v.target)) fail('setCameraKey needs frame, position and target');
      if (v.easing !== undefined && !isEasing(v.easing)) fail(`easing must be one of ${EASINGS.join(', ')}`);
      return { type: 'setCameraKey', frame: v.frame, position: [...v.position], target: [...v.target], ...(v.easing ? { easing: v.easing as Easing } : {}) };
    case 'deleteCameraKey':
      if (!isFrame(v.frame)) fail('deleteCameraKey needs frame');
      return { type: 'deleteCameraKey', frame: v.frame };
    case 'clearAnimation':
      if (!(v.id === null || isId(v.id))) fail('clearAnimation needs id (or null for the camera)');
      return { type: 'clearAnimation', id: v.id as string | null };
    case 'setAnimation':
      if (v.fps !== undefined && !inRange(v.fps, 1, 240)) fail('fps must be 1..240');
      if (v.start !== undefined && !isFrame(v.start)) fail('start invalid');
      if (v.end !== undefined && !isFrame(v.end)) fail('end invalid');
      return { type: 'setAnimation', ...(v.fps !== undefined ? { fps: v.fps as number } : {}), ...(v.start !== undefined ? { start: v.start as number } : {}), ...(v.end !== undefined ? { end: v.end as number } : {}) };
    case 'batch':
      if (depth > 0) fail('batches cannot be nested');
      if (!Array.isArray(v.commands) || v.commands.length > LIMITS.commands) fail(`batch needs a commands list (max ${LIMITS.commands})`);
      return {
        type: 'batch',
        commands: v.commands.map((c, i) => {
          try {
            return validateCommand(c, depth + 1);
          } catch (e) {
            throw new CommandError(`Command ${i + 1}: ${e instanceof Error ? e.message : String(e)}`);
          }
        }),
      };
    case 'replaceScene':
      return { type: 'replaceScene', doc: validateSceneDoc(v.doc) };
    default:
      fail(`unknown command type: ${v.type}`);
  }
}

export { PRIMITIVES };
