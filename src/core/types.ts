// Core scene model. Plain serializable data — no Babylon types here.
// The renderer (src/engine) mirrors this data; it never owns the truth.
// Conventions follow Blender: metres, right-handed, Z up, Euler XYZ in degrees.

export type Vec3 = [number, number, number];

export const PRIMITIVES = ['cube', 'sphere', 'cylinder', 'cone', 'torus', 'capsule', 'plane'] as const;
export type PrimitiveType = (typeof PRIMITIVES)[number];

export const LIGHT_TYPES = ['point', 'sun', 'spot'] as const;
export type LightType = (typeof LIGHT_TYPES)[number];

/** Every object type the scene can hold. */
export type ObjectType = PrimitiveType | 'mesh' | 'model' | 'light' | 'empty' | 'armature' | 'scatter';
export const OBJECT_TYPES: readonly ObjectType[] = [...PRIMITIVES, 'mesh', 'model', 'light', 'empty', 'armature', 'scatter'];

export interface Transform {
  position: Vec3;
  /** Euler rotation in DEGREES (user/AI friendly). Engine converts to radians. */
  rotation: Vec3;
  scale: Vec3;
}

/** Optional shape parameters for primitives. Missing values use Blender's defaults. */
export interface PrimitiveParams {
  /** sphere / cylinder / cone / torus / capsule resolution */
  segments?: number;
  /** cylinder & cone: radius at the top (cone defaults to 0) */
  radiusTop?: number;
  /** cylinder & cone: radius at the bottom */
  radiusBottom?: number;
  /** torus: distance from centre to tube centre */
  majorRadius?: number;
  /** torus: tube radius */
  minorRadius?: number;
}

/** Custom geometry in Blender coordinates. Faces are polygons (3+ vertex indices, counter-clockwise seen from outside). */
export interface MeshData {
  vertices: Vec3[];
  faces: number[][];
  /** Smooth shading (averaged normals) vs flat facets. */
  smooth: boolean;
  /** Added to positions before box-projecting UVs, so the pieces of a broken object keep its texture in place. */
  uvOffset?: Vec3;
  /** Material slot of each face (0 = the object's material, 1.. = materialSlots); missing = all 0. */
  materialIndex?: number[];
  /** UV map: per face, one [u, v] per corner (0..1 image space); missing = box projection in metres. */
  uv?: [number, number][][];
}

/** Principled-BSDF-like material. */
export interface Material {
  baseColor: string; // #rrggbb
  metallic: number; // 0..1
  roughness: number; // 0..1
  emission: string; // #rrggbb, black = none
  emissionStrength: number; // 0..∞
  alpha: number; // 0..1
  /** Library texture set id (photo-scanned PBR maps), or null for a plain colour. */
  texture: string | null;
  /** How many times the texture repeats across each face. */
  textureScale: number;
  /** Principled extras (Blender names), all 0..1 unless noted; absent = off. */
  clearcoat?: number;
  clearcoatRoughness?: number;
  sheen?: number;
  sheenColor?: string;
  /** Glass-like see-through with refraction; ior 1..3 (glass 1.5, water 1.33). */
  transmission?: number;
  ior?: number;
  /** Light scattering under the surface (skin, wax, leaves); tinted by subsurfaceColor. */
  subsurface?: number;
  subsurfaceColor?: string;
  /** Stretched highlights (brushed metal). */
  anisotropy?: number;
  /** Procedural pattern (used when no library texture is set). */
  pattern?: import('./patterns').Pattern | null;
  /** Shader Editor node graph (Blender's Use Nodes): when set, it decides the surface. */
  nodes?: import('./shaderNodes').ShaderGraph | null;
}

export interface LightData {
  type: LightType;
  color: string;
  /** Watts for point/spot (Blender-like scale), strength for sun. */
  power: number;
  /** Spot cone angle in degrees. */
  spotAngle: number;
  shadows: boolean;
}

