import { describe, expect, it } from "vitest";
import { Location } from "../location";
import { Market, marketKey } from "../markets";
import { Company, PirateBrigade } from "../faction";
import { Captain } from "../captain";
import { Sailor, JOURNEYS_PER_HIRE } from "../sailor";
import { Ship, SHIP_CLASSES } from "../transport";
import { setGeography, getLocation } from "../worldData";
import { Route, addRouteToNetwork, setRoutes } from "../routes";
import { buildWorld } from "../buildWorld";
import { buildWorldFromJson } from "../buildWorldFromJson";
import {
  generateSailorPool, getSailorPoolAt, setSailorPool, SAILOR_POOL_FLOOR, SAILOR_POOL_SIZE_MULTIPLIER,
} from "../sailorPool";

/** The floor/demand formula's raw result is scaled by SAILOR_POOL_SIZE_MULTIPLIER (see generateSailorPool) -- this mirrors that scaling for test expectations. */
function scaledPoolSize(raw: number): number {
  return Math.round(raw * SAILOR_POOL_SIZE_MULTIPLIER);
}

/** A freshly generated pool Sailor, gender/birth date test-irrelevant fixed values. */
function makeSailor(name: string): Sailor {
  return new Sailor({ name, gender: "Male", dateOfBirth: new Date("1990-01-01") });
}

/** Wholesale-replaces the world's Sailor pool with exactly `count` Sailors at `locationName` -- mirrors worldData's setGeography-style "reset everything" test convention. */
function setSailorPoolAt(locationName: string, count: number): void {
  const pool = new Map<string, Sailor[]>();
  pool.set(locationName, Array.from({ length: count }, (_, i) => makeSailor(`${locationName} Pool Sailor ${i}`)));
  setSailorPool(pool);
}

function makeTradeWorld() {
  const home = new Location({
    // A small stockpile caps quantity well under both cargoCapacity and
    // Speedster's fuelCapacity (60) at this route's distance/fuel rate, so
    // the route stays feasible regardless of which crew scenario is under
    // test. Platform (not Port) so a Platform is exercised as a hiring/
    // departure point too (Platform supports Sea routes identically to Port
    // -- see routes.ts -- and, since the Port-only hiring restriction was
    // reversed, hires identically too).
    name: "Home", producedCommodities: { Gold: 5 }, consumedCommodities: {},
    stockpiles: { Gold: 5 }, minStockpiles: {}, basePriceModifiers: { Gold: 1 },
    fuelPrice: 1.0, terminalTypes: new Set(["Platform"]),
  });
  const dest = new Location({
    name: "Dest", producedCommodities: {}, consumedCommodities: { Gold: 5 },
    stockpiles: { Gold: 0 }, minStockpiles: { Gold: 1000 }, basePriceModifiers: { Gold: 1 },
    fuelPrice: 1.0, terminalTypes: new Set(["Port"]),
  });
  // A straight (no control points) Sea route exactly 3200 units long --
  // Speedster's speedUnitsPerDay (800) divides it evenly at full speed (4
  // days) and at half speed (8 days), so the crew-fullness speed test's
  // ratio isn't distorted by routeTravelDays' Math.ceil rounding.
  setGeography([home, dest], { Home: [0, 0], Dest: [3200, 0] });
  const routes = new Map();
  addRouteToNetwork(routes, new Route("Home", "Dest", "Sea"));
  setRoutes(routes);

  const buyMarkets = new Map([[marketKey("Home", "Gold"), new Market("Gold", "Home", home, 1, 1, "buy")]]);
  // A wide margin so the trip clears profitability even under the full
  // 4-Sailor crew's upfront wage cost over 4 (or 8, at half crew) days.
  const sellMarkets = new Map([[marketKey("Dest", "Gold"), new Market("Gold", "Dest", dest, 100, 100, "sell")]]);
  return { home, dest, buyMarkets, sellMarkets };
}

/** A Captain at `homeLocationName` (already registered via setGeography) -- gender/birth date are test-irrelevant fixed values. */
function makeCaptain(name: string, homeLocationName: string): Captain {
  return new Captain({
    name, gender: "Male", dateOfBirth: new Date("1980-01-01"), homeLocation: getLocation(homeLocationName)!,
  });
}

