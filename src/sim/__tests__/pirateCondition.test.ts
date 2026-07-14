import { describe, expect, it } from "vitest";
import { Location } from "../location";
import { Company, PirateBrigade, PoliceFleet } from "../faction";
import { Captain } from "../captain";
import { Ship, CONDITION_REPAIR_THRESHOLD } from "../transport";
import { setGeography, getLocation } from "../worldData";
import { setRoutes } from "../routes";
import { setSailorPool } from "../sailorPool";
import { BulletinBoard } from "../contracts";
import { buildWorld } from "../buildWorld";
import { SHIP_CLASSES } from "../transport";

/** Reaches World's private buyPoliceReplacementImmediately -- exercised directly since driving a full day through World.step() to naturally land a specific pirate/police encounter would need much more scripted setup than the behavior itself warrants. */
interface WorldPoliceReplacementAccess {
  buyPoliceReplacementImmediately(policeFleet: PoliceFleet, captain: Captain, day: number): void;
}

/** A Captain at `homeLocationName` (already registered via setGeography) -- gender/birth date are test-irrelevant fixed values. */
function makeCaptain(name: string, homeLocationName: string): Captain {
  return new Captain({
    name, gender: "Male", dateOfBirth: new Date("1980-01-01"), homeLocation: getLocation(homeLocationName)!,
  });
}

function makeDock(): void {
  const dock = new Location({
    name: "Dock", producedCommodities: {}, consumedCommodities: {},
    stockpiles: {}, minStockpiles: {}, basePriceModifiers: {}, fuelPrice: 1.0, terminalTypes: new Set(["Port"]),
  });
  setGeography([dock], { Dock: [0, 0] });
  setRoutes(new Map());
  setSailorPool(new Map());
}

describe("PirateBrigade/PoliceFleet repair gating (mirrors Company)", () => {
  it("PirateBrigade.directFleet issues a REPAIR directive for a docked Ship below CONDITION_REPAIR_THRESHOLD", () => {
    makeDock();
    // A real target Company (with a captain sitting AT "Dock") is needed --
    // directFleet's own target-density scan short-circuits to an empty
    // Directive map before ever reaching the repair check if there's
    // nothing to chase.
    const targetShip = new Ship({ name: "Merchant" });
    const targetCaptain = makeCaptain("Trader", "Dock");
    const company = new Company("Acme", [[targetShip, targetCaptain, "Dock"]], 10_000);

    const transport = new Ship({ name: "Raider", crewRequirement: 1 });
    const captain = makeCaptain("Blackbeard", "Dock");
    const brigade = new PirateBrigade("Brigade", [[transport, captain, "Dock"]], [company]);
    transport.condition = CONDITION_REPAIR_THRESHOLD - 0.01;

    const directives = brigade.directFleet(1, new Map(), new Map(), [], new Set(), new BulletinBoard());
    expect(directives.get(captain)).toEqual({ action: "REPAIR" });
  });

  it("PoliceFleet.directFleet issues a REPAIR directive for a docked Ship below CONDITION_REPAIR_THRESHOLD", () => {
    makeDock();
    const transport = new Ship({ name: "Cutter", crewRequirement: 1 });
    const captain = makeCaptain("Constable", "Dock");
    const police = new PoliceFleet("Coast Guard", [[transport, captain, "Dock"]]);
    transport.condition = CONDITION_REPAIR_THRESHOLD - 0.01;

    const directives = police.directFleet(1, new Map(), new Map(), [], new Set(), new BulletinBoard());
    expect(directives.get(captain)).toEqual({ action: "REPAIR" });
  });
});

// A Company victim pools cash by default, so `victimCaptain.cash` is ALWAYS
// untouched by theft regardless of whether an attack fires ("cash pooled --
// untouchable" -- see Faction.attack) -- not a usable "did the attack
// happen" signal. `pirateCaptain.groundedDaysRemaining` is: set to 1 by
// EVERY successful attack (see maybeAttackOnArrival), 0 otherwise.

describe("A repairing pirate can't attack", () => {
  it("maybeAttackOnArrival does nothing when the only co-located pirate is below the repair threshold", () => {
    makeDock();
    const victimShip = new Ship({ name: "Merchant" });
    const victimCaptain = makeCaptain("Trader", "Dock");
    const company = new Company("Acme", [[victimShip, victimCaptain, "Dock"]], 10_000);

    const pirateShip = new Ship({ name: "Raider" });
    const pirateCaptain = makeCaptain("Blackbeard", "Dock");
    const brigade = new PirateBrigade("Brigade", [[pirateShip, pirateCaptain, "Dock"]], [company]);
    pirateShip.condition = CONDITION_REPAIR_THRESHOLD - 0.01;

    brigade.maybeAttackOnArrival(1, victimCaptain);

    expect(pirateCaptain.groundedDaysRemaining).toBe(0); // never attacked
    expect(pirateCaptain.transport).toBe(pirateShip); // pirate unaffected, still docked
  });
});

