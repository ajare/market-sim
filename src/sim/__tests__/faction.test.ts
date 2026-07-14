import { describe, expect, it, beforeAll } from "vitest";
import { Company } from "../faction";
import { Captain } from "../captain";
import { Ship } from "../transport";
import { Location } from "../location";
import { setGeography, getLocation } from "../worldData";

beforeAll(() => {
  setGeography(
    [new Location({
      name: "Testville", producedCommodities: {}, consumedCommodities: {},
      stockpiles: {}, minStockpiles: {}, basePriceModifiers: {}, fuelPrice: 1.0, terminalTypes: new Set(["Port"]),
    })],
    { Testville: [0, 0] },
  );
});

/** A Captain at "Testville" -- gender/birth date are test-irrelevant fixed values. */
function makeCaptain(name: string): Captain {
  return new Captain({
    name, gender: "Male", dateOfBirth: new Date("1980-01-01"), homeLocation: getLocation("Testville")!,
  });
}

function makeCrew(names: string[]): Array<[Ship, Captain, string]> {
  return names.map((name) => [
    new Ship({ name, crewRequirement: 1 }),
    makeCaptain(`Captain ${name}`),
    "Testville",
  ]);
}

describe("Faction ship-name deduplication", () => {
  it("disambiguates duplicate transport names within the same Company's initial fleet", () => {
    const company = new Company("Acme Traders", makeCrew(["Victory", "Victory", "Victory"]), 0);
    const names = company.captains.map((c) => c.transport!.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toEqual(["Victory", "Victory 2", "Victory 3"]);
  });

  it("disambiguates a Transport added later via addTransport against the existing fleet", () => {
    const company = new Company("Acme Traders", makeCrew(["Victory"]), 0);
    const ship = new Ship({ name: "Victory", crewRequirement: 1 });
    const captain = makeCaptain("Captain New");
    company.addTransport(ship, captain, "Testville");
    const names = company.captains.map((c) => c.transport!.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toEqual(["Victory", "Victory 2"]);
  });

  it("leaves distinct names untouched", () => {
    const company = new Company("Acme Traders", makeCrew(["Victory", "Sovereign"]), 0);
    const names = company.captains.map((c) => c.transport!.name);
    expect(names).toEqual(["Victory", "Sovereign"]);
  });
});

function makeCrewWithCaptains(names: string[]): Array<[Ship, Captain, string]> {
  return names.map((name, i) => [
    new Ship({ name: `Ship ${i}`, crewRequirement: 1 }),
    makeCaptain(name),
    "Testville",
  ]);
}

describe("Faction captain-name deduplication", () => {
  it("gives a colliding Captain a middle initial starting with A", () => {
    const company = new Company("Acme Traders", makeCrewWithCaptains(["John Smith", "John Smith", "John Smith"]), 0);
    expect(company.captains.map((c) => c.name)).toEqual(["John Smith", "John A. Smith", "John B. Smith"]);
  });

  it("replaces a prior dedupe pass's middle initial rather than stacking another one", () => {
    const company = new Company(
      "Acme Traders",
      makeCrewWithCaptains(["John Smith", "John A. Smith", "John Smith"]),
      0,
    );
    expect(company.captains.map((c) => c.name)).toEqual(["John Smith", "John A. Smith", "John B. Smith"]);
  });

  it("appends the initial directly when the name has no last name", () => {
    const company = new Company("Acme Traders", makeCrewWithCaptains(["Blackbeard", "Blackbeard"]), 0);
    expect(company.captains.map((c) => c.name)).toEqual(["Blackbeard", "Blackbeard A."]);
  });

  it("disambiguates a Captain added later via addTransport against the existing fleet", () => {
    const company = new Company("Acme Traders", makeCrewWithCaptains(["John Smith"]), 0);
    const ship = new Ship({ name: "New Ship", crewRequirement: 1 });
    const captain = makeCaptain("John Smith");
    company.addTransport(ship, captain, "Testville");
    expect(company.captains.map((c) => c.name)).toEqual(["John Smith", "John A. Smith"]);
  });

  it("leaves distinct captain names untouched", () => {
    const company = new Company("Acme Traders", makeCrewWithCaptains(["John Smith", "Jane Doe"]), 0);
    expect(company.captains.map((c) => c.name)).toEqual(["John Smith", "Jane Doe"]);
  });
});
