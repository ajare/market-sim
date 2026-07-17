import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { Location } from "../location";
import { PoliticalEntity } from "../politicalEntity";
import { Chieftain } from "../chieftain";
import { Commodity } from "../commodity";
import { PorterParty } from "../transport";
import { Explorer } from "../explorer";
import { Route, addRouteToNetwork, setRoutes } from "../routes";
import { COMMODITIES, setCommodities, setGeography } from "../worldData";
import { seedSimRandom, randRandom } from "../simRandom";
import {
  buildPassageTaxDecision,
  buildLegChoiceDecision,
  HAGGLE_SUCCESS_PROBABILITY,
  REFUSE_SAFE_PROBABILITY,
} from "../decisions";

// Tobacco/Beads are gift-worthy (Commodity.gift > 0) for this file's
// passage-tax gift-giving tests -- gift-worthiness is global, not
// per-chieftain (see commodity.ts's Commodity.gift), so registering it once
// here covers every chieftain below.
const defaultCommodities = COMMODITIES;
const testCommodities: Record<string, Commodity> = {
  Tobacco: new Commodity("Tobacco", 10, undefined, undefined, undefined, [], undefined, undefined, undefined, undefined, 0.6),
  Beads: new Commodity("Beads", 5, undefined, undefined, undefined, [], undefined, undefined, undefined, undefined, 0.9),
};
beforeAll(() => setCommodities(testCommodities));
afterAll(() => setCommodities(defaultCommodities));

function makeVillage(name: string, overrides: Partial<ConstructorParameters<typeof Location>[0]> = {}): Location {
  return new Location({
    name,
    producedCommodities: {},
    consumedCommodities: {},
    stockpiles: {},
    minStockpiles: {},
    basePriceModifiers: {},
    fuelPrice: 0,
    terminalTypes: new Set(["Market"]),
    settlementType: "Native village",
    ...overrides,
  });
}

function makeExplorer(location: Location, cash: number): Explorer {
  const party = new PorterParty({ name: "Test Party" });
  return new Explorer({
    name: "Livia Ashworth", gender: "Female", dateOfBirth: new Date("1850-01-01"),
    homeLocation: location, transport: party, startingCash: cash,
  });
}

/** Seeds `explorer`'s cargo with a single open-market commodity/quantity (no contract, no trip economics -- gift-giving/eligibility checks only care about `heldQuantity`). */
function seedCargo(explorer: Explorer, commodity: string, quantity: number): void {
  explorer.cargo = {
    items: [{ commodity, quantity, unitCost: 0, contract: null }],
    origin: explorer.locationName, destination: explorer.locationName, distance: 0, routeType: "none",
    travelDays: 0, fuelPricePaid: 0, fuelUnitsConsumed: 0, fuelCostTotal: 0, totalCost: 0, departureDay: 0,
  };
}

/** Finds a seed whose very next randRandom() roll satisfies `predicate`, and leaves the RNG primed so the caller's next randRandom() call reproduces it. */
function primeRollMatching(predicate: (roll: number) => boolean): void {
  for (let seed = 1; seed < 10_000; seed++) {
    seedSimRandom(seed);
    const roll = randRandom();
    if (predicate(roll)) {
      seedSimRandom(seed);
      return;
    }
  }
  throw new Error("No seed found matching predicate within range");
}

