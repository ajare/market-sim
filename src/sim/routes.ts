/**
 * Routes: direct, typed connections between locations (Sea/Land/Air),
 * and the procedurally generated route network. Ported from sim/routes.py,
 * extended with a geometry a Route can render/measure itself along (see
 * Route) -- either a plain straight line between endpoints, or a bowed
 * Bezier curve through generated control points, so a route can read as a
 * distinct curved lane on a map rather than always a straight edge.
 */
import { Rng } from "./rng";
import type { Location } from "./location";
import { distanceBetween, pointDistance, LOCATION_COORDINATES, WORLD_GEN_SEED } from "./worldData";
// Imported AND re-exported so every existing `from "./routes"` import of
// RouteType/ROUTE_TERMINAL_COMPATIBILITY keeps working -- these now live in
// @market-sim/shared (shared with the editor).
import type { RouteType } from "@market-sim/shared/terminal";
import { ROUTE_TERMINAL_COMPATIBILITY, compatibleRouteTypes as sharedCompatibleRouteTypes } from "@market-sim/shared/terminal";
export type { RouteType };
export { ROUTE_TERMINAL_COMPATIBILITY };

export type Point = readonly [number, number];

export const ROUTE_TYPE_DISTANCE_SCALE: Record<RouteType, number> = {
  Air: 1.0,
  Sea: 0.8,
  Land: 0.5,
  // Space routes reach the furthest -- never pruned for distance any more
  // aggressively than Air.
  Space: 1.0,
  // Surface haulage -- short-to-medium reach, like Land.
  Road: 0.5,
  Railroad: 0.6,
};

/** How far a control point may bow off the straight origin-destination line, as a fraction of that line's length. */
const MAX_CONTROL_POINT_BOW_FRACTION = 0.12;

/** Points sampled evenly in Bezier parameter t along a Route's curve, cached at construction. Doubles as the polyline used to draw the curve and the lookup table pointAtFraction walks to place a Transport at a constant-speed fraction of the route's actual (arc-length) distance. */
const CURVE_SAMPLE_COUNT = 24;

