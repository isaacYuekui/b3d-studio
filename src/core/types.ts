// Core scene model. Plain serializable data — no Babylon types here.
// The renderer (src/engine) mirrors this data; it never owns the truth.
// Conventions follow Blender: metres, right-handed, Z up, Euler XYZ in degrees.

export type Vec3 = [number, number, number];

export const PRIMITIVES = ['cube', 'sphere', 'cylinder', 'cone', 'torus', 'capsule', 'plane'] as const;
export type PrimitiveType = (typeof PRIMITIVES)[number];

export const LIGHT_TYPES = ['point', 'sun', 'spot'] as const;
export type LightType = (typeof LIGHT_TYPES)[number];

/** Every object type the scene can hold. */
export type ObjectType = PrimitiveType | 'mesh' | 'light' | 'empty';
export const OBJECT_TYPES: readonly ObjectType[] = [...PRIMITIVES, 'mesh', 'light', 'empty'];

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
}

/** Principled-BSDF-like material. */
export interface Material {
  baseColor: string; // #rrggbb
  metallic: number; // 0..1
  roughness: number; // 0..1
  emission: string; // #rrggbb, black = none
  emissionStrength: number; // 0..∞
  alpha: number; // 0..1
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

export interface SceneObject {
  id: string;
  name: string;
  type: ObjectType;
  parentId: string | null;
  transform: Transform;
  visible: boolean;
  material: Material;
  params?: PrimitiveParams;
  mesh?: MeshData;
  light?: LightData;
}

export interface SceneDoc {
  /** Object storage keyed by id. */
  objects: Record<string, SceneObject>;
  /** Creation order — gives the Outliner a stable ordering. */
  order: string[];
}

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
};

export const DEFAULT_LIGHT: Record<LightType, LightData> = {
  point: { type: 'point', color: '#ffffff', power: 1000, spotAngle: 45, shadows: true },
  sun: { type: 'sun', color: '#ffffff', power: 3, spotAngle: 45, shadows: true },
  spot: { type: 'spot', color: '#ffffff', power: 1000, spotAngle: 45, shadows: true },
};

export const isRenderable = (t: ObjectType) => t !== 'light' && t !== 'empty';