describe("buildPassageTaxDecision -- ruler present", () => {
  it("offers all four choices, correctly gated by party state", () => {
    const village = makeVillage("Chief's Village");
    setGeography([village], { "Chief's Village": [0, 0] });
    const chieftain = new Chieftain({
      name: "Chief Ombo", gender: "Male", dateOfBirth: new Date("1950-01-01"),
      passageTaxRate: 0.5, trust: 0.5,
    });
    village.ruler = chieftain;

    const explorer = makeExplorer(village, 100); // demandedAmount = 50

    const decision = buildPassageTaxDecision(explorer, village);
    expect(decision.kind).toBe("PassageTax");
    expect(decision.choices.map((c) => c.label)).toEqual([
      "Pay the demanded amount", "Offer a gift instead of cash", "Haggle the amount down", "Refuse outright",
    ]);

    const [pay, gift, haggle, refuse] = decision.choices;
    expect(pay.isEligible({ explorer })).toBe(true); // cash 100 >= demanded 50
    expect(gift.isEligible({ explorer })).toBe(false); // no Tobacco held
    expect(haggle.isEligible({ explorer })).toBe(true);
    expect(refuse.isEligible({ explorer })).toBe(true);

    seedCargo(explorer, "Tobacco", 3);
    expect(gift.isEligible({ explorer })).toBe(true);
  });

  it("Pay becomes ineligible once the party can't afford the demand", () => {
    const village = makeVillage("Poor Chief's Village");
    setGeography([village], { "Poor Chief's Village": [0, 0] });
    village.ruler = new Chieftain({
      name: "Chief Nkosi", gender: "Male", dateOfBirth: new Date("1945-01-01"), passageTaxRate: 0.9,
    });
    const explorer = makeExplorer(village, 10); // demandedAmount = 9, still affordable
    const decision = buildPassageTaxDecision(explorer, village);
    const pay = decision.choices[0];
    expect(pay.isEligible({ explorer })).toBe(true);

    explorer.cash = 1; // now below the (fixed, already-computed) demandedAmount of 9
    expect(pay.isEligible({ explorer })).toBe(false);
  });

  it("Pay deducts cash and raises trust", () => {
    const village = makeVillage("Pay Village");
    setGeography([village], { "Pay Village": [0, 0] });
    const chieftain = new Chieftain({
      name: "Chief Pay", gender: "Male", dateOfBirth: new Date("1950-01-01"), passageTaxRate: 0.2, trust: 0.5,
    });
    village.ruler = chieftain;
    const explorer = makeExplorer(village, 100); // demandedAmount = 20

    const decision = buildPassageTaxDecision(explorer, village);
    decision.choices[0].resolve({ explorer });

    expect(explorer.cash).toBe(80);
    expect(chieftain.trust).toBeGreaterThan(0.5);
  });

  it("Offer gift removes inventory (capped by what's held) and raises trust", () => {
    const village = makeVillage("Gift Village");
    setGeography([village], { "Gift Village": [0, 0] });
    const chieftain = new Chieftain({
      name: "Chief Gift", gender: "Female", dateOfBirth: new Date("1950-01-01"),
      passageTaxRate: 0.2, trust: 0.5,
    });
    village.ruler = chieftain;
    const explorer = makeExplorer(village, 100);
    seedCargo(explorer, "Beads", 2); // less than GIFT_QUANTITY_OFFERED (5)

    const decision = buildPassageTaxDecision(explorer, village);
    decision.choices[1].resolve({ explorer });

    expect(explorer.heldQuantity("Beads")).toBe(0); // fully depleted
    expect(chieftain.trust).toBeGreaterThan(0.5);
    expect(explorer.cash).toBe(100); // gift doesn't touch cash
  });

  it("Haggle: success reduces the tax and raises trust; failure pays in full and lowers trust", () => {
    const village = makeVillage("Haggle Village");
    setGeography([village], { "Haggle Village": [0, 0] });

    // Success branch.
    primeRollMatching((roll) => roll < HAGGLE_SUCCESS_PROBABILITY);
    const successChief = new Chieftain({
      name: "Chief Success", gender: "Male", dateOfBirth: new Date("1950-01-01"), passageTaxRate: 0.2, trust: 0.5,
    });
    village.ruler = successChief;
    const successExplorer = makeExplorer(village, 100); // demandedAmount = 20
    const successDecision = buildPassageTaxDecision(successExplorer, village);
    successDecision.choices[2].resolve({ explorer: successExplorer });
    expect(successExplorer.cash).toBe(90); // 20 * 0.5 reduction -> paid 10
    expect(successChief.trust).toBeGreaterThan(0.5);

    // Failure branch.
    primeRollMatching((roll) => roll >= HAGGLE_SUCCESS_PROBABILITY);
    const failChief = new Chieftain({
      name: "Chief Fail", gender: "Male", dateOfBirth: new Date("1950-01-01"), passageTaxRate: 0.2, trust: 0.5,
    });
    village.ruler = failChief;
    const failExplorer = makeExplorer(village, 100);
    const failDecision = buildPassageTaxDecision(failExplorer, village);
    failDecision.choices[2].resolve({ explorer: failExplorer });
    expect(failExplorer.cash).toBe(80); // full 20 paid
    expect(failChief.trust).toBeLessThan(0.5);
  });

  it("Refuse: safe outcome costs nothing but trust; bad outcome also costs cash", () => {
    const village = makeVillage("Refuse Village");
    setGeography([village], { "Refuse Village": [0, 0] });

    primeRollMatching((roll) => roll < REFUSE_SAFE_PROBABILITY);
    const safeChief = new Chieftain({
      name: "Chief Safe", gender: "Male", dateOfBirth: new Date("1950-01-01"), trust: 0.5,
    });
    village.ruler = safeChief;
    const safeExplorer = makeExplorer(village, 100);
    buildPassageTaxDecision(safeExplorer, village).choices[3].resolve({ explorer: safeExplorer });
    expect(safeExplorer.cash).toBe(100);
    expect(safeChief.trust).toBeLessThan(0.5);

    primeRollMatching((roll) => roll >= REFUSE_SAFE_PROBABILITY);
    const badChief = new Chieftain({
      name: "Chief Bad", gender: "Male", dateOfBirth: new Date("1950-01-01"), trust: 0.5,
    });
    village.ruler = badChief;
    const badExplorer = makeExplorer(village, 100);
    buildPassageTaxDecision(badExplorer, village).choices[3].resolve({ explorer: badExplorer });
    expect(badExplorer.cash).toBeLessThan(100);
    expect(badChief.trust).toBeLessThan(safeChief.trust);
  });
});

