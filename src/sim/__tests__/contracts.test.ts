import { describe, expect, it } from "vitest";
import { buildWorld } from "../buildWorld";
import {
  BulletinBoard, contractKey, CONTRACT_FEE_ESCALATION_BASE, type Contract,
} from "../contracts";
import { Location, type LocationInit } from "../location";
import { setGeography } from "../worldData";
import { generateRoutes, setRoutes } from "../routes";
import { Market, marketKey } from "../markets";
import { Company, SoloTrader } from "../faction";
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
    type: "Commodity",
    quantity: 100,
    deliveryFee: 50,
    fulfiller: null,
    inFlightCaptain: null,
    fulfilled: false,
    cancelled: false,
    beginDay: 1,
    expiryDay: 8,
    ...overrides,
  };
}

describe("Location.tenderContracts", () => {
  it("tenders a contract sized to minStockpile times the default quantityMultiplier", () => {
    const loc = makeLocation();
    const board = new BulletinBoard();
    loc.tenderContracts(1, board, new Set());
    expect(board.open).toHaveLength(1);
    expect(board.open[0]).toMatchObject({
      location: "Testville",
      commodity: "Wheat",
      type: "Commodity",
      quantity: 150, // 1.5x minStockpile of 100, per the default CONTRACT_QUANTITY_MULTIPLIER
      fulfiller: null,
      inFlightCaptain: null,
      fulfilled: false,
      beginDay: 1,
      expiryDay: 8,
    });
  });

  it("respects a custom expiryDays override", () => {
    const loc = makeLocation();
    const board = new BulletinBoard();
    loc.tenderContracts(10, board, new Set(), { expiryDays: 3 });
    expect(board.open[0].beginDay).toBe(10);
    expect(board.open[0].expiryDay).toBe(13);
  });

  it("respects a custom quantityMultiplier override", () => {
    const loc = makeLocation();
    const board = new BulletinBoard();
    loc.tenderContracts(1, board, new Set(), { quantityMultiplier: 2 });
    expect(board.open[0].quantity).toBe(200); // 2x minStockpile of 100
  });

  it("respects a custom baseFeeRate override", () => {
    const loc = makeLocation({ stockpiles: { Wheat: 100 } }); // deficitRatio 0 -- no urgency scaling
    // quantityMultiplier pinned to 1 so this test isolates baseFeeRate alone.
    const board = new BulletinBoard();
    loc.tenderContracts(1, board, new Set(), { baseFeeRate: 0.1, quantityMultiplier: 1 });
    expect(board.open[0].deliveryFee).toBeCloseTo(100 * 10 * 0.1);
  });

  it("does not tender for a broke location", () => {
    const loc = makeLocation({ cash: 0 });
    const board = new BulletinBoard();
    loc.tenderContracts(1, board, new Set());
    expect(board.open).toHaveLength(0);
  });

  it("tenders proactively at exactly the default 1.5x threshold, above the actual minimum", () => {
    const loc = makeLocation({ stockpiles: { Wheat: 150 } }); // exactly 1.5x minStockpile of 100
    const board = new BulletinBoard();
    loc.tenderContracts(1, board, new Set());
    expect(board.open).toHaveLength(1);
  });

  it("does not tender once stockpile is above the 1.5x threshold", () => {
    const loc = makeLocation({ stockpiles: { Wheat: 151 } });
    const board = new BulletinBoard();
    loc.tenderContracts(1, board, new Set());
    expect(board.open).toHaveLength(0);
  });

  it("honors a per-Location contractThresholdFraction override", () => {
    const loc = makeLocation({ stockpiles: { Wheat: 99 }, contractThresholdFraction: 1.0 });
    // 99 is below the default 1.5x threshold but a 1.0x override only tenders once actually below minStockpile.
    const board = new BulletinBoard();
    loc.tenderContracts(1, board, new Set());
    expect(board.open).toHaveLength(1);

    const aboveMin = makeLocation({ stockpiles: { Wheat: 101 }, contractThresholdFraction: 1.0 });
    const aboveMinBoard = new BulletinBoard();
    aboveMin.tenderContracts(1, aboveMinBoard, new Set());
    expect(aboveMinBoard.open).toHaveLength(0);
  });

  it("does not re-tender for a pair that's already open on the board", () => {
    const loc = makeLocation();
    const board = new BulletinBoard();
    const activeKeys = new Set([contractKey("Testville", "Wheat")]);
    loc.tenderContracts(1, board, activeKeys);
    expect(board.open).toHaveLength(0);
  });

  it("does not re-tender for a pair whose existing contract has already been accepted (so it isn't on any board)", () => {
    // The dedup key set must span contracts accepted elsewhere too, not just
    // board postings -- otherwise a Location would double-order a commodity a
    // Company already accepted but hasn't delivered yet.
    const loc = makeLocation();
    const board = new BulletinBoard(); // empty -- the existing contract isn't posted here
    const activeKeys = new Set([contractKey("Testville", "Wheat")]);
    loc.tenderContracts(1, board, activeKeys);
    expect(board.open).toHaveLength(0);
  });

  it("scales deliveryFee with an exponential urgency curve based on the deficit", () => {
    // quantityMultiplier pinned to 1 so this test isolates the urgency curve alone.
    const opts = { quantityMultiplier: 1 };
    const baseFee = 100 * 10 * 0.05; // quantity * basePrice * 0.05

    const atMinimum = makeLocation({ stockpiles: { Wheat: 100 } }); // deficitRatio 0
    const board1 = new BulletinBoard();
    atMinimum.tenderContracts(1, board1, new Set(), opts);
    expect(board1.open[0].deliveryFee).toBeCloseTo(baseFee);

    const proactiveZone = makeLocation({ stockpiles: { Wheat: 130 } }); // above minimum, still proactive zone
    const board2 = new BulletinBoard();
    proactiveZone.tenderContracts(1, board2, new Set(), opts);
    expect(board2.open[0].deliveryFee).toBeCloseTo(baseFee);

    const emptyStock = makeLocation({ stockpiles: { Wheat: 0 } }); // deficitRatio 1
    const board3 = new BulletinBoard();
    emptyStock.tenderContracts(1, board3, new Set(), opts);
    expect(board3.open[0].deliveryFee).toBeCloseTo(baseFee * CONTRACT_FEE_ESCALATION_BASE);

    const halfway = makeLocation({ stockpiles: { Wheat: 50 } }); // deficitRatio 0.5
    const board4 = new BulletinBoard();
    halfway.tenderContracts(1, board4, new Set(), opts);
    const halfwayFee = board4.open[0].deliveryFee;
    expect(halfwayFee).toBeGreaterThan(baseFee);
    expect(halfwayFee).toBeLessThan(baseFee * CONTRACT_FEE_ESCALATION_BASE);
  });
});

