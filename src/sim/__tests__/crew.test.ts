import { describe, expect, it } from "vitest";
import { Location } from "../location";
import { Market, marketKey } from "../markets";
import { Company } from "../faction";
import { Captain } from "../captain";
import { Ship, SHIP_CLASSES } from "../transport";
import { Sailor } from "../crew";
import { setGeography, getLocation } from "../worldData";
import { Route, addRouteToNetwork, setRoutes } from "../routes";
import { buildWorld } from "../buildWorld";
import { buildWorldFromJson } from "../buildWorldFromJson";

function makeTradeWorld() {
  const home = new Location({
    // A small stockpile caps quantity well under both cargoCapacity and
    // Speedster's fuelCapacity (60) at this route's distance/fuel rate, so
    // the route stays feasible regardless of which crew scenario is under
    // test. Platform (not Port) so an under-crewed ship departing from here
    // isn't auto-rehired to full complement before it even leaves -- Platform
    // supports Sea routes identically to Port otherwise (see routes.ts).
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

/** A Speedster (crewRequirement 4) crewed by Captain + Sailors, then optionally stripped down to the Captain alone. */
function makeSpeedsterCompany(fullCrew: boolean): { transport: Ship; captain: Captain; company: Company } {
  const transport = SHIP_CLASSES.Speedster.clone({ name: "Runner" });
  const captain = new Captain("Cap", "Home");
  const company = new Company("Acme", [[transport, captain, "Home"]], 1_000_000);
  if (!fullCrew) transport.crew = transport.crew.filter((member) => member === captain);
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
    const dailyWagesSum = transport.crew.reduce((sum, member) => sum + member.dailyWages, 0);
    const goodsCost = cargo.unitCost * cargo.quantity;
    const expectedCrewCost = dailyWagesSum * cargo.travelDays;
    expect(cargo.totalCost).toBeCloseTo(goodsCost + cargo.fuelCostTotal + transport.fixedShipmentCost + expectedCrewCost, 5);

    // No further deduction while InTransit -- the whole trip was already paid for.
    const cashAfterDeparture = captain.cash;
    captain.act(2, buyMarkets, sellMarkets, ["Gold"], new Set());
    expect(captain.cash).toBe(cashAfterDeparture);
  });

  it("won't depart at all if the upfront crew wages (plus goods/fuel) aren't affordable", () => {
    const { buyMarkets, sellMarkets } = makeTradeWorld();
    const transport = SHIP_CLASSES.Speedster.clone({ name: "Runner" });
    const captain = new Captain("Cap", "Home");
    // Barely enough for goods + fuel, nowhere near enough for 4 days of a
    // full 4-person crew's wages on top.
    new Company("Acme", [[transport, captain, "Home"]], 50);

    captain.act(1, buyMarkets, sellMarkets, ["Gold"], new Set());
    expect(captain.cargo).toBeNull();
    expect(captain.status).toBe("AtLocation");
  });
});

describe("hiring crew at a Port (not a Platform)", () => {
  function makeDockedShip(terminal: "Port" | "Platform") {
    const dock = new Location({
      name: "Dock", producedCommodities: {}, consumedCommodities: {},
      stockpiles: {}, minStockpiles: {}, basePriceModifiers: {},
      fuelPrice: 1.0, terminalTypes: new Set([terminal]),
    });
    setGeography([dock], { Dock: [0, 0] });
    setRoutes(new Map());

    const transport = SHIP_CLASSES.Speedster.clone({ name: "Runner" });
    const captain = new Captain("Cap", "Dock");
    new Company("Acme", [[transport, captain, "Dock"]], 100_000);
    transport.crew = transport.crew.filter((member) => member === captain);
    return { transport, captain };
  }

  it("fills every open seat in one day when docked at a Port", () => {
    const { transport, captain } = makeDockedShip("Port");
    captain.act(1, new Map(), new Map(), [], new Set());
    expect(transport.crew.length).toBe(transport.crewRequirement);
    const sailors = transport.crew.filter((member) => member instanceof Sailor);
    expect(sailors).toHaveLength(3);
    // Distinct nicknames within this one ship's crew.
    expect(new Set(sailors.map((s) => s.name)).size).toBe(3);
  });

  it("does not hire at a Platform, even though Platforms support Sea routes identically otherwise", () => {
    const { transport, captain } = makeDockedShip("Platform");
    captain.act(1, new Map(), new Map(), [], new Set());
    expect(transport.crew.length).toBe(1);
  });
});

