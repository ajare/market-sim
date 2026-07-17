import { describe, expect, it, vi } from "vitest";
import { buildWorld } from "../buildWorld";
import { Company, SoloTrader, PirateBrigade, PoliceFleet } from "../faction";
import { Captain } from "../captain";
import { Sailor, SHORE_LEAVE_PROBABILITY } from "../sailor";
import { Ship, CONDITION_REPAIR_THRESHOLD } from "../transport";

/** A SoloTrader Captain with zero cash: findBestLocalRoute/considerRepositioning/executeLocalRoute all require cash>0, so this Captain can never trade or reposition and stays docked indefinitely -- a stable "eligible every night" fixture for the statistical Shore Leave test below, with no interference from real trading. */
function pinDocked(): { world: ReturnType<typeof buildWorld>["world"]; captain: Captain } {
  const { world } = buildWorld();
  const captain = world.shipCaptains.find(
    (c): c is Captain =>
      c.company instanceof SoloTrader && c.transport instanceof Ship &&
      c.status === "AtLocation" && c.transport.crew.length > 1,
  )!;
  captain.ownCash = 0;
  return { world, captain };
}

describe("Shore Leave", () => {
  it("grants leave to a docked crew roughly SHORE_LEAVE_PROBABILITY of the time, calling shoreLeave() on every crew member except the Captain", () => {
    const { world, captain } = pinDocked();
    const crewSpy = vi.spyOn(Sailor.prototype, "shoreLeave");
    const nonCaptainCrew = captain.transport!.crew.filter((m) => m !== captain);
    expect(nonCaptainCrew.length).toBeGreaterThan(0);

    const trials = 150;
    let grantedNights = 0;
    for (let i = 0; i < trials; i++) {
      crewSpy.mockClear();
      expect(captain.status).toBe("AtLocation"); // never trades/repositions -- ownCash pinned to 0
      world.step();
      const grantedThisNight = crewSpy.mock.instances.includes(nonCaptainCrew[0]);
      if (grantedThisNight) {
        grantedNights += 1;
        // Whole crew goes together -- a single per-ship coin flip, not a per-Sailor roll.
        for (const member of nonCaptainCrew) expect(crewSpy.mock.instances).toContain(member);
      } else {
        for (const member of nonCaptainCrew) expect(crewSpy.mock.instances).not.toContain(member);
      }
      // The Captain itself is never granted leave, whatever tonight's roll was.
      expect(crewSpy.mock.instances).not.toContain(captain);
    }

    const fraction = grantedNights / trials;
    expect(fraction).toBeGreaterThan(SHORE_LEAVE_PROBABILITY - 0.15);
    expect(fraction).toBeLessThan(SHORE_LEAVE_PROBABILITY + 0.15);
    crewSpy.mockRestore();
  }, 30000);

  it("never grants leave to a Ship that is repairing tonight (condition below CONDITION_REPAIR_THRESHOLD), regardless of the roll", () => {
    const { world } = buildWorld();
    const repairingCaptain = world.shipCaptains.find(
      (c): c is Captain => c.company instanceof Company && c.transport instanceof Ship &&
        c.status === "AtLocation" && c.transport.crew.length > 1,
    )!;
    (repairingCaptain.transport as Ship).condition = CONDITION_REPAIR_THRESHOLD - 0.01;
    const crewSpy = vi.spyOn(Sailor.prototype, "shoreLeave");
    const nonCaptainCrew = repairingCaptain.transport!.crew.filter((m) => m !== repairingCaptain);
    expect(nonCaptainCrew.length).toBeGreaterThan(0);

    world.step();

    expect((repairingCaptain.transport as Ship).condition).toBe(1); // confirms it really did spend today repairing
    for (const member of nonCaptainCrew) expect(crewSpy.mock.instances).not.toContain(member);
    crewSpy.mockRestore();
  });

  it("never grants leave to a PoliceFleet Ship's crew, since PoliceFleet.grantsShoreLeave is false", () => {
    const { world } = buildWorld();
    const policeFleet = world.policeFleet!;
    const policeCaptain = policeFleet.captains.find((c) => c.status === "AtLocation" && c.transport!.crew.length > 1)!;
    const nonCaptainCrew = policeCaptain.transport!.crew.filter((m) => m !== policeCaptain);
    expect(nonCaptainCrew.length).toBeGreaterThan(0);
    const crewSpy = vi.spyOn(Sailor.prototype, "shoreLeave");

    world.step();

    for (const member of nonCaptainCrew) expect(crewSpy.mock.instances).not.toContain(member);
    crewSpy.mockRestore();
  });

  it("never calls shoreLeave for a Ship that is genuinely InTransit tonight", () => {
    const { world } = buildWorld();
    let transitCaptain: Captain | undefined;
    for (let day = 0; day < 10 && transitCaptain === undefined; day++) {
      world.step();
      transitCaptain = world.shipCaptains.find(
        (c): c is Captain => c.status === "InTransit" && c.transport!.crew.length > 1,
      );
    }
    expect(transitCaptain).toBeDefined();
    const nonCaptainCrew = transitCaptain!.transport!.crew.filter((m) => m !== transitCaptain);
    const crewSpy = vi.spyOn(Sailor.prototype, "shoreLeave");

    world.step();

    for (const member of nonCaptainCrew) expect(crewSpy.mock.instances).not.toContain(member);
    crewSpy.mockRestore();
  });

  it("PirateBrigade docked crews are eligible for Shore Leave (FleetOwner.grantsShoreLeave defaults true, only PoliceFleet overrides it)", () => {
    const { world } = buildWorld(undefined, { numPirateShips: 5 });
    expect(world.pirateBrigade).not.toBeNull();
    expect(world.pirateBrigade!.grantsShoreLeave).toBe(true);
    expect((world.policeFleet as PoliceFleet).grantsShoreLeave).toBe(false);
    expect(new PirateBrigade("x", [], []).grantsShoreLeave).toBe(true);
  });
});
