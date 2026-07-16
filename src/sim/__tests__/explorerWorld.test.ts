import { describe, expect, it } from "vitest";
import { buildWorld } from "../buildWorld";
import { Location } from "../location";
import { Chieftain } from "../chieftain";
import { PorterParty } from "../transport";
import { Explorer } from "../explorer";
import { Route, ROUTES, setRoutes, addRouteToNetwork } from "../routes";
import { LOCATION_COORDINATES, setGeography } from "../worldData";

/**
 * Builds a full, valid World (buildWorld enforces MIN_LOCATIONS=20, so a
 * hand-rolled 2-location fixture like other unit tests use isn't an option
 * here) with fleet construction minimized (0 ships) since this test only
 * cares about Explorer/PorterParty/pendingDecision behavior, then grafts one
 * Village Location plus a Trail route onto it.
 */
function makeWorldWithVillage() {
  const { world } = buildWorld(3000, { targetShipsPerLocation: 0, numPirateShips: 0, numPoliceShips: 0 });
  const origin = world.locations[0];

  const chieftain = new Chieftain({
    name: "Chief Tomo", gender: "Male", dateOfBirth: new Date("1950-01-01"), passageTaxRate: 0.2, trust: 0.5,
  });
  const village = new Location({
    name: "Explorer Test Village",
    producedCommodities: {},
    consumedCommodities: {},
    stockpiles: {},
    minStockpiles: {},
    basePriceModifiers: {},
    fuelPrice: 0,
    terminalTypes: new Set(["Market"]),
    settlementType: "Village",
    ruler: chieftain,
  });

  const [ox, oy] = LOCATION_COORDINATES[origin.name];
  setGeography([...world.locations, village], { ...LOCATION_COORDINATES, "Explorer Test Village": [ox + 500, oy] });

  const network = new Map(ROUTES);
  const route = new Route(origin.name, "Explorer Test Village", "Trail");
  addRouteToNetwork(network, route);
  setRoutes(network);

  const party = new PorterParty({ name: "Test Party" });
  const explorer = new Explorer({
    name: "Livia Ashworth", gender: "Female", dateOfBirth: new Date("1850-01-01"),
    homeLocation: origin, transport: party, startingCash: 1000,
  });
  world.explorers.push(explorer);

  return { world, explorer, route, village, chieftain };
}

describe("World + Explorer integration", () => {
  it("pauses on arrival at a Village and resumes once the decision is resolved", () => {
    const { world, explorer, route } = makeWorldWithVillage();
    explorer.departFor(route);
    const totalDays = explorer.daysRemaining;

    for (let i = 0; i < totalDays - 1; i++) {
      world.step();
      expect(world.pendingDecision).toBeNull();
    }

    const dayBeforeArrival = world.step(); // the arrival step itself
    expect(world.pendingDecision).not.toBeNull();
    expect(world.pendingDecision?.kind).toBe("PassageTax");
    expect(explorer.locationName).toBe("Explorer Test Village");

    // Further step() calls while paused are a genuine no-op: the day counter
    // doesn't advance, and the background economy doesn't move either.
    const combinedHistoryLengthWhilePaused = world.combinedHistory.length;
    const dayWhilePaused1 = world.step();
    const dayWhilePaused2 = world.step();
    expect(dayWhilePaused1).toBe(dayBeforeArrival);
    expect(dayWhilePaused2).toBe(dayBeforeArrival);
    expect(world.combinedHistory.length).toBe(combinedHistoryLengthWhilePaused);

    // Resolve the decision -- "Pay the demanded amount" -- and confirm the
    // simulation resumes.
    const cashBeforePaying = explorer.cash;
    const payChoice = world.pendingDecision!.choices[0];
    payChoice.resolve({ explorer });
    world.pendingDecision = null;

    expect(explorer.cash).toBeLessThan(cashBeforePaying);
    const dayAfterResolving = world.step();
    expect(dayAfterResolving).toBe(dayBeforeArrival + 1);
    expect(world.combinedHistory.length).toBeGreaterThan(combinedHistoryLengthWhilePaused);
  }, 20000);
});
