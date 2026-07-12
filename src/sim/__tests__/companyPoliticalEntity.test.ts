import { describe, it, expect } from "vitest";
import { buildWorldFromJson } from "../buildWorldFromJson";

/**
 * Builds an editor-shaped JSON World with `companies` and returns the built
 * factions. The location/commodity scaffolding is the minimum a World needs
 * (20+ locations, one commodity produced/consumed) -- the test only cares
 * about how each Company's politicalEntityId maps onto faction.politicalEntity.
 */
function buildWith(companies: unknown[]) {
  const commodities = [{ name: "Ore", basePrice: 20, productionRate: 8, consumptionRate: 8 }];
  const locations = [];
  for (let i = 0; i < 20; i++) {
    locations.push({
      id: `loc-${i + 1}`, name: `Port ${i + 1}`,
      x: 50 + (i % 5) * 150, y: 50 + Math.floor(i / 5) * 130,
      // Alternate membership so both entities own some Locations.
      politicalEntityId: i % 2 === 0 ? "pe-1" : "pe-2",
      producedCommodities: i % 2 === 0 ? { Ore: 1 } : {},
      consumedCommodities: i % 2 === 0 ? {} : { Ore: 1 },
      stockpiles: i % 2 === 0 ? { Ore: 300 } : { Ore: 30 },
      minStockpiles: i % 2 === 0 ? {} : { Ore: 80 },
      basePriceModifiers: { Ore: 1 },
      fuelPrice: 1.25,
      terminalTypes: ["Port"],
    });
  }
  const routes = [];
  for (let i = 1; i < 20; i++) {
    routes.push({ id: `route-${i}`, locationAId: `loc-${i}`, locationBId: `loc-${i + 1}`, routeType: "Sea", controlPoints: [] });
  }
  const json = JSON.stringify({
    version: 2, worldScale: 100,
    politicalEntities: [
      { id: "pe-1", name: "The Republic", type: "Country" },
      { id: "pe-2", name: "The Duchy", type: "Country" },
    ],
    locations, commodities, companies, routes,
  });
  return buildWorldFromJson(json);
}

describe("Company PoliticalEntity affiliation", () => {
  it("resolves a company's politicalEntityId to the built PoliticalEntity", () => {
    const { factions, politicalEntities } = buildWith([
      { id: "c1", name: "Republic Trading Co", startingFunds: 100000, politicalEntityId: "pe-1",
        fleet: [{ id: "f1", transportType: "Ship", transportName: "Wave", captainName: "Ann" },
                { id: "f2", transportType: "Ship", transportName: "Tide", captainName: "Bo" }] },
    ]);
    const republic = politicalEntities.find((p) => p.name === "The Republic");
    expect(factions[0].politicalEntity).toBe(republic);
    expect(factions[0].politicalEntity?.name).toBe("The Republic");
  });

  it("leaves a company independent when politicalEntityId is null or absent", () => {
    const { factions } = buildWith([
      { id: "c1", name: "Free Traders", startingFunds: 100000, politicalEntityId: null,
        fleet: [{ id: "f1", transportType: "Ship", transportName: "Gull", captainName: "Cy" },
                { id: "f2", transportType: "Ship", transportName: "Kite", captainName: "Di" }] },
      { id: "c2", name: "No Field Co", startingFunds: 100000,
        fleet: [{ id: "f3", transportType: "Ship", transportName: "Hawk", captainName: "Ed" },
                { id: "f4", transportType: "Ship", transportName: "Owl", captainName: "Fi" }] },
    ]);
    expect(factions[0].politicalEntity).toBeNull();
    expect(factions[1].politicalEntity).toBeNull();
  });

  it("falls back to independent for a politicalEntityId that doesn't resolve", () => {
    const { factions } = buildWith([
      { id: "c1", name: "Ghost Corp", startingFunds: 100000, politicalEntityId: "pe-does-not-exist",
        fleet: [{ id: "f1", transportType: "Ship", transportName: "Fog", captainName: "Gil" },
                { id: "f2", transportType: "Ship", transportName: "Mist", captainName: "Hana" }] },
    ]);
    expect(factions[0].politicalEntity).toBeNull();
  });

  it("affiliates a single-ship SoloTrader too (affiliation lives on the base Faction)", () => {
    const { factions, politicalEntities } = buildWith([
      { id: "c1", name: "Lone Duke Trader", startingFunds: 50000, politicalEntityId: "pe-2",
        fleet: [{ id: "f1", transportType: "Ship", transportName: "Solo", captainName: "Ivy" }] },
    ]);
    const duchy = politicalEntities.find((p) => p.name === "The Duchy");
    expect(factions[0].constructor.name).toBe("SoloTrader");
    expect(factions[0].politicalEntity).toBe(duchy);
  });
});