describe("Sailor naming", () => {
  it("gives a Ship's Sailors nicknames, not the old placeholder name", () => {
    const { transport } = makeSpeedsterCompany(true);
    const sailors = transport.crew.filter((member) => member instanceof Sailor);
    expect(sailors).toHaveLength(3);
    for (const sailor of sailors) {
      expect(sailor.name).not.toMatch(/Sailor \d/);
    }
  });
});

describe("removing a crew member (Transports panel's Kill button)", () => {
  it("removes a Sailor, leaving the seat open until the Ship next docks at a Port", () => {
    const dock = new Location({
      name: "Dock", producedCommodities: {}, consumedCommodities: {},
      stockpiles: {}, minStockpiles: {}, basePriceModifiers: {},
      fuelPrice: 1.0, terminalTypes: new Set(["Port"]),
    });
    setGeography([dock], { Dock: [0, 0] });
    setRoutes(new Map());

    const transport = SHIP_CLASSES.Speedster.clone({ name: "Runner" });
    const captain = new Captain("Cap", "Dock");
    new Company("Acme", [[transport, captain, "Dock"]], 100_000);
    expect(transport.crew.length).toBe(4);

    const sailor = transport.crew.find((member) => member instanceof Sailor)!;
    transport.removeCrewMember(sailor);
    expect(transport.crew.length).toBe(3);
    expect(transport.crew).not.toContain(sailor);

    // Docked at a Port -- act() re-hires the open seat for free.
    captain.act(1, new Map(), new Map(), [], new Set());
    expect(transport.crew.length).toBe(4);
  });

  it("is a no-op for a member that isn't (or is no longer) part of this Transport's crew", () => {
    const transport = SHIP_CLASSES.Speedster.clone({ name: "Runner" });
    const captain = new Captain("Cap", "Nowhere");
    new Company("Acme", [[transport, captain, "Nowhere"]], 0);
    expect(transport.crew.length).toBe(4);

    const strayCaptain = new Captain("Ghost", "Elsewhere");
    expect(() => transport.removeCrewMember(strayCaptain)).not.toThrow();
    expect(transport.crew.length).toBe(4);
  });
});

describe("a Ship arriving under-crewed at a Port always hires before it can leave again", () => {
  it("tops back up to full on the arrival day itself -- not deferred to the following day", () => {
    const { buyMarkets, sellMarkets } = makeTradeWorld();
    const { transport, captain } = makeSpeedsterCompany(true);

    // Depart Home (a Platform -- no hiring there) at full crew.
    captain.act(1, buyMarkets, sellMarkets, ["Gold"], new Set());
    expect(captain.status).toBe("InTransit");
    const travelDays = captain.daysRemaining; // 4, per makeTradeWorld's 3200-unit / 800-speed route

    // A Sailor is lost mid-voyage (e.g. the Transports panel's Kill button) --
    // travel time already locked in at departure isn't affected.
    const sailor = transport.crew.find((member) => member instanceof Sailor)!;
    transport.removeCrewMember(sailor);
    expect(transport.crew.length).toBe(3);

    // Step through the remaining transit days up to and including arrival.
    for (let day = 2; day <= 1 + travelDays; day++) {
      captain.act(day, buyMarkets, sellMarkets, ["Gold"], new Set());
    }
    expect(captain.location).toBe("Dest"); // arrived
    expect(captain.status).toBe("AtLocation");
    // Hiring runs on the arrival day itself (Dest is a Port) -- fully crewed
    // again the same day it docks, before any new departure is even
    // considered (the "no same-day redeparture" rule still applies, but
    // hiring isn't gated behind it).
    expect(transport.crew.length).toBe(transport.crewRequirement);
  });
});

describe("crew refilling in the real default World (not a hand-built fixture)", () => {
  it("eventually re-hires a Ship stripped down to its Captain, running the actual buildWorld() fleet/Company/directFleet machinery", () => {
    const { world } = buildWorld();
    const shipCaptain = world.captains.find((c) => c.transport instanceof Ship && c.transport.crew.length > 1);
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
      visitedLocations.add(shipCaptain!.location);
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
      `never refilled after 100 days; ended at ${shipCaptain.location} (status ${shipCaptain.status}); ` +
        `crew: ${transport.crew.length}/${required}`,
    ).not.toBeNull();
  });
});
