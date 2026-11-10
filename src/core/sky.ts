// Time of day: one consistent set of Poly Haven "pure sky" HDRIs (Qwantani, same place, same
// camera) plus a matching sun light, exposure and distance haze.
//
// The sun's position in each HDRI was measured from the image (brightest blob → equirect u, v)
// and calibrated against B3D's viewport: a sky pixel at u appears at Blender azimuth
// 360·u − 161 − world.rotation (degrees, counter-clockwise from +X, seen from above).

export const TIMES = ['sunrise', 'morning', 'noon', 'afternoon', 'sunset', 'dusk', 'night', 'overcast', 'misty'] as const;
export type TimeOfDay = (typeof TIMES)[number];

export interface TimePreset {
  hdri: string;
  /** Equirect u of the sun / moon in the HDRI, and its elevation in degrees. Null: no direct light. */
  sun: { u: number; elevation: number; color: string; power: number; shadows: boolean } | null;
  exposure: number;
  strength: number;
  /** Haze colour (roughly the horizon) and default visibility in metres (0 = no haze). */
  fogColor: string;
  fog: number;
  bloom: number;
}

export const TIME_PRESETS: Record<TimeOfDay, TimePreset> = {
  sunrise: { hdri: 'qwantani_sunrise_puresky', sun: { u: 0.6001, elevation: 4, color: '#ff9a5c', power: 1.4, shadows: true }, exposure: 1.1, strength: 1, fogColor: '#e9b48e', fog: 900, bloom: 0.08 },
  morning: { hdri: 'qwantani_morning_puresky', sun: { u: 0.6001, elevation: 20.2, color: '#ffe0b8', power: 2.8, shadows: true }, exposure: 1.1, strength: 1, fogColor: '#c9d7e6', fog: 1400, bloom: 0.04 },
  noon: { hdri: 'qwantani_noon_puresky', sun: { u: 0.6006, elevation: 49.7, color: '#fffaf2', power: 3.6, shadows: true }, exposure: 1.15, strength: 1, fogColor: '#b9cde6', fog: 2000, bloom: 0.02 },
  afternoon: { hdri: 'qwantani_late_afternoon_puresky', sun: { u: 0.6001, elevation: 19.2, color: '#ffd9a6', power: 2.9, shadows: true }, exposure: 1.1, strength: 1, fogColor: '#d6d8d4', fog: 1400, bloom: 0.05 },
  sunset: { hdri: 'qwantani_sunset_puresky', sun: { u: 0.6001, elevation: 6.2, color: '#ff8a3d', power: 2, shadows: true }, exposure: 1.05, strength: 1, fogColor: '#e2a77c', fog: 900, bloom: 0.1 },
  dusk: { hdri: 'qwantani_dusk_2_puresky', sun: null, exposure: 0.9, strength: 1, fogColor: '#8a6f86', fog: 700, bloom: 0.12 },
  night: { hdri: 'qwantani_night_puresky', sun: { u: 0.7827, elevation: 55, color: '#9fb4ff', power: 0.35, shadows: true }, exposure: 0.42, strength: 0.8, fogColor: '#1c2433', fog: 600, bloom: 0.2 },
  overcast: { hdri: 'kloofendal_overcast_puresky', sun: null, exposure: 1, strength: 1.1, fogColor: '#b8c0c9', fog: 600, bloom: 0 },
  misty: { hdri: 'kloofendal_misty_morning_puresky', sun: null, exposure: 1, strength: 1.1, fogColor: '#c9ccd2', fog: 160, bloom: 0.03 },
};

/** Blender azimuth (degrees) of a sky pixel at equirect u, with the world rotated by `rotation`. */
export const skyAzimuth = (u: number, rotation: number) => (((360 * u - 161 - rotation) % 360) + 360) % 360;

/** World rotation that puts a sky pixel at u at the given azimuth. */
export const rotationFor = (u: number, azimuth: number) => {
  const r = (((360 * u - 161 - azimuth) % 360) + 360) % 360;
  return r > 180 ? r - 360 : r;
};

/**
 * Euler XYZ (degrees) for a sun light shining from (azimuth, elevation): lights point along
 * their local −Z, so tilt by 90° − elevation, then turn by azimuth + 90°.
 */
export const sunRotation = (azimuth: number, elevation: number): [number, number, number] => [
  Math.round((90 - elevation) * 100) / 100,
  0,
  Math.round((((azimuth + 90) % 360) + 360) % 360 * 100) / 100,
];
