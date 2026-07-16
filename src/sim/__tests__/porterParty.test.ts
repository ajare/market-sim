import { describe, expect, it } from "vitest";
import { Location } from "../location";
import {
  PorterParty,
  Ship,
  PORTER_PARTY_BASE_CAPACITY,
  PORTER_PARTY_CAPACITY_PER_PORTER,
  PORTER_PARTY_CAPACITY_PER_ANIMAL,
} from "../transport";
import { Route } from "../routes";
import { setGeography } from "../worldData";

describe("PorterParty", () => {
  it("only allows Trail routes", () => {
    const party = new PorterParty({ name: "Test Party" });
    expect(party.allowedRouteTypes()).toEqual(["Trail"]);
  });

  it("computes cargoCapacity from base + porters + animals", () => {
    const defaultParty = new PorterParty({ name: "Default" }); // porterCount 4, animalCount 0
    expect(defaultParty.cargoCapacity).toBeCloseTo(
      PORTER_PARTY_BASE_CAPACITY + PORTER_PARTY_CAPACITY_PER_PORTER * 4,
      5,
    );

    const bigParty = new PorterParty({ name: "Big", porterCount: 6, animalCount: 2 });
    expect(bigParty.cargoCapacity).toBeCloseTo(
      PORTER_PARTY_BASE_CAPACITY + PORTER_PARTY_CAPACITY_PER_PORTER * 6 + PORTER_PARTY_CAPACITY_PER_ANIMAL * 2,
      5,
    );

    const noPorters = new PorterParty({ name: "Solo", porterCount: 0, animalCount: 0 });
    expect(noPorters.cargoCapacity).toBeCloseTo(PORTER_PARTY_BASE_CAPACITY, 5);
  });

  it("starts with an empty inventory, unlike a Ship (which leaves inventory null)", () => {
    const party = new PorterParty({ name: "Test Party" });
    expect(party.inventory).toEqual({});
    expect(party.cargo).toBeNull();

    const ship = new Ship({ name: "Freighter" });
    expect(ship.inventory).toBeNull();
  });

  it("burns no fuel and never needs refueling", () => {
    const party = new PorterParty({ name: "Test Party" });
    expect(party.currentFuel).toBeNull();
    expect(party.needsRefuel(1000)).toBe(false);
  });

  it("canUseRoute accepts a Trail route and rejects a Sea route", () => {
    const origin = new Location({
      name: "Coastal Town",
      producedCommodities: {},
      consumedCommodities: {},
      stockpiles: {},
      minStockpiles: {},
      basePriceModifiers: {},
      fuelPrice: 1.0,
      terminalTypes: new Set(["Port", "Market"]),
    });
    const dest = new Location({
      name: "Inland Village",
      producedCommodities: {},
      consumedCommodities: {},
      stockpiles: {},
      minStockpiles: {},
      basePriceModifiers: {},
      fuelPrice: 1.0,
      terminalTypes: new Set(["Market"]),
    });
    setGeography([origin, dest], { "Coastal Town": [0, 0], "Inland Village": [10, 0] });

    const trailRoute = new Route("Coastal Town", "Inland Village", "Trail");
    const seaRoute = new Route("Coastal Town", "Inland Village", "Sea");

    const party = new PorterParty({ name: "Test Party" });
    expect(party.canUseRoute(trailRoute)).toBe(true);
    expect(party.canUseRoute(seaRoute)).toBe(false);

    const ship = new Ship({ name: "Freighter" });
    expect(ship.canUseRoute(trailRoute)).toBe(false);
    expect(ship.canUseRoute(seaRoute)).toBe(true);
  });
});
