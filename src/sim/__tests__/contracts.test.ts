import { describe, expect, it } from "vitest";
import { buildWorld } from "../buildWorld";
import {
  tenderContracts, pruneContracts, CONTRACT_FEE_ESCALATION_BASE, type Contract,
} from "../contracts";
import { Location, type LocationInit } from "../location";
import { setGeography } from "../worldData";
import { generateRoutes, setRoutes } from "../routes";
import { Market, marketKey } from "../markets";
import { Company } from "../faction";
import { Captain } from "../captain";
import { SHIP_CLASSES } from "../transport";

function makeLocation(overrides: Partial<LocationInit> = {}): Location {
  return new Location({
    name: "Testville",
    producedCommodities: {},
    consumedCommodities: { Wheat: 5 },
    stockpiles: { Wheat: 50 },
    minStockpiles: { Wheat: 100 },
    basePrices: { Wheat: 10 },
    fuelPrice: 1.0,
    terminalTypes: new Set(["Port"]),
    ...overrides,
  });
}

function makeContract(overrides: Partial<Contract> = {}): Contract {
  return {
    location: "Testville",
    commodity: "Wheat",
    quantity: 100,
    deliveryFee: 50,
    company: null,
    inFlightCaptain: null,
    fulfilled: false,
    beginDay: 1,
    expiryDay: 8,
    ...overrides,
  };
}

describe("tenderContracts", () => {
  it("tenders a contract sized to minStockpile times the default quantityMultiplier", () => {
    const loc = makeLocation();
    const contracts = tenderContracts([loc], [], 1);
    expect(contracts).toHaveLength(1);
    expect(contracts[0]).toMatchObject({
      location: "Testville",
      commodity: "Wheat",
      quantity: 150, // 1.5x minStockpile of 100, per the default CONTRACT_QUANTITY_MULTIPLIER
      company: null,
      inFlightCaptain: null,
      fulfilled: false,
      beginDay: 1,
      expiryDay: 8,
    });
  });

  it("respects a custom expiryDays override", () => {
    const loc = makeLocation();
    const contracts = tenderContracts([loc], [], 10, { expiryDays: 3 });
    expect(contracts[0].beginDay).toBe(10);
    expect(contracts[0].expiryDay).toBe(13);
  });

  it("respects a custom quantityMultiplier override", () => {
    const loc = makeLocation();
    const contracts = tenderContracts([loc], [], 1, { quantityMultiplier: 2 });
    expect(contracts[0].quantity).toBe(200); // 2x minStockpile of 100
  });

  it("respects a custom baseFeeRate override", () => {
    const loc = makeLocation({ stockpiles: { Wheat: 100 } }); // deficitRatio 0 -- no urgency scaling
    // quantityMultiplier pinned to 1 so this test isolates baseFeeRate alone.
    const contracts = tenderContracts([loc], [], 1, { baseFeeRate: 0.1, quantityMultiplier: 1 });
    expect(contracts[0].deliveryFee).toBeCloseTo(100 * 10 * 0.1);
  });

  it("does not tender for a broke location", () => {
    const loc = makeLocation({ cash: 0 });
    expect(tenderContracts([loc], [], 1)).toHaveLength(0);
  });

  it("tenders proactively at exactly the default 1.5x threshold, above the actual minimum", () => {
    const loc = makeLocation({ stockpiles: { Wheat: 150 } }); // exactly 1.5x minStockpile of 100
    expect(tenderContracts([loc], [], 1)).toHaveLength(1);
  });

  it("does not tender once stockpile is above the 1.5x threshold", () => {
    const loc = makeLocation({ stockpiles: { Wheat: 151 } });
    expect(tenderContracts([loc], [], 1)).toHaveLength(0);
  });

  it("honors a per-Location contractThresholdFraction override", () => {
    const loc = makeLocation({ stockpiles: { Wheat: 99 }, contractThresholdFraction: 1.0 });
    // 99 is below the default 1.5x threshold but a 1.0x override only tenders once actually below minStockpile.
    expect(tenderContracts([loc], [], 1)).toHaveLength(1);
    const aboveMin = makeLocation({ stockpiles: { Wheat: 101 }, contractThresholdFraction: 1.0 });
    expect(tenderContracts([aboveMin], [], 1)).toHaveLength(0);
  });

  it("does not re-tender for a pair that already has an open contract", () => {
    const loc = makeLocation();
    expect(tenderContracts([loc], [makeContract()], 1)).toHaveLength(0);
  });

  it("scales deliveryFee with an exponential urgency curve based on the deficit", () => {
    // quantityMultiplier pinned to 1 so this test isolates the urgency curve alone.
    const opts = { quantityMultiplier: 1 };
    const baseFee = 100 * 10 * 0.05; // quantity * basePrice * 0.05

    const atMinimum = makeLocation({ stockpiles: { Wheat: 100 } }); // deficitRatio 0
    expect(tenderContracts([atMinimum], [], 1, opts)[0].deliveryFee).toBeCloseTo(baseFee);

    const proactiveZone = makeLocation({ stockpiles: { Wheat: 130 } }); // above minimum, still proactive zone
    expect(tenderContracts([proactiveZone], [], 1, opts)[0].deliveryFee).toBeCloseTo(baseFee);

    const emptyStock = makeLocation({ stockpiles: { Wheat: 0 } }); // deficitRatio 1
    expect(tenderContracts([emptyStock], [], 1, opts)[0].deliveryFee).toBeCloseTo(baseFee * CONTRACT_FEE_ESCALATION_BASE);

    const halfway = makeLocation({ stockpiles: { Wheat: 50 } }); // deficitRatio 0.5
    const halfwayFee = tenderContracts([halfway], [], 1, opts)[0].deliveryFee;
    expect(halfwayFee).toBeGreaterThan(baseFee);
    expect(halfwayFee).toBeLessThan(baseFee * CONTRACT_FEE_ESCALATION_BASE);
  });
});

