/**
 * A minimal, hand-authored World JSON (the editor's exported shape -- see
 * buildWorldFromJson.ts) built specifically to exercise the exploration
 * mode: a coastal Town, two Market-terminal Villages connected to it by
 * Trail routes (one with a Chieftain ruler, one without -- exercising the
 * PoliticalEntity-only fallback), one Tribe PoliticalEntity owning the
 * villages, and one Explorer/PorterParty starting at the coastal Town.
 * Pasteable via ControlsPanel's "Paste World" flow for manual testing (see
 * doc/ExploreGameTickets.json's EXP-9).
 *
 * World's own MIN_LOCATIONS (20) forces this fixture to include a batch of
 * otherwise-inert filler Town locations alongside the three Locations that
 * actually matter to the exploration mode -- they carry no commodities or
 * routes and exist purely to clear that floor.
 */

const FILLER_TOWN_COUNT = 18; // + 1 coastal Town + 2 Villages = 21, clears MIN_LOCATIONS (20).

/** Builds the demo world as a plain object (editor JSON shape) -- see buildExploreDemoWorldJson for the paste-ready string form. */
export function buildExploreDemoWorld() {
  const politicalEntities = [
    { id: "pe-colonial", name: "Colonial Authority", type: "Country" },
    { id: "pe-tribe", name: "River Tribe", type: "Tribe" },
  ];

  const coastalTown = {
    id: "loc-coastal-town",
    name: "Coastal Town",
    x: 0,
    y: 0,
    politicalEntityId: "pe-colonial",
    producedCommodities: {},
    consumedCommodities: {},
    stockpiles: {},
    minStockpiles: {},
    basePriceModifiers: {},
    fuelPrice: 1.0,
    terminalTypes: ["Port", "Market"],
  };

  const villageWithRuler = {
    id: "loc-village-one",
    name: "Riverbend Village",
    x: 500,
    y: 0,
    politicalEntityId: "pe-tribe",
    producedCommodities: { Ivory: 1.0 },
    consumedCommodities: { Cloth: 1.0 },
    stockpiles: { Ivory: 100, Cloth: 0 },
    minStockpiles: { Ivory: 10, Cloth: 10 },
    basePriceModifiers: { Ivory: 1.0, Cloth: 1.0 },
    fuelPrice: 0,
    terminalTypes: ["Market"],
    settlementType: "Village",
    ruler: {
      name: "Chief Ombo",
      passageTaxRate: 0.15,
      trust: 0.5,
      giftCategories: ["Beads"],
    },
  };

  // Deliberately no `ruler` -- exercises the PoliticalEntity-only fallback
  // branch of decisions.buildPassageTaxDecision.
  const villageWithoutRuler = {
    id: "loc-village-two",
    name: "Highland Village",
    x: 0,
    y: 500,
    politicalEntityId: "pe-tribe",
    producedCommodities: { Gold: 1.0 },
    consumedCommodities: { Tobacco: 1.0 },
    stockpiles: { Gold: 40, Tobacco: 0 },
    minStockpiles: { Gold: 5, Tobacco: 10 },
    basePriceModifiers: { Gold: 1.0, Tobacco: 1.0 },
    fuelPrice: 0,
    terminalTypes: ["Market"],
    settlementType: "Village",
  };

  const fillerTowns = Array.from({ length: FILLER_TOWN_COUNT }, (_, i) => ({
    id: `loc-filler-${i}`,
    name: `Filler Town ${i + 1}`,
    x: 1000 + i * 200,
    y: 1000,
    politicalEntityId: "pe-colonial",
    producedCommodities: {},
    consumedCommodities: {},
    stockpiles: {},
    minStockpiles: {},
    basePriceModifiers: {},
    fuelPrice: 1.0,
    terminalTypes: ["Port"],
  }));

  const routes = [
    { id: "route-1", locationAId: "loc-coastal-town", locationBId: "loc-village-one", routeType: "Trail" },
    { id: "route-2", locationAId: "loc-coastal-town", locationBId: "loc-village-two", routeType: "Trail" },
  ];

  const explorers = [
    {
      name: "Livia Ashworth",
      homeLocationId: "loc-coastal-town",
      porterCount: 4,
      animalCount: 1,
      startingCash: 500,
    },
  ];

  return {
    worldScale: 3000,
    locations: [coastalTown, villageWithRuler, villageWithoutRuler, ...fillerTowns],
    politicalEntities,
    companies: [],
    routes,
    explorers,
  };
}

/** Paste-ready JSON string form of buildExploreDemoWorld() -- what ControlsPanel's "Paste World"/"Import World" flow consumes. */
export function buildExploreDemoWorldJson(): string {
  return JSON.stringify(buildExploreDemoWorld());
}
