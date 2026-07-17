import { describe, it, expect } from "vitest";
import { buildWorldFromJson } from "../buildWorldFromJson";
import { NATIONALITY_POOLS } from "../nationality";
import { DEFAULT_NUM_PIRATE_SHIPS, DEFAULT_NUM_POLICE_SHIPS } from "../buildWorld";
import type { FleetOwner, Company } from "../faction";

const FRENCH_SHIPS = new Set(NATIONALITY_POOLS.French.ships);

interface JsonFleetMember { id: string; transportType: string; transportName: string; captainName: string }
interface JsonCompany {
  id: string; name: string; startingFunds: number; fleet: JsonFleetMember[]; politicalEntityId?: string | null;
  homeLocationId?: string | null;
}

/** A 20-location JSON world (required = round(20*5) = 100 ships) with the given companies/entities. */
function world(companies: JsonCompany[], entities: Array<{ id: string; name: string; nationality?: string }> = []): string {
  const locations = [];
  for (let i = 0; i < 20; i++) {
    const produces = i % 2 === 0;
    locations.push({
      id: `loc-${i + 1}`, name: `Port ${i + 1}`, x: 50 + (i % 5) * 150, y: 50 + Math.floor(i / 5) * 130,
      politicalEntityId: "home", producedCommodities: produces ? { Ore: 1 } : {},
      consumedCommodities: produces ? {} : { Ore: 1 }, stockpiles: produces ? { Ore: 300 } : { Ore: 30 },
      minStockpiles: produces ? {} : { Ore: 80 }, basePriceModifiers: { Ore: 1 }, fuelPrice: 1.25,
      terminalTypes: ["Port"],
    });
  }
  const politicalEntities = [
    { id: "home", name: "Homeland", type: "Country" },
    ...entities.map((e) => ({ id: e.id, name: e.name, type: "Country", nationality: e.nationality })),
  ];
  return JSON.stringify({
    version: 4, worldScale: 100,
    politicalEntities,
    commodities: [{ name: "Ore", basePrice: 20, productionRate: 8, consumptionRate: 8 }],
    locations, companies, routes: [],
  });
}

function ships(factions: FleetOwner[]): number {
  return factions.reduce((n, f) => n + f.captains.length, 0);
}
function soloCount(factions: FleetOwner[]): number {
  return factions.filter((f) => f.captains.length === 1).length;
}

const REQUIRED = 100; // round(20 locations * 5)

