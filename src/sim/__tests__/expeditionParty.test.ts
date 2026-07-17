import { describe, expect, it } from "vitest";
import { Location } from "../location";
import { Market, marketKey } from "../markets";
import { PorterParty } from "../transport";
import { Explorer } from "../explorer";
import { ExpeditionParty } from "../faction";
import { Route, addRouteToNetwork, setRoutes } from "../routes";
import { setGeography } from "../worldData";

function makeVillage(name: string, produced: Record<string, number> = {}, consumed: Record<string, number> = {}): Location {
  return new Location({
    name,
    producedCommodities: produced,
    consumedCommodities: consumed,
    stockpiles: Object.fromEntries([...Object.keys(produced).map((c) => [c, 1000]), ...Object.keys(consumed).map((c) => [c, 0])]),
    minStockpiles: Object.fromEntries(Object.keys(consumed).map((c) => [c, 1000])),
    basePriceModifiers: Object.fromEntries([...Object.keys(produced), ...Object.keys(consumed)].map((c) => [c, 1])),
    fuelPrice: 0,
    terminalTypes: new Set(["Market"]),
  });
}

function makeExplorer(location: Location, startingCash = 1000): Explorer {
  const party = new PorterParty({ name: "Test Party", porterCount: 2, animalCount: 0 });
  return new Explorer({
    name: "Livia Ashworth", gender: "Female", dateOfBirth: new Date("1850-01-01"),
    homeLocation: location, transport: party, startingCash,
  });
}

describe("ExpeditionParty", () => {
  it("manages exactly the one Explorer it's given, PorterParty and all", () => {
    const home = makeVillage("Home Town");
    setGeography([home], { "Home Town": [0, 0] });
    const explorer = makeExplorer(home);

    const party = new ExpeditionParty("Livia's Expedition", explorer);

    expect(party.captains).toEqual([explorer]);
    expect(party.explorer).toBe(explorer);
    expect(party.explorer.transport).toBeInstanceOf(PorterParty);
    expect(party.name).toBe("Livia's Expedition");
  });

  it("does not pool cash, matching SoloTrader", () => {
    const home = makeVillage("Home Town");
    setGeography([home], { "Home Town": [0, 0] });
    const explorer = makeExplorer(home);

    const party = new ExpeditionParty("Livia's Expedition", explorer);

    expect(party.poolsCash).toBe(false);
  });

  it("leaves the Explorer's own cash/placement untouched -- a pure wrapper, not a re-placement", () => {
    const home = makeVillage("Home Town");
    setGeography([home], { "Home Town": [0, 0] });
    const explorer = makeExplorer(home, 1234);
    const locationBefore = explorer.locationName;
    const cashBefore = explorer.cash;

    new ExpeditionParty("Livia's Expedition", explorer);

    expect(explorer.cash).toBe(cashBefore);
    expect(explorer.locationName).toBe(locationBefore);
  });

  it("sets the Explorer's company back-reference, so Explorer.aiControlled reads it", () => {
    const home = makeVillage("Home Town");
    setGeography([home], { "Home Town": [0, 0] });
    const explorer = makeExplorer(home);
    expect(explorer.aiControlled).toBe(false); // not yet wrapped

    const party = new ExpeditionParty("Livia's Expedition", explorer, { aiControlled: true });
    expect(explorer.company).toBe(party);
    expect(explorer.aiControlled).toBe(true);
  });
});

describe("ExpeditionParty.directFleet", () => {
  function makeTradeWorld() {
    const home = makeVillage("Home Village", { Gold: 5 }, {});
    const dest = makeVillage("Dest Village", {}, { Gold: 5 });
    setGeography([home, dest], { "Home Village": [0, 0], "Dest Village": [60, 0] });
    const network = new Map();
    addRouteToNetwork(network, new Route("Home Village", "Dest Village", "Trail"));
    setRoutes(network);

    const buyMarkets = new Map([[marketKey("Home Village", "Gold"), new Market("Gold", "Home Village", home, 10, 10, "buy")]]);
    const sellMarkets = new Map([[marketKey("Dest Village", "Gold"), new Market("Gold", "Dest Village", dest, 50, 50, "sell")]]);
    return { home, dest, buyMarkets, sellMarkets };
  }

  it("returns null when the Explorer is already travelling or hasn't sold its cargo yet", () => {
    const { home, buyMarkets, sellMarkets } = makeTradeWorld();
    const explorer = makeExplorer(home, 1000);
    const party = new ExpeditionParty("AI Party", explorer, { aiControlled: true });

    explorer.destination = "somewhere";
    expect(party.directFleet(1, buyMarkets, sellMarkets, ["Gold"], new Set())).toBeNull();
    explorer.destination = null;

    explorer.cargo = {
      items: [{ commodity: "Gold", quantity: 1, unitCost: 10, contract: null }],
      origin: "Home Village", destination: "Dest Village", distance: 0, routeType: "none",
      travelDays: 0, fuelPricePaid: 0, fuelUnitsConsumed: 0, fuelCostTotal: 0, totalCost: 10, departureDay: 1,
    };
    expect(party.directFleet(1, buyMarkets, sellMarkets, ["Gold"], new Set())).toBeNull();
  });

  it("picks a profitable Trail route and executeTradeDirective buys the bundle and departs", () => {
    const { home, buyMarkets, sellMarkets } = makeTradeWorld();
    const explorer = makeExplorer(home, 1000);
    const party = new ExpeditionParty("AI Party", explorer, { aiControlled: true });

    const directive = party.directFleet(1, buyMarkets, sellMarkets, ["Gold"], new Set());
    expect(directive).not.toBeNull();
    expect(directive!.destination).toBe("Dest Village");
    expect(directive!.items[0].commodity).toBe("Gold");

    explorer.executeTradeDirective(directive!, 1, buyMarkets, sellMarkets);
    expect(explorer.cargo?.items[0].commodity).toBe("Gold");
    expect(explorer.destination).toBe("Dest Village");
    expect(explorer.cash).toBeLessThan(1000);
  });
});
