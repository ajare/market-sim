import { describe, expect, it } from "vitest";
import { Location } from "../location";
import { Company } from "../faction";
import { Captain } from "../captain";
import { Ship, WagonTrain } from "../transport";
import { setGeography, getLocation } from "../worldData";
import { Route, addRouteToNetwork, setRoutes } from "../routes";
import { setSailorPool } from "../sailorPool";
import { WeatherSystem, type WeatherProfile, type Bounds } from "../weather";

/**
 * A fully deterministic WeatherProfile for testing the wind-speed effect in
 * isolation: constant temperature/wind speed everywhere and every day (zero
 * seasonal amplitude, zero storm boost) and a fixed prevailing wind
 * direction with zero spread (no noise wobble at all) -- so windSpeed()
 * always returns exactly WIND_SPEED and windDirection() always returns
 * exactly PREVAILING_DIRECTION_DEG, regardless of position/day/seed.
 */
const WIND_SPEED = 300; // matches captain.ts's WIND_EFFECT_REFERENCE_SPEED exactly -- full-strength effect
const PREVAILING_DIRECTION_DEG = 90; // wind blows due east ("arrow points this way")

const TEST_PROFILE: WeatherProfile = {
  name: "Test",
  centerLatitudeDeg: 0,
  warmLatitudeDeg: 0,
  warmTemperatureC: 20,
  warmSeasonalAmplitudeC: 0,
  coolLatitudeDeg: 90,
  coolTemperatureC: 20,
  coolSeasonalAmplitudeC: 0,
  stormCoolingC: 0,
  warmWindBase: WIND_SPEED,
  coolWindBase: WIND_SPEED,
  stormWindBoost: 0,
  prevailingWindDirectionDeg: PREVAILING_DIRECTION_DEG,
  windDirectionSpreadDeg: 0,
  wetSeasonPeakTimeOfYear: 0,
  wetSeasonAmplitude: 0,
};

const BOUNDS: Bounds = { x0: 0, y0: 0, x1: 9000, y1: 9000 };

/** A Captain at `homeLocationName` (already registered via setGeography) -- gender/birth date are test-irrelevant fixed values. */
function makeCaptain(name: string, homeLocationName: string): Captain {
  return new Captain({
    name, gender: "Male", dateOfBirth: new Date("1980-01-01"), homeLocation: getLocation(homeLocationName)!,
  });
}

/**
 * A four-Port world: Home at the origin, and East/West/South each 4000
 * world-units directly in their named compass direction -- so the heading
 * from Home to East is exactly 90deg (due east), matching PREVAILING_DIRECTION_DEG
 * exactly (a perfect tailwind), West is exactly 270deg (a perfect headwind),
 * and South is exactly 180deg (a right-angle crosswind, no effect).
 */
function makeFourPortWorld(): { home: Location } {
  const make = (name: string) => new Location({
    name, producedCommodities: {}, consumedCommodities: {},
    stockpiles: {}, minStockpiles: {}, basePriceModifiers: {}, fuelPrice: 1.0, terminalTypes: new Set(["Port"]),
  });
  const home = make("Home");
  const east = make("East");
  const west = make("West");
  const south = make("South");
  setGeography([home, east, west, south], {
    Home: [0, 0], East: [4000, 0], West: [-4000, 0], South: [0, 4000],
  });
  const routes = new Map();
  addRouteToNetwork(routes, new Route("Home", "East", "Sea"));
  addRouteToNetwork(routes, new Route("Home", "West", "Sea"));
  addRouteToNetwork(routes, new Route("Home", "South", "Sea"));
  setRoutes(routes);
  setSailorPool(new Map());
  return { home };
}

/** Departs `captain` (already at Home, well-funded) toward `destination` via a REPOSITION directive -- the simplest path through act() that reaches departEmptyTo without needing markets/commodities set up. */
function departTo(captain: Captain, destination: string, weather: WeatherSystem | null): void {
  captain.act(1, new Map(), new Map(), [], new Set(), { action: "REPOSITION", destination }, null, weather);
}

