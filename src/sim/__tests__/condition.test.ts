import { describe, expect, it } from "vitest";
import { Location } from "../location";
import { Company, SoloTrader, PirateBrigade, PoliceFleet } from "../faction";
import { Captain } from "../captain";
import { Ship, CONDITION_DECAY_PER_TRANSIT_DAY, CONDITION_REPAIR_THRESHOLD } from "../transport";
import { setGeography, getLocation } from "../worldData";
import { Route, addRouteToNetwork, setRoutes } from "../routes";
import { buildWorld } from "../buildWorld";
import type { Contract } from "../contracts";
import { setSailorPool, getSailorPoolAt } from "../sailorPool";

/** Reaches World's private buySoloTraderReplacementIfPossible -- exercised directly since driving a full day through World.step() to naturally trigger a specific pirate/victim encounter would need a much larger fixture. */
interface WorldSoloTraderReplacementAccess {
  buySoloTraderReplacementIfPossible(soloTrader: SoloTrader, captain: Captain, day: number): void;
}

/** A Captain at `homeLocationName` (already registered via setGeography) -- gender/birth date are test-irrelevant fixed values. */
function makeCaptain(name: string, homeLocationName: string): Captain {
  return new Captain({
    name, gender: "Male", dateOfBirth: new Date("1980-01-01"), homeLocation: getLocation(homeLocationName)!,
  });
}

/** A two-Port world (Home/Dest) with a long Sea route, so a departing Ship stays InTransit for several days. */
function makeTwoPortWorld(): { home: Location; dest: Location } {
  const home = new Location({
    name: "Home", producedCommodities: {}, consumedCommodities: {},
    stockpiles: {}, minStockpiles: {}, basePriceModifiers: {}, fuelPrice: 1.0, terminalTypes: new Set(["Port"]),
  });
  const dest = new Location({
    name: "Dest", producedCommodities: {}, consumedCommodities: {},
    stockpiles: {}, minStockpiles: {}, basePriceModifiers: {}, fuelPrice: 1.0, terminalTypes: new Set(["Port"]),
  });
  setGeography([home, dest], { Home: [0, 0], Dest: [4000, 0] });
  const routes = new Map();
  addRouteToNetwork(routes, new Route("Home", "Dest", "Sea"));
  setRoutes(routes);
  setSailorPool(new Map());
  return { home, dest };
}

describe("Transport.condition", () => {
  it("initializes to 1 on a fresh Transport", () => {
    expect(new Ship({ name: "Fresh" }).condition).toBe(1);
  });

  it("decays by CONDITION_DECAY_PER_TRANSIT_DAY for every day a Company Ship is genuinely InTransit", () => {
    makeTwoPortWorld();
    const transport = new Ship({ name: "Runner", speedUnitsPerDay: 500, crewRequirement: 1 });
    const captain = makeCaptain("Cap", "Home");
    new Company("Acme", [[transport, captain, "Home"]], 1_000_000);

    transport.status = "InTransit";
    transport.currentFuel = 100;
    captain.destination = "Dest";
    captain.daysRemaining = 5;

    captain.act(1, new Map(), new Map(), [], new Set());
    expect(transport.condition).toBeCloseTo(1 - CONDITION_DECAY_PER_TRANSIT_DAY, 6);
    captain.act(2, new Map(), new Map(), [], new Set());
    expect(transport.condition).toBeCloseTo(1 - 2 * CONDITION_DECAY_PER_TRANSIT_DAY, 6);
  });

  it("decays a PirateBrigade Ship exactly like a Company one -- PirateBrigade.decaysCondition is true", () => {
    makeTwoPortWorld();
    const transport = new Ship({ name: "Raider" });
    const captain = makeCaptain("Blackbeard", "Home");
    new PirateBrigade("Brigade", [[transport, captain, "Home"]], []);

    transport.status = "InTransit";
    transport.currentFuel = 100;
    captain.destination = "Dest";
    captain.daysRemaining = 50;

    for (let day = 1; day <= 5; day++) {
      captain.act(day, new Map(), new Map(), [], new Set());
    }
    expect(transport.condition).toBeCloseTo(1 - 5 * CONDITION_DECAY_PER_TRANSIT_DAY, 6);
  });

  it("decays a PoliceFleet Ship exactly like a Company one -- PoliceFleet.decaysCondition is true", () => {
    makeTwoPortWorld();
    const transport = new Ship({ name: "Cutter" });
    const captain = makeCaptain("Constable", "Home");
    new PoliceFleet("Coast Guard", [[transport, captain, "Home"]]);

    transport.status = "InTransit";
    transport.currentFuel = 100;
    captain.destination = "Dest";
    captain.daysRemaining = 50;

    for (let day = 1; day <= 5; day++) {
      captain.act(day, new Map(), new Map(), [], new Set());
    }
    expect(transport.condition).toBeCloseTo(1 - 5 * CONDITION_DECAY_PER_TRANSIT_DAY, 6);
  });
});

