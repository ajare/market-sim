import { describe, expect, it } from "vitest";
import { Location } from "../location";
import { Market, marketKey } from "../markets";
import {
  allocateBundleForDestination, sellCargoShared, buySingleCommodity, sellSingleCommodity,
} from "../tradingAgent";
import type { CargoState } from "../transport";

function makeLocation(name: string, produced: Record<string, number>, consumed: Record<string, number>): Location {
  return new Location({
    name, producedCommodities: produced, consumedCommodities: consumed,
    stockpiles: Object.fromEntries([...Object.keys(produced).map((c) => [c, 1000]), ...Object.keys(consumed).map((c) => [c, 0])]),
    minStockpiles: Object.fromEntries(Object.keys(consumed).map((c) => [c, 1000])),
    basePriceModifiers: Object.fromEntries([...Object.keys(produced), ...Object.keys(consumed)].map((c) => [c, 1])),
    fuelPrice: 0, terminalTypes: new Set(["Market"]),
  });
}

describe("allocateBundleForDestination", () => {
  it("ranks candidates by per-unit margin and fills capacity/cash margin-first", () => {
    const home = makeLocation("Home", { Gold: 5, Silver: 5 }, {});
    const dest = makeLocation("Dest", {}, { Gold: 5, Silver: 5 });
    const buyMarkets = new Map([
      [marketKey("Home", "Gold"), new Market("Gold", "Home", home, 10, 10, "buy")],
      [marketKey("Home", "Silver"), new Market("Silver", "Home", home, 20, 20, "buy")],
    ]);
    const sellMarkets = new Map([
      [marketKey("Dest", "Gold"), new Market("Gold", "Dest", dest, 50, 50, "sell")], // margin 40
      [marketKey("Dest", "Silver"), new Market("Silver", "Dest", dest, 80, 80, "sell")], // margin 60 -- higher
    ]);

    const items = allocateBundleForDestination(
      "Home", "Dest", ["Gold", "Silver"], buyMarkets, sellMarkets, 1_000_000, 200, new Set(),
    );

    // Silver (higher margin) is allocated first and fills the whole 200-unit
    // capacity, leaving nothing for Gold.
    expect(items).toEqual([{ commodity: "Silver", quantity: 200, buyPrice: 20, sellPriceEstimate: 80 }]);
  });

  it("splits capacity across multiple commodities once the top one runs out of stock", () => {
    const home = makeLocation("Home", { Gold: 5, Silver: 5 }, {});
    home.stockpiles.Silver = 50; // caps Silver's contribution well under capacity
    const dest = makeLocation("Dest", {}, { Gold: 5, Silver: 5 });
    const buyMarkets = new Map([
      [marketKey("Home", "Gold"), new Market("Gold", "Home", home, 10, 10, "buy")],
      [marketKey("Home", "Silver"), new Market("Silver", "Home", home, 20, 20, "buy")],
    ]);
    const sellMarkets = new Map([
      [marketKey("Dest", "Gold"), new Market("Gold", "Dest", dest, 50, 50, "sell")],
      [marketKey("Dest", "Silver"), new Market("Silver", "Dest", dest, 80, 80, "sell")],
    ]);

    const items = allocateBundleForDestination(
      "Home", "Dest", ["Gold", "Silver"], buyMarkets, sellMarkets, 1_000_000, 200, new Set(),
    );

    expect(items).toHaveLength(2);
    expect(items[0]).toEqual({ commodity: "Silver", quantity: 50, buyPrice: 20, sellPriceEstimate: 80 });
    expect(items[1].commodity).toBe("Gold");
    expect(items[1].quantity).toBeCloseTo(150, 5);
  });

  it("excludes a commodity with no margin, and one blocked via excludeRoutes", () => {
    const home = makeLocation("Home", { Gold: 5, Junk: 5 }, {});
    const dest = makeLocation("Dest", {}, { Gold: 5, Junk: 5 });
    const buyMarkets = new Map([
      [marketKey("Home", "Gold"), new Market("Gold", "Home", home, 10, 10, "buy")],
      [marketKey("Home", "Junk"), new Market("Junk", "Home", home, 10, 10, "buy")],
    ]);
    const sellMarkets = new Map([
      [marketKey("Dest", "Gold"), new Market("Gold", "Dest", dest, 50, 50, "sell")],
      [marketKey("Dest", "Junk"), new Market("Junk", "Dest", dest, 5, 5, "sell")], // negative margin
    ]);

    const items = allocateBundleForDestination("Home", "Dest", ["Gold", "Junk"], buyMarkets, sellMarkets, 1000, 200, new Set());
    expect(items).toEqual([{ commodity: "Gold", quantity: 100, buyPrice: 10, sellPriceEstimate: 50 }]);

    const excluded = allocateBundleForDestination(
      "Home", "Dest", ["Gold", "Junk"], buyMarkets, sellMarkets, 1000, 200, new Set(["Gold||Dest"]),
    );
    expect(excluded).toEqual([]);
  });
});