/** Small deterministic string hash (FNV-1a) so a Route's control points depend only on (seed, origin, destination) -- reproducible regardless of what order routes are generated in or what the route-type-selection RNG stream has already consumed. */
function hashSeed(seed: number, a: string, b: string): number {
  let h = (seed ^ 0x9e3779b9) >>> 0;
  for (const part of [a, b]) {
    for (let i = 0; i < part.length; i++) {
      h ^= part.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
  }
  return h >>> 0;
}

/** De Casteljau evaluation -- works for a Bezier curve of any degree, not just cubic, so `controlPointCount` isn't locked to 2. */
function bezierPoint(points: readonly Point[], t: number): Point {
  let pts: Point[] = points.slice();
  while (pts.length > 1) {
    const next: Point[] = [];
    for (let i = 0; i < pts.length - 1; i++) {
      next.push([pts[i][0] + (pts[i + 1][0] - pts[i][0]) * t, pts[i][1] + (pts[i + 1][1] - pts[i][1]) * t]);
    }
    pts = next;
  }
  return pts[0];
}

/** `count` control points spaced evenly along the origin-destination line, each nudged sideways by a random fraction of the line's length (see MAX_CONTROL_POINT_BOW_FRACTION) so the resulting curve reads as a distinct lane rather than a straight edge. */
function generateControlPoints(rng: Rng, origin: Point, destination: Point, count: number): Point[] {
  const dx = destination[0] - origin[0];
  const dy = destination[1] - origin[1];
  const length = Math.hypot(dx, dy) || 1;
  const perpX = -dy / length;
  const perpY = dx / length;
  const maxBow = length * MAX_CONTROL_POINT_BOW_FRACTION;

  const points: Point[] = [];
  for (let i = 1; i <= count; i++) {
    const t = i / (count + 1);
    const bow = rng.uniform(-maxBow, maxBow);
    points.push([origin[0] + dx * t + perpX * bow, origin[1] + dy * t + perpY * bow]);
  }
  return points;
}

export class Route {
  origin: string;
  destination: string;
  routeType: RouteType;
  /** Interior Bezier control points between origin and destination, in the same coordinate space as LOCATION_COORDINATES -- empty for a straight Route, `controlPointCount` long for a curved one. */
  controlPoints: Point[];
  /**
   * Arc length of this Route's curve through origin, controlPoints, and
   * destination -- the plain Euclidean distance when there are no control
   * points, or the Bezier curve's arc length otherwise. Computed once here
   * (control points never change afterward) and used everywhere a Route's
   * distance matters: fuel cost, travel time (see routeTravelDays), and
   * pathfinding edge weight.
   */
  distance: number;
  private samplePoints: Point[];
  private cumulativeDistances: number[];

  constructor(
    origin: string,
    destination: string,
    routeType: RouteType,
    seed: number = WORLD_GEN_SEED,
    controlPointCount: number = 0,
  ) {
    this.origin = origin;
    this.destination = destination;
    this.routeType = routeType;

    const originPoint = LOCATION_COORDINATES[origin];
    const destPoint = LOCATION_COORDINATES[destination];
    // Everything about a Route's shape is derived from its control-point count:
    // zero -> a straight line (no RNG consumed at all), otherwise that many
    // bowed Bezier control points.
    if (controlPointCount <= 0) {
      this.controlPoints = [];
    } else {
      const rng = new Rng(hashSeed(seed, origin, destination));
      this.controlPoints = generateControlPoints(rng, originPoint, destPoint, controlPointCount);
    }

    const curvePoints: Point[] = [originPoint, ...this.controlPoints, destPoint];
    this.samplePoints = [curvePoints[0]];
    this.cumulativeDistances = [0];
    let cumulative = 0;
    let prev = curvePoints[0];
    for (let i = 1; i <= CURVE_SAMPLE_COUNT; i++) {
      const point = bezierPoint(curvePoints, i / CURVE_SAMPLE_COUNT);
      // Each segment measured under the active distance mode (Euclidean in flat
      // mode, great-circle in globe mode -- see distance.ts), so a curved
      // Route's total length is the arc length along the surface either way.
      cumulative += pointDistance(prev[0], prev[1], point[0], point[1]);
      this.samplePoints.push(point);
      this.cumulativeDistances.push(cumulative);
      prev = point;
    }
    this.distance = cumulative;
  }

  /** Points sampled along this Route's Bezier curve, origin to destination -- for drawing the curve on a map. */
  curvePoints(): readonly Point[] {
    return this.samplePoints;
  }

  /**
   * Where a Transport sits after covering `fraction` (0-1) of this Route's
   * distance, walking at constant speed along the actual curve --
   * arc-length-parameterized via the cached sample/cumulative-distance
   * tables, since the raw Bezier parameter t is not itself proportional to
   * distance travelled on a bowed curve.
   */
  pointAtFraction(fraction: number): Point {
    const target = Math.min(1, Math.max(0, fraction)) * this.distance;
    const distances = this.cumulativeDistances;
    const last = distances.length - 1;
    if (target <= 0) return this.samplePoints[0];
    if (target >= distances[last]) return this.samplePoints[last];
    let i = 1;
    while (distances[i] < target) i++;
    const span = distances[i] - distances[i - 1] || 1;
    const segFrac = (target - distances[i - 1]) / span;
    const [x1, y1] = this.samplePoints[i - 1];
    const [x2, y2] = this.samplePoints[i];
    return [x1 + (x2 - x1) * segFrac, y1 + (y2 - y1) * segFrac];
  }
}

/** Days to travel the full length of `route`'s curve at `speedUnitsPerDay` -- the route-aware counterpart of worldData's travelDaysBetween, used wherever a leg's actual Route (not just its endpoints) is already in hand. */
export function routeTravelDays(route: Route, speedUnitsPerDay: number): number {
  return Math.max(1, Math.ceil(route.distance / speedUnitsPerDay));
}

/** Canonical, order-independent key for a location pair -- stands in for Python's frozenset key. */
export function routeKey(locationA: string, locationB: string): string {
  return [locationA, locationB].sort().join("||");
}

function compatibleRouteTypes(origin: Location, destination: Location): RouteType[] {
  return sharedCompatibleRouteTypes([...origin.terminalTypes], [...destination.terminalTypes]);
}

export function generateRoutes(
  locations: Location[],
  seed: number = WORLD_GEN_SEED,
  maxDistance?: number,
): Map<string, Route[]> {
  const rng = new Rng(seed + 2);
  const routes = new Map<string, Route[]>();

  for (let i = 0; i < locations.length; i++) {
    const origin = locations[i];
    for (let j = i + 1; j < locations.length; j++) {
      const destination = locations[j];
      const compatibleTypes = compatibleRouteTypes(origin, destination);
      if (compatibleTypes.length === 0) continue;
      const routeType = rng.choice(compatibleTypes);
      if (maxDistance !== undefined) {
        const scale = ROUTE_TYPE_DISTANCE_SCALE[routeType] ?? 1.0;
        if (distanceBetween(origin.name, destination.name) > maxDistance * scale) continue;
      }
      addRouteToNetwork(routes, new Route(origin.name, destination.name, routeType, seed));
    }
  }
  return routes;
}

/**
 * The route network, keyed by location pair (routeKey). A pair can be connected
 * by more than one Route, of DIFFERENT types (e.g. a Sea route and an Air route
 * between the same two ports), so each entry is a list -- at most one Route per
 * RouteType. Pathfinding treats every Route in every list as its own edge (see
 * pathfinding.ts), so parallel routes of different types are naturally weighed
 * against each other per the transport that can use them.
 */
export let ROUTES: Map<string, Route[]> = new Map();

/** Wholesale-reassign the route network (called once by buildWorld). */
export function setRoutes(routes: Map<string, Route[]>): void {
  ROUTES = routes;
}

/**
 * Adds `route` to a route-network map, grouped by its location pair. A pair may
 * hold several Routes of different types, but never two of the same type -- a
 * duplicate RouteType for a pair is ignored (the first one wins), since the
 * pair can only be connected once by any given mode.
 */
export function addRouteToNetwork(network: Map<string, Route[]>, route: Route): void {
  const key = routeKey(route.origin, route.destination);
  const list = network.get(key);
  if (list === undefined) {
    network.set(key, [route]);
    return;
  }
  if (list.some((r) => r.routeType === route.routeType)) return;
  list.push(route);
}

/** Every Route directly connecting the two locations, across all types (empty if none, or if the two are the same location). */
export function getRoutes(locationA: string, locationB: string): Route[] {
  if (locationA === locationB) return [];
  return ROUTES.get(routeKey(locationA, locationB)) ?? [];
}

/**
 * A single Route directly connecting the two locations -- the shortest one if
 * the pair has several of different types. For display/tracing where any one of
 * the pair's routes will do; trading logic uses getRoutes (all of them) so it
 * can pick whichever type the transport can actually use.
 */
export function getRoute(locationA: string, locationB: string): Route | undefined {
  const list = getRoutes(locationA, locationB);
  if (list.length === 0) return undefined;
  return list.reduce((best, r) => (r.distance < best.distance ? r : best));
}
