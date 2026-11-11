// Camera lens, like Blender's camera data: focal length on a 36 mm sensor (Sensor Fit: Auto, so
// the 36 mm spans the wider side of the picture) and depth of field (f-stop, focus distance).

import type { CameraLens } from './types';

/** The viewport's field of view before lenses existed (0.8 rad vertical); scenes without a lens keep it. */
export const LEGACY_FOV = 0.8;
export const SENSOR = 36;
export const FOCAL_PRESETS = [18, 24, 35, 50, 85, 135] as const;
export const FSTOP_PRESETS = [1.4, 2.8, 5.6, 11] as const;

/** Field of view (radians) across the wider side of the picture for a focal length in mm. */
export function lensFov(focal: number): number {
  return 2 * Math.atan(SENSOR / 2 / focal);
}

/**
 * How the viewport camera should be set up for a lens and picture aspect (width / height):
 * the angle and whether it spans the width (landscape) or the height (portrait).
 */
export function cameraFov(lens: CameraLens | undefined, aspect: number): { fov: number; horizontal: boolean } {
  if (!lens?.focal) return { fov: LEGACY_FOV, horizontal: false };
  return { fov: lensFov(lens.focal), horizontal: aspect >= 1 };
}

/** The focal length (mm) that gives the same horizontal view as `cameraFov` for this aspect. */
export function equivalentFocal(lens: CameraLens | undefined, aspect: number): number {
  if (lens?.focal) return lens.focal;
  const vfov = LEGACY_FOV;
  const hfov = 2 * Math.atan(Math.tan(vfov / 2) * aspect);
  const wide = aspect >= 1 ? hfov : vfov;
  return SENSOR / 2 / Math.tan(wide / 2);
}