/**
 * A Speedster (crewRequirement 4) crewed by Captain + Sailors, then
 * optionally left stripped down to the Captain alone. Full crewing now goes
 * through the Sailor pool (initial crewing is deferred -- see
 * FleetOwner.crewFleet), so `fullCrew` seeds "Home"'s pool first and calls
 * crewFleet() explicitly, standing in for what World's constructor would
 * otherwise do automatically.
 */
function makeSpeedsterCompany(fullCrew: boolean): { transport: Ship; captain: Captain; company: Company } {
  const transport = SHIP_CLASSES.Speedster.clone({ name: "Runner" });
  const captain = makeCaptain("Cap", "Home");
  // Always reset (not just when fullCrew) -- the pool is keyed by Location
  // NAME, so a prior scenario's leftover "Home" pool would otherwise leak
  // into this one (act()'s own hireCrewIfPossible call would silently top a
  // "stripped" ship back up before it even departs) even though
  // makeTradeWorld() rebuilds "Home" as a brand-new Location object each time.
  setSailorPoolAt("Home", fullCrew ? 10 : 0);
  const company = new Company("Acme", [[transport, captain, "Home"]], 1_000_000);
  if (fullCrew) company.crewFleet();
  return { transport, captain, company };
}

describe("SHIP_CLASSES crew requirements", () => {
  it("assigns each class a fixed crewRequirement, and a generic Ship falls back to Handysize's", () => {
    expect(SHIP_CLASSES.SailingVessel.crewRequirement).toBe(3);
    expect(SHIP_CLASSES.Speedster.crewRequirement).toBe(4);
    expect(SHIP_CLASSES.Handysize.crewRequirement).toBe(6);
    expect(SHIP_CLASSES.Panamax.crewRequirement).toBe(9);
    expect(SHIP_CLASSES.Capesize.crewRequirement).toBe(13);
    expect(new Ship({ name: "Generic" }).crewRequirement).toBe(6);
  });
});

describe("crew fullness scales travel speed", () => {
  it("takes exactly twice as many days at half crew as at full crew", () => {
    // Separate worlds per scenario -- sharing one would let the first
    // captain's purchase deplete Home's tiny Gold stockpile out from under
    // the second.
    const { buyMarkets: buyMarkets1, sellMarkets: sellMarkets1 } = makeTradeWorld();
    const full = makeSpeedsterCompany(true);
    expect(full.transport.crew.length).toBe(4); // Captain + 3 Sailors
    full.captain.act(1, buyMarkets1, sellMarkets1, ["Gold"], new Set());
    expect(full.captain.status).toBe("InTransit");
    expect(full.captain.daysRemaining).toBe(4); // 3200 / 800

    const { buyMarkets: buyMarkets2, sellMarkets: sellMarkets2 } = makeTradeWorld();
    const stripped = makeSpeedsterCompany(false);
    expect(stripped.transport.crew.length).toBe(1); // Captain only
    stripped.captain.act(1, buyMarkets2, sellMarkets2, ["Gold"], new Set());
    expect(stripped.captain.status).toBe("InTransit");
    expect(stripped.captain.daysRemaining).toBe(8); // 3200 / (800 * 0.5)
  });
});

