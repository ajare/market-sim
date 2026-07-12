/**
 * Two ways to measure the distance between two world positions:
 *  - "flat": the World is a plane; distance is the plain Cartesian (Euclidean)
 *    distance between the two world-coordinate points. This is the default and
 *    reproduces the original behavior everywhere.
 *  - "globe": the World is the surface of a sphere. Each position's normalized
 *    [0,1] fraction of the map is read as a longitude/latitude, and distance is
 *    the great-circle distance radius * centralAngle -- so it comes out in the
 *    same world-size units as the flat distance (radius is in world units).
 *
 * The normalized->degrees mapping uses a single configurable "longitude span":
 * a full map width spans `lonSpan` degrees, and the SAME degrees-per-fraction
 * applies vertically, so a square world stays undistorted. Longitude is
 * centered on 0 and clamped to [-180, 180]; latitude is centered on 0
 * (north-up: the top of the map is +latitude) and clamped to [-90, 90], so a
 * hand-typed position outside the canvas can never produce an out-of-range
 * angle.
 *
 * All inputs here are NORMALIZED [0,1] fractions. Callers holding world
 * coordinates (the simulation's LOCATION_COORDINATES are world units) divide by
 * worldScale first; callers already in normalized space (the editor) pass them
 * straight through.
 */

export type DistanceMode = "flat" | "globe";

export interface DistanceConfig {
  mode: DistanceMode;
  /** Sphere radius in world-size units (globe mode only). */
  radius: number;
  /** Degrees of longitude spanned by a full map width (globe mode only). */
  lonSpan: number;
  /** Multiplier from normalized [0,1] fractions to world-size units (used by flat mode's Euclidean distance). */
  worldScale: number;
}

export const DEFAULT_DISTANCE_MODE: DistanceMode = "flat";
export const DEFAULT_GLOBE_LON_SPAN = 180;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** A normalized [0,1] position mapped to [longitude, latitude] degrees for the given longitude span. */
export function toLonLat(xNorm: number, yNorm: number, lonSpan: number): [number, number] {
  const lon = clamp(xNorm * lonSpan - lonSpan / 2, -180, 180);
  const lat = clamp(lonSpan / 2 - yNorm * lonSpan, -90, 90);
  return [lon, lat];
}

const DEG_TO_RAD = Math.PI / 180;

/** Great-circle central angle (radians) between two lon/lat points, via the haversine formula. */
export function centralAngle(lonA: number, latA: number, lonB: number, latB: number): number {
  const phi1 = latA * DEG_TO_RAD;
  const phi2 = latB * DEG_TO_RAD;
  const dPhi = (latB - latA) * DEG_TO_RAD;
  const dLambda = (lonB - lonA) * DEG_TO_RAD;
  const a =
    Math.sin(dPhi / 2) ** 2 + Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLambda / 2) ** 2;
  return 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Distance between two NORMALIZED [0,1] positions, in world-size units, under
 * the given config. Flat: Euclidean distance scaled by worldScale. Globe:
 * radius * great-circle central angle.
 */
export function normalizedDistance(
  xNormA: number,
  yNormA: number,
  xNormB: number,
  yNormB: number,
  config: DistanceConfig,
): number {
  if (config.mode === "globe") {
    const [lonA, latA] = toLonLat(xNormA, yNormA, config.lonSpan);
    const [lonB, latB] = toLonLat(xNormB, yNormB, config.lonSpan);
    return config.radius * centralAngle(lonA, latA, lonB, latB);
  }
  return Math.hypot(xNormA - xNormB, yNormA - yNormB) * config.worldScale;
}
