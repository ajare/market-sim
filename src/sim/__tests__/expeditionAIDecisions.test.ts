import { describe, expect, it } from "vitest";
import { Location } from "../location";
import { Chieftain } from "../chieftain";
import { PorterParty } from "../transport";
import { Explorer } from "../explorer";
import { ExpeditionParty } from "../faction";
import { Route } from "../routes";
import { setGeography } from "../worldData";
import type { World } from "../world";

/** A minimal stand-in for World -- Explorer.tick/arrive only ever reads/writes `pendingDecision` (and, for an aiControlled party with cargo, `sellMarkets` -- unused in these tests, nothing here ever buys anything). */
function fakeWorld(): World {
  return { pendingDecision: null } as unknown as World;
}

function makeVillage(name: string, ruler: Chieftain | null = null): Location {
  return new Location({
    name, producedCommodities: {}, consumedCommodities: {}, stockpiles: {}, minStockpiles: {}, basePriceModifiers: {},
    fuelPrice: 0, terminalTypes: new Set(["Market"]), settlementType: "Native village", ruler,
  });
}

function makeExplorerAt(location: Location, startingCash = 1000): Explorer {
  const party = new PorterParty({ name: `${location.name} Party` });
  return new Explorer({
    name: `Explorer at ${location.name}`, gender: "Female", dateOfBirth: new Date("1850-01-01"),
    homeLocation: location, transport: party, startingCash,
  });
}

describe("AI-controlled vs player-controlled decision handling on arrival", () => {
  it("an aiControlled party auto-resolves passage tax and never touches world.pendingDecision", () => {
    const origin = makeVillage("Origin A");
    const chieftain = new Chieftain({
      name: "Chief A", gender: "Male", dateOfBirth: new Date("1950-01-01"), passageTaxRate: 0.1, trust: 0.5,
    });
    const dest = makeVillage("Dest A", chieftain);
    setGeography([origin, dest], { "Origin A": [0, 0], "Dest A": [60, 0] });

    const explorer = makeExplorerAt(origin, 1000);
    new ExpeditionParty("AI Party", explorer, { aiControlled: true });
    const world = fakeWorld();

    const route = new Route("Origin A", "Dest A", "Trail");
    explorer.departFor(route);
    const totalDays = explorer.daysRemaining;
    for (let i = 0; i < totalDays; i++) explorer.tick(1, world);

    expect(explorer.locationName).toBe("Dest A");
    expect(explorer.destination).toBeNull();
    // Auto-resolved (the demand was paid -- Pay is eligible and first in the
    // authored order) -- cash changed, but the World-facing pause never fired.
    expect(explorer.cash).toBeLessThan(1000);
    expect(world.pendingDecision).toBeNull();
  });

  it("a player-controlled party still pauses via world.pendingDecision, unchanged from before Round B", () => {
    const origin = makeVillage("Origin B");
    const chieftain = new Chieftain({
      name: "Chief B", gender: "Male", dateOfBirth: new Date("1950-01-01"), passageTaxRate: 0.1, trust: 0.5,
    });
    const dest = makeVillage("Dest B", chieftain);
    setGeography([origin, dest], { "Origin B": [0, 0], "Dest B": [60, 0] });

    const explorer = makeExplorerAt(origin, 1000);
    new ExpeditionParty("Player Party", explorer); // aiControlled defaults to false
    const world = fakeWorld();

    const route = new Route("Origin B", "Dest B", "Trail");
    explorer.departFor(route);
    const totalDays = explorer.daysRemaining;
    for (let i = 0; i < totalDays; i++) explorer.tick(1, world);

    expect(explorer.cash).toBe(1000); // nothing auto-resolved -- still waiting on the player
    expect(world.pendingDecision).not.toBeNull();
    expect(world.pendingDecision?.kind).toBe("PassageTax");
    expect(world.pendingDecision?.explorer).toBe(explorer);
  });

  it("two aiControlled parties arriving the same day both resolve independently -- the actual multi-explorer collision this fixes", () => {
    const originX = makeVillage("Origin X");
    const chieftainX = new Chieftain({
      name: "Chief X", gender: "Male", dateOfBirth: new Date("1950-01-01"), passageTaxRate: 0.1, trust: 0.5,
    });
    const destX = makeVillage("Dest X", chieftainX);

    const originY = makeVillage("Origin Y");
    const chieftainY = new Chieftain({
      name: "Chief Y", gender: "Male", dateOfBirth: new Date("1950-01-01"), passageTaxRate: 0.2, trust: 0.5,
    });
    const destY = makeVillage("Dest Y", chieftainY);

    setGeography(
      [originX, destX, originY, destY],
      { "Origin X": [0, 0], "Dest X": [60, 0], "Origin Y": [0, 200], "Dest Y": [60, 200] },
    );

    const explorerX = makeExplorerAt(originX, 1000);
    new ExpeditionParty("Party X", explorerX, { aiControlled: true });
    const explorerY = makeExplorerAt(originY, 1000);
    new ExpeditionParty("Party Y", explorerY, { aiControlled: true });

    const world = fakeWorld();
    const routeX = new Route("Origin X", "Dest X", "Trail");
    const routeY = new Route("Origin Y", "Dest Y", "Trail");
    explorerX.departFor(routeX);
    explorerY.departFor(routeY);
    // Both routes are the same distance/speed, so both arrive the same day --
    // before the fix, whichever set world.pendingDecision first would have
    // silently blocked the other's passage-tax decision forever (arrive()
    // never re-fires). Neither one ever touches it now.
    const totalDays = explorerX.daysRemaining;
    expect(explorerY.daysRemaining).toBe(totalDays);
    for (let i = 0; i < totalDays; i++) {
      explorerX.tick(1, world);
      explorerY.tick(1, world);
    }

    expect(explorerX.locationName).toBe("Dest X");
    expect(explorerY.locationName).toBe("Dest Y");
    expect(explorerX.cash).toBeLessThan(1000);
    expect(explorerY.cash).toBeLessThan(1000);
    expect(world.pendingDecision).toBeNull();
  });
});
