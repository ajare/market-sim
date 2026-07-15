import { describe, expect, it } from "vitest";
import { Location } from "../location";
import { Company, SoloTrader } from "../faction";
import { Captain } from "../captain";
import { Ship } from "../transport";
import { setGeography, getLocation } from "../worldData";
import { Route, addRouteToNetwork, setRoutes } from "../routes";
import { setSailorPool } from "../sailorPool";
import { WeatherSystem, type WeatherProfile, type Bounds } from "../weather";
import { StormSystem, type Storm } from "../storms";

/** No wind effect at all (see windSpeedEffect.test.ts's own copy) -- isolates the Storm effect from the already-tested wind effect. */
const CALM_PROFILE: WeatherProfile = {
  name: "Calm",
  centerLatitudeDeg: 0,
  warmLatitudeDeg: 0, warmTemperatureC: 20, warmSeasonalAmplitudeC: 0,
  coolLatitudeDeg: 90, coolTemperatureC: 20, coolSeasonalAmplitudeC: 0,
  stormCoolingC: 0,
  warmWindBase: 0, coolWindBase: 0, stormWindBoost: 0,
  prevailingWindDirectionDeg: null, windDirectionSpreadDeg: 180,
  wetSeasonPeakTimeOfYear: 0, wetSeasonAmplitude: 0,
};

const BOUNDS: Bounds = { x0: 0, y0: 0, x1: 9000, y1: 9000 };

function makeCaptain(name: string, homeLocationName: string): Captain {
  return new Captain({
    name, gender: "Male", dateOfBirth: new Date("1980-01-01"), homeLocation: getLocation(homeLocationName)!,
  });
}

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

function makeStorm(overrides: Partial<Storm> = {}): Storm {
  return {
    id: 1, x: 0, y: 0, radius: 500, intensity: 1, peakIntensity: 1, age: 5, isCyclone: false, cycloneStreak: 0,
    ...overrides,
  };
}

function departTo(captain: Captain, destination: string, weather: WeatherSystem | null, storms: StormSystem | null): void {
  captain.act(1, new Map(), new Map(), [], new Set(), { action: "REPOSITION", destination }, null, weather, storms);
}

describe("Storm effect on Ship departure", () => {
  it("a Storm covering the departure port slows a Ship down (extra penalty on top of the wind effect)", () => {
    makeTwoPortWorld();
    const weather = new WeatherSystem(1, BOUNDS, CALM_PROFILE);

    const clearSystem = new StormSystem(); // no storms at all
    const clearTransport = new Ship({ name: "Clear", speedUnitsPerDay: 500, crewRequirement: 1 });
    const clearCaptain = makeCaptain("Cap1", "Home");
    new Company("Acme1", [[clearTransport, clearCaptain, "Home"]], 1_000_000);
    departTo(clearCaptain, "Dest", weather, clearSystem);

    const stormySystem = new StormSystem();
    stormySystem.storms.push(makeStorm({ x: 0, y: 0, radius: 500 })); // covers Home (0,0)
    const stormyTransport = new Ship({ name: "Stormy", speedUnitsPerDay: 500, crewRequirement: 1 });
    const stormyCaptain = makeCaptain("Cap2", "Home");
    new Company("Acme2", [[stormyTransport, stormyCaptain, "Home"]], 1_000_000);
    departTo(stormyCaptain, "Dest", weather, stormySystem);

    expect(clearCaptain.status).toBe("InTransit");
    expect(stormyCaptain.status).toBe("InTransit");
    // 4000 units at plain 500/day = 8 days; at -25% (375/day) = ceil(10.67) = 11 days.
    expect(clearCaptain.daysRemaining).toBe(8);
    expect(stormyCaptain.daysRemaining).toBe(11);
  });

  it("a cyclone is strictly more severe than a plain storm (slower + more condition damage)", () => {
    makeTwoPortWorld();
    const weather = new WeatherSystem(1, BOUNDS, CALM_PROFILE);

    const stormSystem = new StormSystem();
    stormSystem.storms.push(makeStorm({ x: 0, y: 0, radius: 500, isCyclone: false }));
    const stormTransport = new Ship({ name: "Storm", speedUnitsPerDay: 500, crewRequirement: 1 });
    const stormCaptain = makeCaptain("Cap1", "Home");
    new Company("Acme1", [[stormTransport, stormCaptain, "Home"]], 1_000_000);
    departTo(stormCaptain, "Dest", weather, stormSystem);

    const cycloneSystem = new StormSystem();
    cycloneSystem.storms.push(makeStorm({ x: 0, y: 0, radius: 500, isCyclone: true }));
    const cycloneTransport = new Ship({ name: "Cyclone", speedUnitsPerDay: 500, crewRequirement: 1, condition: 1 });
    const cycloneCaptain = makeCaptain("Cap2", "Home");
    new Company("Acme2", [[cycloneTransport, cycloneCaptain, "Home"]], 1_000_000);
    departTo(cycloneCaptain, "Dest", weather, cycloneSystem);

    expect(cycloneCaptain.daysRemaining).toBeGreaterThan(stormCaptain.daysRemaining);
    expect(cycloneTransport.condition).toBeLessThan(stormTransport.condition);
  });

  it("applies a one-time condition hit on departure into a storm, and it can sink the Ship if condition bottoms out", () => {
    makeTwoPortWorld();
    const weather = new WeatherSystem(1, BOUNDS, CALM_PROFILE);
    const stormSystem = new StormSystem();
    stormSystem.storms.push(makeStorm({ x: 0, y: 0, radius: 500, isCyclone: true })); // cyclone -> big condition hit

    const transport = new Ship({ name: "Fragile", speedUnitsPerDay: 500, crewRequirement: 1, condition: 0.1 });
    const captain = makeCaptain("Cap", "Home");
    const company = new SoloTrader("Solo Co", [[transport, captain, "Home"]], 0);
    captain.ownCash = 500;

    departTo(captain, "Dest", weather, stormSystem);

    // Cyclone condition damage (0.2) exceeds the Ship's starting 0.1 condition -- sinks immediately at sea.
    expect(captain.transport).toBeNull();
    expect(company.captains).not.toContain(captain);
    expect(company.inactiveCaptains).not.toContain(captain); // fatal at sea -- never benched
  });

  it("has no effect when there is no active Storm at the departure port", () => {
    makeTwoPortWorld();
    const weather = new WeatherSystem(1, BOUNDS, CALM_PROFILE);
    const stormSystem = new StormSystem();
    stormSystem.storms.push(makeStorm({ x: 8000, y: 8000, radius: 200 })); // far from Home (0,0)

    const transport = new Ship({ name: "Untouched", speedUnitsPerDay: 500, crewRequirement: 1 });
    const captain = makeCaptain("Cap", "Home");
    new Company("Acme", [[transport, captain, "Home"]], 1_000_000);
    departTo(captain, "Dest", weather, stormSystem);

    expect(captain.daysRemaining).toBe(8);
    expect(transport.condition).toBe(1);
  });

  it("has no effect when act() is called with no StormSystem (storms omitted/null)", () => {
    makeTwoPortWorld();
    const weather = new WeatherSystem(1, BOUNDS, CALM_PROFILE);
    const transport = new Ship({ name: "NoStorms", speedUnitsPerDay: 500, crewRequirement: 1 });
    const captain = makeCaptain("Cap", "Home");
    new Company("Acme", [[transport, captain, "Home"]], 1_000_000);
    departTo(captain, "Dest", weather, null);

    expect(captain.daysRemaining).toBe(8);
    expect(transport.condition).toBe(1);
  });
});
