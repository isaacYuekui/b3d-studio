// The command system: the ONLY way the scene changes.
//
// Every edit (UI click, keyboard shortcut, gizmo drag, file import, scene scripts
// written by Claude) is expressed as a plain JSON command, validated, then applied
// by a pure function. This gives us:
//   - undo/redo for free (snapshots of immutable docs)
//   - a safe surface for AI: Claude emits JSON commands, never JavaScript
//   - easy unit testing

import { BACKGROUNDS, DEFAULT_LIGHT, DEFAULT_MATERIAL, DEFAULT_WORLD, IDENTITY, LIGHT_TYPES, OBJECT_TYPES, PRIMITIVES } from './types';
import type { Background, LightData, LightType, Material, MeshData, ObjectType, PrimitiveParams, SceneDoc, SceneObject, Transform, Vec3, World } from './types';

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
  | { type: 'setWorld'; world: Partial<World> }
  | { type: 'setCamera'; position: Vec3; target: Vec3 }
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
      return { doc: { ...doc, objects: { ...doc.objects, [id]: obj }, order: [...doc.order, id] }, created: [id] };
    }

    case 'delete': {
      const doomed = new Set<string>();
      for (const id of cmd.ids) if (doc.objects[id]) subtree(doc, id).forEach((x) => doomed.add(x));
      if (doomed.size === 0) return { doc, created: [] };
      const objects: Record<string, SceneObject> = {};
      for (const [id, o] of Object.entries(doc.objects)) if (!doomed.has(id)) objects[id] = o;
      return { doc: { ...doc, objects, order: doc.order.filter((id) => !doomed.has(id)) }, created: [] };
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
          if (isRoot) created.push(newId);
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

    case 'setWorld':
      return { doc: { ...doc, world: { ...DEFAULT_WORLD, ...doc.world, ...cmd.world } }, created: [] };

    case 'setCamera':
      return { doc: { ...doc, camera: { position: [...cmd.position], target: [...cmd.target] } }, created: [] };

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
    if (!Array.isArray(f) || f.length < 3 || f.length > 64) fail(`mesh face ${i} must list 3..64 vertex indices`);
    return f.map((idx) => (Number.isInteger(idx) && idx >= 0 && idx < n ? (idx as number) : fail(`mesh face ${i} has invalid index ${String(idx)}`)));
  });
  return { vertices, faces, smooth: v.smooth === true };
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
  if (obj.type === 'light') obj.light = { ...DEFAULT_LIGHT.point, ...validateLight(v.light, false) } as LightData;
  if (obj.type === 'model') obj.asset = typeof v.asset === 'string' && ASSET_ID.test(v.asset) ? v.asset : fail(`object ${v.id}: asset invalid`);
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
  if (v.camera !== undefined) {
    const c = v.camera;
    if (!isRecord(c) || !isVec3(c.position) || !isVec3(c.target)) fail('camera needs position and target [x,y,z]');
    doc.camera = { position: [...c.position], target: [...c.target] };
  }
  return doc;
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
    case 'setWorld':
      return { type: 'setWorld', world: validateWorld(v.world) };
    case 'setCamera':
      if (!isVec3(v.position) || !isVec3(v.target)) fail('setCamera needs position and target as [x,y,z]');
      return { type: 'setCamera', position: [...v.position], target: [...v.target] };
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