describe("BulletinBoard.prune", () => {
  it("keeps an unclaimed posting within its expiry window", () => {
    // Stockpile safely above the 50% severe-deficit line so only the expiry
    // check (not the severe-deficit check) is in play here.
    const loc = makeLocation({ stockpiles: { Wheat: 70 } });
    const board = new BulletinBoard();
    board.post(makeContract({ beginDay: 1, expiryDay: 8 }));
    board.prune([loc], 5);
    expect(board.open).toHaveLength(1);
  });

  it("drops an unclaimed posting past its expiry day", () => {
    const loc = makeLocation();
    const board = new BulletinBoard();
    board.post(makeContract({ beginDay: 1, expiryDay: 8 }));
    board.prune([loc], 9);
    expect(board.open).toHaveLength(0);
  });

  it("drops an unclaimed posting early once the location hits the severe-deficit line, even before expiry", () => {
    const loc = makeLocation({ stockpiles: { Wheat: 40 } }); // 40% of minStockpile 100
    const board = new BulletinBoard();
    board.post(makeContract({ beginDay: 1, expiryDay: 8 }));
    board.prune([loc], 2);
    expect(board.open).toHaveLength(0);
  });
});

describe("ContractFulfiller.pruneFulfilled (exercised via Company.directFleet)", () => {
  it("drops an already-fulfilled contract from its own list on the next servicing pass", () => {
    const transport = SHIP_CLASSES.Speedster.clone({ name: "T1", crewRequirement: 1 });
    const captain = new Captain("Cap", "Testport");
    const company = new Company("Acme", [[transport, captain, "Testport"]], 100_000);
    const fulfilledContract = makeContract({ fulfiller: company, fulfilled: true });
    company.contracts.push(fulfilledContract);

    company.directFleet(1, new Map(), new Map(), [], new Set(), new BulletinBoard());
    expect(company.contracts).not.toContain(fulfilledContract);
  });
});

