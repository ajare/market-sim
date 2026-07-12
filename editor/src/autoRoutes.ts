/**
 * Planner for the header's "Auto-connect Sea routes" action: given the current
 * Locations and Routes, works out which unconnected pairs of sea-capable ports
 * should get a new straight Sea route.
 *
 * A pair (A, B) qualifies when ALL of these hold:
 *  - both A and B are sea-capable (have a Port or Platform terminal);
 *  - no SEA route already connects A-B. A route of a DIFFERENT type (e.g. Air)
 *    on the same pair does NOT block a new Sea route -- the simulation keeps one
 *    Route per type per pair (see src/sim/routes.ts), so parallel routes of
 *    different types coexist;
 *  - the straight A->B length, in world units, is <= maxDistance;
 *  - no OTHER sea-capable port lies strictly within detourDistance (world
 *    units) of the A->B segment -- i.e. no port sits "along the way" that
 *    ships would rather route through. detourDistance = 0 disables this check
 *    (nothing is strictly < 0), so only the max-distance / duplicate / terminal
 *    filters apply.
 *
 * All distances are computed under the active DistanceConfig (see distance.ts)
 * -- flat Euclidean or globe great-circle -- so the thresholds the user types
 * are in the same world units shown everywhere else, in whichever mode is on.
 */
import type { EditorLocation, EditorRoute, TerminalType } from "./types";
import { ROUTE_TERMINAL_COMPATIBILITY } from "./types";
import { crossTrackDistance, normalizedDistance, type DistanceConfig } from "./distance";

/** A Location is sea-capable if it has any terminal that a Sea route requires (Port or Platform). */
function isSeaCapable(location: EditorLocation): boolean {
  const required = ROUTE_TERMINAL_COMPATIBILITY.Sea;
  return location.terminalTypes.some((t: TerminalType) => required.includes(t));
}

/** An unordered pair of Location ids to connect with a new Sea route. */
export interface SeaRoutePair {
  locationAId: string;
  locationBId: string;
}

export function planAutoSeaRoutes(
  locations: readonly EditorLocation[],
  routes: readonly EditorRoute[],
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

      const worldLength = normalizedDistance(a.x, a.y, b.x, b.y, config);
      if (worldLength > maxDistance) continue;

      // Blocked if any OTHER sea-capable port sits strictly within
      // detourDistance (world units) of the A->B path (planar point-to-segment
      // in flat mode, spherical cross-track in globe mode -- see distance.ts).
      let blocked = false;
      for (const c of ports) {
        if (c.id === a.id || c.id === b.id) continue;
        if (crossTrackDistance(c, a, b, config) < detourDistance) {
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