describe("upfront crew wages", () => {
  it("folds the whole trip's crew wages into the upfront departure cost, not a later daily deduction", () => {
    const { buyMarkets, sellMarkets } = makeTradeWorld();
    const { transport, captain } = makeSpeedsterCompany(true);

    captain.act(1, buyMarkets, sellMarkets, ["Gold"], new Set());
    const cargo = captain.cargo!;
    const dailyWagesSum = transport.crew.reduce((sum, member) => sum + member.dailyWage, 0);
    const goodsCost = cargo.items[0].unitCost * cargo.items[0].quantity;
    const expectedCrewCost = dailyWagesSum * cargo.travelDays;
    expect(cargo.totalCost).toBeCloseTo(goodsCost + cargo.fuelCostTotal + transport.fixedShipmentCost + expectedCrewCost, 5);

    // No further deduction while InTransit -- the whole trip was already paid for.
    const cashAfterDeparture = captain.cash;
    captain.act(2, buyMarkets, sellMarkets, ["Gold"], new Set());
    expect(captain.cash).toBe(cashAfterDeparture);
  });

  it("won't depart at all if the upfront crew wages (plus goods/fuel) aren't affordable", () => {
    const { buyMarkets, sellMarkets } = makeTradeWorld();
    // A full crew, not just the Captain -- hiring for an already-docked ship
    // is now a global World.runDay pass (formal day order step 2), not
    // something act() does itself, so seed the pool and hire explicitly to
    // stand in for that pass before exercising the departure decision.
    setSailorPoolAt("Home", 10);
    const transport = SHIP_CLASSES.Speedster.clone({ name: "Runner" });
    const captain = makeCaptain("Cap", "Home");
    // Barely enough for goods + fuel, nowhere near enough for 4 days of a
    // full 4-person crew's wages on top.
    new Company("Acme", [[transport, captain, "Home"]], 50);
    captain.hireCrewIfPossible();
    expect(transport.crew.length).toBe(4);

    captain.act(1, buyMarkets, sellMarkets, ["Gold"], new Set());
    expect(captain.cargo).toBeNull();
    expect(captain.status).toBe("AtLocation");
  });
});

describe("hiring crew at a Port or Platform (pool-based)", () => {
  function makeDockedShip(terminal: "Port" | "Platform", poolSize: number) {
    const dock = new Location({
      name: "Dock", producedCommodities: {}, consumedCommodities: {},
      stockpiles: {}, minStockpiles: {}, basePriceModifiers: {},
      fuelPrice: 1.0, terminalTypes: new Set([terminal]),
    });
    setGeography([dock], { Dock: [0, 0] });
    setRoutes(new Map());
    setSailorPoolAt("Dock", poolSize);

    const transport = SHIP_CLASSES.Speedster.clone({ name: "Runner" });
    const captain = makeCaptain("Cap", "Dock");
    new Company("Acme", [[transport, captain, "Dock"]], 100_000); // crew = [captain] only (initial crewing is deferred)
    return { transport, captain };
  }

  // hireCrewIfPossible is now public and called directly (either by
  // World.runDay's own daily pass, for an already-docked ship, or from
  // act()'s justArrived handling for one that just arrived/rotated crew) --
  // see CLAUDE.md's formal day order. These exercise it directly rather than
  // through act(), since act() no longer hires an already-docked ship itself.
  it("fills every open seat in one day when the pool has enough, at a Port", () => {
    const { transport, captain } = makeDockedShip("Port", 10);
    captain.hireCrewIfPossible();
    expect(transport.crew.length).toBe(transport.crewRequirement);
    const sailors = transport.crew.filter((member) => member.rank === "Able Seaman");
    expect(sailors).toHaveLength(3);
    expect(new Set(sailors.map((s) => s.name)).size).toBe(3);
  });

  it("fills every open seat in one day when the pool has enough, at a Platform too -- the Port-only restriction is gone", () => {
    const { transport, captain } = makeDockedShip("Platform", 10);
    captain.hireCrewIfPossible();
    expect(transport.crew.length).toBe(transport.crewRequirement);
  });

  it("hires only as many as the pool has available, leaving the rest of the seats open rather than generating anyone fresh", () => {
    const { transport, captain } = makeDockedShip("Port", 2);
    captain.hireCrewIfPossible();
    expect(transport.crew.length).toBe(3); // Captain + the 2 pool Sailors available
    expect(getSailorPoolAt("Dock")).toHaveLength(0);
  });

  it("hires nobody when the pool is empty", () => {
    const { transport, captain } = makeDockedShip("Port", 0);
    captain.hireCrewIfPossible();
    expect(transport.crew.length).toBe(1);
  });
});