describe("fleet synthesis on JSON load", () => {
  it("reaches the required ship count with no companies (all become Independent SoloTraders)", () => {
    const { factions } = buildWorldFromJson(world([]));
    expect(ships(factions)).toBe(REQUIRED);
    // No multi-ship company to distribute to -> every faction is a 1-ship SoloTrader.
    expect(factions.every((f) => f.captains.length === 1)).toBe(true);
    expect(factions.every((f) => f.politicalEntity === null)).toBe(true);
  });

  it("makes SoloTraders 20% of the required count and distributes the rest to the multi-ship company", () => {
    const fleet: JsonFleetMember[] = [1, 2, 3].map((n) => ({
      id: `f${n}`, transportType: "Ship", transportName: `Authored ${n}`, captainName: `Cap ${n}`,
    }));
    const { factions } = buildWorldFromJson(world(
      [{ id: "c1", name: "Grand Compagnie", startingFunds: 50000, fleet, politicalEntityId: "fr" }],
      [{ id: "fr", name: "Gallia", nationality: "French" }],
    ));
    // required 100, existing 3, remainder 97; soloTarget round(0.2*100)=20, newSolo 20,
    // companyShipsToAdd 77 -> all onto the single multi-ship company (3 -> 80).
    expect(ships(factions)).toBe(REQUIRED);
    expect(soloCount(factions)).toBe(20);
    const company = factions.find((f) => f.name === "Grand Compagnie")!;
    expect(company.captains.length).toBe(80);
    // The ships synthesized onto a French-affiliated company use French ship names --
    // FleetOwner dedupes same-name Transports within a fleet, so once the (smaller) pool
    // is exhausted a repeat draw gets a " 2"/" 3"/... suffix; strip it before checking.
    const baseName = (name: string): string => name.replace(/ \d+$/, "");
    const frenchNamed = company.captains.filter((c) => FRENCH_SHIPS.has(baseName(c.transport!.name))).length;
    expect(frenchNamed).toBeGreaterThanOrEqual(77);
    // And within this one Company's fleet, no two ships share a display name.
    const names = company.captains.map((c) => c.transport!.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("adds nothing when the world already has at least the required ships", () => {
    const fleet: JsonFleetMember[] = Array.from({ length: REQUIRED }, (_, i) => ({
      id: `f${i}`, transportType: "Ship", transportName: `S${i}`, captainName: `C${i}`,
    }));
    const { factions } = buildWorldFromJson(world([{ id: "big", name: "Armada", startingFunds: 1, fleet }]));
    expect(ships(factions)).toBe(REQUIRED);
    expect(factions.length).toBe(1);
  });

  it("treats a 1-ship JSON company as a SoloTrader outright -- never bulked up, no home Location", () => {
    // Three authored 1-ship companies and no multi-ship company. Per the
    // grilled spec, a 1-ship authored company is a SoloTrader from the start
    // (classified from the AUTHORED fleet size, before any synthesis) -- it
    // never grows past its one ship, and (having no home Location at all)
    // isn't a target for the round-robin ship distribution either. With no
    // real Company to distribute to, the entire remainder becomes more
    // Independent SoloTraders, so every faction in this world ends up 1-ship.
    const company = (n: number): JsonCompany => ({
      id: `c${n}`, name: `House ${n}`, startingFunds: 1,
      fleet: [{ id: `cf${n}`, transportType: "Ship", transportName: `Flag ${n}`, captainName: `Cap ${n}` }],
    });
    const { factions } = buildWorldFromJson(world([company(1), company(2), company(3)]));
    expect(ships(factions)).toBe(REQUIRED);
    expect(soloCount(factions)).toBe(REQUIRED);
    for (const name of ["House 1", "House 2", "House 3"]) {
      const house = factions.find((f) => f.name === name) as Company;
      expect(house.captains.length).toBe(1);
      expect(house.homeLocation).toBeNull();
    }
  });

  it("is deterministic: the same JSON yields the same synthesized fleet", () => {
    const json = world([]);
    const a = buildWorldFromJson(json).factions;
    const b = buildWorldFromJson(json).factions;
    expect(a.map((f) => f.captains[0].transport!.name)).toEqual(b.map((f) => f.captains[0].transport!.name));
  });

  it("honors an authored homeLocationId, and starts every fleet member (authored and synthesized) there", () => {
    const fleet: JsonFleetMember[] = [1, 2].map((n) => ({
      id: `f${n}`, transportType: "Ship", transportName: `Authored ${n}`, captainName: `Cap ${n}`,
    }));
    const { factions } = buildWorldFromJson(world([
      { id: "c1", name: "Grand Compagnie", startingFunds: 50000, fleet, homeLocationId: "loc-7" },
    ]));
    const company = factions.find((f) => f.name === "Grand Compagnie") as Company;
    expect(company.homeLocation).toBe("Port 7");
    for (const captain of company.captains) {
      expect(captain.locationName).toBe("Port 7");
    }
  });

  it("falls back to the default home Location when homeLocationId is missing or incompatible", () => {
    const fleet: JsonFleetMember[] = [1, 2].map((n) => ({
      id: `f${n}`, transportType: "Ship", transportName: `Authored ${n}`, captainName: `Cap ${n}`,
    }));
    // No entities affiliated -> Independent -> world-wide alphabetical default
    // among the "Port N" locations is "Port 1" (string-sorted).
    const { factions: withoutId } = buildWorldFromJson(world([
      { id: "c1", name: "Grand Compagnie", startingFunds: 50000, fleet },
    ]));
    expect((factions => factions.find((f) => f.name === "Grand Compagnie") as Company)(withoutId).homeLocation)
      .toBe("Port 1");

    const { factions: badId } = buildWorldFromJson(world([
      { id: "c1", name: "Grand Compagnie", startingFunds: 50000, fleet, homeLocationId: "does-not-exist" },
    ]));
    expect((factions => factions.find((f) => f.name === "Grand Compagnie") as Company)(badId).homeLocation)
      .toBe("Port 1");
  });

  it("gives Independent SoloTraders a varied mix of nationalities", () => {
    const { factions } = buildWorldFromJson(world([]));
    const nationalitiesSeen = new Set<string>();
    for (const f of factions) {
      for (const [nat, pools] of Object.entries(NATIONALITY_POOLS)) {
        if (pools.ships.includes(f.captains[0].transport!.name)) nationalitiesSeen.add(nat);
      }
    }
    expect(nationalitiesSeen.size).toBeGreaterThan(1);
  });

  it("adds pirates/police at buildWorld's calibrated defaults unless overridden, and honors explicit options/opting out", () => {
    const withDefaults = buildWorldFromJson(world([]));
    expect(withDefaults.world.pirateBrigade).not.toBeNull();
    expect(withDefaults.world.pirateBrigade!.captains.length).toBe(DEFAULT_NUM_PIRATE_SHIPS);
    expect(withDefaults.world.policeFleet).not.toBeNull();
    expect(withDefaults.world.policeFleet!.captains.length).toBe(DEFAULT_NUM_POLICE_SHIPS);
    expect(ships(withDefaults.factions)).toBe(REQUIRED);

    const withoutPiratesOrPolice = buildWorldFromJson(world([]), { numPirateShips: 0, numPoliceShips: 0 });
    expect(withoutPiratesOrPolice.world.pirateBrigade).toBeNull();
    expect(withoutPiratesOrPolice.world.policeFleet).toBeNull();

    const withOptions = buildWorldFromJson(world([]), {
      numPirateShips: 4, pirateCashPerShip: 1000, numPoliceShips: 3, targetShipsPerLocation: 2,
    });
    expect(withOptions.world.pirateBrigade).not.toBeNull();
    expect(withOptions.world.pirateBrigade!.captains.length).toBe(4);
    expect(withOptions.world.policeFleet).not.toBeNull();
    expect(withOptions.world.policeFleet!.captains.length).toBe(3);
    // required = round(20 locations * 2) = 40, not the default 100.
    expect(ships(withOptions.factions)).toBe(40);
  });

  it("honors a seed override for reproducible (but seed-distinct) World dynamics", () => {
    // Only one World's module-level geography/routes (worldData.LOCATIONS,
    // routes.ROUTES, etc. -- see CLAUDE.md's "mutable module-level world
    // state") is ever live at a time, so each World must be fully built AND
    // run before the next is constructed -- interleaving construction would
    // have a later build's globals silently take over an earlier World's
    // pathfinding/pricing mid-run.
    const json = world([]);
    const runPrices = (seed: number): number[] => {
      const { world: w } = buildWorldFromJson(json, { seed });
      w.run(5);
      return w.combinedHistory.map((r) => r.price);
    };
    const a = runPrices(111);
    const b = runPrices(111);
    const c = runPrices(222);
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
  });
});