/** Non-destructive modifiers on a mesh object, evaluated Mirror → Array → Solidify → Bevel → Subdivision → Displace. */
export interface Modifiers {
  mirror?: {
    x: boolean;
    y: boolean;
    z: boolean;
    /** Keep vertices on the mirror plane from crossing it while editing. */
    clip?: boolean;
    /** Weld distance on the mirror plane, metres. */
    merge?: number;
  };
  /**
   * Array: `count` copies, each shifted by `relative` × the mesh's size plus `constant` metres
   * (Blender's Relative / Constant Offset). `merge` welds copies that touch (default on).
   */
  array?: { count: number; relative: Vec3; constant?: Vec3; merge?: boolean };
  /**
   * Solidify: give a surface thickness (metres). `offset` −1 grows inwards (Blender's default),
   * 1 outwards, 0 both ways. `rim` closes open edges (default on).
   */
  solidify?: { thickness: number; offset?: number; rim?: boolean };
  /** Bevel every edge sharper than `angle` degrees (Blender's Bevel modifier, Limit Method: Angle). */
  bevel?: { width: number; segments: number; angle: number };
  /** Catmull–Clark subdivision surface; edges sharper than `sharpAngle` degrees stay crisp (creased). */
  subdivision?: { levels: number; sharpAngle?: number };
  /**
   * Displace: push the surface along its normals by 3D noise — `strength` metres, `scale` = size
   * of the bumps in metres, `seed` picks another pattern. Runs last, so subdivide first for detail.
   */
  displace?: { strength: number; scale: number; seed?: number };
  /** Curve: the vertices are control points of a smooth path, drawn as a tube (Blender's curve object). */
  curve?: import('./curve').CurveSettings;
}

/** One bone of an armature, in the armature's local space (metres, Z up), like Blender's edit bones. */
export interface Bone {
  name: string;
  parent: string | null;
  head: Vec3;
  tail: Vec3;
  /** Twist around the bone's length, degrees. */
  roll?: number;
  /** false for control bones that should not move the mesh. */
  deform?: boolean;
}

export interface ArmatureData {
  bones: Bone[];
}

/** A bone's pose relative to its rest position, in the bone's own axes (Y along the bone). */
export interface BonePose {
  rotation: Vec3;
  location?: Vec3;
}

export interface SceneObject {
  id: string;
  name: string;
  type: ObjectType;
  parentId: string | null;
  transform: Transform;
  visible: boolean;
  /** Collection id (Outliner folder); none = the Scene Collection. */
  collection?: string;
  /** Follow Path: move along a curve object between two frames (Blender's Follow Path constraint). */
  follow?: FollowPath;
  material: Material;
  /** More materials for faces of a mesh (Blender's material slots 2, 3…); faces pick one with mesh.materialIndex. */
  materialSlots?: Material[];
  params?: PrimitiveParams;
  mesh?: MeshData;
  /** Mesh objects only. */
  modifiers?: Modifiers;
  light?: LightData;
  /** Library model id, for type 'model'. */
  asset?: string;
  /** Armature objects: bones and the current pose. */
  armature?: ArmatureData;
  pose?: Record<string, BonePose>;
  /**
   * Mesh objects: deformed by this armature. Weights are automatic (bone distance) unless
   * `bone` (follow one bone rigidly, e.g. eyes) or `weights` (a library weight set such as
   * "humans/male#body") is given.
   */
  skin?: { armature: string; bone?: string; weights?: string };
  /** Terrain meshes: grid layout and texture layers (grass / path / rock blend). */
  terrain?: import('./terrain').TerrainData;
  /** Scatter objects: many copies of one library model, each [x, y, z, yaw°, scale] in world space. */
  scatter?: { asset?: string; source?: string; items: import('./terrain').ScatterItem[] };
  /** Particle system emitted from this object's surface (Blender's Particles, Emitter). */
  particles?: import('./particles').ParticleSettings;
  /** Rigid body physics settings (Blender's Physics → Rigid Body); baked into keyframes. */
  rigid?: import('./physics').RigidBody;
  /** Text objects (a mesh made from a font): editing the mesh itself turns it into a plain mesh. */
  text?: import('./text').TextData;
  /** Water surfaces: animated ripples (size of the waves in metres, speed in m/s). */
  water?: import('./ocean').WaterSettings;
  /** Force field (on an empty): pushes rigid bodies during the physics bake. */
  field?: import('./fields').ForceField;
  /** Floats on the water under it, bobbing and tilting with the waves. */
  float?: import('./ocean').FloatSettings;
}

