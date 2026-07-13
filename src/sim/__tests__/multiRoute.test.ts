import { describe, it, expect } from "vitest";
import { buildWorldFromJson } from "../buildWorldFromJson";
import { getRoute, getRoutes } from "../routes";
import { findShortestPath } from "../pathfinding";

/**
 * An editor-shaped World whose first two locations, A and B, both have a Port
 * AND an Airport, and are connected by BOTH a Sea route and an Air route --
 * padded with filler ports to clear World's 20-location minimum. `extraRoutes`
 * are appended after the base A<->B Sea route.
 */
function twoParallelRouteWorld(extraRoutes: unknown[], baseRouteControlPoints: unknown[] = []): string {
  const locations: unknown[] = [
    {
      id: "loc-1", name: "A", x: 25, y: 50, politicalEntityId: "pe-1",
      producedCommodities: { Ore: 1 }, consumedCommodities: {},
      stockpiles: { Ore: 300 }, minStockpiles: {}, basePriceModifiers: { Ore: 1 },
      fuelPrice: 1.25, terminalTypes: ["Port", "Airport"],
    },
    {
      id: "loc-2", name: "B", x: 75, y: 50, politicalEntityId: "pe-1",
      producedCommodities: {}, consumedCommodities: { Ore: 1 },
      stockpiles: { Ore: 30 }, minStockpiles: { Ore: 80 }, basePriceModifiers: { Ore: 1 },
      fuelPrice: 1.25, terminalTypes: ["Port", "Airport"],
    },
  ];
  for (let i = 3; i <= 22; i++) {
    const produces = i % 2 === 0;
    locations.push({
      id: `loc-${i}`, name: `Port ${i}`, x: 20 + (i % 5) * 12, y: 20 + Math.floor(i / 5) * 15,
      politicalEntityId: "pe-1",
      producedCommodities: produces ? { Ore: 1 } : {}, consumedCommodities: produces ? {} : { Ore: 1 },
      stockpiles: produces ? { Ore: 300 } : { Ore: 30 }, minStockpiles: produces ? {} : { Ore: 80 },
      basePriceModifiers: { Ore: 1 }, fuelPrice: 1.25, terminalTypes: ["Port"],
    });
  }
  return JSON.stringify({
    version: 3, worldScale: 100,
    politicalEntities: [{ id: "pe-1", name: "Realm", type: "Country" }],
    commodities: [{ name: "Ore", basePrice: 20, productionRate: 8, consumptionRate: 8 }],
    locations,
    companies: [],
    routes: [
      { id: "route-1", locationAId: "loc-1", locationBId: "loc-2", routeType: "Sea", controlPoints: baseRouteControlPoints },
      ...extraRoutes,
    ],
  });
}

describe("multiple routes between one location pair", () => {
  it("keeps both a Sea and an Air route between the same pair", () => {
    buildWorldFromJson(twoParallelRouteWorld([
      { id: "route-2", locationAId: "loc-1", locationBId: "loc-2", routeType: "Air", controlPoints: [] },
    ]));
    const routes = getRoutes("A", "B");
    expect(routes).toHaveLength(2);
    expect(new Set(routes.map((r) => r.routeType))).toEqual(new Set(["Sea", "Air"]));
    // Undirected: same pair looked up the other way round.
    expect(getRoutes("B", "A")).toHaveLength(2);
  });

  it("lets pathfinding pick the route matching what the transport can use", () => {
    buildWorldFromJson(twoParallelRouteWorld([
      { id: "route-2", locationAId: "loc-1", locationBId: "loc-2", routeType: "Air", controlPoints: [] },
    ]));
    const seaPath = findShortestPath("A", "B", (r) => r.routeType === "Sea");
    const airPath = findShortestPath("A", "B", (r) => r.routeType === "Air");
    expect(seaPath?.map((r) => r.routeType)).toEqual(["Sea"]);
    expect(airPath?.map((r) => r.routeType)).toEqual(["Air"]);
  });

  it("drops a duplicate route of the same type on a pair (one per type)", () => {
    buildWorldFromJson(twoParallelRouteWorld([
      { id: "route-dup", locationAId: "loc-1", locationBId: "loc-2", routeType: "Sea", controlPoints: [] },
      { id: "route-2", locationAId: "loc-1", locationBId: "loc-2", routeType: "Air", controlPoints: [] },
    ]));
    const routes = getRoutes("A", "B");
    expect(routes).toHaveLength(2);
    expect(routes.filter((r) => r.routeType === "Sea")).toHaveLength(1);
  });
});

describe("imported Route control-point geometry", () => {
  it("reconstructs a route through the exact authored control points, not a randomly bowed curve", () => {
    // A straight A(25,50)-B(75,50) Sea leg, hand-bowed in the editor through
    // one control point well off the line (50, 90).
    buildWorldFromJson(twoParallelRouteWorld([], [{ id: "cp-1", x: 50, y: 90 }]));
    const route = getRoute("A", "B")!;
    expect(route.controlPoints).toEqual([[50, 90]]);
    // A straight A-B leg would be exactly 50 long; bowing through (50, 90)
    // roughly triples the arc length, so this also confirms the curve is
    // actually built through the authored point rather than ignored.
    expect(route.distance).toBeGreaterThan(60);
  });
});
