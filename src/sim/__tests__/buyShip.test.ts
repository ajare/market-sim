import { describe, expect, it } from "vitest";
import { buildWorld } from "../buildWorld";
import { Company, SoloTrader } from "../faction";
import { SHIP_CLASSES, Ship } from "../transport";
import { Captain } from "../captain";
import { Location } from "../location";
import { setGeography } from "../worldData";
import { setRoutes } from "../routes";

describe("World.buyShipForCompany", () => {
  it("buys a Ship of the chosen class at the chosen Location (not the Company's home), deducting the exact purchase price", () => {
    const { world } = buildWorld();
    const company = world.factions.find(
      (f): f is Company => f instanceof Company && !(f instanceof SoloTrader) && f.homeLocation !== null,
    )!;
    const otherPort = world.locations.find(
      (l) => l.name !== company.homeLocation && (l.terminalTypes.has("Port") || l.terminalTypes.has("Platform")),
    )!;
    const cashBefore = company.cash;
    const captainsBefore = new Set(world.captains);

    const captain = world.buyShipForCompany(company, otherPort.name, "Speedster");

    expect(world.captains).toContain(captain);
    expect(captainsBefore.has(captain)).toBe(false);
    expect(captain.company).toBe(company);
    expect(captain.transport).toBeInstanceOf(Ship);
    expect(captain.transport!.name).toBeTruthy();
    expect(captain.locationName).toBe(otherPort.name);
    expect(captain.locationName).not.toBe(company.homeLocation);
    expect(company.cash).toBeCloseTo(cashBefore - SHIP_CLASSES.Speedster.purchasePrice, 5);
    // The Company's own home Location is untouched by a purchase elsewhere.
    expect(company.homeLocation).not.toBe(otherPort.name);
  });

  it("throws (and changes nothing) if the Company can't afford the class", () => {
    const { world } = buildWorld();
    const company = world.factions.find((f): f is Company => f instanceof Company && !(f instanceof SoloTrader))!;
    company.cash = 1;
    const cashBefore = company.cash;
    const captainsBefore = world.captains.length;
    const port = world.locations.find((l) => l.terminalTypes.has("Port") || l.terminalTypes.has("Platform"))!;

    expect(() => world.buyShipForCompany(company, port.name, "Speedster")).toThrow(/cannot afford/);
    expect(company.cash).toBe(cashBefore);
    expect(world.captains.length).toBe(captainsBefore);
  });

  it("throws for an unknown ship class", () => {
    const { world } = buildWorld();
    const company = world.factions.find((f): f is Company => f instanceof Company && !(f instanceof SoloTrader))!;
    const port = world.locations.find((l) => l.terminalTypes.has("Port") || l.terminalTypes.has("Platform"))!;
    expect(() => world.buyShipForCompany(company, port.name, "NotAClass")).toThrow(/Unknown ship class/);
  });

  it("throws for a nonexistent Location", () => {
    const { world } = buildWorld();
    const company = world.factions.find((f): f is Company => f instanceof Company && !(f instanceof SoloTrader))!;
    expect(() => world.buyShipForCompany(company, "Nowhere", "Speedster")).toThrow(/does not exist/);
  });

  it("throws for a Location that doesn't support a Ship (no Port/Platform terminal)", () => {
    const { world } = buildWorld();
    const company = world.factions.find((f): f is Company => f instanceof Company && !(f instanceof SoloTrader))!;
    const railYard = new Location({
      name: "Rail Yard", producedCommodities: {}, consumedCommodities: {},
      stockpiles: {}, minStockpiles: {}, basePriceModifiers: {}, fuelPrice: 1.0,
      terminalTypes: new Set(["Station"]),
    });
    setGeography([...world.locations, railYard], {
      ...Object.fromEntries(world.locations.map((l) => [l.name, [0, 0]])),
      "Rail Yard": [0, 0],
    });
    setRoutes(new Map());
    expect(() => world.buyShipForCompany(company, "Rail Yard", "Speedster")).toThrow(/TerminalType/);
  });

  it("refuses a SoloTrader -- capped at one Ship, replacement is a future automatic feature, not a manual purchase", () => {
    const { world } = buildWorld();
    const solo = world.factions.find((f): f is SoloTrader => f instanceof SoloTrader)!;
    const port = world.locations.find((l) => l.terminalTypes.has("Port") || l.terminalTypes.has("Platform"))!;
    expect(() => world.buyShipForCompany(solo, port.name, "Speedster")).toThrow(/SoloTrader/);
  });

  it("every SHIP_CLASSES entry has a positive purchasePrice, scaled with cargoCapacity", () => {
    const names = Object.keys(SHIP_CLASSES);
    for (const name of names) {
      expect(SHIP_CLASSES[name].purchasePrice).toBeGreaterThan(0);
    }
    // Bigger cargo capacity -> bigger price (monotonic, per the grilled spec).
    const sorted = [...names].sort((a, b) => SHIP_CLASSES[a].cargoCapacity - SHIP_CLASSES[b].cargoCapacity);
    for (let i = 1; i < sorted.length; i++) {
      expect(SHIP_CLASSES[sorted[i]].purchasePrice).toBeGreaterThanOrEqual(SHIP_CLASSES[sorted[i - 1]].purchasePrice);
    }
  });
});

