import { describe, expect, it } from "vitest";
import { Location } from "../location";
import { Market } from "../markets";
import { PorterParty } from "../transport";
import { Explorer } from "../explorer";
import { Route } from "../routes";
import { setGeography } from "../worldData";
import type { World } from "../world";

/** A minimal stand-in for World -- Explorer.tick/arrive only ever reads/writes `pendingDecision`, so a real World (with its heavy constructor) isn't needed for these unit tests. */
function fakeWorld(): World {
  return { pendingDecision: null } as unknown as World;
}

function makeVillage(name: string): Location {
  return new Location({
    name,
    producedCommodities: { Ivory: 1 },
    consumedCommodities: { Cloth: 1 },
    stockpiles: { Ivory: 100, Cloth: 0 },
    minStockpiles: { Ivory: 10, Cloth: 10 },
    basePriceModifiers: { Ivory: 1, Cloth: 1 },
    fuelPrice: 0,
    terminalTypes: new Set(["Market"]),
    settlementType: "Native village",
  });
}

function makeExplorer(location: Location, startingCash = 1000): { explorer: Explorer; party: PorterParty } {
  const party = new PorterParty({ name: "Test Party", porterCount: 2, animalCount: 0 });
  const explorer = new Explorer({
    name: "Livia Ashworth", gender: "Female", dateOfBirth: new Date("1850-01-01"),
    homeLocation: location, transport: party, startingCash,
  });
  return { explorer, party };
}

describe("Explorer construction", () => {
  it("boards its PorterParty immediately -- AT a Location XOR ON a Transport", () => {
    const village = makeVillage("Home Village");
    setGeography([village], { "Home Village": [0, 0] });
    const { explorer, party } = makeExplorer(village);

    expect(explorer.location).toBeNull();
    expect(explorer.transport).toBe(party);
    expect(explorer.locationName).toBe("Home Village");
    expect(party.location).toBe(village);
  });
});

describe("Explorer.buy/sell", () => {
  it("buy() moves goods from the market into cargo and deducts cash (plus a little price impact, same rules as a Ship)", () => {
    const village = makeVillage("Trade Village");
    setGeography([village], { "Trade Village": [0, 0] });
    const { explorer } = makeExplorer(village, 1000);

    // Ivory is produced here -- matches world.ts's convention of a produced
    // commodity's Market being side="buy" (the side a Captain/Explorer buys
    // FROM), landing in world.buyMarkets.
    const ivoryMarket = new Market("Ivory", "Trade Village", village, 10, 10, "buy");
    const bought = explorer.buy("Ivory", 5, ivoryMarket);

    expect(bought).toBe(5);
    expect(explorer.cargo?.items).toEqual([{ commodity: "Ivory", quantity: 5, unitCost: 10, contract: null }]);
    expect(explorer.cash).toBe(1000 - 5 * 10);
    expect(village.stockpiles.Ivory).toBe(95); // buy-side applyTrade decreases location stockpile
  });

  it("buy() clamps to affordability, available stock, and remaining weight capacity", () => {
    const village = makeVillage("Poor Village");
    setGeography([village], { "Poor Village": [0, 0] });
    const { explorer, party } = makeExplorer(village, 25); // only affords ~2.5 units at price 10

    const ivoryMarket = new Market("Ivory", "Poor Village", village, 10, 10, "buy");
    const bought = explorer.buy("Ivory", 100, ivoryMarket);

    expect(bought).toBeCloseTo(2.5, 1);
    expect(explorer.cash).toBeCloseTo(0, 1);
    expect(party.cargoCapacity).toBeGreaterThan(bought); // capacity wasn't the binding constraint here
  });

  it("sell() moves goods from cargo back to cash, capped by what's held", () => {
    const village = makeVillage("Sell Village");
    setGeography([village], { "Sell Village": [0, 0] });
    const { explorer } = makeExplorer(village, 0);
    explorer.cargo = {
      items: [{ commodity: "Cloth", quantity: 3, unitCost: 0, contract: null }],
      origin: "Sell Village", destination: "Sell Village", distance: 0, routeType: "none",
      travelDays: 0, fuelPricePaid: 0, fuelUnitsConsumed: 0, fuelCostTotal: 0, totalCost: 0, departureDay: 0,
    };

    // Cloth is consumed here -- matches world.ts's convention of a consumed
    // commodity's Market being side="sell" (the side a Captain/Explorer
    // sells INTO), landing in world.sellMarkets.
    const clothMarket = new Market("Cloth", "Sell Village", village, 5, 5, "sell");
    const sold = explorer.sell("Cloth", 10, clothMarket); // asks for more than held

    expect(sold).toBe(3);
    expect(explorer.cash).toBe(15);
    expect(explorer.heldQuantity("Cloth")).toBe(0); // fully depleted
  });
});

describe("Explorer.departFor/tick", () => {
  it("arrives after the correct number of days on a Trail route", () => {
    const origin = makeVillage("Origin Village");
    const dest = makeVillage("Destination Village");
    setGeography([origin, dest], { "Origin Village": [0, 0], "Destination Village": [600, 0] });
    const { explorer, party } = makeExplorer(origin);

    const route = new Route("Origin Village", "Destination Village", "Trail");
    const expectedDays = Math.ceil(route.distance / party.speedUnitsPerDay);

    explorer.departFor(route);
    expect(explorer.destination).toBe("Destination Village");
    expect(explorer.daysRemaining).toBe(expectedDays);

    const world = fakeWorld();
    for (let i = 0; i < expectedDays - 1; i++) {
      explorer.tick(1, world);
      expect(explorer.destination).toBe("Destination Village"); // not there yet
    }
    explorer.tick(1, world);
    expect(explorer.destination).toBeNull();
    expect(explorer.locationName).toBe("Destination Village");
  });

  it("triggers the passage-tax decision on arrival at a Village, but not before", () => {
    const origin = makeVillage("Origin Village 3");
    const dest = makeVillage("Destination Village 3");
    setGeography([origin, dest], { "Origin Village 3": [0, 0], "Destination Village 3": [600, 0] });
    const { explorer } = makeExplorer(origin);

    const route = new Route("Origin Village 3", "Destination Village 3", "Trail");
    explorer.departFor(route);
    const world = fakeWorld();
    const totalDays = explorer.daysRemaining;

    for (let i = 0; i < totalDays - 1; i++) {
      explorer.tick(1, world);
      expect(world.pendingDecision).toBeNull(); // not arrived yet
    }
    explorer.tick(1, world);
    expect(explorer.destination).toBeNull();
    expect(world.pendingDecision).not.toBeNull();
    expect(world.pendingDecision?.kind).toBe("PassageTax");
    expect(world.pendingDecision?.explorer).toBe(explorer);
  });

  it("departFor is a no-op while already travelling", () => {
    const origin = makeVillage("Origin Village 2");
    const dest = makeVillage("Destination Village 2");
    setGeography([origin, dest], { "Origin Village 2": [0, 0], "Destination Village 2": [600, 0] });
    const { explorer } = makeExplorer(origin);

    const route = new Route("Origin Village 2", "Destination Village 2", "Trail");
    explorer.departFor(route);
    const daysAfterFirstDeparture = explorer.daysRemaining;
    explorer.departFor(route); // second call while already travelling
    expect(explorer.daysRemaining).toBe(daysAfterFirstDeparture);
  });
});