describe("pruneContracts", () => {
  it("drops fulfilled contracts", () => {
    const loc = makeLocation();
    const contract = makeContract({ fulfilled: true });
    expect(pruneContracts([contract], [loc], 2)).toHaveLength(0);
  });

  it("keeps an unclaimed contract within its expiry window", () => {
    // Stockpile safely above the 50% severe-deficit line so only the expiry
    // check (not the severe-deficit check) is in play here.
    const loc = makeLocation({ stockpiles: { Wheat: 70 } });
    const contract = makeContract({ beginDay: 1, expiryDay: 8 });
    expect(pruneContracts([contract], [loc], 5)).toHaveLength(1);
  });

  it("drops an unclaimed contract past its expiry day", () => {
    const loc = makeLocation();
    const contract = makeContract({ beginDay: 1, expiryDay: 8 });
    expect(pruneContracts([contract], [loc], 9)).toHaveLength(0);
  });

  it("keeps a claimed contract even past its expiry day", () => {
    const loc = makeLocation();
    const company = new Company("Acme", [], 0);
    const contract = makeContract({ beginDay: 1, expiryDay: 8, company });
    expect(pruneContracts([contract], [loc], 9)).toHaveLength(1);
  });

  it("drops an unclaimed contract early once the location hits the severe-deficit line, even before expiry", () => {
    const loc = makeLocation({ stockpiles: { Wheat: 40 } }); // 40% of minStockpile 100
    const contract = makeContract({ beginDay: 1, expiryDay: 8 });
    expect(pruneContracts([contract], [loc], 2)).toHaveLength(0);
  });

  it("keeps a claimed contract even at the severe-deficit line", () => {
    const loc = makeLocation({ stockpiles: { Wheat: 40 } });
    const company = new Company("Acme", [], 0);
    const contract = makeContract({ beginDay: 1, expiryDay: 8, company });
    expect(pruneContracts([contract], [loc], 2)).toHaveLength(1);
  });
});

describe("Contract claiming (location-funded design)", () => {
  it("a broke Company can still claim a contract -- goods affordability is no longer its problem", () => {
    const homeLocation = "Testport";
    const transport = SHIP_CLASSES.Speedster.clone({ name: "T1", crewRequirement: 1 });
    const captain = new Captain("Cap", homeLocation);
    const company = new Company("Broke Co", [[transport, captain, homeLocation]], 0);
    expect(company.cash).toBe(0);

    const contract = makeContract({ location: "Somewhere", commodity: "Gold", deliveryFee: 99_999 });
    company.directFleet(1, new Map(), new Map(), [], new Set(), [contract]);
    expect(contract.company).toBe(company);
  });
});

