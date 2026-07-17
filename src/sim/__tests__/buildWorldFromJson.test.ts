import { describe, expect, it } from "vitest";
import { buildWorldFromJson } from "../buildWorldFromJson";
import { buildExploreDemoWorldJson } from "../__fixtures__/exploreDemoWorld";
import { getRoute } from "../routes";
import { COMMODITIES } from "../worldData";

/** A minimal, pre-exploration-shaped 20-location World JSON -- none of the new settlementType/ruler/explorers fields, exercising the backward-compatible defaults. */
function minimalPreExplorationWorldJson(): string {
  const locations = Array.from({ length: 20 }, (_, i) => ({
    id: `loc-${i}`,
    name: `Port ${i}`,
    x: (i % 5) * 100,
    y: Math.floor(i / 5) * 100,
    politicalEntityId: "pe-1",
    producedCommodities: {},
    consumedCommodities: {},
    stockpiles: {},
    minStockpiles: {},
    basePriceModifiers: {},
    fuelPrice: 1.0,
    terminalTypes: ["Port"],
  }));
  return JSON.stringify({
    worldScale: 1000,
    politicalEntities: [{ id: "pe-1", name: "Realm", type: "Country" }],
    locations,
    companies: [],
    routes: [],
  });
}

describe("buildWorldFromJson -- exploration mode fields", () => {
  it("loads a pre-exploration World JSON (no settlementType/ruler/explorers) unchanged", () => {
    const { world } = buildWorldFromJson(minimalPreExplorationWorldJson(), {
      targetShipsPerLocation: 0, numPirateShips: 0, numPoliceShips: 0,
    });
    expect(world.explorers).toEqual([]);
    for (const location of world.locations) {
      expect(location.settlementType).toBe("Town");
      expect(location.ruler).toBeNull();
    }
  }, 20000);

  it("doesn't crash on a Location whose ruler is explicitly null (not just absent) -- the editor's own export always writes the field", () => {
    // Regression test: the editor's EditorLocation.ruler is `EditorChieftain
    // | null`, never just omitted, so a real exported World JSON always
    // includes `"ruler": null` for a Location with none. The parser used to
    // check `loc.ruler !== undefined` only, which let an explicit `null`
    // through and crashed on `loc.ruler.name`.
    const raw = JSON.parse(minimalPreExplorationWorldJson());
    raw.locations[0].ruler = null;
    const { world } = buildWorldFromJson(JSON.stringify(raw), {
      targetShipsPerLocation: 0, numPirateShips: 0, numPoliceShips: 0,
    });
    expect(world.locations[0].ruler).toBeNull();
  }, 20000);

  it("loads the exploration demo fixture with villages, a ruler, Trail routes, and an Explorer", () => {
    const { world } = buildWorldFromJson(buildExploreDemoWorldJson(), {
      targetShipsPerLocation: 0, numPirateShips: 0, numPoliceShips: 0,
    });

    expect(world.explorers).toHaveLength(1);
    const explorer = world.explorers[0];
    expect(explorer.name).toBe("Livia Ashworth");
    expect(explorer.locationName).toBe("Coastal Town");
    expect(explorer.cash).toBe(500);
    expect(explorer.porterParty.porterCount).toBe(4);
    expect(explorer.porterParty.animalCount).toBe(1);

    const villageWithRuler = world.locations.find((l) => l.name === "Riverbend Village")!;
    expect(villageWithRuler.settlementType).toBe("Native village");
    expect(villageWithRuler.ruler).not.toBeNull();
    expect(villageWithRuler.ruler?.name).toBe("Chief Ombo");
    expect(villageWithRuler.ruler?.passageTaxRate).toBe(0.15);
    // Gift-worthiness is a global Commodity property now, not per-chieftain
    // (see commodity.ts's Commodity.gift) -- the fixture's "Beads" entry
    // round-trips through here instead of a ruler-level giftCategories list.
    expect(COMMODITIES.Beads?.gift).toBe(0.7);

    const villageWithoutRuler = world.locations.find((l) => l.name === "Highland Village")!;
    expect(villageWithoutRuler.settlementType).toBe("Native village");
    expect(villageWithoutRuler.ruler).toBeNull();
    expect(villageWithoutRuler.politicalEntity?.name).toBe("River Tribe");
    expect(villageWithoutRuler.politicalEntity?.type).toBe("Tribe");

    // Trail routes are present and PorterParty-usable.
    const route = getRoute("Coastal Town", "Riverbend Village");
    expect(route?.routeType).toBe("Trail");
    expect(explorer.porterParty.canUseRoute(route)).toBe(true);
    const coastalTown = world.locations.find((l) => l.name === "Coastal Town")!;
    expect(coastalTown.terminalTypes.has("Market")).toBe(true);
  }, 20000);
});