describe("Contract acceptance (location-funded design)", () => {
  it("a broke Company can still accept a contract -- goods affordability is no longer its problem", () => {
    const homeLocation = "Testport";
    const transport = SHIP_CLASSES.Speedster.clone({ name: "T1", crewRequirement: 1 });
    const captain = new Captain("Cap", homeLocation);
    const company = new Company("Broke Co", [[transport, captain, homeLocation]], 0);
    // "prioritise" accepts eagerly regardless of servicing viability -- this
    // test is specifically about that acceptance behaviour (see
    // ContractStrategy), not about "compare"'s accept-at-commit-time semantics.
    company.contractStrategy = "prioritise";
    expect(company.cash).toBe(0);

    const board = new BulletinBoard();
    const contract = makeContract({ location: "Somewhere", commodity: "Gold", deliveryFee: 99_999 });
    board.post(contract);
    company.directFleet(1, new Map(), new Map(), [], new Set(), board);
    expect(contract.fulfiller).toBe(company);
    expect(board.open).not.toContain(contract);
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

    const contract = makeContract({ location: "Dest", commodity: "Gold", quantity: 100, fulfiller: company });
    company.contracts.push(contract);
    // Pinned to "prioritise" -- this test exercises serviceContracts' producer
    // ranking specifically; bestProducer (compare mode's equivalent) has its
    // own coverage in the contract-strategy describe block below.
    company.contractStrategy = "prioritise";

    const buyMarkets = new Map([
      [marketKey("NearLow", "Gold"), new Market("Gold", "NearLow", nearLow, 100, 100, "buy")],
      [marketKey("FarHigh", "Gold"), new Market("Gold", "FarHigh", farHigh, 100, 100, "buy")],
    ]);

    const directives = company.directFleet(1, buyMarkets, new Map(), ["Gold"], new Set(), new BulletinBoard());
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

    const contract = makeContract({ location: "Dest", commodity: "Gold", quantity: 100, fulfiller: company });
    company.contracts.push(contract);
    company.contractStrategy = "prioritise";

    const buyMarkets = new Map([
      [marketKey("Near", "Gold"), new Market("Gold", "Near", near, 100, 100, "buy")],
      [marketKey("Far", "Gold"), new Market("Gold", "Far", far, 100, 100, "buy")],
    ]);

    const directives = company.directFleet(1, buyMarkets, new Map(), ["Gold"], new Set(), new BulletinBoard());
    expect(directives.get(captain)).toMatchObject({ action: "REPOSITION", destination: "Near" });
  });
});

