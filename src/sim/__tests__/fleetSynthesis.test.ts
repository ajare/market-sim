import { describe, it, expect } from "vitest";
import { buildWorldFromJson } from "../buildWorldFromJson";
import { NATIONALITY_POOLS } from "../nationality";
import type { Faction } from "../faction";

const FRENCH_SHIPS = new Set(NATIONALITY_POOLS.French.ships);

interface JsonFleetMember { id: string; transportType: string; transportName: string; captainName: string }
interface JsonCompany {
  id: string; name: string; startingFunds: number; fleet: JsonFleetMember[]; politicalEntityId?: string | null;
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

function ships(factions: Faction[]): number {
  return factions.reduce((n, f) => n + f.captains.length, 0);
}
function soloCount(factions: Faction[]): number {
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
    // The ships synthesized onto a French-affiliated company use French ship names.
    const frenchNamed = company.captains.filter((c) => FRENCH_SHIPS.has(c.transport!.name)).length;
    expect(frenchNamed).toBeGreaterThanOrEqual(77);
  });

  it("adds nothing when the world already has at least the required ships", () => {
    const fleet: JsonFleetMember[] = Array.from({ length: REQUIRED }, (_, i) => ({
      id: `f${i}`, transportType: "Ship", transportName: `S${i}`, captainName: `C${i}`,
    }));
    const { factions } = buildWorldFromJson(world([{ id: "big", name: "Armada", startingFunds: 1, fleet }]));
    expect(ships(factions)).toBe(REQUIRED);
    expect(factions.length).toBe(1);
  });

  it("distributes the rest to 1-ship JSON companies (only ~20% end up as SoloTraders)", () => {
    // Three authored 1-ship companies and no multi-ship company. The rest of
    // the fleet must still land on these companies (bulking them up), NOT all
    // become SoloTraders.
    const company = (n: number): JsonCompany => ({
      id: `c${n}`, name: `House ${n}`, startingFunds: 1,
      fleet: [{ id: `cf${n}`, transportType: "Ship", transportName: `Flag ${n}`, captainName: `Cap ${n}` }],
    });
    const { factions } = buildWorldFromJson(world([company(1), company(2), company(3)]));
    expect(ships(factions)).toBe(REQUIRED);
    // Exactly the 20% new Independent SoloTraders -- the three authored
    // companies received ships and are no longer 1-ship SoloTraders.
    expect(soloCount(factions)).toBe(20);
    for (const name of ["House 1", "House 2", "House 3"]) {
      const house = factions.find((f) => f.name === name)!;
      expect(house.captains.length).toBeGreaterThan(1);
    }
  });

  it("is deterministic: the same JSON yields the same synthesized fleet", () => {
    const json = world([]);
    const a = buildWorldFromJson(json).factions;
    const b = buildWorldFromJson(json).factions;
    expect(a.map((f) => f.captains[0].transport!.name)).toEqual(b.map((f) => f.captains[0].transport!.name));
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
});