describe("buildPassageTaxDecision -- PoliticalEntity-only fallback", () => {
  it("offers only Pay and Refuse, no Haggle/Offer-gift", () => {
    const village = makeVillage("Tribe Village");
    setGeography([village], { "Tribe Village": [0, 0] });
    new PoliticalEntity("Test Tribe", [village], 1000, "Tribe"); // sets village.politicalEntity, no ruler

    const explorer = makeExplorer(village, 100);
    const decision = buildPassageTaxDecision(explorer, village);

    expect(decision.choices.map((c) => c.label)).toEqual(["Pay the demanded amount", "Refuse outright"]);
    decision.choices[0].resolve({ explorer });
    expect(explorer.cash).toBe(95); // FALLBACK_PASSAGE_TAX_RATE (0.05) * 100
  });
});

describe("buildLegChoiceDecision", () => {
  it("offers one choice per outgoing Trail route, and resolving one departs the party", () => {
    const origin = makeVillage("Leg Origin");
    const destA = makeVillage("Leg Dest A");
    const destB = makeVillage("Leg Dest B");
    setGeography([origin, destA, destB], {
      "Leg Origin": [0, 0], "Leg Dest A": [600, 0], "Leg Dest B": [0, 600],
    });
    const network = new Map<string, Route[]>();
    addRouteToNetwork(network, new Route("Leg Origin", "Leg Dest A", "Trail"));
    addRouteToNetwork(network, new Route("Leg Origin", "Leg Dest B", "Trail"));
    setRoutes(network);

    const explorer = makeExplorer(origin, 100);
    const decision = buildLegChoiceDecision(explorer);

    expect(decision.kind).toBe("LegChoice");
    expect(decision.choices).toHaveLength(2);
    expect(decision.choices.map((c) => c.label).sort()).toEqual([
      "Head to Leg Dest A", "Head to Leg Dest B",
    ]);

    decision.choices[0].resolve({ explorer });
    expect(explorer.destination).not.toBeNull();
  });
});