describe("Ship sinking at sea (fatal)", () => {
  it("kills the crew and Captain, loses cash/cargo, cancels the in-flight contract, and removes the Ship -- when condition is exhausted by unrepaired transit decay", () => {
    makeTwoPortWorld();
    const transport = new Ship({ name: "Runner", speedUnitsPerDay: 500, crewRequirement: 1 });
    const captain = makeCaptain("Doomed", "Home");
    // SoloTrader (non-pooling) -- captain.cash is where its own money lives,
    // so the "cash lost" assertion below is actually meaningful (a pooling
    // Company's shared purse is untouched by a single Ship's loss by design
    // -- see the "in port" describe block below for that case).
    const solo = new SoloTrader("Lone Co", [[transport, captain, "Home"]], 0);
    captain.ownCash = 500;

    const contract: Contract = {
      location: "Dest", commodity: "Gold", type: "Commodity", quantity: 10, deliveryFee: 100,
      fulfiller: null, inFlightCaptain: captain, fulfilled: false, cancelled: false, beginDay: 1, expiryDay: 10,
    };
    captain.cargo = {
      commodity: "Gold", quantity: 10, unitCost: 1, origin: "Home", destination: "Dest",
      distance: 4000, routeType: "Sea", travelDays: 8, fuelPricePaid: 1, fuelUnitsConsumed: 10,
      fuelCostTotal: 10, totalCost: 20, departureDay: 1, contract,
    };

    transport.status = "InTransit";
    transport.currentFuel = 100;
    transport.condition = 0.01; // one decay tick (0.02) will push this below 0
    captain.destination = "Dest";
    captain.daysRemaining = 5;

    expect(solo.captains).toContain(captain);
    captain.act(1, new Map(), new Map(), [], new Set());

    expect(captain.transport).toBeNull();
    expect(solo.captains).not.toContain(captain);
    expect(solo.inactiveCaptains).not.toContain(captain); // fatal -- never benched
    expect(captain.cargo).toBeNull();
    expect(captain.cash).toBe(0);
    expect(contract.cancelled).toBe(true);
    expect(contract.inFlightCaptain).toBeNull();
  });
});

