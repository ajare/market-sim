/**
 * Editor-side mirror of the simulation's distance model (src/sim/distance.ts):
 * measure the distance between world positions either as a flat plane
 * (Euclidean) or as the surface of a globe (great-circle). The editor and the
 * sim are separate builds, so this is a standalone copy; it must stay in step
 * with the sim's mapping so authored distances match what the simulation runs.
 *
 * Unlike the sim (whose coordinates are world units), the editor already holds
 * NORMALIZED [0,1] coordinates, so these functions take normalized inputs
 * directly. Flat distances are scaled up by worldScale to world-size units;
 * globe distances come out in world units already (radius is in world units).
 */
import { routeRenderPoints, type RouteControlPoint } from "./types";

export type DistanceMode = "flat" | "globe";

export const DISTANCE_MODES: DistanceMode[] = ["flat", "globe"];

export const DEFAULT_DISTANCE_MODE: DistanceMode = "flat";
export const DEFAULT_GLOBE_LON_SPAN = 180;
/** Default sphere radius, in world-size units. worldScale/PI makes a full-width equatorial hop read about the same in flat and globe modes, so toggling doesn't jump the numbers. */
export function defaultGlobeRadius(worldScale: number): number {
  return Math.round((worldScale / Math.PI) * 100) / 100;
}

export interface DistanceConfig {
  mode: DistanceMode;
  radius: number;
  lonSpan: number;
  worldScale: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

const DEG_TO_RAD = Math.PI / 180;

/** A normalized [0,1] position mapped to [longitude, latitude] degrees for the given longitude span (north-up: y=0 is the top / +latitude). */
export function toLonLat(xNorm: number, yNorm: number, lonSpan: number): [number, number] {
  const lon = clamp(xNorm * lonSpan - lonSpan / 2, -180, 180);
  const lat = clamp(lonSpan / 2 - yNorm * lonSpan, -90, 90);
  return [lon, lat];
}

/** Great-circle central angle (radians) between two lon/lat points (haversine). */
export function centralAngle(lonA: number, latA: number, lonB: number, latB: number): number {
  const phi1 = latA * DEG_TO_RAD;
  const phi2 = latB * DEG_TO_RAD;
  const dPhi = (latB - latA) * DEG_TO_RAD;
  const dLambda = (lonB - lonA) * DEG_TO_RAD;
  const a = Math.sin(dPhi / 2) ** 2 + Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLambda / 2) ** 2;
  return 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Distance between two NORMALIZED [0,1] positions, in world-size units, under `config`. */
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

/** World-unit length of a Route's actual (possibly curved) path, summing `normalizedDistance` over its sampled render points -- the flat arc length in flat mode, the great-circle arc length in globe mode. */
export function routeWorldLength(
  a: { x: number; y: number },
  b: { x: number; y: number },
  controlPoints: readonly RouteControlPoint[],
  config: DistanceConfig,
): number {
  const points = routeRenderPoints(a, b, controlPoints);
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += normalizedDistance(points[i - 1].x, points[i - 1].y, points[i].x, points[i].y, config);
  }
  return total;
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
 * arc A->B in globe mode. Used by the auto-routes "detour" check.
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