export const BACKGROUNDS = ['color', 'hdri', 'blurred'] as const;
export type Background = (typeof BACKGROUNDS)[number];

/** Scene-wide lighting and camera look, used in Rendered shading. */
export interface World {
  /** Library HDRI id lighting the scene, or null for the neutral studio. */
  hdri: string | null;
  strength: number;
  /** Rotation of the HDRI around Z, degrees. */
  rotation: number;
  background: Background;
  color: string;
  exposure: number;
  /** Glow around bright/emissive areas, 0..1. */
  bloom: number;
  /** Ambient occlusion: soft contact shadows in corners and creases. */
  ao: boolean;
  /** Distance haze: metres at which things are half hidden (0 = off). */
  fog: number;
  fogColor: string;
  /** Time-of-day preset this world came from (informational; set by setTimeOfDay). */
  time?: string;
}

/** The scene's composed viewpoint (Blender's camera view, key 0). Blender coordinates. */
export interface SceneCamera {
  position: Vec3;
  target: Vec3;
}

/** Camera lens settings (Blender's camera data), for the scene camera view and videos. */
export interface CameraLens {
  /** Focal length in mm on a 36 mm sensor (Blender's default 50). Unset = the app's original wide view. */
  focal?: number;
  /** Depth of field: things nearer or farther than the focus distance blur. */
  dof?: boolean;
  /** Aperture: lower = blurrier background (1.4 portrait, 2.8, 5.6, 11 everything sharp). */
  fStop?: number;
  /** Focus distance in metres; unset = the camera's target point. */
  focus?: number;
}

export interface FollowPath {
  /** The curve object's id. */
  curve: string;
  start: number;
  end: number;
  /** Turn to face along the path (its +Y forward, Z up). */
  orient: boolean;
  /** Where along the path it starts / ends, 0..1 (default 0 → 1). */
  from?: number;
  to?: number;
}

export interface SceneDoc {
  /** Object storage keyed by id. */
  objects: Record<string, SceneObject>;
  /** Creation order — gives the Outliner a stable ordering. */
  order: string[];
  /** Outliner collections, in display order. */
  collections?: import('./collections').Collection[];
  world?: World;
  camera?: SceneCamera;
  lens?: CameraLens;
  animation?: import('./animation').Animation;
}

export const DEFAULT_WORLD: World = {
  hdri: null,
  strength: 1,
  rotation: 0,
  background: 'color',
  color: '#3c3c3c',
  exposure: 1,
  bloom: 0,
  ao: true,
  fog: 0,
  fogColor: '#b9cde6',
};

export const worldOf = (doc: SceneDoc): World => ({ ...DEFAULT_WORLD, ...doc.world });

export const IDENTITY: Transform = {
  position: [0, 0, 0],
  rotation: [0, 0, 0],
  scale: [1, 1, 1],
};

export const DEFAULT_MATERIAL: Material = {
  baseColor: '#b4b4b4',
  metallic: 0,
  roughness: 0.5,
  emission: '#000000',
  emissionStrength: 0,
  alpha: 1,
  texture: null,
  textureScale: 1,
};

export const DEFAULT_LIGHT: Record<LightType, LightData> = {
  point: { type: 'point', color: '#ffffff', power: 1000, spotAngle: 45, shadows: true },
  sun: { type: 'sun', color: '#ffffff', power: 3, spotAngle: 45, shadows: true },
  spot: { type: 'spot', color: '#ffffff', power: 1000, spotAngle: 45, shadows: true },
};

export const isRenderable = (t: ObjectType) => t !== 'light' && t !== 'empty' && t !== 'armature' && t !== 'scatter';
