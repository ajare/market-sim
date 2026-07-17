import { describe, expect, it } from "vitest";
import { Location } from "../location";
import { Company, SoloTrader, PirateBrigade, PoliceFleet } from "../faction";
import { Captain } from "../captain";
import { Sailor, PIRACY_INCREASE_PER_DAY, PIRACY_DECAY_PER_DAY } from "../sailor";
import { Ship } from "../transport";
import { setGeography, getLocation } from "../worldData";
import { setRoutes } from "../routes";
import { hireFromSailorPool, setSailorPool, getSailorPoolAt, SAILOR_POOL_SIZE_MULTIPLIER } from "../sailorPool";
import { buildWorld } from "../buildWorld";

/** A Captain at `homeLocationName` (already registered via setGeography) -- gender/birth date are test-irrelevant fixed values. */
function makeCaptain(name: string, homeLocationName: string): Captain {
  return new Captain({
    name, gender: "Male", dateOfBirth: new Date("1980-01-01"), homeLocation: getLocation(homeLocationName)!,
  });
}

function makeSailor(name: string, piracy: number): Sailor {
  const sailor = new Sailor({ name, gender: "Male", dateOfBirth: new Date("1990-01-01") });
  sailor.piracy = piracy;
  return sailor;
}

function makeDock(): void {
  const dock = new Location({
    name: "Dock", producedCommodities: {}, consumedCommodities: {},
    stockpiles: {}, minStockpiles: {}, basePriceModifiers: {}, fuelPrice: 1.0, terminalTypes: new Set(["Port"]),
  });
  setGeography([dock], { Dock: [0, 0] });
  setRoutes(new Map());
}

describe("Sailor.piracy", () => {
  it("initializes to 0 on a fresh Sailor", () => {
    expect(new Sailor({ name: "Fresh", gender: "Male", dateOfBirth: new Date("1990-01-01") }).piracy).toBe(0);
  });
});

describe("FleetOwner.hirePiracyThreshold", () => {
  it("is 0.1 for Company (inherited by SoloTrader), 0 for PoliceFleet, 1 for PirateBrigade", () => {
    makeDock();
    const companyShip = new Ship({ name: "C" });
    const company = new Company("Acme", [[companyShip, makeCaptain("Cap1", "Dock"), "Dock"]], 0);
    expect(company.hirePiracyThreshold).toBe(0.1);

    const soloShip = new Ship({ name: "S" });
    const solo = new SoloTrader("Lone", [[soloShip, makeCaptain("Cap2", "Dock"), "Dock"]], 0);
    expect(solo.hirePiracyThreshold).toBe(0.1);

    const policeShip = new Ship({ name: "P" });
    const police = new PoliceFleet("Coast Guard", [[policeShip, makeCaptain("Cap3", "Dock"), "Dock"]]);
    expect(police.hirePiracyThreshold).toBe(0);

    const pirateShip = new Ship({ name: "R" });
    const brigade = new PirateBrigade("Brigade", [[pirateShip, makeCaptain("Cap4", "Dock"), "Dock"]], []);
    expect(brigade.hirePiracyThreshold).toBe(1);
  });
});

describe("hireFromSailorPool piracy filtering", () => {
  it("only draws candidates at or below maxPiracy, leaving the rest in the pool", () => {
    makeDock();
    const clean = makeSailor("Clean", 0);
    const lightlyTainted = makeSailor("LightlyTainted", 0.1);
    const tooTainted = makeSailor("TooTainted", 0.5);
    const pool = new Map([["Dock", [clean, lightlyTainted, tooTainted]]]);
    setSailorPool(pool);

    // Company-like threshold (0.1): eligible pool is {clean, lightlyTainted} -- draws both, leaves tooTainted behind.
    const hired = hireFromSailorPool("Dock", 5, 0.1);
    expect(hired).toHaveLength(2);
    expect(hired).toContain(clean);
    expect(hired).toContain(lightlyTainted);
    expect(hired).not.toContain(tooTainted);
    expect(getSailorPoolAt("Dock")).toEqual([tooTainted]);
  });

  it("a PirateBrigade-level threshold (1) can hire even a maximally-tainted Sailor", () => {
    makeDock();
    const tainted = makeSailor("Tainted", 1.0);
    setSailorPool(new Map([["Dock", [tainted]]]));
    const hired = hireFromSailorPool("Dock", 1, 1.0);
    expect(hired).toEqual([tainted]);
  });

  it("defaults to hiring anyone when no threshold is passed", () => {
    makeDock();
    const tainted = makeSailor("Tainted", 0.9);
    setSailorPool(new Map([["Dock", [tainted]]]));
    expect(hireFromSailorPool("Dock", 1)).toEqual([tainted]);
  });
});

describe("Company.hireCrewIfPossible / FleetOwner.fillExtraSeats respect the threshold", () => {
  it("a Company docked Ship skips a too-piracy-tainted pool Sailor when hiring", () => {
    makeDock();
    const tainted = makeSailor("Tainted", 0.5);
    const clean = makeSailor("Clean", 0);
    setSailorPool(new Map([["Dock", [tainted, clean]]]));

    const transport = new Ship({ name: "Runner", crewRequirement: 3 });
    const captain = makeCaptain("Cap", "Dock");
    new Company("Acme", [[transport, captain, "Dock"]], 0);
    captain.hireCrewIfPossible();

    expect(transport.crew).toContain(clean);
    expect(transport.crew).not.toContain(tainted);
    expect(getSailorPoolAt("Dock")).toEqual([tainted]);
  });
});

describe("Sailor pool size scaling", () => {
  it("SAILOR_POOL_SIZE_MULTIPLIER is 1.25", () => {
    expect(SAILOR_POOL_SIZE_MULTIPLIER).toBe(1.25);
  });
});

describe("Daily piracy tick (World.runDay)", () => {
  it("raises a pirate crew's piracy and decays everyone else's (docked non-pirate crew and pool Sailors alike), clamped to [0, 1]", () => {
    const { world } = buildWorld();

    const pirateCaptain = world.pirateBrigade!.captains[0];
    const pirateExtra = pirateCaptain.transport!.crew.find((m) => m !== pirateCaptain);

    const merchantCaptain = world.shipCaptains.find(
      (c) => c.transport instanceof Ship && c.company instanceof Company && c.transport.crew.length > 1,
    )!;
    const merchantExtra = merchantCaptain.transport!.crew.find((m) => m !== merchantCaptain)!;
    merchantExtra.piracy = 0.5; // simulate a former pirate who's since been (barely) hired

    const somePoolLocation = world.locations.find((l) => getSailorPoolAt(l.name).length > 0)!;
    const poolSailor = getSailorPoolAt(somePoolLocation.name)[0];
    poolSailor.piracy = 0.01; // near the decay floor, to also exercise the clamp

    world.step();

    expect(pirateCaptain.piracy).toBeCloseTo(PIRACY_INCREASE_PER_DAY, 6);
    if (pirateExtra !== undefined) expect(pirateExtra.piracy).toBeCloseTo(PIRACY_INCREASE_PER_DAY, 6);
    expect(merchantExtra.piracy).toBeCloseTo(0.5 - PIRACY_DECAY_PER_DAY, 6);
    expect(poolSailor.piracy).toBe(0); // clamped -- 0.01 - 0.02 would go negative
  });
});