describe("Sailor pool generation", () => {
  it("generates pool Sailors with a full name, always Male, a null nickname, and a plausible birth date, disembarked at their Location", () => {
    const dock = new Location({
      name: "Dock", producedCommodities: {}, consumedCommodities: {},
      stockpiles: {}, minStockpiles: {}, basePriceModifiers: {},
      fuelPrice: 1.0, terminalTypes: new Set(["Port"]),
    });
    setGeography([dock], { Dock: [0, 0] });
    generateSailorPool([]); // no FleetOwner demand -- every Sea-capable Location still gets the floor
    const sailors = getSailorPoolAt("Dock");
    expect(sailors.length).toBe(scaledPoolSize(SAILOR_POOL_FLOOR));
    for (const sailor of sailors) {
      expect(sailor.name).toMatch(/^\S+ \S+/); // "First Last"
      expect(sailor.gender).toBe("Male");
      expect(sailor.nickname).toBeNull();
      expect(sailor.dateOfBirth).toBeInstanceOf(Date);
      expect(sailor.location?.name).toBe("Dock");
      expect(sailor.transport).toBeNull();
      expect(sailor.journeysRemaining).toBeNull(); // not yet hired by anyone
    }
  });
});

describe("Sailor pool sizing", () => {
  it("sizes a Sea-capable Location's pool at max(floor, 2 x its initial extra-seat demand)", () => {
    const home = new Location({
      name: "Base", producedCommodities: {}, consumedCommodities: {},
      stockpiles: {}, minStockpiles: {}, basePriceModifiers: {}, fuelPrice: 1.0, terminalTypes: new Set(["Port"]),
    });
    setGeography([home], { Base: [0, 0] });

    const transport = SHIP_CLASSES.Speedster.clone({ name: "Runner" }); // crewRequirement 4 -> extraSeats 3
    const captain = makeCaptain("Cap", "Base");
    const company = new Company("Acme", [[transport, captain, "Base"]], 0); // crew = [captain] only (deferred)

    generateSailorPool([company]);
    expect(getSailorPoolAt("Base")).toHaveLength(scaledPoolSize(SAILOR_POOL_FLOOR)); // round(max(10, 2*3) * 1.25) = 13
  });

  it("floors at SAILOR_POOL_FLOOR (before scaling) for a Sea-capable Location with no initial ship demand", () => {
    const empty = new Location({
      name: "Quiet Port", producedCommodities: {}, consumedCommodities: {},
      stockpiles: {}, minStockpiles: {}, basePriceModifiers: {}, fuelPrice: 1.0, terminalTypes: new Set(["Port"]),
    });
    setGeography([empty], { "Quiet Port": [0, 0] });
    generateSailorPool([]);
    expect(getSailorPoolAt("Quiet Port")).toHaveLength(scaledPoolSize(SAILOR_POOL_FLOOR));
  });

  it("scales past the floor once demand crosses it", () => {
    const home = new Location({
      name: "Busy Port", producedCommodities: {}, consumedCommodities: {},
      stockpiles: {}, minStockpiles: {}, basePriceModifiers: {}, fuelPrice: 1.0, terminalTypes: new Set(["Port"]),
    });
    setGeography([home], { "Busy Port": [0, 0] });
    const crew: Array<[Ship, Captain, string]> = [];
    for (let i = 0; i < 3; i++) {
      crew.push([SHIP_CLASSES.Capesize.clone({ name: `Ship ${i}` }), makeCaptain(`Cap ${i}`, "Busy Port"), "Busy Port"]);
    }
    // 3 x Capesize, crewRequirement 13 -> extraSeats 12 each -> 36 total demand.
    const company = new Company("Acme", crew, 0);
    generateSailorPool([company]);
    expect(getSailorPoolAt("Busy Port")).toHaveLength(scaledPoolSize(72)); // 2 * 36, well past the floor
  });
});