describe("wind speed/direction effect on Ship travel time", () => {
  it("a following wind (tailwind) shortens the voyage vs. no wind at all", () => {
    makeFourPortWorld();
    const weather = new WeatherSystem(1, BOUNDS, TEST_PROFILE);

    const noWindTransport = new Ship({ name: "Baseline", speedUnitsPerDay: 500, crewRequirement: 1 });
    const noWindCaptain = makeCaptain("Cap1", "Home");
    new Company("Acme1", [[noWindTransport, noWindCaptain, "Home"]], 1_000_000);
    departTo(noWindCaptain, "East", null);

    const tailwindTransport = new Ship({ name: "Tailwind", speedUnitsPerDay: 500, crewRequirement: 1 });
    const tailwindCaptain = makeCaptain("Cap2", "Home");
    new Company("Acme2", [[tailwindTransport, tailwindCaptain, "Home"]], 1_000_000);
    departTo(tailwindCaptain, "East", weather);

    expect(tailwindCaptain.status).toBe("InTransit");
    expect(noWindCaptain.status).toBe("InTransit");
    // 4000 units at plain 500/day = ceil(8) = 8 days; at +15% (575/day) = ceil(6.96) = 7 days.
    expect(noWindCaptain.daysRemaining).toBe(8);
    expect(tailwindCaptain.daysRemaining).toBe(7);
    expect(tailwindCaptain.daysRemaining).toBeLessThan(noWindCaptain.daysRemaining);
  });

  it("a headwind lengthens the voyage vs. no wind at all", () => {
    makeFourPortWorld();
    const weather = new WeatherSystem(1, BOUNDS, TEST_PROFILE);

    const noWindTransport = new Ship({ name: "Baseline", speedUnitsPerDay: 500, crewRequirement: 1 });
    const noWindCaptain = makeCaptain("Cap1", "Home");
    new Company("Acme1", [[noWindTransport, noWindCaptain, "Home"]], 1_000_000);
    departTo(noWindCaptain, "West", null);

    const headwindTransport = new Ship({ name: "Headwind", speedUnitsPerDay: 500, crewRequirement: 1 });
    const headwindCaptain = makeCaptain("Cap2", "Home");
    new Company("Acme2", [[headwindTransport, headwindCaptain, "Home"]], 1_000_000);
    departTo(headwindCaptain, "West", weather);

    // 4000 units at plain 500/day = 8 days; at -15% (425/day) = ceil(9.41) = 10 days.
    expect(noWindCaptain.daysRemaining).toBe(8);
    expect(headwindCaptain.daysRemaining).toBe(10);
    expect(headwindCaptain.daysRemaining).toBeGreaterThan(noWindCaptain.daysRemaining);
  });

  it("a right-angle crosswind has no effect on travel time", () => {
    makeFourPortWorld();
    const weather = new WeatherSystem(1, BOUNDS, TEST_PROFILE);

    const noWindTransport = new Ship({ name: "Baseline", speedUnitsPerDay: 500, crewRequirement: 1 });
    const noWindCaptain = makeCaptain("Cap1", "Home");
    new Company("Acme1", [[noWindTransport, noWindCaptain, "Home"]], 1_000_000);
    departTo(noWindCaptain, "South", null);

    const crosswindTransport = new Ship({ name: "Crosswind", speedUnitsPerDay: 500, crewRequirement: 1 });
    const crosswindCaptain = makeCaptain("Cap2", "Home");
    new Company("Acme2", [[crosswindTransport, crosswindCaptain, "Home"]], 1_000_000);
    departTo(crosswindCaptain, "South", weather);

    expect(crosswindCaptain.daysRemaining).toBe(noWindCaptain.daysRemaining);
  });

  it("does not affect non-Ship Transport types (wind is a maritime-only effect)", () => {
    makeFourPortWorld();
    const weather = new WeatherSystem(1, BOUNDS, TEST_PROFILE);
    // A WagonTrain can't use a Sea route, so give it its own Land route --
    // still a perfect-tailwind heading (due east), which should be ignored.
    const routes = new Map();
    addRouteToNetwork(routes, new Route("Home", "East", "Land"));
    addRouteToNetwork(routes, new Route("Home", "West", "Sea"));
    addRouteToNetwork(routes, new Route("Home", "South", "Sea"));
    setRoutes(routes);

    const wagon = new WagonTrain({ name: "Cart", speedUnitsPerDay: 500, crewRequirement: 1 });
    const wagonCaptain = makeCaptain("Cap3", "Home");
    new Company("Acme3", [[wagon, wagonCaptain, "Home"]], 1_000_000);
    departTo(wagonCaptain, "East", weather);

    expect(wagonCaptain.status).toBe("InTransit");
    // Plain 4000/500 = 8 days -- no wind adjustment despite the perfect-tailwind heading.
    expect(wagonCaptain.daysRemaining).toBe(8);
  });

  it("has no effect when act() is called with no WeatherSystem (weather omitted/null)", () => {
    makeFourPortWorld();
    const transport = new Ship({ name: "NoWeather", speedUnitsPerDay: 500, crewRequirement: 1 });
    const captain = makeCaptain("Cap4", "Home");
    new Company("Acme4", [[transport, captain, "Home"]], 1_000_000);
    departTo(captain, "East", null);

    expect(captain.daysRemaining).toBe(8);
  });
});
