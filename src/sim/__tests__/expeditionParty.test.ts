import { describe, expect, it } from "vitest";
import { Location } from "../location";
import { Market, marketKey } from "../markets";
import { PorterParty } from "../transport";
import { Explorer } from "../explorer";
import { ExpeditionParty } from "../faction";
import { Route, addRouteToNetwork, setRoutes } from "../routes";
import { COMMODITIES, setCommodities, setGeography } from "../worldData";
import { Commodity } from "../commodity";
import { GIFT_QUANTITY_OFFERED } from "../decisions";
import { isRepositionDirective } from "../captain";

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

describe("ExpeditionParty.direct", () => {
  /** Home Town with a single direct Trail neighbor, Dest Village -- neither produces/consumes anything, so no trade is ever profitable between them (isolates the random-wander/movement behavior from trading). */
  function makeWanderWorld() {
    const home = makeVillage("Home Town");
    const dest = makeVillage("Dest Village");
    setGeography([home, dest], { "Home Town": [0, 0], "Dest Village": [60, 0] });
    const network = new Map();
    addRouteToNetwork(network, new Route("Home Town", "Dest Village", "Trail"));
    setRoutes(network);
    return { home, dest };
  }

  const noMarkets = new Map<string, Market>();

  it("returns an empty Map when the Explorer is already travelling", () => {
    const { home } = makeWanderWorld();
    const explorer = makeExplorer(home, 1000);
    const party = new ExpeditionParty("AI Party", explorer, { aiControlled: true });

    explorer.destination = "somewhere";
    expect(party.direct(1, noMarkets, noMarkets, [], new Set()).size).toBe(0);
  });

  it("returns an empty Map and never moves once cash has run out", () => {
    const { home } = makeWanderWorld();
    const explorer = makeExplorer(home, 0);
    const party = new ExpeditionParty("AI Party", explorer, { aiControlled: true });

    expect(party.direct(1, noMarkets, noMarkets, [], new Set()).size).toBe(0);
    expect(explorer.locationName).toBe("Home Town"); // never departed
  });

  it("picks its one reachable Trail neighbor and returns a bare REPOSITION Directive when nothing is profitable to carry", () => {
    const { home } = makeWanderWorld();
    const explorer = makeExplorer(home, 1000);
    const party = new ExpeditionParty("AI Party", explorer, { aiControlled: true });

    const directives = party.direct(1, noMarkets, noMarkets, [], new Set());
    const directive = directives.get(explorer);
    expect(directive).not.toBeUndefined();
    if (directive === undefined || !isRepositionDirective(directive)) throw new Error("expected a RepositionDirective");
    expect(directive.destination).toBe("Dest Village");

    explorer.departToward(directive.destination);
    expect(explorer.destination).toBe("Dest Village");
  });

  it("excludes closed Locations from the candidate set", () => {
    const { home } = makeWanderWorld();
    const explorer = makeExplorer(home, 1000);
    const party = new ExpeditionParty("AI Party", explorer, { aiControlled: true });

    expect(party.direct(1, noMarkets, noMarkets, [], new Set(["Dest Village"])).size).toBe(0);
  });

  it("returns an empty Map when this Explorer has no reachable Trail neighbor (a dead end)", () => {
    const home = makeVillage("Isolated Town");
    setGeography([home], { "Isolated Town": [0, 0] });
    const explorer = makeExplorer(home, 1000);
    const party = new ExpeditionParty("AI Party", explorer, { aiControlled: true });

    expect(party.direct(1, noMarkets, noMarkets, [], new Set()).size).toBe(0);
  });

  it("restocks a gift-worthy commodity out of necessity, then still returns a REPOSITION Directive for the random neighbor in the SAME call", () => {
    const home = makeVillage("Home Village", { Beads: 5 }, {});
    const dest = makeVillage("Dest Village");
    setGeography([home, dest], { "Home Village": [0, 0], "Dest Village": [60, 0] });
    const network = new Map();
    addRouteToNetwork(network, new Route("Home Village", "Dest Village", "Trail"));
    setRoutes(network);

    const defaultCommodities = COMMODITIES;
    setCommodities({
      Beads: new Commodity("Beads", 5, undefined, undefined, undefined, [], undefined, undefined, undefined, undefined, 0.8),
    });
    try {
      const buyMarkets = new Map([[marketKey("Home Village", "Beads"), new Market("Beads", "Home Village", home, 5, 5, "buy")]]);
      const explorer = makeExplorer(home, 1000);
      const party = new ExpeditionParty("AI Party", explorer, { aiControlled: true });

      const directives = party.direct(1, buyMarkets, noMarkets, [], new Set());

      // Restocked toward the target -- destination-independent, never a
      // margin/profit calculation (no sell market at all is even supplied).
      expect(explorer.heldQuantity("Beads")).toBe(GIFT_QUANTITY_OFFERED);
      expect(explorer.cash).toBeLessThan(1000);

      // Still picks a destination in the same call -- restocking and route
      // choice are decoupled but both happen this same "morning".
      const directive = directives.get(explorer);
      expect(directive).not.toBeUndefined();
      if (directive === undefined || !isRepositionDirective(directive)) throw new Error("expected a RepositionDirective");
      expect(directive.destination).toBe("Dest Village");
    } finally {
      setCommodities(defaultCommodities);
    }
  });
});

describe("Explorer.executeTradeDirective", () => {
  it("still works standalone -- buys the bundle and departs (not called by ExpeditionParty.direct anymore, see it for why)", () => {
    const home = makeVillage("Home Village", { Gold: 5 }, {});
    const dest = makeVillage("Dest Village", {}, { Gold: 5 });
    setGeography([home, dest], { "Home Village": [0, 0], "Dest Village": [60, 0] });
    const network = new Map();
    addRouteToNetwork(network, new Route("Home Village", "Dest Village", "Trail"));
    setRoutes(network);

    const buyMarkets = new Map([[marketKey("Home Village", "Gold"), new Market("Gold", "Home Village", home, 10, 10, "buy")]]);
    const sellMarkets = new Map([[marketKey("Dest Village", "Gold"), new Market("Gold", "Dest Village", dest, 50, 50, "sell")]]);

    const explorer = makeExplorer(home, 1000);
    const directive = explorer.findBestLocalRoute(buyMarkets, sellMarkets, ["Gold"], new Set());
    expect(directive).not.toBeNull();
    if (directive === null) throw new Error("expected a TradeDirective");
    expect(directive.destination).toBe("Dest Village");
    expect(directive.items[0].commodity).toBe("Gold");

    explorer.executeTradeDirective(directive, 1, buyMarkets, sellMarkets);
    expect(explorer.cargo?.items[0].commodity).toBe("Gold");
    expect(explorer.destination).toBe("Dest Village");
    expect(explorer.cash).toBeLessThan(1000);
  });
});
