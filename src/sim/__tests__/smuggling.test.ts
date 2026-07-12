import { describe, expect, it } from "vitest";
import { Location } from "../location";
import { Market, marketKey } from "../markets";
import { Company, SoloTrader } from "../faction";
import { Captain, type CargoState } from "../captain";
import { SHIP_CLASSES } from "../transport";
import { seedSimRandom } from "../simRandom";

function makeClosedPortScenario(FactionCls: typeof Company | typeof SoloTrader) {
  const location = new Location({
    name: "Blockaded Port",
    producedCommodities: {},
    consumedCommodities: { Wheat: 5 },
    stockpiles: { Wheat: 0 }, // deficit -- canSell/isAvailable is true
    minStockpiles: { Wheat: 100 },
    basePriceModifiers: { Wheat: 1 },
    fuelPrice: 1.0,
    terminalTypes: new Set(["Port"]),
  });
  const market = new Market("Wheat", "Blockaded Port", location, 20, 10, "sell");
  const sellMarkets = new Map([[marketKey("Blockaded Port", "Wheat"), market]]);

  const transport = SHIP_CLASSES.Speedster.clone({ name: "Runner", crewRequirement: 1 });
  const captain = new Captain("Cap", "Blockaded Port");
  const faction = new FactionCls("Acme", [[transport, captain, "Blockaded Port"]], 100_000);
  captain.location = "Blockaded Port";
  captain.status = "AtLocation";

  const cargo: CargoState = {
    commodity: "Wheat",
    quantity: 50,
    unitCost: 8,
    origin: "Elsewhere",
    destination: "Blockaded Port",
    distance: 100,
    routeType: "Sea",
    travelDays: 2,
    fuelPricePaid: 1,
    fuelUnitsConsumed: 5,
    fuelCostTotal: 5,
    totalCost: 405, // 50 * 8 + 5 fuel
    departureDay: 1,
    contract: null,
  };
  captain.cargo = cargo;

  const closedLocations = new Set(["Blockaded Port"]);
  return { location, market, sellMarkets, faction, captain, closedLocations, cargo };
}

describe("Faction.canSmuggle", () => {
  it("is false by default and for a plain Company, true only for SoloTrader", () => {
    const transport = SHIP_CLASSES.Speedster.clone({ name: "T1", crewRequirement: 1 });
    const captain1 = new Captain("Cap1", "Home");
    const company = new Company("Acme", [[transport, captain1, "Home"]], 0);
    expect(company.canSmuggle).toBe(false);

    const transport2 = SHIP_CLASSES.Speedster.clone({ name: "T2", crewRequirement: 1 });
    const captain2 = new Captain("Cap2", "Home");
    const solo = new SoloTrader("Loner", [[transport2, captain2, "Home"]], 0);
    expect(solo.canSmuggle).toBe(true);
  });
});

describe("SoloTrader smuggling at a closed port", () => {
  it("never smuggles for a plain Company -- cargo just waits", () => {
    const { market, sellMarkets, captain, closedLocations, cargo } = makeClosedPortScenario(Company);
    const cashBefore = captain.cash;
    const stockBefore = market.location.stockpiles.Wheat;

    captain.act(1, new Map(), sellMarkets, [], closedLocations);

    expect(captain.cargo).toBe(cargo); // untouched, still waiting
    expect(captain.cash).toBe(cashBefore);
    expect(market.location.stockpiles.Wheat).toBe(stockBefore);
    expect(captain.tradeLog.some((e) => e.action === "SMUGGLE")).toBe(false);
  });

  it("either sells at a discount (bypassing the port's own cash ledger) or gets caught and fined, across a sweep of seeds", () => {
    let sawSuccess = false;
    let sawCaught = false;

    for (let seed = 1; seed <= 60 && !(sawSuccess && sawCaught); seed++) {
      const { market, sellMarkets, captain, closedLocations, cargo } = makeClosedPortScenario(SoloTrader);
      const locationCashBefore = market.location.cash;
      const stockBefore = market.location.stockpiles.Wheat ?? 0;
      const cashBefore = captain.cash;

      seedSimRandom(seed);
      captain.act(1, new Map(), sellMarkets, [], closedLocations);

      expect(captain.cargo).toBeNull(); // resolved one way or the other, no deadlock
      const entry = captain.tradeLog.find((e) => e.action === "SMUGGLE");
      expect(entry).toBeDefined();

      // The port's own books never move either way -- that's the whole point.
      expect(market.location.cash).toBe(locationCashBefore);

      if (entry!.price !== null) {
        sawSuccess = true;
        expect(captain.cash).toBeGreaterThan(cashBefore); // sold at a discount, still positive proceeds
        expect(market.location.stockpiles.Wheat).toBe(stockBefore + cargo.quantity); // goods physically arrived
        expect(entry!.price).toBeCloseTo(market.price * 0.7);
      } else {
        sawCaught = true;
        expect(captain.cash).toBeLessThan(cashBefore); // fined, no proceeds
        expect(market.location.stockpiles.Wheat).toBe(stockBefore); // seized -- never delivered
        expect(entry!.profit).toBeLessThan(0);
      }
    }

    expect(sawSuccess).toBe(true);
    expect(sawCaught).toBe(true);
  });
});