describe("Company.buyShipAt", () => {
  it("places the new Ship at the given Location and skips the home-location forcing addTransport normally does", () => {
    const home = new Location({
      name: "Home", producedCommodities: {}, consumedCommodities: {},
      stockpiles: {}, minStockpiles: {}, basePriceModifiers: {}, fuelPrice: 1.0,
      terminalTypes: new Set(["Port"]),
    });
    const away = new Location({
      name: "Away", producedCommodities: {}, consumedCommodities: {},
      stockpiles: {}, minStockpiles: {}, basePriceModifiers: {}, fuelPrice: 1.0,
      terminalTypes: new Set(["Platform"]),
    });
    setGeography([home, away], { Home: [0, 0], Away: [100, 0] });
    setRoutes(new Map());

    const existingShip = new Ship({ name: "Existing" });
    const existingCaptain = new Captain({
      name: "Founder", gender: "Male", dateOfBirth: new Date("1980-01-01"), homeLocation: home,
    });
    const company = new Company("Acme", [[existingShip, existingCaptain, "Home"]], 100_000, "Home");

    const newShip = new Ship({ name: "Newcomer" });
    const newCaptain = new Captain({
      name: "Rookie", gender: "Female", dateOfBirth: new Date("1990-01-01"), homeLocation: away,
    });
    company.buyShipAt(newShip, newCaptain, "Away");

    expect(newCaptain.locationName).toBe("Away");
    expect(company.homeLocation).toBe("Home");
    expect(company.captains).toContain(newCaptain);
  });

  it("throws if the Location doesn't support the Transport type", () => {
    const home = new Location({
      name: "Home", producedCommodities: {}, consumedCommodities: {},
      stockpiles: {}, minStockpiles: {}, basePriceModifiers: {}, fuelPrice: 1.0,
      terminalTypes: new Set(["Port"]),
    });
    const railYard = new Location({
      name: "Rail Yard", producedCommodities: {}, consumedCommodities: {},
      stockpiles: {}, minStockpiles: {}, basePriceModifiers: {}, fuelPrice: 1.0,
      terminalTypes: new Set(["Station"]),
    });
    setGeography([home, railYard], { Home: [0, 0], "Rail Yard": [100, 0] });
    setRoutes(new Map());

    const existingShip = new Ship({ name: "Existing" });
    const existingCaptain = new Captain({
      name: "Founder", gender: "Male", dateOfBirth: new Date("1980-01-01"), homeLocation: home,
    });
    const company = new Company("Acme", [[existingShip, existingCaptain, "Home"]], 100_000, "Home");

    const newShip = new Ship({ name: "Newcomer" });
    const newCaptain = new Captain({
      name: "Rookie", gender: "Female", dateOfBirth: new Date("1990-01-01"), homeLocation: railYard,
    });
    expect(() => company.buyShipAt(newShip, newCaptain, "Rail Yard")).toThrow(/TerminalType/);
  });
});
