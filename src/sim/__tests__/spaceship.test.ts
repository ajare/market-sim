import { describe, it, expect } from "vitest";
import { Spaceship, Ship, Lorry, FreightTrain } from "../transport";
import { ROUTE_TERMINAL_COMPATIBILITY, type Route } from "../routes";
import { buildWorldFromJson } from "../buildWorldFromJson";

describe("Spaceship / Space route / Spaceport", () => {
  it("Spaceship is restricted to Space routes only", () => {
    const spaceship = new Spaceship();
    expect(spaceship.allowedRouteTypes()).toEqual(["Space"]);
    expect(spaceship.canUseRoute({ routeType: "Space" } as unknown as Route)).toBe(true);
    expect(spaceship.canUseRoute({ routeType: "Sea" } as unknown as Route)).toBe(false);
    expect(spaceship.canUseRoute({ routeType: "Air" } as unknown as Route)).toBe(false);
  });

  it("a non-Spaceship can NOT use a Space route", () => {
    expect(new Ship().canUseRoute({ routeType: "Space" } as unknown as Route)).toBe(false);
  });

  it("a Space route requires Spaceports at both ends", () => {
    expect(ROUTE_TERMINAL_COMPATIBILITY.Space).toEqual(["Spaceport"]);
  });

  it("Lorry is restricted to Road routes; Road requires TransitDepots", () => {
    const lorry = new Lorry();
    expect(lorry.allowedRouteTypes()).toEqual(["Road"]);
    expect(lorry.canUseRoute({ routeType: "Road" } as unknown as Route)).toBe(true);
    expect(lorry.canUseRoute({ routeType: "Sea" } as unknown as Route)).toBe(false);
    expect(new Ship().canUseRoute({ routeType: "Road" } as unknown as Route)).toBe(false);
    expect(ROUTE_TERMINAL_COMPATIBILITY.Road).toEqual(["TransitDepot"]);
  });

  it("FreightTrain is restricted to Railroad routes; Railroad requires Stations", () => {
    const train = new FreightTrain();
    expect(train.allowedRouteTypes()).toEqual(["Railroad"]);
    expect(train.canUseRoute({ routeType: "Railroad" } as unknown as Route)).toBe(true);
    expect(train.canUseRoute({ routeType: "Road" } as unknown as Route)).toBe(false);
    expect(new Ship().canUseRoute({ routeType: "Railroad" } as unknown as Route)).toBe(false);
    expect(ROUTE_TERMINAL_COMPATIBILITY.Railroad).toEqual(["Station"]);
  });

  it("builds a runnable World of Spaceports + Space routes + Spaceships from JSON", async () => {
    const commodities = [
      { name: "Ore", basePrice: 20, productionRate: 8, consumptionRate: 8 },
      { name: "Fuel Cells", basePrice: 60, productionRate: 6, consumptionRate: 6 },
    ];
    const locations = [];
    const routes = [];
    for (let i = 0; i < 20; i++) {
      const producesOre = i % 2 === 0;
      const produced = producesOre ? "Ore" : "Fuel Cells";
      const consumed = producesOre ? "Fuel Cells" : "Ore";
      locations.push({
        id: `loc-${i + 1}`, name: `Colony ${i + 1}`,
        x: 50 + (i % 5) * 150, y: 50 + Math.floor(i / 5) * 130,
        politicalEntityId: "pe-1",
        producedCommodities: { [produced]: 1.0 },
        consumedCommodities: { [consumed]: 1.0 },
        // Consumer starts in deficit (below its 80 minimum) so sells are
        // immediately possible and the sell price is deficit-boosted -- a
        // clear, immediate arbitrage for the spaceships to exploit.
        stockpiles: { [produced]: 300, [consumed]: 30 },
        minStockpiles: { [consumed]: 80 },
        basePriceModifiers: { Ore: 1, "Fuel Cells": 1 },
        fuelPrice: 1.25,
        terminalTypes: ["Spaceport"],
      });
      if (i > 0) {
        routes.push({
          id: `route-${i}`, locationAId: `loc-${i}`, locationBId: `loc-${i + 1}`,
          routeType: "Space", controlPoints: [],
        });
      }
    }
    const json = JSON.stringify({
      version: 1, worldWidth: 800,
      politicalEntities: [{ id: "pe-1", name: "The Federation", type: "Planet" }],
      locations, commodities,
      companies: [{
        id: "c1", name: "Star Freight Inc", startingFunds: 200000,
        fleet: [
          { id: "f1", transportType: "Spaceship", transportName: "Enterprise", captainName: "Kirk" },
          { id: "f2", transportType: "Spaceship", transportName: "Voyager", captainName: "Janeway" },
        ],
      }],
      routes,
    });

    const { world, factions } = buildWorldFromJson(json);
    expect(world.locations.length).toBe(20);
    expect(factions.length).toBe(1);

    // Every captain's transport is a Spaceship that can traverse Space routes.
    const captains = factions.flatMap((f) => f.captains);
    expect(captains.length).toBe(2);
    for (const captain of captains) {
      expect(captain.transport).toBeInstanceOf(Spaceship);
      expect(captain.transport!.allowedRouteTypes()).toEqual(["Space"]);
    }

    // The world runs without throwing, and the spaceships actually move cargo
    // over the space-route network (proving they aren't stranded).
    // The route network built for this world is all Space routes (regression
    // guard: a route-type validator once silently downgraded "Space" to "Sea",
    // which stranded the spaceships).
    const { ROUTES } = await import("../routes");
    expect([...ROUTES.values()].every((r) => r.routeType === "Space")).toBe(true);

    // The world runs without throwing, and the spaceships actually move cargo
    // over the space-route network (proving they aren't stranded).
    world.run(30);
    const totalTrades = captains.reduce((sum, c) => sum + c.tradeLog.length, 0);
    expect(totalTrades).toBeGreaterThan(0);
  });
});