describe("serviceContracts producer selection", () => {
  it("repositions toward a farther but well-stocked producer over a nearer but thin one", () => {
    const home = makeLocation({
      name: "Home", producedCommodities: {}, consumedCommodities: {},
      stockpiles: {}, minStockpiles: {}, basePrices: {},
    });
    const nearLow = makeLocation({
      name: "NearLow", producedCommodities: { Gold: 5 }, consumedCommodities: {},
      stockpiles: { Gold: 10 }, minStockpiles: {}, basePrices: { Gold: 100 },
    });
    const farHigh = makeLocation({
      name: "FarHigh", producedCommodities: { Gold: 5 }, consumedCommodities: {},
      stockpiles: { Gold: 200 }, minStockpiles: {}, basePrices: { Gold: 100 },
    });
    const dest = makeLocation({
      name: "Dest", producedCommodities: {}, consumedCommodities: { Gold: 5 },
      stockpiles: { Gold: 0 }, minStockpiles: { Gold: 100 }, basePrices: { Gold: 100 },
    });

    const locations = [home, nearLow, farHigh, dest];
    setGeography(locations, { Home: [0, 0], NearLow: [10, 0], FarHigh: [1000, 0], Dest: [20, 0] });
    setRoutes(generateRoutes(locations, 12345, undefined));

    const transport = SHIP_CLASSES.Speedster.clone({ name: "T1", crewRequirement: 1 });
    const captain = new Captain("Cap", "Home");
    const company = new Company("Acme", [[transport, captain, "Home"]], 100_000);

    const contract = makeContract({ location: "Dest", commodity: "Gold", quantity: 100, company });
    company.contracts.push(contract);

    const buyMarkets = new Map([
      [marketKey("NearLow", "Gold"), new Market("Gold", "NearLow", nearLow, 100, 100, "buy")],
      [marketKey("FarHigh", "Gold"), new Market("Gold", "FarHigh", farHigh, 100, 100, "buy")],
    ]);

    const directives = company.directFleet(1, buyMarkets, new Map(), ["Gold"], new Set(), [contract]);
    expect(directives.get(captain)).toMatchObject({ action: "REPOSITION", destination: "FarHigh" });
  });

  it("still prefers the nearer producer when both can fully supply the contract", () => {
    const home = makeLocation({
      name: "Home", producedCommodities: {}, consumedCommodities: {},
      stockpiles: {}, minStockpiles: {}, basePrices: {},
    });
    const near = makeLocation({
      name: "Near", producedCommodities: { Gold: 5 }, consumedCommodities: {},
      stockpiles: { Gold: 200 }, minStockpiles: {}, basePrices: { Gold: 100 },
    });
    const far = makeLocation({
      name: "Far", producedCommodities: { Gold: 5 }, consumedCommodities: {},
      stockpiles: { Gold: 200 }, minStockpiles: {}, basePrices: { Gold: 100 },
    });
    const dest = makeLocation({
      name: "Dest", producedCommodities: {}, consumedCommodities: { Gold: 5 },
      stockpiles: { Gold: 0 }, minStockpiles: { Gold: 100 }, basePrices: { Gold: 100 },
    });

    const locations = [home, near, far, dest];
    setGeography(locations, { Home: [0, 0], Near: [10, 0], Far: [1000, 0], Dest: [20, 0] });
    setRoutes(generateRoutes(locations, 12345, undefined));

    const transport = SHIP_CLASSES.Speedster.clone({ name: "T1", crewRequirement: 1 });
    const captain = new Captain("Cap", "Home");
    const company = new Company("Acme", [[transport, captain, "Home"]], 100_000);

    const contract = makeContract({ location: "Dest", commodity: "Gold", quantity: 100, company });
    company.contracts.push(contract);

    const buyMarkets = new Map([
      [marketKey("Near", "Gold"), new Market("Gold", "Near", near, 100, 100, "buy")],
      [marketKey("Far", "Gold"), new Market("Gold", "Far", far, 100, 100, "buy")],
    ]);

    const directives = company.directFleet(1, buyMarkets, new Map(), ["Gold"], new Set(), [contract]);
    expect(directives.get(captain)).toMatchObject({ action: "REPOSITION", destination: "Near" });
  });
});

describe("Contract system integration", () => {
  it("tenders, services, and prunes contracts over a run without ballooning world.contracts", () => {
    const { world } = buildWorld();
    world.run(60);
    const day = 60;

    // Pruning of a given day's fulfillments/expirations happens at the
    // START of the *next* day (per the new timing), so right after the last
    // simulated day there can still be that day's fresh fulfillments sitting
    // unpruned -- the exact mechanism is covered precisely by the
    // `pruneContracts` unit tests above. Here we only check the invariant
    // that doesn't have that one-day lag: no unclaimed contract is ever seen
    // past its own expiry day (expiry pruning for day N happens before
    // anything on day N can act, so it holds at inspection time too).
    expect(world.contracts.every((c) => c.company !== null || day <= c.expiryDay)).toBe(true);

    // At least one Location's cash should have moved from the untouched
    // 10-billion default, proving trades are actually tracked against it.
    const defaultCash = 10_000_000_000;
    expect(world.locations.some((l) => l.cash !== defaultCash)).toBe(true);
  }, 20000);
});
