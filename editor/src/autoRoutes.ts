/**
 * Thin editor-side adapter over @market-sim/shared's planSeaRoutes (shared
 * with the simulation's own "add a Location" feature): the shared planner
 * works in WORLD-UNIT coordinates, but the editor's own Locations are stored
 * normalized [0,1] (see EditorLocation), so this multiplies by worldScale
 * before calling in.
 */
import type { EditorLocation, EditorRoute } from "./types";
import { planSeaRoutes, type DistanceConfig, type RoutePlannerLocation, type SeaRoutePair } from "@market-sim/shared";

export type { SeaRoutePair };

function toWorldUnits(location: EditorLocation, worldScale: number): RoutePlannerLocation {
  return { id: location.id, x: location.x * worldScale, y: location.y * worldScale, terminalTypes: location.terminalTypes };
}

export function planAutoSeaRoutes(
  locations: readonly EditorLocation[],
  routes: readonly EditorRoute[],
  detourDistance: number,
  maxDistance: number,
  config: DistanceConfig,
): SeaRoutePair[] {
  const worldLocations = locations.map((l) => toWorldUnits(l, config.worldScale));
  return planSeaRoutes(worldLocations, routes, detourDistance, maxDistance, config);
}