describe("sellCargoShared", () => {
  it("sells every open-market item with an available market and apportions overhead by quantity share", () => {
    const dest = makeLocation("Dest", {}, { Gold: 5, Silver: 5 });
    const sellMarkets = new Map([
      [marketKey("Dest", "Gold"), new Market("Gold", "Dest", dest, 50, 50, "sell")],
      [marketKey("Dest", "Silver"), new Market("Silver", "Dest", dest, 80, 80, "sell")],
    ]);
    const cargo: CargoState = {
      items: [
        { commodity: "Gold", quantity: 10, unitCost: 10, contract: null },
        { commodity: "Silver", quantity: 20, unitCost: 20, contract: null },
      ],
      origin: "Home", destination: "Dest", distance: 100, routeType: "Sea", travelDays: 1,
      fuelPricePaid: 1, fuelUnitsConsumed: 10, fuelCostTotal: 10, totalCost: 10 * 10 + 20 * 20 + 30, departureDay: 1,
      // goodsCost = 100 + 400 = 500; totalCost = 530 -> overhead = 30, split 1/3 Gold (10 qty) : 2/3 Silver (20 qty)
    };

    const result = sellCargoShared("Dest", cargo, sellMarkets, 0);

    expect(result.remainingItems).toEqual([]);
    expect(result.proceeds).toBeCloseTo(10 * 50 + 20 * 80, 5);
    // Gold: proceeds 500, cost 100, overhead share (10/30)*30=10 -> profit 390
    // Silver: proceeds 1600, cost 400, overhead share (20/30)*30=20 -> profit 1180
    expect(result.entries.find((e) => e.commodity === "Gold")?.profit).toBeCloseTo(390, 5);
    expect(result.entries.find((e) => e.commodity === "Silver")?.profit).toBeCloseTo(1180, 5);
    expect(result.realizedProfitDelta).toBeCloseTo(390 + 1180, 5);
  });

  it("leaves an item with a closed/unavailable market aboard instead of blocking the rest of the hold", () => {
    const dest = makeLocation("Dest", {}, { Gold: 5 }); // no Silver sell market at all
    const sellMarkets = new Map([[marketKey("Dest", "Gold"), new Market("Gold", "Dest", dest, 50, 50, "sell")]]);
    const cargo: CargoState = {
      items: [
        { commodity: "Gold", quantity: 10, unitCost: 10, contract: null },
        { commodity: "Silver", quantity: 5, unitCost: 20, contract: null },
      ],
      origin: "Home", destination: "Dest", distance: 100, routeType: "Sea", travelDays: 1,
      fuelPricePaid: 0, fuelUnitsConsumed: 0, fuelCostTotal: 0, totalCost: 200, departureDay: 1,
    };

    const result = sellCargoShared("Dest", cargo, sellMarkets, 0);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].commodity).toBe("Gold");
    expect(result.remainingItems).toEqual([{ commodity: "Silver", quantity: 5, unitCost: 20, contract: null }]);
  });

  it("leaves a contract-bound item untouched in remainingItems regardless of market availability", () => {
    const dest = makeLocation("Dest", {}, { Gold: 5 });
    const sellMarkets = new Map([[marketKey("Dest", "Gold"), new Market("Gold", "Dest", dest, 50, 50, "sell")]]);
    const contract = { location: "Dest", commodity: "Gold", type: "Commodity" as const, quantity: 10, deliveryFee: 5, fulfiller: null, inFlightCaptain: null, fulfilled: false, cancelled: false, beginDay: 1, expiryDay: 10 };
    const cargo: CargoState = {
      items: [{ commodity: "Gold", quantity: 10, unitCost: 10, contract }],
      origin: "Home", destination: "Dest", distance: 0, routeType: "none", travelDays: 0,
      fuelPricePaid: 0, fuelUnitsConsumed: 0, fuelCostTotal: 0, totalCost: 0, departureDay: 1,
    };
    const result = sellCargoShared("Dest", cargo, sellMarkets, 0);
    expect(result.entries).toEqual([]);
    expect(result.remainingItems).toEqual(cargo.items);
  });
});

describe("buySingleCommodity/sellSingleCommodity", () => {
  it("clamps to cash, available quantity, and remaining capacity, and applies price impact", () => {
    const home = makeLocation("Home", { Gold: 5 }, {});
    const market = new Market("Gold", "Home", home, 10, 10, "buy");
    const priceBefore = market.price;

    const { quantity, cost } = buySingleCommodity(1000, market, 25, Infinity, 0.01);
    expect(quantity).toBeCloseTo(2.5, 5); // cash-limited: 25 / 10
    expect(cost).toBeCloseTo(25, 5);
    expect(market.price).toBeGreaterThan(priceBefore); // buying pushes price up

    const capped = buySingleCommodity(1000, market, 1_000_000, 3, 0.01);
    expect(capped.quantity).toBe(3); // capacity-limited
  });

  it("sell caps at what's held and applies price impact downward", () => {
    const dest = makeLocation("Dest", {}, { Gold: 5 });
    const market = new Market("Gold", "Dest", dest, 50, 50, "sell");
    const priceBefore = market.price;

    const { quantity, proceeds } = sellSingleCommodity(100, 10, market, 0.01);
    expect(quantity).toBe(10);
    expect(proceeds).toBeCloseTo(10 * priceBefore, 5);
    expect(market.price).toBeLessThan(priceBefore);
  });
});
