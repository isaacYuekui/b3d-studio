// The command system: the ONLY way the scene changes.
//
// Every edit (UI click, keyboard shortcut, gizmo drag, file import, scene scripts
// written by Claude) is expressed as a plain JSON command, validated, then applied
// by a pure function. This gives us:
//   - undo/redo for free (snapshots of immutable docs)
//   - a safe surface for AI: Claude emits JSON commands, never JavaScript
//   - easy unit testing

import { BACKGROUNDS, DEFAULT_LIGHT, DEFAULT_MATERIAL, DEFAULT_WORLD, IDENTITY, worldOf, LIGHT_TYPES, OBJECT_TYPES, PRIMITIVES } from './types';
import { DEFAULT_ANIMATION, EASINGS, animationOf, transformAt, upsertKey } from './animation';
import { KEY_OPS, editKeys as editKeysIn } from './dopesheet';
import type { KeyOp, KeyRef } from './dopesheet';
import type { Animation, Easing, PoseKey } from './animation';
import type { ArmatureData, Bone, BonePose, Background, CameraLens, LightData, LightType, Material, MeshData, Modifiers, ObjectType, PrimitiveParams, PrimitiveType, SceneDoc, SceneObject, Transform, Vec3, World } from './types';
import { primitiveMesh } from './mesh/primitives';
import { applyModifiers } from './mesh/modifiers';
import { ALIGNS, DEFAULT_TEXT, FONTS, MAX_TEXT_LENGTH, textMesh } from './text';
import { DEFAULT_RIGID, RIGID_SHAPES, RIGID_TYPES, simulate } from './physics';
import { fracturePieces } from './fracture';
import { DEFAULT_PARTICLES, PARTICLE_GROUND, PARTICLE_SHAPES } from './particles';
import type { ParticleSettings } from './particles';
import type { WaterSettings } from './ocean';
import type { RigidBody } from './physics';
import type { FontId, TextAlign, TextData } from './text';
import { compact } from './mesh/topology';
import { PATTERNS } from './patterns';
import type { PatternType } from './patterns';
import { apply as applyM4, invert as invertM4, mul as mulM4, rotEuler, worldMatrix } from './rig';
import { EDIT_OPS, runEditSteps } from './mesh/script';
import { DEFAULT_OUTFIT, HUMAN_PRESETS, humanPreset } from './humans';
import { generateTerrain, scatterOn, terrainSample } from './terrain';
import { PLANT_KINDS, makePlant } from './plants';
import { BOOLEAN_OPS, meshBoolean } from './mesh/boolean';
import type { BooleanOp } from './mesh/boolean';
import { CAMERA_MOVES, liftOverObstacles, sampleCameraMove, sampleFollow, sceneObstacles } from './cameraMoves';
import type { CameraMoveKind } from './cameraMoves';
import { TIME_PRESETS, TIMES, rotationFor, skyAzimuth, sunRotation } from './sky';
import type { TimeOfDay } from './sky';
import { ROOFS, makeBuilding } from './buildings';
import type { RoofKind } from './buildings';
import type { PlantKind } from './plants';
import type { ScatterParams, TerrainParams } from './terrain';
import type { Outfit } from './humans';
import { ACTIONS, playAction, polylineRoute, standPose } from './motion';
import type { ActionName } from './motion';
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
  | { type: 'setModifiers'; id: string; modifiers: ModifierPatch }
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
  | { type: 'setSkin'; id: string; armature: string | null; bone?: string; weights?: string }
  /** A realistic, rigged person (MakeHuman CC0 preset): armature + body + clothes + hair + eyes. */
  | { type: 'addHuman'; id: string; preset: string; name?: string; transform?: Partial<Transform>; outfit?: Outfit; parentId?: string | null }
  /** Procedural landscape: hills, flats, carved paths, grass/path/rock texture blend. */
  | { type: 'addTerrain'; id: string; name?: string; params: TerrainParams; layers?: [string, string, string]; scales?: [number, number, number]; position?: Vec3; tint?: string }
  /** Many copies of a library model spread over a terrain (trees, rocks, grass…), drawn efficiently. */
  | { type: 'scatter'; id: string; name?: string; asset?: string; source?: string; on: string; params: ScatterParams; hideSource?: boolean }
  /** A procedural house: walls, roof, windows, door, chimney, stone base (each its own material). */
  | { type: 'addBuilding'; id: string; name?: string; width: number; depth: number; floors: number; roof?: RoofKind; seed?: number; style?: BuildingStyle; transform?: Partial<Transform> }
  /** A procedural low-poly plant or rock (pine, tree, bush, rock, grass): an empty with wood / leaves meshes. */
  | { type: 'addPlant'; id: string; name?: string; kind: PlantKind; seed: number; height?: number; colors?: { wood?: string; leaves?: string }; transform?: Partial<Transform> }
  /** Animate an armature with a built-in action (walk, run, idle, wave, jump, sit…). */
  | { type: 'playAction'; id: string; action: ActionName; start: number; cycles?: number; speed?: number; travel?: boolean }
  /** Walk or run a human rig along a path of [x, y] points, turning at corners and following any terrain. */
  | { type: 'walkPath'; id: string; points: [number, number][]; start: number; action?: 'walk' | 'run'; speed?: number }
  /** Model with Edit Mode operators: each step selects elements by a query and applies an op. */
  | { type: 'editMesh'; id: string; steps: EditStep[] }
  | { type: 'setWorld'; world: Partial<World> }
  /** Ready-made camera move (orbit, dolly, flyover, crane, pan) as camera keys between start and end. */
  | { type: 'cameraMove'; move: CameraMoveKind; target?: Vec3; on?: string; start?: number; end?: number; distance?: number; height?: number; heading?: number; degrees?: number; smooth?: boolean; clearance?: boolean }
  /** Separate: faces (or each loose part) of a mesh into new objects, like Blender's P. */
  | { type: 'separate'; id: string; faces?: number[]; mode?: 'selection' | 'loose' }
  /** Join other meshes into `id` (one object, shapes kept as they are), like Blender's Ctrl J. */
  | { type: 'join'; id: string; others: string[] }
  /** Boolean (applied): cut / join / intersect `cutter` into `id`. The cutter is hidden unless keepCutter. */
  | { type: 'boolean'; id: string; cutter: string; op: BooleanOp; keepCutter?: boolean }
  /** Lake / sea / river surface: a flat plane at z = level with animated ripples. */
  | { type: 'addWater'; id: string; name?: string; size: [number, number]; level: number; position?: [number, number]; color?: string; clarity?: number; waves?: number; speed?: number; height?: number; direction?: number }
  /** Change a water surface: ripple size and speed, ocean wave height and direction. */
  | { type: 'setWater'; id: string; water: Partial<WaterSettings> }
  /** Sky, sun light, exposure and haze for a time of day; heading turns the sky so the sun shines from that azimuth (degrees). */
  | { type: 'setTimeOfDay'; time: TimeOfDay; heading?: number; fog?: number }
  | { type: 'setCamera'; position: Vec3; target: Vec3 }
  /** 3D text: letters from a font, extruded (Blender's Add → Text). Stands up facing −Y unless a rotation is given. */
  | { type: 'addText'; id?: string; name?: string; text: Partial<TextData> & { body: string }; transform?: Partial<Transform>; material?: Partial<Material>; parentId?: string | null }
  /** Change a text object's words, font, size, thickness or alignment (rebuilds its mesh). */
  | { type: 'setText'; id: string; text: Partial<TextData> }
  /** Rigid body settings for one object (null removes it from the simulation). */
  | { type: 'setRigidBody'; id: string; rigid: Partial<RigidBody> | null }
  /** Particle system on an object (null removes it). */
  | { type: 'setParticles'; id: string; particles: Partial<ParticleSettings> | null }
  /** Cell Fracture: break an object into about `pieces` Voronoi pieces, each an active rigid body (convex hull). */
  | { type: 'fracture'; id: string; pieces: number; seed?: number }
  /** Simulate the rigid bodies from start to end and write the result as keyframes (Bake to Keyframes). */
  | { type: 'bakePhysics'; start?: number; end?: number }
  /** Camera lens: focal length (mm), depth of field, f-stop, focus distance (m). null clears a setting. */
  | { type: 'setLens'; lens: { [K in keyof CameraLens]?: CameraLens[K] | null } }
  | { type: 'setKeyframe'; id: string; frame: number; transform?: Transform; easing?: Easing }
  | { type: 'deleteKeyframe'; id: string; frame: number }
  | { type: 'setCameraKey'; frame: number; position: Vec3; target: Vec3; easing?: Easing }
  | { type: 'deleteCameraKey'; frame: number }
  | { type: 'clearAnimation'; id: string | null }
  | { type: 'setAnimation'; fps?: number; start?: number; end?: number }
  /** Dope Sheet edit of many keys at once: move / duplicate (offset), scale (factor, pivot), delete, easing. */
  | { type: 'editKeys'; keys: KeyRef[]; op: KeyOp; offset?: number; factor?: number; pivot?: number; easing?: Easing }
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

export interface BuildingStyle {
  walls?: 'plaster' | 'brick' | 'wood';
  wallColor?: string;
  roofColor?: string;
  trimColor?: string;
  doorColor?: string;
}
const DEFAULT_STYLE: Required<BuildingStyle> = { walls: 'plaster', wallColor: '#f1e7d6', roofColor: '#ffffff', trimColor: '#f4f2ec', doorColor: '#5a3b26' };

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
  const r = applyCommandInner(doc, cmd, idGen);
  if (r.doc === doc || cmd.type === 'setText' || cmd.type === 'addText' || cmd.type === 'batch') return r;
  return { ...r, doc: dropStaleText(doc, r.doc) };
}

/** A text object whose mesh was changed by anything but setText is now a plain mesh (Blender: Convert to Mesh). */
function dropStaleText(before: SceneDoc, after: SceneDoc): SceneDoc {
  let objects = after.objects;
  for (const [id, o] of Object.entries(after.objects)) {
    if (!o.text || !before.objects[id] || before.objects[id].mesh === o.mesh) continue;
    if (objects === after.objects) objects = { ...objects };
    const rest = { ...o };
    delete rest.text;
    objects[id] = rest;
  }
  return objects === after.objects ? after : { ...after, objects };
}

function buildText(t: TextData): MeshData {
  try {
    return textMesh(t);
  } catch (e) {
    throw new CommandError(e instanceof Error ? e.message : String(e));
  }
}

