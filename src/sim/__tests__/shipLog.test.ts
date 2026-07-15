import { describe, expect, it } from "vitest";
import { Location } from "../location";
import { Company } from "../faction";
import { Captain, setShipLogEnabled } from "../captain";
import { Ship } from "../transport";
import { setGeography, getLocation } from "../worldData";
import { Route, addRouteToNetwork, setRoutes } from "../routes";
import { setSailorPool } from "../sailorPool";
import { buildWorld } from "../buildWorld";

// Ship's Log is off by default app-wide (see captain.ts's isShipLogEnabled) --
// this whole file is specifically about that feature's content, so it's
// switched on for every test here. Module state is isolated per test file,
// so this doesn't leak into other suites.
setShipLogEnabled(true);

/** A Captain at `homeLocationName` (already registered via setGeography) -- gender/birth date are test-irrelevant fixed values. */
function makeCaptain(name: string, homeLocationName: string): Captain {
  return new Captain({
    name, gender: "Male", dateOfBirth: new Date("1980-01-01"), homeLocation: getLocation(homeLocationName)!,
  });
}

/** A two-Port world (Home/Dest) with a long Sea route -- no commodities at all, so a Captain here never finds a profitable trade and just sits, ideal for isolating the "nothing happened" filler text. */
function makeTwoPortWorld(): { home: Location; dest: Location } {
  const home = new Location({
    name: "Home", producedCommodities: {}, consumedCommodities: {},
    stockpiles: {}, minStockpiles: {}, basePriceModifiers: {}, fuelPrice: 1.0, terminalTypes: new Set(["Port"]),
  });
  const dest = new Location({
    name: "Dest", producedCommodities: {}, consumedCommodities: {},
    stockpiles: {}, minStockpiles: {}, basePriceModifiers: {}, fuelPrice: 1.0, terminalTypes: new Set(["Port"]),
  });
  setGeography([home, dest], { Home: [0, 0], Dest: [4000, 0] });
  const routes = new Map();
  addRouteToNetwork(routes, new Route("Home", "Dest", "Sea"));
  setRoutes(routes);
  setSailorPool(new Map());
  return { home, dest };
}

describe("Ship's Log -- enable/disable toggle", () => {
  it("recordShipLog is a no-op while disabled (isShipLogEnabled false)", () => {
    // Undo this file's module-level setShipLogEnabled(true) just for this test.
    setShipLogEnabled(false);
    try {
      makeTwoPortWorld();
      const transport = new Ship({ name: "Runner", crewRequirement: 1 });
      const captain = makeCaptain("Cap", "Home");
      new Company("Acme", [[transport, captain, "Home"]], 0);

      captain.act(1, new Map(), new Map(), [], new Set());
      captain.recordShipLog(1);

      expect(captain.shipLog).toEqual([]);
    } finally {
      setShipLogEnabled(true);
    }
  });
});

describe("Ship's Log -- ambient filler (nothing else happened today)", () => {
  it("describes a quiet day at anchor for a docked Captain with nothing to do", () => {
    makeTwoPortWorld();
    const transport = new Ship({ name: "Runner", crewRequirement: 1 });
    const captain = makeCaptain("Cap", "Home");
    new Company("Acme", [[transport, captain, "Home"]], 0); // no cash -- can never find/afford a trade

    captain.act(1, new Map(), new Map(), [], new Set());
    captain.recordShipLog(1);

    expect(captain.shipLog).toEqual([{ day: 1, text: "Rode out a quiet day at anchor in Home." }]);
  });

  it("describes an ongoing voyage for a Captain still InTransit", () => {
    makeTwoPortWorld();
    const transport = new Ship({ name: "Runner", crewRequirement: 1 });
    const captain = makeCaptain("Cap", "Home");
    new Company("Acme", [[transport, captain, "Home"]], 1_000_000);
    transport.status = "InTransit";
    transport.currentFuel = 100;
    captain.destination = "Dest";
    captain.daysRemaining = 5;

    captain.act(1, new Map(), new Map(), [], new Set());
    captain.recordShipLog(1);

    expect(captain.shipLog).toEqual([{ day: 1, text: "Under way toward Dest, 4 days out." }]);
  });
});

describe("Ship's Log -- arrival", () => {
  it("notes making port on the day of a genuine arrival", () => {
    makeTwoPortWorld();
    const transport = new Ship({ name: "Runner", crewRequirement: 1 });
    const captain = makeCaptain("Cap", "Home");
    new Company("Acme", [[transport, captain, "Home"]], 1_000_000);
    transport.status = "InTransit";
    transport.currentFuel = 100;
    captain.destination = "Dest";
    captain.daysRemaining = 1;

    captain.act(1, new Map(), new Map(), [], new Set());
    captain.recordShipLog(1);

    expect(captain.status).toBe("AtLocation");
    expect(captain.shipLog).toEqual([{ day: 1, text: "Made port at Dest." }]);
  });
});