describe("A repairing police ship doesn't deter", () => {
  it("a pirate still attacks even with a police Ship AtLocation, if that police Ship is below the repair threshold", () => {
    makeDock();
    const victimShip = new Ship({ name: "Merchant" });
    const victimCaptain = makeCaptain("Trader", "Dock");
    const company = new Company("Acme", [[victimShip, victimCaptain, "Dock"]], 10_000);

    const policeShip = new Ship({ name: "Cutter" });
    const policeCaptain = makeCaptain("Constable", "Dock");
    const police = new PoliceFleet("Coast Guard", [[policeShip, policeCaptain, "Dock"]]);
    policeShip.condition = CONDITION_REPAIR_THRESHOLD - 0.01; // repairing -- shouldn't deter

    const pirateShip = new Ship({ name: "Raider" });
    const pirateCaptain = makeCaptain("Blackbeard", "Dock");
    const brigade = new PirateBrigade("Brigade", [[pirateShip, pirateCaptain, "Dock"]], [company], 0, 1, 0.1, [police]);

    brigade.maybeAttackOnArrival(1, victimCaptain);

    expect(pirateCaptain.groundedDaysRemaining).toBe(1); // the attack went through
  });

  it("a fully-repaired police Ship DOES deter", () => {
    makeDock();
    const victimShip = new Ship({ name: "Merchant" });
    const victimCaptain = makeCaptain("Trader", "Dock");
    const company = new Company("Acme", [[victimShip, victimCaptain, "Dock"]], 10_000);

    const policeShip = new Ship({ name: "Cutter" });
    const policeCaptain = makeCaptain("Constable", "Dock");
    const police = new PoliceFleet("Coast Guard", [[policeShip, policeCaptain, "Dock"]]);
    // policeShip.condition stays at its default 1 -- fully seaworthy, deters normally.

    const pirateShip = new Ship({ name: "Raider" });
    const pirateCaptain = makeCaptain("Blackbeard", "Dock");
    const brigade = new PirateBrigade("Brigade", [[pirateShip, pirateCaptain, "Dock"]], [company], 0, 1, 0.1, [police]);

    brigade.maybeAttackOnArrival(1, victimCaptain);

    expect(pirateCaptain.groundedDaysRemaining).toBe(0); // deterred -- no attack
  });
});

describe("PirateBrigade sinking has no auto-replacement (fleet just shrinks)", () => {
  it("a Pirate Ship sinking (fatal, at sea -- the only way a pirate's OWN Ship can ever sink, since nothing damages a docked pirate) leaves the Captain permanently gone, no replacement bought", () => {
    makeDock();
    const pirateShip = new Ship({ name: "Raider", crewRequirement: 1 });
    const pirateCaptain = makeCaptain("Blackbeard", "Dock");
    const brigade = new PirateBrigade("Brigade", [[pirateShip, pirateCaptain, "Dock"]], []);
    pirateShip.status = "InTransit";

    // Called directly -- a pirate's OWN Ship taking damage while docked is
    // unreachable in practice (attacking never damages the attacker -- see
    // this session's "no self-damage" decision -- and nothing else ever
    // touches a docked pirate's condition), so the only real path to a
    // pirate Ship sinking at all is transit decay, always fatal.
    brigade.sinkAtSea(pirateCaptain, 1);

    expect(pirateCaptain.transport).toBeNull();
    expect(brigade.inactiveCaptains).not.toContain(pirateCaptain); // fatal -- never benched
    expect(brigade.captains).not.toContain(pirateCaptain);
    // No World involved here (this is a pure Faction-level check) -- there's
    // simply no code path that buys PirateBrigade a replacement, unlike
    // PoliceFleet's World.buyPoliceReplacementImmediately.
  });
});

describe("PoliceFleet unconditional immediate auto-replacement", () => {
  it("buys the cheapest Ship, with no crew, at the sinking's own Location, for a benched (survived) Captain", () => {
    const { world } = buildWorld();
    const policeFleet = world.policeFleet!;
    const captain = policeFleet.captains[0];
    const transport = captain.transport as Ship;
    const location = transport.location!;
    const shipsBefore = policeFleet.captains.length;

    // Bench the Captain directly (mirrors what a pirate attack's sinkInPort
    // would do) -- isolates the replacement-purchase behavior itself from
    // the randomness of actually landing a qualifying attack.
    policeFleet.sinkInPort(captain, 1);
    expect(policeFleet.inactiveCaptains).toContain(captain);

    (world as unknown as WorldPoliceReplacementAccess).buyPoliceReplacementImmediately(policeFleet, captain, 1);

    expect(policeFleet.captains).toHaveLength(shipsBefore); // replaced, net count unchanged
    expect(policeFleet.inactiveCaptains).not.toContain(captain); // reactivated, not left benched
    expect(captain.transport).not.toBeNull();
    expect(captain.locationName).toBe(location.name);
    const cheapest = Object.values(SHIP_CLASSES).reduce((a, b) => (a.purchasePrice <= b.purchasePrice ? a : b));
    // Class identity checked via crewRequirement (unique per SHIP_CLASSES entry) -- the Ship's own `name` is drawn from a nationality pool, not the class name.
    expect(captain.transport!.crewRequirement).toBe(cheapest.crewRequirement);
    expect(captain.transport!.crew).toEqual([captain]); // no crew beyond the Captain
  });

  it("buys a replacement even when the Captain died (sunk at sea) -- a fresh Captain is generated", () => {
    const { world } = buildWorld();
    const policeFleet = world.policeFleet!;
    const captain = policeFleet.captains[0];
    const transport = captain.transport as Ship;
    const location = transport.location!;
    const shipsBefore = policeFleet.captains.length;

    transport.status = "InTransit"; // sinkAtSea only applies mid-voyage
    policeFleet.sinkAtSea(captain, 1);
    expect(captain.transport).toBeNull();
    expect(policeFleet.captains).not.toContain(captain);
    expect(policeFleet.inactiveCaptains).not.toContain(captain); // dead, never benched

    (world as unknown as WorldPoliceReplacementAccess).buyPoliceReplacementImmediately(policeFleet, captain, 1);

    expect(policeFleet.captains).toHaveLength(shipsBefore); // replaced, net count unchanged
    const replacement = policeFleet.captains.find((c) => c !== captain && c.locationName === location.name);
    expect(replacement).toBeDefined();
    expect(replacement!.transport!.crew).toEqual([replacement]);
  });
});