describe("Company/SoloTrader crew rotation", () => {
  it("hires with a JOURNEYS_PER_HIRE counter, never sets one on the Captain, and resets it on re-hire after an expiry", () => {
    const { buyMarkets, sellMarkets } = makeTradeWorld();
    setSailorPoolAt("Home", 10);
    const transport = SHIP_CLASSES.Speedster.clone({ name: "Runner" });
    const captain = makeCaptain("Cap", "Home");
    const company = new Company("Acme", [[transport, captain, "Home"]], 1_000_000);
    company.crewFleet();

    expect(company.rotatesCrew).toBe(true);
    const sailors = transport.crew.filter((m) => m.rank === "Able Seaman");
    expect(sailors).toHaveLength(3);
    for (const s of sailors) expect(s.journeysRemaining).toBe(JOURNEYS_PER_HIRE);
    expect(captain.journeysRemaining).toBeNull(); // Captains never rotate

    // Force everyone to expire on the very next arrival.
    for (const s of sailors) s.journeysRemaining = 1;

    captain.act(1, buyMarkets, sellMarkets, ["Gold"], new Set());
    const travelDays = captain.daysRemaining;
    for (let day = 2; day <= 1 + travelDays; day++) {
      captain.act(day, buyMarkets, sellMarkets, ["Gold"], new Set());
    }
    expect(captain.locationName).toBe("Dest");
    // The expired Sailors disembarked into Dest's pool on arrival and were
    // immediately re-hired back onto the same still-open seats (the only
    // Sailors locally available) -- crew count is unchanged, but their
    // rotation clocks reset.
    expect(transport.crew.length).toBe(transport.crewRequirement);
    for (const member of transport.crew.filter((m) => m.rank === "Able Seaman")) {
      expect(member.journeysRemaining).toBe(JOURNEYS_PER_HIRE);
      expect(member.transport).toBe(transport);
    }
  });
});

describe("PirateBrigade/PoliceFleet crew never rotates", () => {
  it("leaves journeysRemaining null on hires for a FleetOwner with rotatesCrew=false", () => {
    const base = new Location({
      name: "Base", producedCommodities: {}, consumedCommodities: {},
      stockpiles: {}, minStockpiles: {}, basePriceModifiers: {}, fuelPrice: 1.0, terminalTypes: new Set(["Port"]),
    });
    setGeography([base], { Base: [0, 0] });
    setSailorPoolAt("Base", 10);

    const ship = new Ship({ name: "Raider", crewRequirement: 4 });
    const captain = makeCaptain("Blackbeard", "Base");
    const brigade = new PirateBrigade("Brigade", [[ship, captain, "Base"]], []);
    brigade.crewFleet();

    expect(brigade.rotatesCrew).toBe(false);
    const sailors = ship.crew.filter((m) => m.rank === "Able Seaman");
    expect(sailors).toHaveLength(3);
    for (const s of sailors) expect(s.journeysRemaining).toBeNull();
  });
});

describe("removing a crew member (Transports panel's Kill button)", () => {
  it("removes a Sailor, leaving the seat open until re-hired from the pool", () => {
    const dock = new Location({
      name: "Dock", producedCommodities: {}, consumedCommodities: {},
      stockpiles: {}, minStockpiles: {}, basePriceModifiers: {},
      fuelPrice: 1.0, terminalTypes: new Set(["Port"]),
    });
    setGeography([dock], { Dock: [0, 0] });
    setRoutes(new Map());
    setSailorPoolAt("Dock", 10);

    const transport = SHIP_CLASSES.Speedster.clone({ name: "Runner" });
    const captain = makeCaptain("Cap", "Dock");
    const company = new Company("Acme", [[transport, captain, "Dock"]], 100_000);
    company.crewFleet();
    expect(transport.crew.length).toBe(4);

    const sailor = transport.crew.find((member) => member.rank === "Able Seaman")!;
    transport.removeCrewMember(sailor);
    expect(transport.crew.length).toBe(3);
    expect(transport.crew).not.toContain(sailor);

    // Docked at a Port with Sailors still in the local pool -- hiring for an
    // already-docked ship is now a global World.runDay pass (formal day
    // order step 2), not something act() does itself, so call it directly to
    // stand in for that pass.
    captain.hireCrewIfPossible();
    expect(transport.crew.length).toBe(4);
  });

  it("is a no-op for a member that isn't (or is no longer) part of this Transport's crew", () => {
    const nowhere = new Location({
      name: "Nowhere", producedCommodities: {}, consumedCommodities: {},
      stockpiles: {}, minStockpiles: {}, basePriceModifiers: {}, fuelPrice: 1.0, terminalTypes: new Set(["Port"]),
    });
    const elsewhere = new Location({
      name: "Elsewhere", producedCommodities: {}, consumedCommodities: {},
      stockpiles: {}, minStockpiles: {}, basePriceModifiers: {}, fuelPrice: 1.0, terminalTypes: new Set(["Port"]),
    });
    setGeography([nowhere, elsewhere], { Nowhere: [0, 0], Elsewhere: [1, 1] });
    setSailorPoolAt("Nowhere", 10);

    const transport = SHIP_CLASSES.Speedster.clone({ name: "Runner" });
    const captain = makeCaptain("Cap", "Nowhere");
    const company = new Company("Acme", [[transport, captain, "Nowhere"]], 0);
    company.crewFleet();
    expect(transport.crew.length).toBe(4);

    const strayCaptain = makeCaptain("Ghost", "Elsewhere");
    expect(() => transport.removeCrewMember(strayCaptain)).not.toThrow();
    expect(transport.crew.length).toBe(4);
  });
});