function applyCommandInner(doc: SceneDoc, cmd: Command, idGen: IdGen): ApplyResult {
  switch (cmd.type) {
    case 'addText': {
      const t: TextData = { ...DEFAULT_TEXT, ...cmd.text };
      const r = applyCommand(doc, { type: 'add', primitive: 'mesh', id: cmd.id, name: cmd.name ?? 'Text', mesh: buildText(t), parentId: cmd.parentId, material: cmd.material, transform: { rotation: [90, 0, 0], ...cmd.transform } }, idGen);
      const id = r.created[0];
      return { doc: withObject(r.doc, { ...r.doc.objects[id], text: t }), created: r.created };
    }

    case 'setRigidBody': {
      const o = requireObj(doc, cmd.id);
      if (o.type !== 'mesh' && !(PRIMITIVES as readonly string[]).includes(o.type)) throw new CommandError(`${o.name}: only shapes and meshes can be rigid bodies`);
      if (cmd.rigid === null) {
        const next = { ...o };
        delete next.rigid;
        return { doc: withObject(doc, next), created: [] };
      }
      return { doc: withObject(doc, { ...o, rigid: { ...DEFAULT_RIGID, ...o.rigid, ...cmd.rigid } }), created: [] };
    }

    case 'setParticles': {
      const o = requireObj(doc, cmd.id);
      if (o.type !== 'mesh' && !(PRIMITIVES as readonly string[]).includes(o.type)) throw new CommandError(`${o.name}: only shapes and meshes can emit particles`);
      if (cmd.particles === null) {
        const next = { ...o };
        delete next.particles;
        return { doc: withObject(doc, next), created: [] };
      }
      const a = animationOf(doc);
      const base: ParticleSettings = o.particles ?? { ...DEFAULT_PARTICLES, start: a.start, end: Math.max(a.start + 1, Math.round(a.start + (a.end - a.start) * 0.6)) };
      const next = { ...base, ...cmd.particles };
      if (next.end < next.start) throw new CommandError('Particles: the end frame must come after the start');
      return { doc: withObject(doc, { ...o, particles: next }), created: [] };
    }

    case 'fracture': {
      const o = requireObj(doc, cmd.id);
      const geo = o.type === 'mesh' && o.mesh ? applyModifiers(o.mesh, o.modifiers) : (PRIMITIVES as readonly string[]).includes(o.type) ? primitiveMesh(o.type as PrimitiveType, o.params) : null;
      if (!geo) throw new CommandError(`${o.name}: only shapes and meshes can be fractured`);
      let pieces;
      try {
        pieces = fracturePieces(geo, cmd.pieces, cmd.seed ?? 1, o.name);
      } catch (e) {
        throw new CommandError(e instanceof Error ? e.message : String(e));
      }
      if (pieces.length < 2) throw new CommandError(`${o.name} couldn't be broken up (is it a closed solid?)`);
      const R = rotEuler(o.transform.rotation);
      const sc = o.transform.scale;
      const base = { ...DEFAULT_RIGID, ...o.rigid, type: 'active' as const, shape: 'hull' as const };
      const ids: string[] = [];
      const commands: Command[] = [];
      pieces.forEach((pc, i) => {
        let id = `${o.id}.${i + 1}`;
        for (let k = 2; doc.objects[id] || ids.includes(id); k++) id = `${o.id}.${i + 1}.${k}`;
        ids.push(id);
        const off = applyM4(R, [pc.center[0] * sc[0], pc.center[1] * sc[1], pc.center[2] * sc[2]]);
        const p = o.transform.position;
        commands.push({
          type: 'add',
          primitive: 'mesh',
          id,
          name: `${o.name} piece ${i + 1}`,
          mesh: pc.mesh,
          material: o.material,
          parentId: o.parentId,
          transform: { position: [p[0] + off[0], p[1] + off[1], p[2] + off[2]].map((x) => Math.round(x * 1e5) / 1e5) as Vec3, rotation: [...o.transform.rotation], scale: [...sc] },
        });
        commands.push({ type: 'setRigidBody', id, rigid: { ...base, mass: Math.max(0.001, Math.round(base.mass * pc.share * 1000) / 1000) } });
      });
      commands.push({ type: 'delete', ids: [o.id] });
      const r = applyCommand(doc, { type: 'batch', commands }, idGen);
      return { doc: r.doc, created: ids };
    }

    case 'bakePhysics': {
      const a = animationOf(doc);
      const start = cmd.start ?? a.start, end = cmd.end ?? a.end;
      if (end <= start) throw new CommandError('The bake needs an end frame after the start frame');
      if (end - start > 10000) throw new CommandError('Bake at most 10,000 frames at a time');
      let res;
      try {
        res = simulate(doc, start, end, a.fps);
      } catch (e) {
        throw new CommandError(e instanceof Error ? e.message : String(e));
      }
      if (!Object.keys(res.tracks).length) throw new CommandError('No active rigid bodies: turn on Physics → Rigid body (Active) for the objects that should fall');
      const tracks = { ...a.tracks };
      for (const [id, keys] of Object.entries(res.tracks)) {
        const keep = (tracks[id] ?? []).filter((k) => k.frame < start || k.frame > end);
        tracks[id] = [...keep, ...keys].sort((x, y) => x.frame - y.frame);
      }
      return { doc: withAnimation(doc, { ...a, tracks }), created: [] };
    }

    case 'setText': {
      const o = requireObj(doc, cmd.id);
      if (!o.text) throw new CommandError(`${o.name} isn't a text object (it was turned into a mesh)`);
      const t: TextData = { ...o.text, ...cmd.text };
      return { doc: withObject(doc, { ...o, text: t, mesh: buildText(t) }), created: [] };
    }

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
      for (const k of MODIFIER_KEYS) {
        const v = cmd.modifiers[k];
        if (v === null) delete mods[k];
        else if (v !== undefined) (mods as Record<string, unknown>)[k] = withModifierDefaults(k, { ...(mods[k] ?? {}), ...v });
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
      const skin: NonNullable<SceneObject['skin']> = { armature: cmd.armature };
      if (cmd.bone) skin.bone = cmd.bone;
      if (cmd.weights) skin.weights = cmd.weights;
      return { doc: withObject(doc, { ...o, skin }), created: [] };
    }

    case 'addHuman': {
      const data = humanPreset(cmd.preset);
      if (!data) throw new CommandError(`Human preset "${cmd.preset}" is not loaded (presets: ${HUMAN_PRESETS.join(', ')})`);
      const o: Required<Outfit> = { ...DEFAULT_OUTFIT, ...cmd.outfit } as Required<Outfit>;
      const sub: Command[] = [{ type: 'add', primitive: 'armature', id: cmd.id, name: cmd.name ?? `${cmd.preset === 'female' ? 'Woman' : 'Man'}`, armature: { bones: data.bones }, ...(cmd.transform ? { transform: cmd.transform } : {}), ...(cmd.parentId ? { parentId: cmd.parentId } : {}) }];
      const part = (p: 'body' | 'shirt' | 'pants' | 'shoes' | 'hair', color: string, rough: number, label: string) => {
        sub.push({ type: 'add', primitive: 'mesh', id: `${cmd.id}-${p}`, name: label, parentId: cmd.id, mesh: data.parts[p].mesh, material: { baseColor: color, roughness: rough, metallic: 0 } });
        sub.push({ type: 'setSkin', id: `${cmd.id}-${p}`, armature: cmd.id, weights: `humans/${cmd.preset}#${p}` });
      };
      part('body', o.skin, 0.55, 'Skin');
      if (o.shirt) part('shirt', o.shirt, 0.8, 'Shirt');
      if (o.pants) part('pants', o.pants, 0.85, 'Trousers');
      if (o.shoes) part('shoes', o.shoes, 0.45, 'Shoes');
      if (o.hair) part('hair', o.hair, 0.7, 'Hair');
      // Eyes: eyeball, iris and pupil, following the eye bones.
      data.eyes.forEach((e, i) => {
        const side = i === 0 ? 'L' : 'R';
        const f = e.forward;
        const at = (d: number): Vec3 => [e.center[0] + f[0] * d, e.center[1] + f[1] * d, e.center[2] + f[2] * d];
        const ball = `${cmd.id}-eye${side}`;
        sub.push({ type: 'add', primitive: 'sphere', id: ball, name: `Eye.${side}`, parentId: cmd.id, transform: { position: e.center, scale: [0.0118, 0.0118, 0.0118] }, params: { segments: 24 }, material: { baseColor: '#f2efe9', roughness: 0.15 } });
        sub.push({ type: 'add', primitive: 'sphere', id: `${ball}-iris`, name: `Iris.${side}`, parentId: cmd.id, transform: { position: at(0.0098), scale: [0.0058, 0.0024, 0.0058] }, params: { segments: 24 }, material: { baseColor: o.eyes, roughness: 0.2 } });
        sub.push({ type: 'add', primitive: 'sphere', id: `${ball}-pupil`, name: `Pupil.${side}`, parentId: cmd.id, transform: { position: at(0.0112), scale: [0.0025, 0.0012, 0.0025] }, params: { segments: 16 }, material: { baseColor: '#050505', roughness: 0.1 } });
        for (const id of [ball, `${ball}-iris`, `${ball}-pupil`]) sub.push({ type: 'setSkin', id, armature: cmd.id, bone: e.bone });
      });
      // Start relaxed (arms down) instead of the modelling A-pose.
      sub.push({ type: 'setPose', id: cmd.id, pose: standPose(data.bones), reset: true });
      return applyCommand(doc, { type: 'batch', commands: sub }, idGen);
    }

    case 'addTerrain': {
      if (doc.objects[cmd.id]) throw new CommandError(`Id already in use: ${cmd.id}`);
      const { mesh, terrain } = generateTerrain(cmd.params, cmd.layers);
      if (cmd.scales) terrain.scales = cmd.scales;
      const r = applyCommand(doc, { type: 'add', primitive: 'mesh', id: cmd.id, name: cmd.name ?? 'Terrain', mesh, material: { texture: terrain.layers[0], textureScale: terrain.scales[0], roughness: 1, baseColor: cmd.tint ?? '#c8f08c' }, ...(cmd.position ? { transform: { position: cmd.position } } : {}) }, idGen);
      const o = r.doc.objects[cmd.id];
      return { doc: withObject(r.doc, { ...o, terrain }), created: r.created };
    }

    case 'scatter': {
      if (doc.objects[cmd.id]) throw new CommandError(`Id already in use: ${cmd.id}`);
      const ground = requireObj(doc, cmd.on);
      if (!ground.terrain) throw new CommandError(`${ground.name} is not a terrain (make one with addTerrain)`);
      if (!cmd.asset && !cmd.source) throw new CommandError('scatter needs an asset (library model) or a source (object id)');
      if (cmd.source) requireObj(doc, cmd.source);
      const items = scatterOn(ground, cmd.params);
      const label = cmd.asset ?? doc.objects[cmd.source!].name;
      const r = applyCommand(doc, { type: 'add', primitive: 'scatter', id: cmd.id, name: cmd.name ?? `${label} ×${items.length}` }, idGen);
      let next = withObject(r.doc, { ...r.doc.objects[cmd.id], scatter: { ...(cmd.asset ? { asset: cmd.asset } : { source: cmd.source }), items } });
      // The template stays in the scene (edit it, re-run) but is hidden by default.
      if (cmd.source && cmd.hideSource !== false) for (const id of subtree(next, cmd.source)) next = withObject(next, { ...next.objects[id], visible: false });
      return { doc: next, created: r.created };
    }

    case 'addBuilding': {
      if (doc.objects[cmd.id]) throw new CommandError(`Id already in use: ${cmd.id}`);
      const b = makeBuilding({ width: cmd.width, depth: cmd.depth, floors: cmd.floors, roof: cmd.roof, seed: cmd.seed });
      const st: Required<BuildingStyle> = { ...DEFAULT_STYLE, ...cmd.style };
      const wallTex = { plaster: 'white_rough_plaster', brick: 'castle_brick_01', wood: 'brown_planks_07' }[st.walls];
      const sub: Command[] = [{ type: 'add', primitive: 'empty', id: cmd.id, name: cmd.name ?? 'House', ...(cmd.transform ? { transform: cmd.transform } : {}) }];
      const part = (k: string, mesh: MeshData | undefined, material: Partial<Material>) => {
        if (mesh && mesh.faces.length) sub.push({ type: 'add', primitive: 'mesh', id: `${cmd.id}-${k}`, name: capitalize(k), parentId: cmd.id, mesh, material });
      };
      part('walls', b.walls, { texture: wallTex, textureScale: st.walls === 'brick' ? 0.7 : 0.5, baseColor: st.wallColor });
      part('roof', b.roof, cmd.roof === 'flat' ? { baseColor: '#8f8b85', roughness: 0.9 } : { texture: 'clay_roof_tiles_02', textureScale: 0.7, baseColor: st.roofColor });
      part('frames', b.frames, { baseColor: st.trimColor, roughness: 0.6 });
      part('glass', b.glass, { baseColor: '#1b2731', roughness: 0.05, metallic: 0.2 });
      part('door', b.door, { baseColor: st.doorColor, roughness: 0.55 });
      part('base', b.base, { texture: 'rock_face', textureScale: 0.6, baseColor: '#c9c3b8' });
      part('chimney', b.chimney, { texture: 'castle_brick_01', textureScale: 0.8, baseColor: '#ffffff' });
      return applyCommand(doc, { type: 'batch', commands: sub }, idGen);
    }

    case 'addPlant': {
      if (doc.objects[cmd.id]) throw new CommandError(`Id already in use: ${cmd.id}`);
      const p = makePlant(cmd.kind, cmd.seed, cmd.height);
      const defaults: Record<PlantKind, { wood: string; leaves: string }> = {
        pine: { wood: '#5a4030', leaves: '#2f5a32' },
        tree: { wood: '#5e4433', leaves: '#5d8c3a' },
        bush: { wood: '#5e4433', leaves: '#4f7d34' },
        rock: { wood: '#8a8780', leaves: '#5d8c3a' },
        grass: { wood: '#5e4433', leaves: '#6a9a3e' },
      };
      const col = { ...defaults[cmd.kind], ...cmd.colors };
      const sub: Command[] = [{ type: 'add', primitive: 'empty', id: cmd.id, name: cmd.name ?? capitalize(cmd.kind), ...(cmd.transform ? { transform: cmd.transform } : {}) }];
      if (p.wood) sub.push({ type: 'add', primitive: 'mesh', id: `${cmd.id}-wood`, name: cmd.kind === 'rock' ? 'Stone' : 'Wood', parentId: cmd.id, mesh: p.wood, material: { baseColor: col.wood, roughness: cmd.kind === 'rock' ? 0.85 : 0.9 } });
      if (p.leaves) sub.push({ type: 'add', primitive: 'mesh', id: `${cmd.id}-leaves`, name: 'Leaves', parentId: cmd.id, mesh: p.leaves, material: { baseColor: col.leaves, roughness: 0.75 } });
      return applyCommand(doc, { type: 'batch', commands: sub }, idGen);
    }

    case 'playAction': {
      const o = requireArmature(doc, cmd.id);
      const res = playAction(doc, o, cmd.action, cmd.start, { cycles: cmd.cycles, speed: cmd.speed, travel: cmd.travel });
      let next = doc;
      for (const c of res) next = applyCommand(next, c, idGen).doc;
      return { doc: next, created: [] };
    }

    case 'walkPath': {
      const o = requireArmature(doc, cmd.id);
      const grounds = Object.values(doc.objects).filter((g) => g.terrain);
      const ground = grounds.length
        ? (x: number, y: number) => {
            let z: number | null = null;
            for (const g of grounds) {
              const h = terrainSample(g, x, y)?.z;
              if (h !== undefined && (z === null || h > z)) z = h;
            }
            return z;
          }
        : undefined;
      let res: Command[];
      try {
        res = playAction(doc, o, cmd.action ?? 'walk', cmd.start, { speed: cmd.speed, route: polylineRoute(cmd.points, ground) });
      } catch (e) {
        throw new CommandError(e instanceof Error ? e.message : String(e));
      }
      let next = doc;
      for (const c of res) next = applyCommand(next, c, idGen).doc;
      const last = Math.max(...res.map((c) => ('frame' in c ? c.frame : 0)));
      const anim = animationOf(next);
      if (last > anim.end) next = withAnimation(next, { ...anim, end: last });
      return { doc: next, created: [] };
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

    case 'setWorld': {
      const world = { ...DEFAULT_WORLD, ...doc.world, ...cmd.world };
      // Picking another sky by hand leaves the time-of-day preset.
      if (cmd.world.hdri !== undefined && cmd.world.time === undefined) delete world.time;
      return { doc: { ...doc, world }, created: [] };
    }

    case 'separate': {
      const o = asMesh(requireObj(doc, cmd.id));
      const m = o.mesh!;
      // Groups of faces that become their own object.
      let groups: number[][];
      if ((cmd.mode ?? 'selection') === 'loose') groups = looseParts(m).slice(1);
      else {
        const pick = [...new Set(cmd.faces ?? [])].filter((f) => f >= 0 && f < m.faces.length);
        if (!pick.length) throw new CommandError('Select the faces to separate first');
        if (pick.length === m.faces.length) throw new CommandError('That is the whole mesh: select only part of it');
        groups = [pick];
      }
      if (!groups.length) throw new CommandError(`${o.name} is all one piece: nothing to separate`);
      const taken = new Set(groups.flat());
      let next = withObject(doc, { ...o, mesh: compact({ ...m, faces: m.faces.filter((_, i) => !taken.has(i)) }).mesh });
      const created: string[] = [];
      for (const g of groups) {
        const newId = idGen();
        const part: SceneObject = { ...clone(o), id: newId, name: uniqueName(next, o.name), mesh: compact({ ...m, faces: g.map((i) => m.faces[i]) }).mesh };
        next = { ...next, objects: { ...next.objects, [newId]: part }, order: [...next.order, newId] };
        created.push(newId);
      }
      return { doc: next, created };
    }

    case 'join': {
      const t = asMesh(requireObj(doc, cmd.id));
      const others = [...new Set(cmd.others)].filter((x) => x !== t.id).map((x) => asMesh(requireObj(doc, x)));
      if (!others.length) throw new CommandError('Pick at least one other object to join');
      for (const o of others) {
        if (doc.order.some((k) => doc.objects[k]?.parentId === o.id)) throw new CommandError(`${o.name} has children: unparent them first`);
        if (isAncestor(doc, o.id, t.id)) throw new CommandError(`${o.name} is a parent of ${t.name}`);
      }
      const inv = invertM4(worldMatrix(doc, t.id, 1));
      const vertices = [...t.mesh!.vertices];
      const faces = [...t.mesh!.faces];
      for (const o of others) {
        const M = mulM4(inv, worldMatrix(doc, o.id, 1));
        const om = applyModifiers(o.mesh!, o.modifiers);
        const base = vertices.length;
        for (const v of om.vertices) vertices.push(applyM4(M, v).map((x) => Math.round(x * 1e5) / 1e5) as Vec3);
        for (const f of om.faces) faces.push(f.map((i) => i + base));
      }
      if (vertices.length > LIMITS.vertices || faces.length > LIMITS.faces) throw new CommandError('The joined mesh would be too large');
      const joined = withObject(doc, { ...t, mesh: { ...t.mesh!, vertices, faces } });
      return applyCommand(joined, { type: 'delete', ids: others.map((o) => o.id) }, idGen);
    }

    case 'boolean': {
      const t = asMesh(requireObj(doc, cmd.id));
      const c = asMesh(requireObj(doc, cmd.cutter));
      if (t.id === c.id) throw new CommandError('Pick a different object as the cutter');
      // The cutter, with its modifiers, in the target's local space.
      const M = mulM4(invertM4(worldMatrix(doc, t.id, 1)), worldMatrix(doc, c.id, 1));
      const cm = applyModifiers(c.mesh!, c.modifiers);
      const cutter: MeshData = { ...cm, vertices: cm.vertices.map((v) => applyM4(M, v)) };
      let mesh: MeshData;
      try {
        mesh = meshBoolean(applyModifiers(t.mesh!, t.modifiers), cutter, cmd.op, [t.name, c.name]);
      } catch (e) {
        throw new CommandError(e instanceof Error ? e.message : String(e));
      }
      if (mesh.vertices.length > LIMITS.vertices || mesh.faces.length > LIMITS.faces) throw new CommandError(`${t.name}: boolean result too large`);
      const next: SceneObject = { ...t, mesh };
      delete next.modifiers;
      let out = withObject(doc, next);
      if (!cmd.keepCutter) out = withObject(out, { ...out.objects[c.id], visible: false });
      return { doc: out, created: [] };
    }

    case 'cameraMove': {
      const anim = animationOf(doc);
      const start = cmd.start ?? anim.start;
      const end = cmd.end ?? Math.max(start + 24, anim.end);
      if (end <= start) throw new CommandError('cameraMove end must be after start');
      let target = cmd.target;
      if (!target && cmd.on) target = transformAt(doc, requireObj(doc, cmd.on).id, start)!.position;
      target ??= doc.camera?.target ?? [0, 0, 0];
      let samples: ReturnType<typeof sampleCameraMove>;
      if (cmd.move === 'follow' || cmd.move === 'track') {
        if (!cmd.on) throw new CommandError(`cameraMove ${cmd.move} needs "on": the id of the person or object to follow`);
        const id = requireObj(doc, cmd.on).id;
        // Rigs carry the motion; a skinned body follows its rig.
        const src = doc.objects[id].skin?.armature ?? id;
        samples = sampleFollow(cmd.move, (f) => {
          const t = transformAt(doc, src, f)!;
          return { position: t.position, heading: t.rotation[2] };
        }, { start, end, distance: cmd.distance, height: cmd.height, side: (cmd.degrees ?? 90) < 0 ? -1 : 1 });
      } else samples = sampleCameraMove({ move: cmd.move, target, start, end, distance: cmd.distance, height: cmd.height, heading: cmd.heading, degrees: cmd.degrees, smooth: cmd.smooth });
      // Fly over trees and houses rather than through them.
      if (cmd.clearance !== false && cmd.move !== 'follow' && cmd.move !== 'track') liftOverObstacles(samples, sceneObstacles(doc).filter((ob) => Math.hypot(ob.x - target![0], ob.y - target![1]) > ob.r + 0.5)); // not what we're filming
      // Never dip into a hill: keep the camera at least 2 m above any terrain under it.
      const grounds = Object.values(doc.objects).filter((o) => o.terrain);
      if (grounds.length)
        for (const k of samples) {
          let floor = -Infinity;
          for (const g of grounds) {
            const z = terrainSample(g, k.position[0], k.position[1])?.z;
            if (z !== undefined) floor = Math.max(floor, z + 2);
          }
          if (k.position[2] < floor) k.position = [k.position[0], k.position[1], Math.round(floor * 1000) / 1000];
        }
      const kept = anim.camera.filter((k) => k.frame < start || k.frame > end);
      const camera = [...kept, ...samples.map((s) => ({ ...s, easing: 'linear' as Easing }))].sort((a, b) => a.frame - b.frame);
      const next = withAnimation(doc, { ...anim, camera, end: Math.max(anim.end, end) });
      return { doc: { ...next, camera: { position: samples[0].position, target: samples[0].target } }, created: [] };
    }

    case 'addWater': {
      if (doc.objects[cmd.id]) throw new CommandError(`Id already in use: ${cmd.id}`);
      const [w, d] = cmd.size;
      const mesh: MeshData = { vertices: [[-w / 2, -d / 2, 0], [w / 2, -d / 2, 0], [w / 2, d / 2, 0], [-w / 2, d / 2, 0]], faces: [[0, 1, 2, 3]], smooth: false };
      const [x, y] = cmd.position ?? [0, 0];
      const clarity = cmd.clarity ?? 0.35;
      const r = applyCommand(doc, { type: 'add', primitive: 'mesh', id: cmd.id, name: cmd.name ?? 'Water', mesh, material: { baseColor: cmd.color ?? '#1d4f5c', roughness: 0.03, metallic: 0, alpha: Math.round((1 - clarity * 0.6) * 100) / 100 }, transform: { position: [x, y, cmd.level] } }, idGen);
      const water: WaterSettings = { waves: cmd.waves ?? 1.2, speed: cmd.speed ?? 0.25 };
      if (cmd.height) water.height = cmd.height;
      if (cmd.direction !== undefined) water.direction = cmd.direction;
      return { doc: withObject(r.doc, { ...r.doc.objects[cmd.id], water }), created: r.created };
    }

    case 'setWater': {
      const o = requireObj(doc, cmd.id);
      if (!o.water) throw new CommandError(`${o.name} isn't water (add water with Add → Water or addWater)`);
      return { doc: withObject(doc, { ...o, water: { ...o.water, ...cmd.water } }), created: [] };
    }

    case 'setTimeOfDay': {
      const t = TIME_PRESETS[cmd.time];
      const cur = worldOf(doc);
      const rotation = cmd.heading !== undefined ? rotationFor(t.sun?.u ?? 0.6, cmd.heading) : cur.rotation;
      const sub: Command[] = [
        { type: 'setWorld', world: { hdri: t.hdri, strength: t.strength, exposure: t.exposure, background: 'hdri', rotation, bloom: t.bloom, fog: cmd.fog ?? t.fog, fogColor: t.fogColor, time: cmd.time } },
      ];
      const sun = doc.order.map((id) => doc.objects[id]).find((o) => o?.type === 'light' && o.light?.type === 'sun');
      if (t.sun) {
        const rot = sunRotation(skyAzimuth(t.sun.u, rotation), t.sun.elevation);
        const light = { color: t.sun.color, power: t.sun.power, shadows: t.sun.shadows };
        if (sun) sub.push({ type: 'transform', id: sun.id, rotation: rot }, { type: 'setLight', id: sun.id, light }, { type: 'setVisible', id: sun.id, visible: true });
        else {
          let id = 'sun';
          for (let k = 2; doc.objects[id]; k++) id = `sun-${k}`;
          sub.push({ type: 'add', primitive: 'light', id, name: 'Sun', light: { type: 'sun', spotAngle: 45, ...light }, transform: { position: [0, 0, 30], rotation: rot, scale: [1, 1, 1] } });
        }
      } else if (sun) sub.push({ type: 'setVisible', id: sun.id, visible: false });
      return applyCommand(doc, { type: 'batch', commands: sub }, idGen);
    }

    case 'setCamera':
      return { doc: { ...doc, camera: { position: [...cmd.position], target: [...cmd.target] } }, created: [] };

    case 'setLens': {
      const lens: Record<string, unknown> = { ...doc.lens };
      for (const [k, v] of Object.entries(cmd.lens)) {
        if (v === null) delete lens[k];
        else if (v !== undefined) lens[k] = v;
      }
      const next: SceneDoc = { ...doc, lens: lens as CameraLens };
      if (!Object.keys(lens).length) delete next.lens;
      return { doc: next, created: [] };
    }

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

    case 'editKeys': {
      if (!doc.animation || !cmd.keys.length) return { doc, created: [] };
      const next = editKeysIn(doc, cmd.keys, { op: cmd.op, offset: cmd.offset, factor: cmd.factor, pivot: cmd.pivot, easing: cmd.easing });
      // An object whose last key was deleted keeps the pose of that key, so nothing jumps.
      let base = doc;
      for (const [id, keys] of Object.entries(doc.animation.tracks)) {
        if (!next.tracks[id] && keys.length && base.objects[id]) base = withObject(base, { ...base.objects[id], transform: clone(keys[0].transform) });
      }
      return { doc: withAnimation(base, next), created: [] };
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
  for (const k of ['clearcoat', 'clearcoatRoughness', 'sheen', 'transmission', 'subsurface', 'anisotropy'] as const)
    if (v[k] !== undefined) m[k] = inRange(v[k], 0, 1) ? (v[k] as number) : fail(`material.${k} must be 0..1`);
  for (const k of ['sheenColor', 'subsurfaceColor'] as const) if (v[k] !== undefined) m[k] = isColor(v[k]) ? (v[k] as string) : fail(`material.${k} must be #rrggbb`);
  if (v.ior !== undefined) m.ior = inRange(v.ior, 1, 3) ? (v.ior as number) : fail('material.ior must be 1..3');
  if (v.pattern !== undefined) {
    const p = v.pattern;
    if (p === null) m.pattern = null;
    else {
      if (!isRecord(p) || !(PATTERNS as readonly unknown[]).includes(p.type)) fail(`material.pattern.type must be one of ${PATTERNS.join(', ')}`);
      const q = p as Record<string, unknown>;
      m.pattern = {
        type: q.type as PatternType,
        colorA: q.colorA === undefined ? '#2b2b2b' : isColor(q.colorA) ? q.colorA : fail('material.pattern.colorA must be #rrggbb'),
        colorB: q.colorB === undefined ? '#d8d8d8' : isColor(q.colorB) ? q.colorB : fail('material.pattern.colorB must be #rrggbb'),
        scale: q.scale === undefined ? 1 : inRange(q.scale, 0.01, 100) ? (q.scale as number) : fail('material.pattern.scale must be 0.01..100 (repeats per metre)'),
        bump: q.bump === undefined ? 0.3 : inRange(q.bump, 0, 1) ? (q.bump as number) : fail('material.pattern.bump must be 0..1'),
      };
    }
  }
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
  if (v.fog !== undefined) w.fog = inRange(v.fog, 0, 100000) ? v.fog : fail('world.fog must be 0..100000 m (0 = off)');
  if (v.fogColor !== undefined) w.fogColor = isColor(v.fogColor) ? v.fogColor : fail('world.fogColor must be #rrggbb');
  if (v.time !== undefined) w.time = (TIMES as readonly unknown[]).includes(v.time) ? (v.time as string) : fail(`world.time must be one of ${TIMES.join(', ')}`);
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

function validateSkin(v: unknown, at: string): NonNullable<SceneObject['skin']> {
  if (!isRecord(v) || !isId(v.armature)) fail(`${at}: skin needs an armature id`);
  const out: NonNullable<SceneObject['skin']> = { armature: v.armature as string };
  if (v.bone !== undefined) out.bone = typeof v.bone === 'string' && BONE_NAME.test(v.bone) ? v.bone : fail(`${at}: skin.bone invalid`);
  if (v.weights !== undefined) out.weights = typeof v.weights === 'string' && /^[a-z0-9_-]+\/[a-z0-9_-]+#[a-z0-9_-]+$/.test(v.weights) ? v.weights : fail(`${at}: skin.weights must look like "humans/male#body"`);
  return out;
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

export const MODIFIER_KEYS = ['mirror', 'array', 'solidify', 'bevel', 'subdivision', 'displace'] as const;
/** setModifiers: a value merges into that modifier, null removes it. */
export type ModifierPatch = { [K in (typeof MODIFIER_KEYS)[number]]?: Partial<NonNullable<Modifiers[K]>> | null };

const isVec3In = (v: unknown, lim: number): v is Vec3 => isVec3(v) && v.every((x) => inRange(x, -lim, lim));

interface FieldSpec {
  /** Used when the field is missing (a required field with `def` is filled in for new modifiers created by a patch). */
  def?: unknown;
  req?: boolean;
  check: (x: unknown) => boolean;
  msg: string;
}
const isBool = (x: unknown) => typeof x === 'boolean';
const intIn = (lo: number, hi: number) => (x: unknown) => Number.isInteger(x) && inRange(x, lo, hi);
const numIn = (lo: number, hi: number) => (x: unknown) => inRange(x, lo, hi);
const MOD_SPEC: Record<(typeof MODIFIER_KEYS)[number], Record<string, FieldSpec>> = {
  mirror: {
    x: { def: false, check: isBool, msg: 'true/false' },
    y: { def: false, check: isBool, msg: 'true/false' },
    z: { def: false, check: isBool, msg: 'true/false' },
    clip: { check: isBool, msg: 'true/false' },
    merge: { check: numIn(0, 1), msg: '0..1' },
  },
  array: {
    count: { req: true, def: 2, check: intIn(1, 100), msg: 'a whole number 1..100' },
    relative: { def: [1, 0, 0], check: (x) => isVec3In(x, 100), msg: '[x, y, z], each -100..100' },
    constant: { check: (x) => isVec3In(x, 1000), msg: '[x, y, z] metres, each -1000..1000' },
    merge: { check: isBool, msg: 'true/false' },
  },
  solidify: {
    thickness: { req: true, def: 0.02, check: numIn(-10, 10), msg: '-10..10 m' },
    offset: { check: numIn(-1, 1), msg: '-1..1' },
    rim: { check: isBool, msg: 'true/false' },
  },
  bevel: {
    width: { req: true, def: 0.02, check: numIn(0, 10), msg: '0..10 m' },
    segments: { def: 1, check: intIn(1, 6), msg: '1..6' },
    angle: { def: 30, check: numIn(0, 180), msg: '0..180 degrees' },
  },
  subdivision: {
    levels: { req: true, def: 1, check: intIn(0, 4), msg: '0..4' },
    sharpAngle: { check: numIn(0, 180), msg: '0..180 degrees' },
  },
  displace: {
    strength: { req: true, def: 0.1, check: numIn(-10, 10), msg: '-10..10 m' },
    scale: { def: 1, check: numIn(0.01, 100), msg: '0.01..100 m' },
    seed: { check: intIn(0, 99999), msg: 'a whole number 0..99999' },
  },
};

/**
 * Validate one modifier's settings. `partial` (setModifiers patches) checks only the fields given,
 * so changing one setting keeps the others; otherwise missing fields get their defaults.
 */
function validateModifier(k: (typeof MODIFIER_KEYS)[number], m: unknown, partial: boolean): Record<string, unknown> {
  if (!isRecord(m)) fail(`modifiers.${k} must be an object`);
  const out: Record<string, unknown> = {};
  for (const [f, spec] of Object.entries(MOD_SPEC[k])) {
    const x = m[f];
    if (x === undefined) {
      if (partial) continue;
      if (spec.req) fail(`modifiers.${k}.${f} must be ${spec.msg}`);
      if (spec.def !== undefined) out[f] = Array.isArray(spec.def) ? [...spec.def] : spec.def;
      continue;
    }
    if (!spec.check(x)) fail(`modifiers.${k}.${f} must be ${spec.msg}`);
    out[f] = Array.isArray(x) ? [...x] : x;
  }
  return out;
}

/** Fill a merged modifier's missing settings with defaults (a patch may create it with only some). */
function withModifierDefaults(k: (typeof MODIFIER_KEYS)[number], m: Record<string, unknown>): Record<string, unknown> {
  const out = { ...m };
  for (const [f, spec] of Object.entries(MOD_SPEC[k])) if (out[f] === undefined && spec.def !== undefined) out[f] = Array.isArray(spec.def) ? [...spec.def] : spec.def;
  return out;
}

export function validateModifiers(v: unknown, partial = false): Modifiers {
  if (!isRecord(v)) fail('modifiers must be an object');
  const out: Record<string, unknown> = {};
  for (const k of MODIFIER_KEYS) if (v[k] !== undefined) out[k] = validateModifier(k, v[k], partial);
  return out as Modifiers;
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
  if (obj.type === 'mesh' && v.text !== undefined) obj.text = validateText(v.text, false) as TextData;
  if (v.rigid !== undefined && (obj.type === 'mesh' || (PRIMITIVES as readonly string[]).includes(obj.type))) obj.rigid = validateRigid(v.rigid, false) as RigidBody;
  if (v.particles !== undefined && (obj.type === 'mesh' || (PRIMITIVES as readonly string[]).includes(obj.type))) obj.particles = validateParticles(v.particles, false) as ParticleSettings;
  if (obj.type === 'light') obj.light = { ...DEFAULT_LIGHT.point, ...validateLight(v.light, false) } as LightData;
  if (obj.type === 'model') obj.asset = typeof v.asset === 'string' && ASSET_ID.test(v.asset) ? v.asset : fail(`object ${v.id}: asset invalid`);
  if (obj.type === 'armature') {
    obj.armature = validateArmature(v.armature);
    if (v.pose !== undefined) obj.pose = validatePose(v.pose);
  }
  if (obj.type === 'mesh' && v.terrain !== undefined) {
    const t = v.terrain;
    if (!isRecord(t) || !Number.isInteger(t.nx) || !Number.isInteger(t.ny) || !Array.isArray(t.splat) || !Array.isArray(t.layers) || !Array.isArray(t.scales) || !Array.isArray(t.size)) fail(`object ${v.id}: terrain invalid`);
    if ((t.nx as number) * (t.ny as number) !== obj.mesh!.vertices.length || (t.splat as unknown[]).length !== obj.mesh!.vertices.length * 3) fail(`object ${v.id}: terrain does not match its mesh`);
    obj.terrain = { nx: t.nx as number, ny: t.ny as number, size: t.size as [number, number], splat: (t.splat as unknown[]).map(Number), layers: t.layers as [string, string, string], scales: t.scales as [number, number, number] };
  }
  if (obj.type === 'scatter') {
    const sc = v.scatter;
    if (!isRecord(sc) || !((typeof sc.asset === 'string' && ASSET_ID.test(sc.asset)) || isId(sc.source)) || !Array.isArray(sc.items) || sc.items.length > 20000) fail(`object ${v.id}: scatter invalid`);
    obj.scatter = { ...(typeof sc.asset === 'string' ? { asset: sc.asset } : { source: sc.source as string }), items: (sc.items as unknown[]).map((it) => (Array.isArray(it) && it.length === 5 && it.every((x) => typeof x === 'number' && Number.isFinite(x)) ? (it as [number, number, number, number, number]) : fail(`object ${v.id}: scatter item invalid`))) };
  }
  if (obj.type === 'mesh' && v.skin !== undefined) {
    obj.skin = validateSkin(v.skin, `object ${v.id}`);
  }
  if (obj.type === 'mesh' && v.water !== undefined) {
    const w = v.water;
    if (!isRecord(w)) fail(`object ${v.id}: water invalid`);
    obj.water = validateWater(w, false) as WaterSettings;
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
  if (v.lens !== undefined) {
    const lens = validateLens(v.lens, false) as CameraLens;
    if (Object.keys(lens).length) doc.lens = lens;
  }
  return doc;
}

/** Water settings; `partial` checks only the fields given. */
export function validateWater(v: unknown, partial: boolean): Partial<WaterSettings> {
  if (!isRecord(v)) fail('water must be an object');
  const out: Partial<WaterSettings> = {};
  for (const k of Object.keys(v)) if (!['waves', 'speed', 'height', 'direction'].includes(k)) fail(`water has no setting "${k}" (use waves, speed, height, direction)`);
  if (v.waves !== undefined) out.waves = inRange(v.waves, 0.05, 50) ? (v.waves as number) : fail('water.waves must be 0.05..50 m');
  if (v.speed !== undefined) out.speed = inRange(v.speed, 0, 20) ? (v.speed as number) : fail('water.speed must be 0..20 m/s');
  if (v.height !== undefined) out.height = inRange(v.height, 0, 30) ? (v.height as number) : fail('water.height must be 0..30 m');
  if (v.direction !== undefined) out.direction = inRange(v.direction, -3600, 3600) ? (v.direction as number) : fail('water.direction must be degrees');
  if (!partial && (out.waves === undefined || out.speed === undefined)) fail('water needs waves and speed');
  return out;
}

/** Particle settings; `partial` checks only the fields given. */
export function validateParticles(v: unknown, partial: boolean): Partial<ParticleSettings> {
  if (!isRecord(v)) fail('particles must be an object');
  const spec: Record<keyof ParticleSettings, [(x: unknown) => boolean, string]> = {
    count: [(x) => Number.isInteger(x) && inRange(x, 1, 20000), 'a whole number 1..20000'],
    start: [(x) => Number.isInteger(x) && isFrame(x), 'a whole frame number'],
    end: [(x) => Number.isInteger(x) && isFrame(x), 'a whole frame number'],
    lifetime: [(x) => inRange(x, 1, 10000), '1..10000 frames'],
    speed: [(x) => inRange(x, -1000, 1000), '-1000..1000 m/s'],
    random: [(x) => inRange(x, 0, 1000), '0..1000 m/s'],
    gravity: [(x) => inRange(x, -10, 10), '-10..10 (× Earth)'],
    size: [(x) => inRange(x, 0.001, 100), '0.001..100 m'],
    sizeRandom: [(x) => inRange(x, 0, 1), '0..1'],
    shape: [(x) => (PARTICLE_SHAPES as readonly unknown[]).includes(x), PARTICLE_SHAPES.join(', ')],
    color: [(x) => isColor(x), 'a colour like #ffaa33'],
    glow: [(x) => inRange(x, 0, 1), '0..1'],
    ground: [(x) => (PARTICLE_GROUND as readonly unknown[]).includes(x), PARTICLE_GROUND.join(', ')],
    wind: [(x) => isVec3In(x, 100), '[x, y, z] m/s², each -100..100'],
    hideEmitter: [(x) => typeof x === 'boolean', 'true/false'],
    seed: [(x) => Number.isInteger(x) && inRange(x, 0, 99999), 'a whole number 0..99999'],
  };
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) {
    const sp = spec[k as keyof ParticleSettings];
    if (!sp) fail(`particles has no setting "${k}" (use ${Object.keys(spec).join(', ')})`);
    out[k] = sp[0](x) ? x : fail(`particles.${k} must be ${sp[1]}`);
  }
  if (!partial) return { ...DEFAULT_PARTICLES, ...out } as ParticleSettings;
  return out as Partial<ParticleSettings>;
}

/** Rigid body settings; `partial` checks only the fields given. */
export function validateRigid(v: unknown, partial: boolean): Partial<RigidBody> {
  if (!isRecord(v)) fail('rigid must be an object');
  const out: Partial<RigidBody> = {};
  for (const k of Object.keys(v)) if (!['type', 'shape', 'mass', 'friction', 'bounce', 'velocity'].includes(k)) fail(`rigid has no setting "${k}" (use type, shape, mass, friction, bounce, velocity)`);
  if (v.type !== undefined) out.type = (RIGID_TYPES as readonly unknown[]).includes(v.type) ? (v.type as RigidBody['type']) : fail(`rigid.type must be one of ${RIGID_TYPES.join(', ')}`);
  if (v.shape !== undefined) out.shape = (RIGID_SHAPES as readonly unknown[]).includes(v.shape) ? (v.shape as RigidBody['shape']) : fail(`rigid.shape must be one of ${RIGID_SHAPES.join(', ')}`);
  if (v.mass !== undefined) out.mass = inRange(v.mass, 0.001, 100000) ? (v.mass as number) : fail('rigid.mass must be 0.001..100000 kg');
  if (v.friction !== undefined) out.friction = inRange(v.friction, 0, 1) ? (v.friction as number) : fail('rigid.friction must be 0..1');
  if (v.bounce !== undefined) out.bounce = inRange(v.bounce, 0, 1) ? (v.bounce as number) : fail('rigid.bounce must be 0..1');
  if (v.velocity !== undefined) out.velocity = isVec3In(v.velocity, 1000) ? ([...v.velocity] as Vec3) : fail('rigid.velocity must be [x, y, z] m/s, each -1000..1000');
  if (!partial) return { ...DEFAULT_RIGID, ...out };
  return out;
}

/** Text settings; `partial` checks only the fields given. */
export function validateText(v: unknown, partial: boolean): Partial<TextData> {
  if (!isRecord(v)) fail('text must be an object');
  const out: Partial<TextData> = {};
  for (const k of Object.keys(v)) if (!['body', 'font', 'size', 'depth', 'align', 'lineHeight'].includes(k)) fail(`text has no setting "${k}" (use body, font, size, depth, align, lineHeight)`);
  if (v.body !== undefined) {
    if (typeof v.body !== 'string' || !v.body.trim() || v.body.length > MAX_TEXT_LENGTH) fail(`text.body must be 1..${MAX_TEXT_LENGTH} characters`);
    out.body = v.body;
  }
  if (v.font !== undefined) out.font = (FONTS as readonly unknown[]).includes(v.font) ? (v.font as FontId) : fail(`text.font must be one of ${FONTS.join(', ')}`);
  if (v.size !== undefined) out.size = inRange(v.size, 0.01, 100) ? (v.size as number) : fail('text.size must be 0.01..100 m');
  if (v.depth !== undefined) out.depth = inRange(v.depth, 0, 100) ? (v.depth as number) : fail('text.depth must be 0..100 m');
  if (v.align !== undefined) out.align = (ALIGNS as readonly unknown[]).includes(v.align) ? (v.align as TextAlign) : fail(`text.align must be one of ${ALIGNS.join(', ')}`);
  if (v.lineHeight !== undefined) out.lineHeight = inRange(v.lineHeight, 0.5, 5) ? (v.lineHeight as number) : fail('text.lineHeight must be 0.5..5');
  if (!partial) {
    for (const k of ['body', 'font', 'size', 'depth', 'align'] as const) if (out[k] === undefined) fail(`text.${k} is missing`);
  }
  return out;
}

/** Lens settings; with `allowNull` (setLens), null clears a setting. Unknown keys are refused. */
function validateLens(v: unknown, allowNull: boolean): Record<string, unknown> {
  if (!isRecord(v)) fail('lens must be an object');
  const spec: Record<string, [(x: unknown) => boolean, string]> = {
    focal: [(x) => inRange(x, 1, 5000), 'focal must be 1..5000 mm'],
    dof: [(x) => typeof x === 'boolean', 'dof must be true/false'],
    fStop: [(x) => inRange(x, 0.5, 128), 'fStop must be 0.5..128'],
    focus: [(x) => inRange(x, 0.01, 100000), 'focus must be 0.01..100000 m'],
  };
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) {
    if (!spec[k]) fail(`lens has no setting "${k}" (use focal, dof, fStop, focus)`);
    if (x === null && allowNull) out[k] = null;
    else if (x !== undefined) out[k] = spec[k][0](x) ? x : fail(`lens ${spec[k][1]}`);
  }
  return out;
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
      const out: ModifierPatch = {};
      for (const k of Object.keys(m)) if (!(MODIFIER_KEYS as readonly string[]).includes(k)) fail(`unknown modifier "${k}" (use ${MODIFIER_KEYS.join(', ')})`);
      for (const k of MODIFIER_KEYS) {
        if (m[k] === null) out[k] = null;
        else if (m[k] !== undefined) (out as Record<string, unknown>)[k] = validateModifiers({ [k]: m[k] }, true)[k];
      }
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
    case 'setSkin': {
      if (!isId(v.id) || !(v.armature === null || isId(v.armature))) fail('setSkin needs id and armature (or null)');
      if (v.armature === null) return { type: 'setSkin', id: v.id, armature: null };
      const sk = validateSkin({ armature: v.armature, bone: v.bone, weights: v.weights }, 'setSkin');
      return { type: 'setSkin', id: v.id, armature: sk.armature, ...(sk.bone ? { bone: sk.bone } : {}), ...(sk.weights ? { weights: sk.weights } : {}) };
    }
    case 'addHuman': {
      if (typeof v.id !== 'string' || !REF_ID.test(v.id)) fail('addHuman needs an id (letters, digits, _ . -)');
      if (!(HUMAN_PRESETS as readonly string[]).includes(v.preset as string)) fail(`addHuman preset must be ${HUMAN_PRESETS.join(' or ')}`);
      const cmd: Extract<Command, { type: 'addHuman' }> = { type: 'addHuman', id: v.id, preset: v.preset as string };
      if (v.name !== undefined) cmd.name = isStr(v.name, 100) ? v.name : fail('addHuman name invalid');
      if (v.parentId !== undefined && v.parentId !== null) cmd.parentId = isId(v.parentId) ? v.parentId : fail('addHuman parentId invalid');
      if (v.transform !== undefined) {
        if (!isRecord(v.transform)) fail('addHuman transform invalid');
        const t: Partial<Transform> = {};
        for (const k of ['position', 'rotation', 'scale'] as const) if (v.transform[k] !== undefined) t[k] = isVec3(v.transform[k]) ? (v.transform[k] as Vec3) : fail(`addHuman transform.${k} must be [x,y,z]`);
        cmd.transform = t;
      }
      if (v.outfit !== undefined) {
        if (!isRecord(v.outfit)) fail('addHuman outfit must be an object of colours');
        const o: Outfit = {};
        for (const [k, c] of Object.entries(v.outfit)) {
          if (!['skin', 'shirt', 'pants', 'shoes', 'hair', 'eyes'].includes(k)) fail(`addHuman outfit.${k} unknown (skin, shirt, pants, shoes, hair, eyes)`);
          if (c === null && !['skin', 'eyes'].includes(k)) (o as Record<string, unknown>)[k] = null;
          else if (isColor(c)) (o as Record<string, unknown>)[k] = c;
          else fail(`addHuman outfit.${k} must be #rrggbb${['skin', 'eyes'].includes(k) ? '' : ' or null'}`);
        }
        cmd.outfit = o;
      }
      return cmd;
    }
    case 'addTerrain': {
      if (typeof v.id !== 'string' || !REF_ID.test(v.id)) fail('addTerrain needs an id');
      const P = v;
      const size = Array.isArray(P.size) && P.size.length === 2 && P.size.every((x) => inRange(x, 2, 4000)) ? (P.size as [number, number]) : fail('addTerrain size must be [width, depth] metres (2..4000)');
      const params: TerrainParams = {
        size,
        resolution: P.resolution === undefined ? 128 : Number.isInteger(P.resolution) && inRange(P.resolution, 4, 256) ? (P.resolution as number) : fail('addTerrain resolution must be 4..256'),
        height: P.height === undefined ? 8 : inRange(P.height, 0, 500) ? (P.height as number) : fail('addTerrain height must be 0..500 m'),
        seed: P.seed === undefined ? 1 : Number.isInteger(P.seed) ? (P.seed as number) : fail('addTerrain seed must be an integer'),
      };
      for (const k of ['scale', 'roughness', 'ridges', 'rim', 'rockSlope'] as const) if (P[k] !== undefined) params[k] = inRange(P[k], 0, 4000) ? (P[k] as number) : fail(`addTerrain ${k} out of range`);
      const xy = (q: unknown) => Array.isArray(q) && q.length === 2 && q.every((x) => typeof x === 'number' && Number.isFinite(x));
      if (P.flats !== undefined) {
        if (!Array.isArray(P.flats) || P.flats.length > 64) fail('addTerrain flats must be a list');
        params.flats = P.flats.map((f, i) => (isRecord(f) && xy(f.center) && inRange(f.radius, 0.1, 4000) && (f.height === undefined || inRange(f.height, -500, 500)) ? { center: f.center as [number, number], radius: f.radius as number, ...(f.height !== undefined ? { height: f.height as number } : {}) } : fail(`addTerrain flats[${i}] needs center [x,y] and radius`)));
      }
      if (P.paths !== undefined) {
        if (!Array.isArray(P.paths) || P.paths.length > 32) fail('addTerrain paths must be a list');
        params.paths = P.paths.map((q, i) => (isRecord(q) && Array.isArray(q.points) && q.points.length >= 2 && q.points.length <= 256 && q.points.every(xy) && inRange(q.width, 0.2, 100) ? { points: q.points as [number, number][], width: q.width as number } : fail(`addTerrain paths[${i}] needs points [[x,y],…] and width`)));
      }
      const tex = (q: unknown) => typeof q === 'string' && ASSET_ID.test(q);
      const cmd: Extract<Command, { type: 'addTerrain' }> = { type: 'addTerrain', id: v.id, params };
      if (v.name !== undefined) cmd.name = isStr(v.name, 100) ? v.name : fail('addTerrain name invalid');
      if (v.layers !== undefined) cmd.layers = Array.isArray(v.layers) && v.layers.length === 3 && v.layers.every(tex) ? (v.layers as [string, string, string]) : fail('addTerrain layers must be 3 texture ids [grass, path, rock]');
      if (v.scales !== undefined) cmd.scales = Array.isArray(v.scales) && v.scales.length === 3 && v.scales.every((x) => inRange(x, 0.01, 100)) ? (v.scales as [number, number, number]) : fail('addTerrain scales must be 3 numbers (repeats per metre)');
      if (v.position !== undefined) cmd.position = isVec3(v.position) ? (v.position as Vec3) : fail('addTerrain position must be [x,y,z]');
      if (v.tint !== undefined) cmd.tint = isColor(v.tint) ? (v.tint as string) : fail('addTerrain tint must be #rrggbb (colours the grass)');
      return cmd;
    }
    case 'scatter': {
      if (typeof v.id !== 'string' || !REF_ID.test(v.id)) fail('scatter needs an id');
      if (v.asset !== undefined && (typeof v.asset !== 'string' || !ASSET_ID.test(v.asset))) fail('scatter asset must be a library model id');
      if (v.source !== undefined && !isId(v.source)) fail('scatter source must be an object id');
      if ((v.asset === undefined) === (v.source === undefined)) fail('scatter needs either "asset" (library model) or "source" (an object in the scene, e.g. from addPlant)');
      if (!isId(v.on)) fail('scatter needs "on": the terrain id');
      if (!(Number.isInteger(v.count) && inRange(v.count, 1, 20000))) fail('scatter count must be 1..20000');
      const params: ScatterParams = { count: v.count as number, seed: Number.isInteger(v.seed) ? (v.seed as number) : 1 };
      const xy = (q: unknown) => Array.isArray(q) && q.length === 2 && q.every((x) => typeof x === 'number' && Number.isFinite(x));
      if (v.area !== undefined) {
        const a = v.area;
        if (isRecord(a) && xy(a.min) && xy(a.max)) params.area = { min: a.min as [number, number], max: a.max as [number, number] };
        else if (isRecord(a) && xy(a.center) && inRange(a.radius, 0.1, 10000)) params.area = { center: a.center as [number, number], radius: a.radius as number };
        else fail('scatter area must be {min,max} or {center,radius}');
      }
      if (v.scale !== undefined) params.scale = Array.isArray(v.scale) && v.scale.length === 2 && v.scale.every((x) => inRange(x, 0.01, 100)) ? (v.scale as [number, number]) : fail('scatter scale must be [min, max]');
      for (const k of ['spacing', 'maxSlope', 'sink', 'clump'] as const) if (v[k] !== undefined) params[k] = inRange(v[k], 0, 1000) ? (v[k] as number) : fail(`scatter ${k} out of range`);
      if (v.avoidPaths !== undefined) params.avoidPaths = v.avoidPaths === true;
      if (v.avoid !== undefined) {
        if (!Array.isArray(v.avoid) || v.avoid.length > 256) fail('scatter avoid must be a list of {center, radius}');
        params.avoid = v.avoid.map((q, i) => (isRecord(q) && xy(q.center) && inRange(q.radius, 0, 10000) ? { center: q.center as [number, number], radius: q.radius as number } : fail(`scatter avoid[${i}] invalid`)));
      }
      const cmd: Extract<Command, { type: 'scatter' }> = { type: 'scatter', id: v.id, on: v.on, params, ...(v.asset ? { asset: v.asset as string } : { source: v.source as string }) };
      if (v.hideSource === false) cmd.hideSource = false;
      if (v.name !== undefined) cmd.name = isStr(v.name, 100) ? v.name : fail('scatter name invalid');
      return cmd;
    }
    case 'addBuilding': {
      if (typeof v.id !== 'string' || !REF_ID.test(v.id)) fail('addBuilding needs an id');
      const num = (k: string, lo: number, hi: number, d?: number) => (v[k] === undefined && d !== undefined ? d : inRange(v[k], lo, hi) ? (v[k] as number) : fail(`addBuilding ${k} must be ${lo}..${hi}`));
      const cmd: Extract<Command, { type: 'addBuilding' }> = { type: 'addBuilding', id: v.id, width: num('width', 2, 60, 8), depth: num('depth', 2, 60, 6), floors: Math.round(num('floors', 1, 12, 1)) };
      if (v.roof !== undefined) cmd.roof = (ROOFS as readonly string[]).includes(v.roof as string) ? (v.roof as RoofKind) : fail(`addBuilding roof must be ${ROOFS.join(', ')}`);
      if (v.seed !== undefined) cmd.seed = Number.isInteger(v.seed) ? (v.seed as number) : fail('addBuilding seed must be an integer');
      if (v.name !== undefined) cmd.name = isStr(v.name, 100) ? v.name : fail('addBuilding name invalid');
      if (v.style !== undefined) {
        if (!isRecord(v.style)) fail('addBuilding style must be an object');
        const st: BuildingStyle = {};
        for (const [k, c] of Object.entries(v.style)) {
          if (k === 'walls') st.walls = ['plaster', 'brick', 'wood'].includes(c as string) ? (c as BuildingStyle['walls']) : fail('addBuilding style.walls must be plaster, brick or wood');
          else if (['wallColor', 'roofColor', 'trimColor', 'doorColor'].includes(k)) (st as Record<string, unknown>)[k] = isColor(c) ? c : fail(`addBuilding style.${k} must be #rrggbb`);
          else fail(`addBuilding style.${k} unknown`);
        }
        cmd.style = st;
      }
      if (v.transform !== undefined) {
        if (!isRecord(v.transform)) fail('addBuilding transform invalid');
        const t: Partial<Transform> = {};
        for (const k of ['position', 'rotation', 'scale'] as const) if (v.transform[k] !== undefined) t[k] = isVec3(v.transform[k]) ? (v.transform[k] as Vec3) : fail(`addBuilding transform.${k} must be [x,y,z]`);
        cmd.transform = t;
      }
      return cmd;
    }
    case 'addPlant': {
      if (typeof v.id !== 'string' || !REF_ID.test(v.id)) fail('addPlant needs an id');
      if (!(PLANT_KINDS as readonly string[]).includes(v.kind as string)) fail(`addPlant kind must be ${PLANT_KINDS.join(', ')}`);
      const cmd: Extract<Command, { type: 'addPlant' }> = { type: 'addPlant', id: v.id, kind: v.kind as PlantKind, seed: Number.isInteger(v.seed) ? (v.seed as number) : 1 };
      if (v.name !== undefined) cmd.name = isStr(v.name, 100) ? v.name : fail('addPlant name invalid');
      if (v.height !== undefined) cmd.height = inRange(v.height, 0.05, 200) ? (v.height as number) : fail('addPlant height must be 0.05..200 m');
      if (v.colors !== undefined) {
        if (!isRecord(v.colors)) fail('addPlant colors must be {wood, leaves}');
        cmd.colors = {};
        for (const k of ['wood', 'leaves'] as const) if (v.colors[k] !== undefined) cmd.colors[k] = isColor(v.colors[k]) ? (v.colors[k] as string) : fail(`addPlant colors.${k} must be #rrggbb`);
      }
      if (v.transform !== undefined) {
        if (!isRecord(v.transform)) fail('addPlant transform invalid');
        const t: Partial<Transform> = {};
        for (const k of ['position', 'rotation', 'scale'] as const) if (v.transform[k] !== undefined) t[k] = isVec3(v.transform[k]) ? (v.transform[k] as Vec3) : fail(`addPlant transform.${k} must be [x,y,z]`);
        cmd.transform = t;
      }
      return cmd;
    }
    case 'walkPath': {
      if (!isId(v.id) || !isFrame(v.start)) fail('walkPath needs id and start frame');
      if (!Array.isArray(v.points) || v.points.length < 2 || v.points.length > 500 || !v.points.every((p) => Array.isArray(p) && p.length === 2 && p.every((n) => inRange(n, -100000, 100000)))) fail('walkPath points must be 2..500 [x, y] pairs');
      const cmd: Extract<Command, { type: 'walkPath' }> = { type: 'walkPath', id: v.id, start: v.start as number, points: (v.points as number[][]).map((p) => [p[0], p[1]] as [number, number]) };
      if (v.action !== undefined) cmd.action = v.action === 'walk' || v.action === 'run' ? v.action : fail('walkPath action must be walk or run');
      if (v.speed !== undefined) cmd.speed = inRange(v.speed, 0.25, 4) ? (v.speed as number) : fail('walkPath speed must be 0.25..4');
      return cmd;
    }
    case 'playAction': {
      if (!isId(v.id) || !(ACTIONS as readonly string[]).includes(v.action as string) || !isFrame(v.start)) fail(`playAction needs id, start frame and action (${ACTIONS.join(', ')})`);
      const cmd: Extract<Command, { type: 'playAction' }> = { type: 'playAction', id: v.id, action: v.action as ActionName, start: v.start as number };
      if (v.cycles !== undefined) cmd.cycles = inRange(v.cycles, 0.25, 200) ? (v.cycles as number) : fail('playAction cycles must be 0.25..200');
      if (v.speed !== undefined) cmd.speed = inRange(v.speed, 0.1, 5) ? (v.speed as number) : fail('playAction speed must be 0.1..5');
      if (v.travel !== undefined) cmd.travel = typeof v.travel === 'boolean' ? v.travel : fail('playAction travel must be true/false');
      return cmd;
    }
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
    case 'separate': {
      if (!isId(v.id)) fail('separate needs id');
      const mode = v.mode ?? 'selection';
      if (mode !== 'selection' && mode !== 'loose') fail('separate mode must be selection or loose');
      const cmd: Extract<Command, { type: 'separate' }> = { type: 'separate', id: v.id, mode };
      if (v.faces !== undefined) cmd.faces = Array.isArray(v.faces) && v.faces.length <= LIMITS.faces && v.faces.every((f) => Number.isInteger(f) && (f as number) >= 0) ? (v.faces as number[]) : fail('separate faces must be face indices');
      return cmd;
    }
    case 'join':
      if (!isId(v.id) || !Array.isArray(v.others) || !v.others.length || v.others.length > 1000 || !v.others.every(isId)) fail('join needs id and others (a list of object ids)');
      return { type: 'join', id: v.id, others: [...(v.others as string[])] };
    case 'boolean': {
      if (!isId(v.id) || !isId(v.cutter)) fail('boolean needs id (the object) and cutter (the other object)');
      if (!(BOOLEAN_OPS as readonly unknown[]).includes(v.op ?? 'difference')) fail(`boolean op must be one of ${BOOLEAN_OPS.join(', ')}`);
      const cmd: Extract<Command, { type: 'boolean' }> = { type: 'boolean', id: v.id, cutter: v.cutter, op: (v.op ?? 'difference') as BooleanOp };
      if (v.keepCutter !== undefined) cmd.keepCutter = typeof v.keepCutter === 'boolean' ? v.keepCutter : fail('boolean keepCutter must be true/false');
      return cmd;
    }
    case 'cameraMove': {
      if (!(CAMERA_MOVES as readonly unknown[]).includes(v.move)) fail(`cameraMove move must be one of ${CAMERA_MOVES.join(', ')}`);
      const cmd: Extract<Command, { type: 'cameraMove' }> = { type: 'cameraMove', move: v.move as CameraMoveKind };
      if (v.target !== undefined) cmd.target = isVec3(v.target) ? ([...v.target] as Vec3) : fail('cameraMove target must be [x,y,z]');
      if (v.on !== undefined) cmd.on = isId(v.on) ? v.on : fail('cameraMove on must be an object id');
      if (v.start !== undefined) cmd.start = isFrame(v.start) ? v.start : fail('cameraMove start must be a frame');
      if (v.end !== undefined) cmd.end = isFrame(v.end) ? v.end : fail('cameraMove end must be a frame');
      for (const k of ['distance', 'height'] as const) if (v[k] !== undefined) cmd[k] = inRange(v[k], k === 'height' ? -1000 : 0.1, 5000) ? (v[k] as number) : fail(`cameraMove ${k} out of range`);
      for (const k of ['heading', 'degrees'] as const) if (v[k] !== undefined) cmd[k] = inRange(v[k], -3600, 3600) ? (v[k] as number) : fail(`cameraMove ${k} must be degrees`);
      if (v.smooth !== undefined) cmd.smooth = typeof v.smooth === 'boolean' ? v.smooth : fail('cameraMove smooth must be true/false');
      if (v.clearance !== undefined) cmd.clearance = typeof v.clearance === 'boolean' ? v.clearance : fail('cameraMove clearance must be true/false');
      return cmd;
    }
    case 'addWater': {
      if (typeof v.id !== 'string' || !REF_ID.test(v.id)) fail('addWater needs an id');
      if (!Array.isArray(v.size) || v.size.length !== 2 || !v.size.every((n) => inRange(n, 0.1, 20000))) fail('addWater size must be [x, y] metres (0.1..20000)');
      if (!inRange(v.level, -10000, 10000)) fail('addWater level must be the water height z in metres');
      const cmd: Extract<Command, { type: 'addWater' }> = { type: 'addWater', id: v.id, size: [v.size[0] as number, v.size[1] as number], level: v.level as number };
      if (v.name !== undefined) cmd.name = isStr(v.name, 100) ? v.name : fail('addWater name invalid');
      if (v.position !== undefined) cmd.position = Array.isArray(v.position) && v.position.length === 2 && v.position.every((n) => inRange(n, -100000, 100000)) ? [v.position[0] as number, v.position[1] as number] : fail('addWater position must be [x, y]');
      if (v.color !== undefined) cmd.color = isColor(v.color) ? v.color : fail('addWater color must be #rrggbb');
      if (v.clarity !== undefined) cmd.clarity = inRange(v.clarity, 0, 1) ? (v.clarity as number) : fail('addWater clarity must be 0..1');
      if (v.waves !== undefined) cmd.waves = inRange(v.waves, 0.05, 50) ? (v.waves as number) : fail('addWater waves must be 0.05..50 m');
      if (v.speed !== undefined) cmd.speed = inRange(v.speed, 0, 20) ? (v.speed as number) : fail('addWater speed must be 0..20 m/s');
      if (v.height !== undefined) cmd.height = inRange(v.height, 0, 30) ? (v.height as number) : fail('addWater height must be 0..30 m (wave height)');
      if (v.direction !== undefined) cmd.direction = inRange(v.direction, -3600, 3600) ? (v.direction as number) : fail('addWater direction must be degrees');
      return cmd;
    }
    case 'setWater': {
      if (!isId(v.id) || !isRecord(v.water)) fail('setWater needs id and water: {waves?, speed?, height?, direction?}');
      return { type: 'setWater', id: v.id, water: validateWater(v.water, true) };
    }
    case 'setTimeOfDay': {
      if (!(TIMES as readonly unknown[]).includes(v.time)) fail(`setTimeOfDay time must be one of ${TIMES.join(', ')}`);
      const cmd: Extract<Command, { type: 'setTimeOfDay' }> = { type: 'setTimeOfDay', time: v.time as TimeOfDay };
      if (v.heading !== undefined) cmd.heading = inRange(v.heading, -3600, 3600) ? (v.heading as number) : fail('setTimeOfDay heading must be degrees');
      if (v.fog !== undefined) cmd.fog = inRange(v.fog, 0, 100000) ? (v.fog as number) : fail('setTimeOfDay fog must be 0..100000 m');
      return cmd;
    }
    case 'setCamera':
      if (!isVec3(v.position) || !isVec3(v.target)) fail('setCamera needs position and target as [x,y,z]');
      return { type: 'setCamera', position: [...v.position], target: [...v.target] };
    case 'addText': {
      if (!isRecord(v.text)) fail('addText needs text: {body, font?, size?, depth?, align?}');
      const cmd: Extract<Command, { type: 'addText' }> = { type: 'addText', text: validateText(v.text, true) as TextData };
      if (typeof cmd.text.body !== 'string') fail('addText needs text.body (the words)');
      if (v.id !== undefined) cmd.id = typeof v.id === 'string' && REF_ID.test(v.id) ? v.id : fail('id may only use letters, digits, _ . - (max 64)');
      if (v.name !== undefined) cmd.name = isStr(v.name, 100) ? v.name : fail('name invalid');
      if (v.parentId !== undefined && v.parentId !== null) cmd.parentId = isId(v.parentId) ? v.parentId : fail('parentId invalid');
      if (v.material !== undefined) cmd.material = validateMaterial(v.material, true);
      if (v.transform !== undefined) {
        if (!isRecord(v.transform)) fail('transform invalid');
        const tr: Partial<Transform> = {};
        for (const k of ['position', 'rotation', 'scale'] as const) if (v.transform[k] !== undefined) tr[k] = isVec3(v.transform[k]) ? ([...v.transform[k]] as Vec3) : fail(`transform.${k} must be [x,y,z]`);
        cmd.transform = tr;
      }
      return cmd;
    }
    case 'setRigidBody':
      if (!isId(v.id)) fail('setRigidBody needs id');
      if (v.rigid === null) return { type: 'setRigidBody', id: v.id, rigid: null };
      if (!isRecord(v.rigid)) fail('setRigidBody needs rigid: {type?, shape?, mass?, friction?, bounce?, velocity?} or null');
      return { type: 'setRigidBody', id: v.id, rigid: validateRigid(v.rigid, true) };
    case 'setParticles':
      if (!isId(v.id)) fail('setParticles needs id');
      if (v.particles === null) return { type: 'setParticles', id: v.id, particles: null };
      if (!isRecord(v.particles)) fail('setParticles needs particles: {count?, start?, end?, lifetime?, speed?, …} or null');
      return { type: 'setParticles', id: v.id, particles: validateParticles(v.particles, true) };
    case 'fracture': {
      if (!isId(v.id)) fail('fracture needs id');
      if (!(Number.isInteger(v.pieces) && inRange(v.pieces, 2, 100))) fail('fracture pieces must be a whole number 2..100');
      const cmd: Extract<Command, { type: 'fracture' }> = { type: 'fracture', id: v.id, pieces: v.pieces as number };
      if (v.seed !== undefined) cmd.seed = Number.isInteger(v.seed) && inRange(v.seed, 0, 99999) ? (v.seed as number) : fail('fracture seed must be a whole number 0..99999');
      return cmd;
    }
    case 'bakePhysics': {
      const cmd: Extract<Command, { type: 'bakePhysics' }> = { type: 'bakePhysics' };
      if (v.start !== undefined) cmd.start = isFrame(v.start) && Number.isInteger(v.start) ? v.start : fail('bakePhysics start must be a whole frame number');
      if (v.end !== undefined) cmd.end = isFrame(v.end) && Number.isInteger(v.end) ? v.end : fail('bakePhysics end must be a whole frame number');
      return cmd;
    }
    case 'setText':
      if (!isId(v.id) || !isRecord(v.text)) fail('setText needs id and text: {body?, font?, size?, depth?, align?}');
      return { type: 'setText', id: v.id, text: validateText(v.text, true) };
    case 'setLens':
      if (!isRecord(v.lens)) fail('setLens needs lens: {focal?, dof?, fStop?, focus?}');
      return { type: 'setLens', lens: validateLens(v.lens, true) as Extract<Command, { type: 'setLens' }>['lens'] };
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
    case 'editKeys': {
      if (!(KEY_OPS as readonly unknown[]).includes(v.op)) fail(`editKeys op must be one of ${KEY_OPS.join(', ')}`);
      if (!Array.isArray(v.keys) || v.keys.length > 100000 || !v.keys.every((k) => isRecord(k) && typeof k.channel === 'string' && /^(summary|camera|obj:.+|pose:.+)$/.test(k.channel) && isFrame(k.frame)))
        fail('editKeys keys must be a list of {channel, frame}');
      const cmd: Extract<Command, { type: 'editKeys' }> = { type: 'editKeys', op: v.op as KeyOp, keys: (v.keys as KeyRef[]).map((k) => ({ channel: k.channel, frame: k.frame })) };
      if (v.offset !== undefined) cmd.offset = isNum(v.offset) && Number.isInteger(v.offset) && Math.abs(v.offset) <= 100000 ? v.offset : fail('editKeys offset must be a whole number of frames');
      if (v.factor !== undefined) cmd.factor = inRange(v.factor, 0.01, 100) ? (v.factor as number) : fail('editKeys factor must be 0.01..100');
      if (v.pivot !== undefined) cmd.pivot = isFrame(v.pivot) ? v.pivot : fail('editKeys pivot must be a frame');
      if (v.easing !== undefined) cmd.easing = isEasing(v.easing) ? v.easing : fail(`easing must be one of ${EASINGS.join(', ')}`);
      if ((cmd.op === 'move' || cmd.op === 'duplicate') && cmd.offset === undefined) fail(`editKeys ${cmd.op} needs offset`);
      if (cmd.op === 'scale' && cmd.factor === undefined) fail('editKeys scale needs factor');
      if (cmd.op === 'easing' && cmd.easing === undefined) fail('editKeys easing needs easing');
      return cmd;
    }
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

/** Faces grouped into connected pieces (sharing vertices), largest first. */
export function looseParts(m: MeshData): number[][] {
  const parent = m.vertices.map((_, i) => i);
  const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x])));
  for (const f of m.faces) for (let k = 1; k < f.length; k++) parent[find(f[k])] = find(f[0]);
  const groups = new Map<number, number[]>();
  m.faces.forEach((f, i) => {
    const r = find(f[0]);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r)!.push(i);
  });
  return [...groups.values()].sort((a, b) => b.length - a.length);
}
