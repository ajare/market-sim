import { afterEach, describe, expect, it } from "vitest";
import {
  StormSystem, stormAt, setStormFrequency, getStormFrequency, DEFAULT_STORM_FREQUENCY_MULTIPLIER, type Storm,
} from "../storms";
import { WeatherSystem, type WeatherProfile, type Bounds } from "../weather";
import { seedSimRandom } from "../simRandom";

const BOUNDS: Bounds = { x0: 0, y0: 0, x1: 9000, y1: 9000 };
const START_DATE = new Date("2000-01-01T00:00:00.000Z");

/** No seasonal rainfall bias at all -- a pure noise baseline to compare a wet-season profile against. */
const NO_WET_SEASON_PROFILE: WeatherProfile = {
  name: "NoWetSeason",
  centerLatitudeDeg: 0,
  warmLatitudeDeg: 0, warmTemperatureC: 20, warmSeasonalAmplitudeC: 0,
  coolLatitudeDeg: 90, coolTemperatureC: 20, coolSeasonalAmplitudeC: 0,
  stormCoolingC: 0,
  warmWindBase: 100, coolWindBase: 100, stormWindBoost: 0,
  prevailingWindDirectionDeg: null, windDirectionSpreadDeg: 180,
  wetSeasonPeakTimeOfYear: 0, wetSeasonAmplitude: 0,
};

/** Same storminess noise field (same base seed, applied below), but boosted well above the baseline at its wet-season peak -- rainfall() at every position on that peak day is >= NO_WET_SEASON_PROFILE's, never lower (see the test's own comment for why this makes the comparison deterministic, not statistical). */
const WET_SEASON_PROFILE: WeatherProfile = {
  ...NO_WET_SEASON_PROFILE,
  name: "WetSeason",
  wetSeasonPeakTimeOfYear: 0, // so timeOfYear 0 (day 1) IS the peak day
  wetSeasonAmplitude: 1,
};

/** A wide, warm, mid-latitude band -- lets a cyclone-formation test hold its criteria steady across a few days of storm drift without the storm wandering out of the qualifying zone. */
const CYCLONE_TEST_PROFILE: WeatherProfile = {
  name: "CycloneTest",
  centerLatitudeDeg: 17,
  warmLatitudeDeg: 0, warmTemperatureC: 30, warmSeasonalAmplitudeC: 0,
  coolLatitudeDeg: 90, coolTemperatureC: 30, coolSeasonalAmplitudeC: 0,
  stormCoolingC: 0,
  warmWindBase: 100, coolWindBase: 100, stormWindBoost: 0,
  prevailingWindDirectionDeg: null, windDirectionSpreadDeg: 180,
  wetSeasonPeakTimeOfYear: 0, wetSeasonAmplitude: 0,
};

/** A fully deterministic profile (no noise wobble in direction) for isolating movement direction. */
const EASTWARD_WIND_PROFILE: WeatherProfile = {
  ...NO_WET_SEASON_PROFILE,
  name: "EastwardWind",
  prevailingWindDirectionDeg: 90, // due east, "arrow points this way"
  windDirectionSpreadDeg: 0,
};

function makeStorm(overrides: Partial<Storm> = {}): Storm {
  return {
    id: 999,
    x: 4500,
    y: 4500,
    radius: 500,
    intensity: 0,
    peakIntensity: 1,
    age: 0,
    isCyclone: false,
    cycloneStreak: 0,
    ...overrides,
  };
}