describe("Ship sinking in port (survivable)", () => {
  function makeDockedVictim(): { transport: Ship; captain: Captain; company: Company } {
    const transport = new Ship({ name: "Runner", crewRequirement: 2 });
    const captain = makeCaptain("Survivor", "Home");
    const company = new Company("Acme", [[transport, captain, "Home"]], 1_000_000);
    captain.ownCash = 500;
    return { transport, captain, company };
  }

  it("benches the surviving Captain (disembarked, no Transport) into Company.inactiveCaptains, returns crew to the Location pool, and never touches the Company's pooled cash", () => {
    const { home } = makeTwoPortWorld();
    const { transport, captain, company } = makeDockedVictim();
    const sailor = makeCaptain("Mate", "Home"); // stand-in Sailor-like crew member
    transport.crew.push(sailor);
    transport.condition = 0; // guarantees a sink regardless of the attack's random damage roll
    const cashBefore = company.cash;

    const pirateShip = new Ship({ name: "Raider" });
    const pirateCaptain = makeCaptain("Blackbeard", "Home");
    const brigade = new PirateBrigade("Brigade", [[pirateShip, pirateCaptain, "Home"]], [company]);

    brigade.maybeAttackOnArrival(1, captain);

    expect(captain.transport).toBeNull();
    expect(captain.location).toBe(home);
    expect(company.captains).not.toContain(captain);
    expect(company.inactiveCaptains).toContain(captain);
    // "Cash on board is lost" only has a literal meaning for a non-pooling
    // Captain -- a pooling Company's shared purse isn't "on" any one Ship
    // (see Company.loseCargoAndCash), so it's untouched by this Ship's loss.
    expect(company.cash).toBe(cashBefore);
    expect(getSailorPoolAt("Home")).toContain(sailor);
  });

  it("zeroes a non-pooling (SoloTrader) survivor's own cash -- 'no cash survives a sinking' applies literally there", () => {
    makeTwoPortWorld();
    const transport = new Ship({ name: "LoneStar", crewRequirement: 1 });
    const captain = makeCaptain("Lone", "Home");
    const solo = new SoloTrader("Solo Co", [[transport, captain, "Home"]], 0);
    captain.ownCash = 500;
    transport.condition = 0;

    const pirateShip = new Ship({ name: "Raider" });
    const pirateCaptain = makeCaptain("Blackbeard", "Home");
    const brigade = new PirateBrigade("Brigade", [[pirateShip, pirateCaptain, "Home"]], [solo]);

    brigade.maybeAttackOnArrival(1, captain);

    expect(captain.transport).toBeNull();
    expect(solo.inactiveCaptains).toContain(captain);
    expect(captain.cash).toBe(0);
  });
});

describe("Repair", () => {
  it("Company.directFleet issues a REPAIR directive (preempting trade) for a docked Ship below CONDITION_REPAIR_THRESHOLD, and it can't depart until repaired", () => {
    const { world } = buildWorld();
    const shipCaptain = world.captains.find((c) => c.transport instanceof Ship && c.company instanceof Company)!;
    const transport = shipCaptain.transport as Ship;
    transport.condition = CONDITION_REPAIR_THRESHOLD - 0.01;

    world.step();

    expect(transport.condition).toBe(1); // repaired, same day
    expect(shipCaptain.status).toBe("AtLocation"); // did not depart today
  });
});

describe("SoloTrader dissolution on an unaffordable sinking", () => {
  it("removes the SoloTrader from world.factions and zeroes the surviving Captain's cash when even the cheapest replacement Ship is unaffordable", () => {
    // buildWorld() already satisfies World's own 20-location minimum and
    // procedurally includes real SoloTraders/a real PirateBrigade -- reused
    // here rather than hand-building a tiny World (which the constructor
    // would reject outright) just to reach this scenario.
    const { world } = buildWorld();
    const solo = world.factions.find((f): f is SoloTrader => f instanceof SoloTrader)!;
    const captain = solo.captains[0];
    const transport = captain.transport as Ship;
    captain.ownCash = 1; // nowhere near the cheapest SHIP_CLASSES price
    transport.condition = 0; // guarantees a sink regardless of the attack's random damage roll

    const brigade = world.pirateBrigade!;
    // Neutral -- buildWorld()'s real PoliceFleet might otherwise coincidentally
    // already have a Ship docked at this SoloTrader's Location, which would
    // block the attack entirely (see PirateBrigade.policePresentAt); not what
    // this test is about.
    brigade.policeFleets = [];
    const pirateCaptain = brigade.captains[0];
    pirateCaptain.transport!.arriveAt(transport.location!); // co-locate a pirate with the victim

    brigade.maybeAttackOnArrival(1, captain);
    expect(captain.transport).toBeNull();
    expect(solo.inactiveCaptains).toContain(captain);

    // Mirrors World.runDay's own post-act() dispatch for a benched
    // SoloTrader Captain -- exercised directly here since driving a full
    // day through World.step() to naturally land this exact encounter would
    // need much more scripted setup than the behavior itself warrants.
    (world as unknown as WorldSoloTraderReplacementAccess).buySoloTraderReplacementIfPossible(solo, captain, 1);

    expect(world.factions).not.toContain(solo);
    expect(solo.inactiveCaptains).toHaveLength(0);
    expect(captain.cash).toBe(0);
  });
});
