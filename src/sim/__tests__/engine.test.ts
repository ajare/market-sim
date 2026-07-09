import { describe, expect, it } from "vitest";
import { buildWorld } from "../buildWorld";
import { Location } from "../location";
import { Company, SoloTrader, PirateBrigade } from "../faction";
import { Captain } from "../captain";
import { Ship, Train, SHIP_CLASSES } from "../transport";

describe("buildWorld", () => {
  it("builds the default procedural world and runs 60 days without throwing", () => {
    const { world, factions } = buildWorld();
    expect(world.locations.length).toBe(33); // 30 trading hubs + 3 fuel depots
    expect(factions.length).toBeGreaterThan(0);
    expect(() => world.run(60)).not.toThrow();
    expect(world.combinedHistory.length).toBeGreaterThan(0);
  }, 20000); // the default world's fleet is large (locations x TARGET_SHIPS_PER_LOCATION) -- exceeds vitest's 5s default

  it("produces identical day-60 net worth across two runs built from the same seeds", () => {
    const run1 = buildWorld();
    run1.world.run(60);
    const run2 = buildWorld();
    run2.world.run(60);

    const netWorth1 = run1.factions.map((f) => Math.round(f.netWorth(run1.world.sellMarkets) * 100));
    const netWorth2 = run2.factions.map((f) => Math.round(f.netWorth(run2.world.sellMarkets) * 100));
    expect(netWorth1).toEqual(netWorth2);

    const day60Prices1 = run1.world.combinedHistory.filter((r) => r.day === 60).map((r) => r.price);
    const day60Prices2 = run2.world.combinedHistory.filter((r) => r.day === 60).map((r) => r.price);
    expect(day60Prices1).toEqual(day60Prices2);
  }, 40000); // the default world's fleet is large (96 companies x 5 ships) -- two 60-day runs exceed vitest's 5s default

  it("steps one day at a time and matches run(1)'s effect on the day counter", () => {
    const { world } = buildWorld();
    const day = world.step();
    expect(day).toBe(1);
    expect(world.step()).toBe(2);
  });
});

describe("Location", () => {
  it("throws when a commodity is both produced and consumed", () => {
    expect(
      () =>
        new Location({
          name: "Bad Port",
          producedCommodities: { Wheat: 5 },
          consumedCommodities: { Wheat: 5 },
          stockpiles: {},
          minStockpiles: {},
          basePrices: {},
          fuelPrice: 1.0,
          terminalTypes: new Set(["Port"]),
        }),
    ).toThrow();
  });

  it("throws when Platform is combined with another terminal type", () => {
    expect(
      () =>
        new Location({
          name: "Bad Rig",
          producedCommodities: {},
          consumedCommodities: {},
          stockpiles: {},
          minStockpiles: {},
          basePrices: {},
          fuelPrice: 1.0,
          terminalTypes: new Set(["Platform", "Port"]),
        }),
    ).toThrow();
  });
});

describe("Faction cash pooling", () => {
  const homeLocation = "Testport";

  function makeCrew(): { crew: Array<[Ship, Captain, string]>; captain1: Captain; captain2: Captain } {
    const transport1 = SHIP_CLASSES.Speedster.clone({ name: "T1", crewRequirement: 1 });
    const transport2 = SHIP_CLASSES.Speedster.clone({ name: "T2", crewRequirement: 1 });
    const captain1 = new Captain("Cap One", homeLocation);
    const captain2 = new Captain("Cap Two", homeLocation);
    return {
      crew: [
        [transport1, captain1, homeLocation],
        [transport2, captain2, homeLocation],
      ],
      captain1,
      captain2,
    };
  }

  it("Company pools cash across every captain", () => {
    const { crew, captain1, captain2 } = makeCrew();
    const company = new Company("Acme", [...crew], 1000);
    expect(captain1.cash).toBe(company.cash);
    captain1.cash -= 100;
    expect(captain2.cash).toBe(company.cash);
    expect(captain2.cash).toBe(900);
  });

  it("SoloTrader keeps independent balances", () => {
    const { crew, captain1, captain2 } = makeCrew();
    const solo = new SoloTrader("Loose Assoc", [...crew], 1000);
    expect(solo.poolsCash).toBe(false);
    const before2 = captain2.cash;
    captain1.cash -= 100;
    expect(captain2.cash).toBe(before2);
  });

  it("PirateBrigade rejects a non-Ship transport", () => {
    const train = new Train({ name: "Landlocked" });
    const captain = new Captain("Rejected", homeLocation);
    expect(
      () => new PirateBrigade("Doomed Brigade", [[train, captain, homeLocation]], []),
    ).toThrow();
  });

  it("PirateBrigade accepts Ship transports", () => {
    const ship = new Ship({ name: "Raider" });
    const captain = new Captain("Pirate Pete", homeLocation);
    expect(
      () => new PirateBrigade("Fine Brigade", [[ship, captain, homeLocation]], []),
    ).not.toThrow();
  });
});