describe("contract strategy toggle (prioritise vs compare)", () => {
  // A world offering the captain BOTH a cheap-in/dear-out arbitrage haul
  // (buy Silver at Home, sell at nearby SilverDest) and a Gold supply contract
  // sourced from a far Mine for delivery to GoldDest. Which one a Company
  // takes is exactly what the strategy toggle controls.
  function setupStrategyWorld(deliveryFee: number) {
    const home = makeLocation({
      name: "Home", producedCommodities: { Silver: 5 }, consumedCommodities: {},
      stockpiles: { Silver: 1000 }, minStockpiles: {}, basePrices: { Silver: 10 },
    });
    const silverDest = makeLocation({
      name: "SilverDest", producedCommodities: {}, consumedCommodities: { Silver: 5 },
      stockpiles: { Silver: 0 }, minStockpiles: { Silver: 100 }, basePrices: { Silver: 100 },
    });
    const mine = makeLocation({
      name: "Mine", producedCommodities: { Gold: 5 }, consumedCommodities: {},
      stockpiles: { Gold: 1000 }, minStockpiles: {}, basePrices: { Gold: 100 },
    });
    const goldDest = makeLocation({
      name: "GoldDest", producedCommodities: {}, consumedCommodities: { Gold: 5 },
      stockpiles: { Gold: 0 }, minStockpiles: { Gold: 100 }, basePrices: { Gold: 100 },
    });
    const locations = [home, silverDest, mine, goldDest];
    setGeography(locations, { Home: [0, 0], SilverDest: [20, 0], Mine: [600, 0], GoldDest: [620, 0] });
    setRoutes(generateRoutes(locations, 12345, undefined));

    const transport = SHIP_CLASSES.Speedster.clone({ name: "T1", crewRequirement: 1 });
    const captain = new Captain("Cap", "Home");
    const company = new Company("Acme", [[transport, captain, "Home"]], 100_000);

    const buyMarkets = new Map([
      [marketKey("Home", "Silver"), new Market("Silver", "Home", home, 10, 10, "buy")],
      [marketKey("Mine", "Gold"), new Market("Gold", "Mine", mine, 100, 100, "buy")],
    ]);
    const sellMarkets = new Map([
      [marketKey("SilverDest", "Silver"), new Market("Silver", "SilverDest", silverDest, 100, 100, "sell")],
    ]);
    const contract = makeContract({ location: "GoldDest", commodity: "Gold", quantity: 100, deliveryFee, fulfiller: null });
    return { company, captain, buyMarkets, sellMarkets, contract, commodities: ["Silver", "Gold"] };
  }

  it("prioritise mode services a due contract even when arbitrage pays more", () => {
    const { company, captain, buyMarkets, sellMarkets, contract, commodities } = setupStrategyWorld(50);
    company.contractStrategy = "prioritise";
    const board = new BulletinBoard();
    board.post(contract);
    const directives = company.directFleet(1, buyMarkets, sellMarkets, commodities, new Set(), board);
    expect(directives.get(captain)).toMatchObject({ action: "REPOSITION", destination: "Mine" });
    expect(contract.fulfiller).toBe(company);
    expect(board.open).not.toContain(contract);
  });

  it("compare mode takes the more-profitable arbitrage over a low-fee contract", () => {
    const { company, captain, buyMarkets, sellMarkets, contract, commodities } = setupStrategyWorld(50);
    company.contractStrategy = "compare";
    const board = new BulletinBoard();
    board.post(contract);
    const directives = company.directFleet(1, buyMarkets, sellMarkets, commodities, new Set(), board);
    const directive = directives.get(captain);
    expect(directive).toBeDefined();
    // An arbitrage directive is a TradeDirective -- no `action` discriminator -- for Silver.
    expect((directive as { action?: string }).action).toBeUndefined();
    expect((directive as { commodity?: string }).commodity).toBe("Silver");
    // The contract was neither accepted nor serviced -- still sitting on the board.
    expect(contract.fulfiller).toBeNull();
    expect(board.open).toContain(contract);
  });

  it("compare mode services a contract that out-earns arbitrage", () => {
    const { company, captain, buyMarkets, sellMarkets, contract, commodities } = setupStrategyWorld(5_000_000);
    company.contractStrategy = "compare";
    const board = new BulletinBoard();
    board.post(contract);
    const directives = company.directFleet(1, buyMarkets, sellMarkets, commodities, new Set(), board);
    expect(directives.get(captain)).toMatchObject({ action: "REPOSITION", destination: "Mine" });
    expect(contract.fulfiller).toBe(company); // accepted at the moment the ship commits
    expect(board.open).not.toContain(contract);
  });
});

describe("SoloTrader never accepts a Contract", () => {
  it("has no contractTypes, so it ignores every board posting regardless of profitability", () => {
    const transport = SHIP_CLASSES.Speedster.clone({ name: "T1", crewRequirement: 1 });
    const captain = new Captain("Cap", "Testport");
    const solo = new SoloTrader("Loner", [[transport, captain, "Testport"]], 100_000);
    expect(solo.contractTypes).toHaveLength(0);

    const board = new BulletinBoard();
    // An absurdly lucrative contract -- if SoloTrader could accept anything, it certainly would here.
    const contract = makeContract({ location: "Testport", commodity: "Gold", deliveryFee: 1_000_000 });
    board.post(contract);

    solo.directFleet(1, new Map(), new Map(), [], new Set(), board);
    expect(contract.fulfiller).toBeNull();
    expect(board.open).toContain(contract);
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
    // `BulletinBoard.prune` unit tests above. Here we only check the invariant
    // that doesn't have that one-day lag: no unclaimed contract is ever seen
    // past its own expiry day (expiry pruning for day N happens before
    // anything on day N can act, so it holds at inspection time too).
    expect(world.contracts.every((c) => c.fulfiller !== null || day <= c.expiryDay)).toBe(true);

    // At least one Location's cash should have moved from the untouched
    // 10-billion default, proving trades are actually tracked against it.
    const defaultCash = 10_000_000_000;
    expect(world.locations.some((l) => l.cash !== defaultCash)).toBe(true);
  }, 20000);
});
