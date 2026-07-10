/**
 * Routes: direct, typed connections between locations (Sea/Land/Air),
 * and the procedurally generated route network. Ported from sim/routes.py.
 */
import { Rng } from "./rng";
import type { Location, TerminalType } from "./location";
import { distanceBetween, WORLD_GEN_SEED } from "./worldData";

export type RouteType = "Land" | "Air" | "Sea";

export const ROUTE_TERMINAL_COMPATIBILITY: Record<RouteType, TerminalType[]> = {
  Land: ["Wagon yard"],
  Air: ["Airport"],
  Sea: ["Port", "Platform"],
};

export const ROUTE_TYPE_DISTANCE_SCALE: Record<RouteType, number> = {
  Air: 1.0,
  Sea: 0.8,
  Land: 0.5,
};

export class Route {
  origin: string;
  destination: string;
  routeType: RouteType;
  distance: number;

  constructor(origin: string, destination: string, routeType: RouteType) {
    this.origin = origin;
    this.destination = destination;
    this.routeType = routeType;
    this.distance = distanceBetween(origin, destination);
  }
}

/** Canonical, order-independent key for a location pair -- stands in for Python's frozenset key. */
export function routeKey(locationA: string, locationB: string): string {
  return [locationA, locationB].sort().join("||");
}

function compatibleRouteTypes(origin: Location, destination: Location): RouteType[] {
  const result: RouteType[] = [];
  for (const routeType of Object.keys(ROUTE_TERMINAL_COMPATIBILITY) as RouteType[]) {
    const required = ROUTE_TERMINAL_COMPATIBILITY[routeType];
    const originHas = required.some((t) => origin.terminalTypes.has(t));
    const destHas = required.some((t) => destination.terminalTypes.has(t));
    if (originHas && destHas) result.push(routeType);
  }
  return result;
}

export function generateRoutes(
  locations: Location[],
  seed: number = WORLD_GEN_SEED,
  maxDistance?: number,
): Map<string, Route> {
  const rng = new Rng(seed + 2);
  const routes = new Map<string, Route>();

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
      routes.set(routeKey(origin.name, destination.name), new Route(origin.name, destination.name, routeType));
    }
  }
  return routes;
}

export let ROUTES: Map<string, Route> = new Map();

/** Wholesale-reassign the route network (called once by buildWorld). */
export function setRoutes(routes: Map<string, Route>): void {
  ROUTES = routes;
}

export function getRoute(locationA: string, locationB: string): Route | undefined {
  if (locationA === locationB) return undefined;
  return ROUTES.get(routeKey(locationA, locationB));
}