describe("StormSystem spawning", () => {
  it("spawns at least as many storms during a boosted wet-season peak as during a baseline day with the same seed (deterministic, not statistical -- see the profiles' own comments)", () => {
    seedSimRandom(12345);
    const noWetSeason = new StormSystem();
    const weatherA = new WeatherSystem(7, BOUNDS, NO_WET_SEASON_PROFILE);
    for (let day = 1; day <= 20; day++) noWetSeason.simulateDay(day, weatherA, START_DATE);
    const baselineCount = noWetSeason.storms.length;

    seedSimRandom(12345); // same seed -- identical draw sequence
    const wetSeason = new StormSystem();
    const weatherB = new WeatherSystem(7, BOUNDS, WET_SEASON_PROFILE); // same WeatherSystem seed too -- same base noise field
    for (let day = 1; day <= 20; day++) wetSeason.simulateDay(day, weatherB, START_DATE);
    const wetSeasonCount = wetSeason.storms.length;

    expect(wetSeasonCount).toBeGreaterThanOrEqual(baselineCount);
  });

  it("produces at least one storm somewhere over 20 days at a boosted wet-season peak", () => {
    seedSimRandom(1);
    const system = new StormSystem();
    const weather = new WeatherSystem(3, BOUNDS, WET_SEASON_PROFILE);
    for (let day = 1; day <= 20; day++) system.simulateDay(day, weather, START_DATE);
    expect(system.storms.length).toBeGreaterThan(0);
  });
});

describe("storm frequency global setting", () => {
  afterEach(() => {
    setStormFrequency(DEFAULT_STORM_FREQUENCY_MULTIPLIER);
  });

  it("defaults to 1.0", () => {
    expect(getStormFrequency()).toBe(1.0);
    expect(DEFAULT_STORM_FREQUENCY_MULTIPLIER).toBe(1.0);
  });

  it("setStormFrequency changes the global multiplier read back by getStormFrequency, clamped to a minimum of 0", () => {
    setStormFrequency(2.5);
    expect(getStormFrequency()).toBe(2.5);
    setStormFrequency(-5);
    expect(getStormFrequency()).toBe(0);
  });

  it("a multiplier of 0 spawns nothing, even at a boosted wet-season peak", () => {
    setStormFrequency(0);
    seedSimRandom(1);
    const system = new StormSystem();
    const weather = new WeatherSystem(3, BOUNDS, WET_SEASON_PROFILE);
    for (let day = 1; day <= 20; day++) system.simulateDay(day, weather, START_DATE);
    expect(system.storms.length).toBe(0);
  });

  it("a higher multiplier spawns at least as many storms as the default, given the same seed", () => {
    seedSimRandom(999);
    setStormFrequency(DEFAULT_STORM_FREQUENCY_MULTIPLIER);
    const normal = new StormSystem();
    const weatherA = new WeatherSystem(5, BOUNDS, NO_WET_SEASON_PROFILE);
    for (let day = 1; day <= 20; day++) normal.simulateDay(day, weatherA, START_DATE);
    const normalCount = normal.storms.length;

    seedSimRandom(999); // same seed -- identical draw sequence
    setStormFrequency(5);
    const boosted = new StormSystem();
    const weatherB = new WeatherSystem(5, BOUNDS, NO_WET_SEASON_PROFILE); // same WeatherSystem seed too
    for (let day = 1; day <= 20; day++) boosted.simulateDay(day, weatherB, START_DATE);
    const boostedCount = boosted.storms.length;

    expect(boostedCount).toBeGreaterThanOrEqual(normalCount);
  });
});

describe("StormSystem movement", () => {
  it("drifts toward the local prevailing wind direction", () => {
    seedSimRandom(1);
    const system = new StormSystem();
    const storm = makeStorm({ age: 5, intensity: 1 }); // already past growth, so intensity/radius stay stable this step
    system.storms.push(storm);
    const weather = new WeatherSystem(1, BOUNDS, EASTWARD_WIND_PROFILE);
    const startX = storm.x;

    system.simulateDay(1, weather, START_DATE);

    // Wind is due east (90deg) with zero wobble -- the storm must have moved
    // strictly eastward (+x), regardless of the small residual wobble noise.
    expect(storm.x).toBeGreaterThan(startX);
  });
});