describe("Ship's Log -- trade/event narration", () => {
  function makeIdleCaptain(): Captain {
    makeTwoPortWorld();
    const transport = new Ship({ name: "Runner", crewRequirement: 1 });
    const captain = makeCaptain("Cap", "Home");
    new Company("Acme", [[transport, captain, "Home"]], 0);
    return captain;
  }

  it("narrates a market BUY", () => {
    const captain = makeIdleCaptain();
    captain.tradeLog.push({
      day: 1, action: "BUY", commodity: "Gold", location: "Home", destination: "Dest",
      quantity: 10, price: 5, distance: 100, routeType: "Sea", travelDays: 1,
      fuelPrice: 1, fuelUnitsConsumed: 1, fuelCostPaid: 1, profit: null,
    });
    captain.recordShipLog(1);
    expect(captain.shipLog[0].text).toBe("Took on 10.0 units of Gold at Home, bound for Dest.");
  });

  it("narrates a market SELL (profit and loss)", () => {
    const captain = makeIdleCaptain();
    captain.tradeLog.push({
      day: 1, action: "SELL", commodity: "Gold", location: "Dest", destination: null,
      quantity: 10, price: 8, distance: null, routeType: null, travelDays: null,
      fuelPrice: null, fuelUnitsConsumed: null, fuelCostPaid: 0, profit: 30,
    });
    captain.recordShipLog(1);
    expect(captain.shipLog[0].text).toBe("Sold 10.0 Gold at Dest for $8.00/unit, a profit of $30.00.");

    captain.shipLog = [];
    captain.tradeLog[0] = { ...captain.tradeLog[0], profit: -12 };
    captain.recordShipLog(1);
    expect(captain.shipLog[0].text).toBe("Sold 10.0 Gold at Dest for $8.00/unit, a loss of $12.00.");
  });

  it("narrates a contract delivery SELL (price null) distinctly from a market sale", () => {
    const captain = makeIdleCaptain();
    captain.tradeLog.push({
      day: 1, action: "SELL", commodity: "Gold", location: "Dest", destination: null,
      quantity: 10, price: null, distance: null, routeType: null, travelDays: null,
      fuelPrice: null, fuelUnitsConsumed: null, fuelCostPaid: 0, profit: 15,
    });
    captain.recordShipLog(1);
    expect(captain.shipLog[0].text).toBe("Delivered 10.0 Gold at Dest against a standing supply contract.");
  });

  it("narrates a REFUEL stop", () => {
    const captain = makeIdleCaptain();
    captain.tradeLog.push({
      day: 1, action: "REFUEL", commodity: "Gold", location: "Home", destination: "Dest",
      quantity: 0, price: null, distance: null, routeType: null, travelDays: null,
      fuelPrice: 1, fuelUnitsConsumed: 5, fuelCostPaid: 5, profit: null,
    });
    captain.recordShipLog(1);
    expect(captain.shipLog[0].text).toBe("Took on fuel at Home.");
  });

  it("narrates a REPOSITION departure", () => {
    const captain = makeIdleCaptain();
    captain.tradeLog.push({
      day: 1, action: "REPOSITION", commodity: null, location: "Home", destination: "Dest",
      quantity: 0, price: null, distance: 4000, routeType: "Sea", travelDays: 8,
      fuelPrice: 1, fuelUnitsConsumed: 10, fuelCostPaid: 10, profit: null,
    });
    captain.recordShipLog(1);
    expect(captain.shipLog[0].text).toBe("Weighed anchor from Home for Dest, chasing a better market.");
  });

  it("narrates a pirate ATTACK (with and without cargo seized)", () => {
    const captain = makeIdleCaptain();
    captain.tradeLog.push({
      day: 1, action: "ATTACK", commodity: "Gold", location: "Dest", destination: "Victim",
      quantity: 5, price: null, distance: null, routeType: null, travelDays: null,
      fuelPrice: null, fuelUnitsConsumed: null, fuelCostPaid: 0, profit: 100,
    });
    captain.recordShipLog(1);
    expect(captain.shipLog[0].text).toBe("Ran down a merchant near Dest, seizing 5.0 Gold and $100.00 in coin.");

    captain.shipLog = [];
    captain.tradeLog[0] = { ...captain.tradeLog[0], commodity: null, quantity: 0 };
    captain.recordShipLog(1);
    expect(captain.shipLog[0].text).toBe("Ran down a merchant near Dest, making off with $100.00 in coin.");
  });

  it("narrates a SMUGGLE attempt (caught vs. successful)", () => {
    const captain = makeIdleCaptain();
    captain.tradeLog.push({
      day: 1, action: "SMUGGLE", commodity: "Gold", location: "Dest", destination: null,
      quantity: 10, price: null, distance: null, routeType: null, travelDays: null,
      fuelPrice: null, fuelUnitsConsumed: null, fuelCostPaid: 0, profit: -50,
    });
    captain.recordShipLog(1);
    expect(captain.shipLog[0].text).toBe("Tried to run 10.0 Gold past the blockade at Dest -- caught, cargo seized and a fine levied.");

    captain.shipLog = [];
    captain.tradeLog[0] = { ...captain.tradeLog[0], price: 7 };
    captain.recordShipLog(1);
    expect(captain.shipLog[0].text).toBe("Slipped 10.0 Gold past the blockade at Dest for a tidy sum.");
  });

  it("incorporates an agentEventLog entry's own name and detail text", () => {
    const captain = makeIdleCaptain();
    captain.agentEventLog.push({
      day: 1, location: "Home", name: "Pirate attack by Blackbeard", kind: "cash_loss", detail: "-$50.00 cash",
    });
    captain.recordShipLog(1);
    expect(captain.shipLog[0].text).toBe("Pirate attack by Blackbeard -- -$50.00 cash.");
  });
});

