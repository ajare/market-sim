/**
 * Planner for "auto-connect Sea routes": given a set of Locations and the
 * Routes already connecting them, works out which unconnected pairs of
 * sea-capable Locations should get a new straight Sea route. Shared between
 * the editor's "Auto-connect Sea routes" header action and the simulation's
 * own "add a Location" feature (see src/sim/world.ts).
 *
 * A pair (A, B) qualifies when ALL of these hold:
 *  - both A and B are sea-capable (have a Port or Platform terminal);
 *  - no SEA route already connects A-B. A route of a DIFFERENT type (e.g. Air)
 *    on the same pair does NOT block a new Sea route -- a pair can be
 *    connected by several Routes of different types (see
 *    src/sim/routes.ts), so parallel routes of different types coexist;
 *  - the straight A->B length is <= maxDistance;
 *  - no OTHER sea-capable Location lies strictly within detourDistance of the
 *    A->B segment -- i.e. no port sits "along the way" that ships would
 *    rather route through. detourDistance = 0 disables this check (nothing is
 *    strictly < 0), so only the max-distance / duplicate / terminal filters
 *    apply.
 *
 * All coordinates here are WORLD-UNIT (matching the simulation's native
 * Location.name -> [x,y] representation) and all distances are computed under
 * the active DistanceConfig (see distance.ts) -- flat Euclidean or globe
 * great-circle. A caller holding normalized [0,1] coordinates (the editor's
 * own Locations) multiplies by worldScale before calling in.
 */
import { worldDistance, worldCrossTrackDistance, type DistanceConfig } from "./distance";
import { ROUTE_TERMINAL_COMPATIBILITY, type RouteType, type TerminalType } from "./terminal";

/** The minimal shape planSeaRoutes needs from a Location -- a unique id, WORLD-UNIT position, and its TerminalTypes. */
export interface RoutePlannerLocation {
  id: string;
  x: number;
  y: number;
  terminalTypes: readonly TerminalType[];
}

/** The minimal shape planSeaRoutes needs from an existing Route. */
export interface RoutePlannerRoute {
  locationAId: string;
  locationBId: string;
  routeType: RouteType;
}

/** An unordered pair of Location ids to connect with a new Sea route. */
export interface SeaRoutePair {
  locationAId: string;
  locationBId: string;
}

/** A Location is sea-capable if it has any terminal a Sea route requires (Port or Platform). */
function isSeaCapable(location: RoutePlannerLocation): boolean {
  const required = ROUTE_TERMINAL_COMPATIBILITY.Sea;
  return location.terminalTypes.some((t) => required.includes(t));
}

export function planSeaRoutes(
  locations: readonly RoutePlannerLocation[],
  routes: readonly RoutePlannerRoute[],
  detourDistance: number,
  maxDistance: number,
  config: DistanceConfig,
): SeaRoutePair[] {
  const ports = locations.filter(isSeaCapable);

  // Set of "a||b" (sorted) for pairs already connected by a SEA route -- only a
  // Sea route suppresses a new one; a route of another type on the pair doesn't
  // (the two coexist, one Route per type -- see src/sim/routes.ts).
  const seaConnected = new Set<string>();
  for (const r of routes) {
    if (r.routeType === "Sea") seaConnected.add([r.locationAId, r.locationBId].sort().join("||"));
  }
  const hasSeaRoute = (aId: string, bId: string) => seaConnected.has([aId, bId].sort().join("||"));

  const pairs: SeaRoutePair[] = [];
  for (let i = 0; i < ports.length; i++) {
    for (let j = i + 1; j < ports.length; j++) {
      const a = ports[i];
      const b = ports[j];
      if (hasSeaRoute(a.id, b.id)) continue;

      const worldLength = worldDistance(a.x, a.y, b.x, b.y, config);
      if (worldLength > maxDistance) continue;

      // Blocked if any OTHER sea-capable port sits strictly within
      // detourDistance of the A->B path (planar point-to-segment in flat
      // mode, spherical cross-track in globe mode -- see distance.ts).
      let blocked = false;
      for (const c of ports) {
        if (c.id === a.id || c.id === b.id) continue;
        if (worldCrossTrackDistance(c, a, b, config) < detourDistance) {
          blocked = true;
          break;
        }
      }
      if (blocked) continue;

      pairs.push({ locationAId: a.id, locationBId: b.id });
    }
  }
  return pairs;
}

/**
 * Every existing Sea route that would now be blocked by `newPort` sitting
 * within `detourDistance` of its straight-line path -- i.e. the detour rule
 * applied retroactively after a new Location is added. Used to prune routes
 * that are no longer "the direct way" now that a port sits along them (see
 * src/sim/world.ts's addLocation).
 */
export function seaRoutesBlockedBy(
  newPort: RoutePlannerLocation,
  locations: readonly RoutePlannerLocation[],
  routes: readonly RoutePlannerRoute[],
  detourDistance: number,
  config: DistanceConfig,
): RoutePlannerRoute[] {
  if (detourDistance <= 0 || !isSeaCapable(newPort)) return [];
  const byId = new Map(locations.map((l) => [l.id, l]));
  return routes.filter((r) => {
    if (r.routeType !== "Sea") return false;
    if (r.locationAId === newPort.id || r.locationBId === newPort.id) return false;
    const a = byId.get(r.locationAId);
    const b = byId.get(r.locationBId);
    if (a === undefined || b === undefined) return false;
    return worldCrossTrackDistance(newPort, a, b, config) < detourDistance;
  });
}