describe("a Ship arriving under-crewed at a Port always hires before it can leave again", () => {
  it("tops back up (as much as the destination's pool allows) on the arrival day itself -- not deferred to the following day", () => {
    const { buyMarkets, sellMarkets } = makeTradeWorld();
    setSailorPoolAt("Home", 10);
    const transport = SHIP_CLASSES.Speedster.clone({ name: "Runner" });
    const captain = makeCaptain("Cap", "Home");
    const company = new Company("Acme", [[transport, captain, "Home"]], 1_000_000);
    company.crewFleet();

    // Depart Home at full crew.
    captain.act(1, buyMarkets, sellMarkets, ["Gold"], new Set());
    expect(captain.status).toBe("InTransit");
    const travelDays = captain.daysRemaining; // 4, per makeTradeWorld's 3200-unit / 800-speed route

    // A Sailor is lost mid-voyage (e.g. the Transports panel's Kill button) --
    // travel time already locked in at departure isn't affected.
    const sailor = transport.crew.find((member) => member.rank === "Able Seaman")!;
    transport.removeCrewMember(sailor);
    expect(transport.crew.length).toBe(3);

    // Dest's own pool, available once the ship actually arrives there --
    // Home's pool is irrelevant from this point on.
    setSailorPoolAt("Dest", 10);

    // Step through the remaining transit days up to and including arrival.
    for (let day = 2; day <= 1 + travelDays; day++) {
      captain.act(day, buyMarkets, sellMarkets, ["Gold"], new Set());
    }
    expect(captain.locationName).toBe("Dest"); // arrived
    expect(captain.status).toBe("AtLocation");
    // Hiring runs on the arrival day itself (Dest is a Port with Sailors
    // available) -- fully crewed again the same day it docks, before any new
    // departure is even considered (the "no same-day redeparture" rule still
    // applies, but hiring isn't gated behind it).
    expect(transport.crew.length).toBe(transport.crewRequirement);
  });
});

describe("crew refilling in the real default World (not a hand-built fixture)", () => {
  it("eventually re-hires a Ship stripped down to its Captain, running the actual buildWorld() fleet/Company/direct machinery", () => {
    const { world } = buildWorld();
    const shipCaptain = world.shipCaptains.find((c) => c.transport instanceof Ship && c.transport.crew.length > 1);
    expect(shipCaptain).toBeDefined();
    const transport = shipCaptain!.transport as Ship;
    const required = transport.crewRequirement;
    expect(required).toBeGreaterThan(1);

    transport.crew = transport.crew.filter((member) => member === shipCaptain);
    expect(transport.crew.length).toBe(1);

    let refilledOnDay: number | null = null;
    const visitedLocations = new Set<string>();
    for (let day = 1; day <= 365 && refilledOnDay === null; day++) {
      world.step();
      visitedLocations.add(shipCaptain!.locationName);
      if (transport.crew.length === required) refilledOnDay = day;
    }

    const portsVisited = [...visitedLocations].filter((name) => getLocation(name)?.terminalTypes.has("Port"));
    expect(
      refilledOnDay,
      `never refilled over a full year; visited ${visitedLocations.size} locations ` +
        `(${portsVisited.length} of them Ports: ${portsVisited.join(", ") || "none"})`,
    ).not.toBeNull();
  });
});

