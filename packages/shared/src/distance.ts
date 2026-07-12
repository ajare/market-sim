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
 * coordinates (the simulation's LOCATION_COORDINATES are world units, as are
 * the world-unit Location coordinates the shared route-planning module takes
 * -- see routePlanning.ts) divide by worldScale first; callers already in
 * normalized space (the editor's own Locations) pass them straight through.
 */

export type DistanceMode = "flat" | "globe";

export const DISTANCE_MODES: DistanceMode[] = ["flat", "globe"];

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

/** Default sphere radius, in world-size units. worldScale/PI makes a full-width equatorial hop read about the same in flat and globe modes, so toggling doesn't jump the numbers. */
export function defaultGlobeRadius(worldScale: number): number {
  return Math.round((worldScale / Math.PI) * 100) / 100;
}

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

/** Initial bearing (radians) from point 1 to point 2, both lon/lat degrees. */
function bearing(lon1: number, lat1: number, lon2: number, lat2: number): number {
  const phi1 = lat1 * DEG_TO_RAD;
  const phi2 = lat2 * DEG_TO_RAD;
  const dLambda = (lon2 - lon1) * DEG_TO_RAD;
  const y = Math.sin(dLambda) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLambda);
  return Math.atan2(y, x);
}

/**
 * Shortest world-unit distance from point C to the path between A and B under
 * `config` -- the flat point-to-segment distance in flat mode, and the
 * spherical cross-track distance (clamped to the endpoints) to the great-circle
 * arc A->B in globe mode. All three points are NORMALIZED [0,1]. Used by the
 * route-planner's "detour" check (see routePlanning.ts).
 */
export function crossTrackDistance(
  c: { x: number; y: number },
  a: { x: number; y: number },
  b: { x: number; y: number },
  config: DistanceConfig,
): number {
  if (config.mode !== "globe") {
    // Planar point-to-segment on normalized coords, scaled to world units.
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lengthSquared = dx * dx + dy * dy;
    if (lengthSquared === 0) return Math.hypot(c.x - a.x, c.y - a.y) * config.worldScale;
    const t = clamp(((c.x - a.x) * dx + (c.y - a.y) * dy) / lengthSquared, 0, 1);
    return Math.hypot(c.x - (a.x + t * dx), c.y - (a.y + t * dy)) * config.worldScale;
  }
  const [lonA, latA] = toLonLat(a.x, a.y, config.lonSpan);
  const [lonB, latB] = toLonLat(b.x, b.y, config.lonSpan);
  const [lonC, latC] = toLonLat(c.x, c.y, config.lonSpan);
  const delta13 = centralAngle(lonA, latA, lonC, latC);
  const delta12 = centralAngle(lonA, latA, lonB, latB);
  if (delta12 === 0) return config.radius * delta13;
  const theta13 = bearing(lonA, latA, lonC, latC);
  const theta12 = bearing(lonA, latA, lonB, latB);
  const crossTrack = Math.asin(clamp(Math.sin(delta13) * Math.sin(theta13 - theta12), -1, 1));
  const alongTrack = Math.acos(clamp(Math.cos(delta13) / Math.cos(crossTrack), -1, 1));
  // Clamp to the segment: past either end, the nearest point is that endpoint.
  if (alongTrack < 0) return config.radius * delta13;
  if (alongTrack > delta12) return config.radius * centralAngle(lonB, latB, lonC, latC);
  return config.radius * Math.abs(crossTrack);
}

/**
 * `normalizedDistance`/`crossTrackDistance`'s world-unit counterparts: takes
 * WORLD-UNIT coordinates directly (dividing by config.worldScale internally
 * before delegating), matching the simulation's native Location coordinate
 * representation and the shared route-planning module's Location-shaped
 * inputs (see routePlanning.ts). A caller already holding normalized [0,1]
 * coordinates (the editor's own Locations) multiplies by worldScale first.
 */
export function worldDistance(x1: number, y1: number, x2: number, y2: number, config: DistanceConfig): number {
  const scale = config.worldScale;
  return normalizedDistance(x1 / scale, y1 / scale, x2 / scale, y2 / scale, config);
}

/** World-unit-coordinate counterpart of crossTrackDistance -- see worldDistance. */
export function worldCrossTrackDistance(
  c: { x: number; y: number },
  a: { x: number; y: number },
  b: { x: number; y: number },
  config: DistanceConfig,
): number {
  const scale = config.worldScale;
  const norm = (p: { x: number; y: number }) => ({ x: p.x / scale, y: p.y / scale });
  return crossTrackDistance(norm(c), norm(a), norm(b), config);
}
