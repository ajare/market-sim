import { describe, expect, it } from "vitest";
import { Location } from "../location";
import { Chieftain } from "../chieftain";

function makeLocation(overrides: Partial<ConstructorParameters<typeof Location>[0]> = {}): Location {
  return new Location({
    name: "Test Location",
    producedCommodities: {},
    consumedCommodities: {},
    stockpiles: {},
    minStockpiles: {},
    basePriceModifiers: {},
    fuelPrice: 1.0,
    terminalTypes: new Set(["Port"]),
    ...overrides,
  });
}

describe("Location.settlementType", () => {
  it("defaults to Town when not specified -- regression guard for every existing fixture", () => {
    const location = makeLocation();
    expect(location.settlementType).toBe("Town");
  });

  it("respects an explicit settlementType", () => {
    const location = makeLocation({ settlementType: "Native village" });
    expect(location.settlementType).toBe("Native village");
  });
});

describe("Location.ruler", () => {
  it("defaults to null", () => {
    const location = makeLocation();
    expect(location.ruler).toBeNull();
  });

  it("round-trips a Chieftain ruler set at construction", () => {
    const chieftain = new Chieftain({
      name: "Chief Ombo", gender: "Male", dateOfBirth: new Date("1950-01-01"),
      passageTaxRate: 0.15, trust: 0.4,
    });
    const location = makeLocation({ settlementType: "Native village", terminalTypes: new Set(["Market"]), ruler: chieftain });
    expect(location.ruler).toBe(chieftain);
    expect(location.ruler?.passageTaxRate).toBe(0.15);
  });
});

describe("Chieftain", () => {
  it("applies its defaults", () => {
    const chieftain = new Chieftain({ name: "Chief Default", gender: "Female", dateOfBirth: new Date("1960-01-01") });
    expect(chieftain.passageTaxRate).toBe(0.1);
    expect(chieftain.trust).toBe(0.5);
  });

  it("never crews a Transport -- starts with location/transport both null like any fresh Person", () => {
    const chieftain = new Chieftain({ name: "Chief Solo", gender: "Male", dateOfBirth: new Date("1955-01-01") });
    expect(chieftain.location).toBeNull();
    expect(chieftain.transport).toBeNull();
  });
});
