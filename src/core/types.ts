// Core scene model. Plain serializable data — no Babylon types here.
// The renderer (src/engine) mirrors this data; it never owns the truth.

export type Vec3 = [number, number, number];

export const PRIMITIVES = ['cube', 'sphere', 'cylinder', 'plane'] as const;
export type PrimitiveType = (typeof PRIMITIVES)[number];

export interface Transform {
  position: Vec3;
  /** Euler rotation in DEGREES (user/AI friendly). Engine converts to radians. */
  rotation: Vec3;
  scale: Vec3;
}

export interface SceneObject {
  id: string;
  name: string;
  type: PrimitiveType;
  parentId: string | null;
  transform: Transform;
  /** Hex colour, e.g. "#cccccc". Placeholder until the PBR material system lands. */
  color: string;
  visible: boolean;
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
