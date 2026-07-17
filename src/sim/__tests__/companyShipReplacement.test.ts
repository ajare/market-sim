import { describe, expect, it } from "vitest";
import { buildWorld } from "../buildWorld";
import { Company, SoloTrader } from "../faction";
import { Captain } from "../captain";
import { Ship, SHIP_CLASSES } from "../transport";

/** Reaches World's private buyCompanyReplacementIfPossible -- exercised directly since driving a full day through World.step() to naturally land a specific sinking would need much more scripted setup than the behavior itself warrants (mirrors the WorldSoloTraderReplacementAccess/WorldPoliceReplacementAccess pattern already used elsewhere). */
interface WorldCompanyReplacementAccess {
  buyCompanyReplacementIfPossible(company: Company, captain: Captain, day: number): void;
}

/** A Captain crewing a plain (non-SoloTrader) multi-ship Company's Ship -- optionally filtered to a specific cargoCapacity, to pin down exactly which SHIP_CLASSES entry is "the same kind" for a test. */
function findCompanyCaptain(
  world: ReturnType<typeof buildWorld>["world"], cargoCapacity?: number,
): Captain {
  return world.shipCaptains.find(
    (c): c is Captain =>
      c.company instanceof Company && !(c.company instanceof SoloTrader) &&
      c.transport instanceof Ship &&
      (cargoCapacity === undefined || c.transport.cargoCapacity === cargoCapacity),
  )!;
}

describe("Company auto ship replacement", () => {
  it("buys the same class at the sinking Location, reusing the benched Captain, when the Ship survives sinking in port", () => {
    const { world } = buildWorld();
    const captain = findCompanyCaptain(world);
    const company = captain.company as Company;
    const transport = captain.transport as Ship;
    const location = transport.location!;
    const shipsBefore = company.captains.length;

    company.sinkInPort(captain, 1);
    expect(company.inactiveCaptains).toContain(captain);
    expect(captain.lastTransport).toBe(transport);

    (world as unknown as WorldCompanyReplacementAccess).buyCompanyReplacementIfPossible(company, captain, 1);

    expect(company.captains).toHaveLength(shipsBefore); // replaced, net count unchanged
    expect(company.inactiveCaptains).not.toContain(captain); // reactivated, not left benched
    expect(captain.transport).not.toBeNull();
    expect(captain.locationName).toBe(location.name); // bought right where it sank
    expect(captain.transport!.cargoCapacity).toBe(transport.cargoCapacity); // same kind
    expect(captain.transport!.crew).toContain(captain);
    expect(captain.transport!.crew.length).toBeGreaterThan(1); // crewed normally, unlike SoloTrader/PoliceFleet's noCrew replacement
  });

  it("buys at the Company's home port with a freshly generated Captain when the Ship sinks at sea (fatal)", () => {
    const { world } = buildWorld();
    const captain = findCompanyCaptain(world);
    const company = captain.company as Company;
    const transport = captain.transport as Ship;
    const homeLocation = company.homeLocation!;
    transport.status = "InTransit"; // sinkAtSea only applies mid-voyage
    const shipsBefore = company.captains.length;
    const captainsBefore = new Set(company.captains);

    company.sinkAtSea(captain, 1);
    expect(captain.transport).toBeNull();
    expect(company.captains).not.toContain(captain);
    expect(company.inactiveCaptains).not.toContain(captain); // fatal -- never benched

    (world as unknown as WorldCompanyReplacementAccess).buyCompanyReplacementIfPossible(company, captain, 1);

    expect(company.captains).toHaveLength(shipsBefore); // replaced, net count unchanged
    const replacement = company.captains.find((c) => !captainsBefore.has(c));
    expect(replacement).toBeDefined();
    expect(replacement!.locationName).toBe(homeLocation);
    expect(replacement!.transport!.cargoCapacity).toBe(transport.cargoCapacity); // same kind
    expect(replacement!.transport!.crew.length).toBeGreaterThan(1); // crewed normally
  });

  it("falls back to a cheaper class if it can't afford the same kind", () => {
    const { world } = buildWorld();
    const capesize = SHIP_CLASSES.Capesize;
    const captain = findCompanyCaptain(world, capesize.cargoCapacity);
    const company = captain.company as Company;
    const transport = captain.transport as Ship;
    const location = transport.location!;

    company.sinkInPort(captain, 1);
    // Enough for Panamax (10,000) but not Capesize (17,500).
    company.cash = SHIP_CLASSES.Panamax.purchasePrice;

    (world as unknown as WorldCompanyReplacementAccess).buyCompanyReplacementIfPossible(company, captain, 1);

    expect(captain.transport).not.toBeNull();
    expect(captain.locationName).toBe(location.name);
    expect(captain.transport!.cargoCapacity).toBe(SHIP_CLASSES.Panamax.cargoCapacity);
    expect(company.cash).toBe(0);
  });

  it("buys nothing if it can't afford even the cheapest class -- the fleet just shrinks", () => {
    const { world } = buildWorld();
    const captain = findCompanyCaptain(world);
    const company = captain.company as Company;
    const shipsBefore = company.captains.length;

    company.sinkInPort(captain, 1);
    company.cash = 0;

    (world as unknown as WorldCompanyReplacementAccess).buyCompanyReplacementIfPossible(company, captain, 1);

    expect(company.captains).toHaveLength(shipsBefore - 1); // no replacement bought
    expect(company.inactiveCaptains).toContain(captain); // still benched
    expect(captain.transport).toBeNull();
    expect(company.cash).toBe(0);
  });
});
