import { describe, expect, it, beforeEach } from "vitest";
import { Location, type TerminalType } from "../location";
import { setGeography } from "../worldData";
import { PoliticalEntity } from "../politicalEntity";
import { Company, SoloTrader } from "../faction";
import { Captain } from "../captain";
import { Ship, WagonTrain } from "../transport";
import { defaultCompanyHomeLocation } from "../companyHome";

function makeLocation(name: string, terminalTypes: TerminalType[]): Location {
  return new Location({
    name,
    producedCommodities: {},
    consumedCommodities: {},
    stockpiles: {},
    minStockpiles: {},
    basePriceModifiers: {},
    fuelPrice: 1,
    terminalTypes: new Set(terminalTypes),
  });
}

describe("Company home Location", () => {
  beforeEach(() => {
    const port = makeLocation("Alpha Port", ["Port"]);
    const inland = makeLocation("Beta Inland", ["Wagon yard"]);
    setGeography([port, inland], { "Alpha Port": [0, 0], "Beta Inland": [1, 1] });
  });

  it("constructs successfully and reports homeLocation when it supports the fleet", () => {
    const ship = new Ship({ name: "Victory", crewRequirement: 1 });
    const captain = new Captain("Cap", "Alpha Port");
    const company = new Company("Acme", [[ship, captain, "Alpha Port"]], 0, "Alpha Port");
    expect(company.homeLocation).toBe("Alpha Port");
  });

  it("throws at construction when homeLocation lacks a TerminalType the initial fleet needs", () => {
    const ship = new Ship({ name: "Victory", crewRequirement: 1 });
    const captain = new Captain("Cap", "Beta Inland");
    expect(() => new Company("Acme", [[ship, captain, "Beta Inland"]], 0, "Beta Inland")).toThrow();
  });

  it("throws when a non-existent homeLocation is given", () => {
    expect(() => new Company("Acme", [], 0, "Nowhere")).toThrow();
  });

  it("throws when addTransport adds a Transport incompatible with the existing home Location", () => {
    const company = new Company("Acme", [], 0, "Beta Inland"); // Wagon-yard-only -- no Ship allowed
    const ship = new Ship({ name: "Victory", crewRequirement: 1 });
    const captain = new Captain("Cap", "Beta Inland");
    expect(() => company.addTransport(ship, captain, "Beta Inland")).toThrow();
  });

  it("addTransport places the new Captain at the Company's home Location, ignoring the passed-in location", () => {
    const company = new Company("Acme", [], 0, "Alpha Port");
    const ship = new Ship({ name: "Victory", crewRequirement: 1 });
    const captain = new Captain("Cap", "Beta Inland"); // deliberately wrong
    company.addTransport(ship, captain, "Beta Inland");
    expect(captain.location).toBe("Alpha Port");
  });

  it("SoloTrader always reports homeLocation null and never applies the compatibility check", () => {
    // Deliberately placed at a Port-only Location, even though WagonTrain
    // needs "Wagon yard" -- SoloTraders have no home Location, so nothing
    // validates this.
    const wagonTrain = new WagonTrain({ name: "Wagon" });
    const captain = new Captain("Cap", "Alpha Port");
    const solo = new SoloTrader("Solo", [[wagonTrain, captain, "Alpha Port"]], 0);
    expect(solo.homeLocation).toBeNull();
  });
});

describe("defaultCompanyHomeLocation", () => {
  let alpha: Location;
  let beta: Location;
  let gamma: Location;

  beforeEach(() => {
    alpha = makeLocation("Alpha Port", ["Port"]);
    beta = makeLocation("Beta Port", ["Port"]);
    gamma = makeLocation("Gamma Inland", ["Wagon yard"]);
    setGeography([alpha, beta, gamma], { "Alpha Port": [0, 0], "Beta Port": [1, 0], "Gamma Inland": [2, 0] });
  });

  it("picks the alphabetically-first Location among the entity's own Locations", () => {
    const entity = new PoliticalEntity("Kingdom", [beta, alpha]);
    const ship = new Ship({ name: "S", crewRequirement: 1 });
    expect(defaultCompanyHomeLocation(entity, [ship])).toBe("Alpha Port");
  });

  it("falls back to a world-wide search when the entity owns no Locations", () => {
    const entity = new PoliticalEntity("Empty Kingdom", []);
    const ship = new Ship({ name: "S", crewRequirement: 1 });
    expect(defaultCompanyHomeLocation(entity, [ship])).toBe("Alpha Port");
  });

  it("searches world-wide for an Independent Company (no PoliticalEntity)", () => {
    const ship = new Ship({ name: "S", crewRequirement: 1 });
    expect(defaultCompanyHomeLocation(null, [ship])).toBe("Alpha Port");
  });

  it("skips an entity-owned Location that doesn't support the fleet's TerminalType needs", () => {
    // gamma sorts alphabetically before alpha's rival "Beta", but it's
    // Wagon-yard-only, so a Ship-owning Company must skip it.
    const entity = new PoliticalEntity("Kingdom", [gamma, alpha]);
    const ship = new Ship({ name: "S", crewRequirement: 1 });
    expect(defaultCompanyHomeLocation(entity, [ship])).toBe("Alpha Port");
  });

  it("throws when nothing supports the fleet", () => {
    const entity = new PoliticalEntity("Kingdom", [gamma]);
    const ship = new Ship({ name: "S", crewRequirement: 1 });
    expect(() => defaultCompanyHomeLocation(entity, [ship])).toThrow();
  });

  it("an empty fleet is trivially supported everywhere -- picks purely by nationality/alphabetical", () => {
    const entity = new PoliticalEntity("Kingdom", [gamma, alpha]);
    expect(defaultCompanyHomeLocation(entity, [])).toBe("Alpha Port");
  });
});