describe("StormSystem lifecycle", () => {
  it("ramps intensity up through the growth phase, holds at peak through the plateau, then decays and eventually dissipates", () => {
    seedSimRandom(1);
    const system = new StormSystem();
    const storm = makeStorm({ peakIntensity: 1, age: 0 });
    system.storms.push(storm);
    const weather = new WeatherSystem(1, BOUNDS, NO_WET_SEASON_PROFILE);

    system.simulateDay(1, weather, START_DATE); // age 1 -- partway through the 4-day growth ramp
    expect(storm.age).toBe(1);
    expect(storm.intensity).toBeGreaterThan(0);
    expect(storm.intensity).toBeLessThan(1);

    for (let day = 2; day <= 4; day++) system.simulateDay(day, weather, START_DATE);
    expect(storm.age).toBe(4);
    expect(storm.intensity).toBe(1); // plateau

    for (let day = 5; day <= 12; day++) system.simulateDay(day, weather, START_DATE);
    expect(storm.age).toBe(12);
    expect(storm.intensity).toBeGreaterThan(0);
    expect(storm.intensity).toBeLessThan(1); // partway through decay

    system.simulateDay(13, weather, START_DATE);
    // By day 13 (4 growth + 3 plateau + 6 decay) the storm has fully decayed
    // and is removed from the active list.
    expect(system.storms.find((s) => s.id === storm.id)).toBeUndefined();
  });
});

describe("StormSystem cyclone escalation", () => {
  it("escalates a sustained, warm, mid-latitude Storm into a cyclone after CYCLONE_SUSTAIN_DAYS, and it stays a cyclone", () => {
    seedSimRandom(1);
    const system = new StormSystem();
    const bounds: Bounds = { x0: 0, y0: 0, x1: 2000, y1: 2000 };
    // y at the bounds' vertical center maps to exactly centerLatitudeDeg (17) -- see WeatherSystem.latitudeDeg.
    const storm = makeStorm({ x: 1000, y: 1000, peakIntensity: 1, age: 3 }); // simulateDay below brings it to age 4 -> plateau, intensity 1
    system.storms.push(storm);
    const weather = new WeatherSystem(1, bounds, CYCLONE_TEST_PROFILE);

    expect(storm.isCyclone).toBe(false);
    system.simulateDay(1, weather, START_DATE); // age 4, streak 1
    expect(storm.isCyclone).toBe(false);
    system.simulateDay(2, weather, START_DATE); // age 5, streak 2
    expect(storm.isCyclone).toBe(false);
    system.simulateDay(3, weather, START_DATE); // age 6, streak 3 -- escalates
    expect(storm.isCyclone).toBe(true);

    // Stays a cyclone even once it starts decaying below the intensity
    // threshold (a real cyclone doesn't un-become one crossing cooler water).
    for (let day = 4; day <= 10; day++) system.simulateDay(day, weather, START_DATE);
    expect(storm.isCyclone).toBe(true);
  });

  it("does not escalate a Storm whose intensity never sustains above the threshold", () => {
    seedSimRandom(1);
    const system = new StormSystem();
    const bounds: Bounds = { x0: 0, y0: 0, x1: 2000, y1: 2000 };
    const storm = makeStorm({ x: 1000, y: 1000, peakIntensity: 0.3, age: 3 }); // below CYCLONE_MIN_INTENSITY (0.6) even at plateau
    system.storms.push(storm);
    const weather = new WeatherSystem(1, bounds, CYCLONE_TEST_PROFILE);

    for (let day = 1; day <= 10; day++) system.simulateDay(day, weather, START_DATE);
    expect(storm.isCyclone).toBe(false);
  });
});

describe("stormAt", () => {
  it("finds the most intense Storm covering a position, and returns null outside every Storm's radius", () => {
    const weak = makeStorm({ id: 1, x: 0, y: 0, radius: 400, intensity: 0.3 });
    const strong = makeStorm({ id: 2, x: 100, y: 0, radius: 400, intensity: 0.9 });
    const storms = [weak, strong];

    expect(stormAt(storms, { x: 50, y: 0 })?.id).toBe(2); // covered by both, picks the more intense
    expect(stormAt(storms, { x: -350, y: 0 })?.id).toBe(1); // only weak's radius (400) reaches here; strong's (dist 450) doesn't
    expect(stormAt(storms, { x: 5000, y: 5000 })).toBeNull();
  });
});
