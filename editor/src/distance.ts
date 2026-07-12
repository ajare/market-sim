/**
 * Distance model, moved into @market-sim/shared (shared with the simulation
 * engine, see src/sim/distance.ts) -- this re-export keeps every existing
 * `from "./distance"` import in the editor working unchanged. routeWorldLength
 * stays here (not in shared) since it depends on the editor's own
 * RouteControlPoint/routeRenderPoints (types.ts), which the sim has no
 * equivalent of.
 */
import { normalizedDistance, type DistanceConfig } from "@market-sim/shared/distance";
import { routeRenderPoints, type RouteControlPoint } from "./types";

export * from "@market-sim/shared/distance";

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