describe("crew refilling in an editor-authored (buildWorldFromJson) World", () => {
  it("refills an authored Company ship stripped of its crew, once it's back at a Port", () => {
    // A 20-location world (buildWorldFromJson's MIN_LOCATIONS floor) -- two
    // real trading posts (Home a Platform, Dest a Port) connected by a Sea
    // route, plus filler locations with no routes at all (only there to
    // satisfy the floor; fleet synthesis may add ships to them too, but
    // that's irrelevant to this test).
    const locations: unknown[] = [
      {
        id: "loc-home", name: "Home", x: 0, y: 0, politicalEntityId: "pe-1",
        producedCommodities: { Ore: 1 }, consumedCommodities: {},
        stockpiles: { Ore: 10 }, minStockpiles: {}, basePriceModifiers: { Ore: 1 },
        fuelPrice: 1.0, terminalTypes: ["Platform"],
      },
      {
        // A big price differential from Home (modifier 10x) so the trip is
        // unmistakably profitable -- otherwise the ships correctly (and
        // silently) refuse to ever depart at all, which isn't what this test
        // is trying to isolate.
        id: "loc-dest", name: "Dest", x: 200, y: 0, politicalEntityId: "pe-1",
        producedCommodities: {}, consumedCommodities: { Ore: 1 },
        stockpiles: { Ore: 0 }, minStockpiles: { Ore: 1000 }, basePriceModifiers: { Ore: 10 },
        fuelPrice: 1.0, terminalTypes: ["Port"],
      },
    ];
    for (let i = 0; i < 18; i++) {
      locations.push({
        id: `loc-filler-${i}`, name: `Filler ${i}`, x: 100 + i * 200, y: 500,
        politicalEntityId: "pe-1", producedCommodities: {}, consumedCommodities: {},
        stockpiles: {}, minStockpiles: {}, basePriceModifiers: {}, fuelPrice: 1.0, terminalTypes: ["Port"],
      });
    }

    const json = JSON.stringify({
      // worldScale must be in the same ballpark as the raw coordinates above
      // (buildWorldFromJson rescales every Transport's speed by
      // worldScale/COORDINATE_SPREAD -- a mismatched worldScale silently
      // makes the fleet crawl at a tiny fraction of its nominal speed).
      version: 7, worldScale: 200,
      politicalEntities: [{ id: "pe-1", name: "Realm", type: "Country" }],
      commodities: [{ name: "Ore", basePrice: 20, productionRate: 8, consumptionRate: 8 }],
      locations,
      companies: [
        {
          id: "co-1", name: "Acme", startingFunds: 1_000_000,
          fleet: [
            { id: "f1", transportType: "Ship", transportName: "Runner", captainName: "Cap One" },
            { id: "f2", transportType: "Ship", transportName: "Runner Two", captainName: "Cap Two" },
          ],
          homeLocationId: "loc-home",
        },
      ],
      routes: [{ id: "r1", locationAId: "loc-home", locationBId: "loc-dest", routeType: "Sea", controlPoints: [] }],
    });

    // Disable fleet synthesis (targetShipsPerLocation: 0) -- otherwise
    // buildWorldFromJson bulks Acme up with ~98 more synthesized ships (Home
    // supports Ship hosting), all competing for the same tiny Home->Dest Ore
    // stockpile and drowning out the two ships this test actually cares about.
    const { world, factions } = buildWorldFromJson(json, { targetShipsPerLocation: 0 });
    const company = factions.find((f) => f.name === "Acme")!;
    const shipCaptain = company.captains.find((c) => c.transport instanceof Ship && c.transport.name === "Runner")!;
    const transport = shipCaptain.transport as Ship;
    const required = transport.crewRequirement;
    expect(required).toBeGreaterThan(1); // a plain editor-authored Ship defaults to 6 (Handysize)

    transport.crew = transport.crew.filter((member) => member === shipCaptain);
    expect(transport.crew.length).toBe(1);

    let refilledOnDay: number | null = null;
    for (let day = 1; day <= 100 && refilledOnDay === null; day++) {
      world.step();
      if (transport.crew.length === required) refilledOnDay = day;
    }
    expect(
      refilledOnDay,
      `never refilled after 100 days; ended at ${shipCaptain.locationName} (status ${shipCaptain.status}); ` +
        `crew: ${transport.crew.length}/${required}`,
    ).not.toBeNull();
  });
});