describe("Ship's Log -- repair and Shore Leave flags", () => {
  it("notes a day spent under repair", () => {
    makeTwoPortWorld();
    const transport = new Ship({ name: "Runner", crewRequirement: 1 });
    const captain = makeCaptain("Cap", "Home");
    new Company("Acme", [[transport, captain, "Home"]], 1_000_000);
    transport.condition = 0.1;

    captain.act(1, new Map(), new Map(), [], new Set(), { action: "REPAIR" });
    captain.recordShipLog(1);

    expect(transport.condition).toBe(1);
    expect(captain.shipLog).toEqual([{ day: 1, text: "Spent the day under repair." }]);
  });

  it("appends a Shore Leave note onto whatever else happened that day", () => {
    makeTwoPortWorld();
    const transport = new Ship({ name: "Runner", crewRequirement: 1 });
    const captain = makeCaptain("Cap", "Home");
    new Company("Acme", [[transport, captain, "Home"]], 0);
    captain.shoreLeaveGrantedToday = 1;

    captain.act(1, new Map(), new Map(), [], new Set());
    captain.recordShipLog(1);

    expect(captain.shipLog).toEqual([
      { day: 1, text: "Rode out a quiet day at anchor in Home. Crew granted shore leave for the night." },
    ]);
  });
});

describe("Ship's Log -- sinking", () => {
  it("writes a final entry when the Ship is lost at sea", () => {
    makeTwoPortWorld();
    const transport = new Ship({ name: "Runner", crewRequirement: 1 });
    const captain = makeCaptain("Cap", "Home");
    const company = new Company("Acme", [[transport, captain, "Home"]], 1_000_000);
    transport.status = "InTransit";

    company.sinkAtSea(captain, 7);

    expect(captain.shipLog).toEqual([
      { day: 7, text: "The Runner went down at sea with all hands -- lost with everyone aboard." },
    ]);
  });

  it("writes a final entry when the Ship is lost (survivably) in port", () => {
    makeTwoPortWorld();
    const transport = new Ship({ name: "Runner", crewRequirement: 1 });
    const captain = makeCaptain("Cap", "Home");
    const company = new Company("Acme", [[transport, captain, "Home"]], 1_000_000);

    company.sinkInPort(captain, 7);

    expect(captain.shipLog).toEqual([
      { day: 7, text: "The Runner was lost at Home -- Cap and crew made it ashore safely." },
    ]);
  });
});

describe("Ship's Log -- new ship acquisition", () => {
  it("gives a manually bought replacement Ship its own first entry immediately, not deferred to a later day", () => {
    const { world } = buildWorld();
    const company = world.factions.find(
      (f): f is Company => f.constructor.name === "Company" && f.captains.length > 0 && f.captains[0].transport !== null,
    )!;
    const homeLocation = company.homeLocation!;

    const captain = world.buyShipForCompany(company, homeLocation, "Speedster");

    expect(captain.shipLog).toHaveLength(1);
    expect(captain.shipLog[0].text).toBe(`Took command of the ${captain.transport!.name} at ${homeLocation}.`);
  });
});
