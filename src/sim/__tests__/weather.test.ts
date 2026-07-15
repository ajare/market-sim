import { describe, expect, it } from "vitest";
import { WeatherSystem, WEATHER_PROFILES, type Bounds } from "../weather";
import { WEATHER_PROFILE_NAMES } from "@market-sim/shared/weatherProfiles";

const DEFAULT_PROFILE = WEATHER_PROFILES.default;
const CARIBBEAN_PROFILE = WEATHER_PROFILES.caribbean;

const BOUNDS: Bounds = { x0: 0, y0: 0, x1: 9000, y1: 9000 };
const EQUATOR = { x: 4500, y: 4500 };
const NORTH_EDGE = { x: 4500, y: 0 };
const SOUTH_EDGE = { x: 4500, y: 9000 };

// Tall enough (12420 = 90deg * 69mi/deg * 2) that the edges land exactly on
// the default profile's pole anchor (90deg) -- used for tests that check
// against the profile's actual reference values.
const POLE_TO_POLE_BOUNDS: Bounds = { x0: 0, y0: 0, x1: 9000, y1: 12420 };

// Sized so the vertical span covers roughly the Caribbean profile's own
// 10-25deg anchor band (half-height 750/69 = ~10.9deg either side of the
// 17deg center -- edges land at ~6deg and ~28deg, just past both anchors).
const CARIBBEAN_BOUNDS: Bounds = { x0: 0, y0: 0, x1: 3000, y1: 1500 };

describe("WeatherSystem determinism", () => {
  it("returns identical values for repeated calls with the same (timeOfYear, position)", () => {
    const weather = new WeatherSystem(1, BOUNDS, DEFAULT_PROFILE);
    const pos = { x: 1234, y: 5678 };
    expect(weather.temperature(0.3, pos)).toBe(weather.temperature(0.3, pos));
    expect(weather.rainfall(0.3, pos)).toBe(weather.rainfall(0.3, pos));
    expect(weather.windSpeed(0.3, pos)).toBe(weather.windSpeed(0.3, pos));
    expect(weather.windDirection(0.3, pos)).toBe(weather.windDirection(0.3, pos));
  });

  it("gives different weather for different seeds at the same input", () => {
    const a = new WeatherSystem(1, BOUNDS, DEFAULT_PROFILE);
    const b = new WeatherSystem(2, BOUNDS, DEFAULT_PROFILE);
    const pos = { x: 1234, y: 5678 };
    expect(a.rainfall(0.3, pos)).not.toBe(b.rainfall(0.3, pos));
  });

  it("produces the same weather across two independently-constructed instances with the same seed", () => {
    const a = new WeatherSystem(42, BOUNDS, DEFAULT_PROFILE);
    const b = new WeatherSystem(42, BOUNDS, DEFAULT_PROFILE);
    const pos = { x: 777, y: 222 };
    expect(a.temperature(0.6, pos)).toBe(b.temperature(0.6, pos));
    expect(a.windDirection(0.6, pos)).toBe(b.windDirection(0.6, pos));
  });
});

describe("WeatherSystem seasonal/latitude shape (default profile)", () => {
  it("keeps rainfall and windDirection within their documented ranges across a sweep of inputs", () => {
    const weather = new WeatherSystem(7, BOUNDS, DEFAULT_PROFILE);
    for (let i = 0; i < 50; i++) {
      const t = i / 50;
      const pos = { x: (i * 173) % 9000, y: (i * 911) % 9000 };
      const rain = weather.rainfall(t, pos);
      const dir = weather.windDirection(t, pos);
      const speed = weather.windSpeed(t, pos);
      expect(rain).toBeGreaterThanOrEqual(0);
      expect(rain).toBeLessThanOrEqual(1);
      expect(dir).toBeGreaterThanOrEqual(0);
      expect(dir).toBeLessThan(360);
      expect(speed).toBeGreaterThanOrEqual(0);
    }
  });

  it("is on average colder toward the map edges (poles) than at the vertical center (equator), for a fixed timeOfYear", () => {
    const weather = new WeatherSystem(11, BOUNDS, DEFAULT_PROFILE);
    let equatorSum = 0;
    let edgeSum = 0;
    const samples = 30;
    for (let i = 0; i < samples; i++) {
      const t = i / samples;
      equatorSum += weather.temperature(t, EQUATOR);
      edgeSum += weather.temperature(t, NORTH_EDGE) + weather.temperature(t, SOUTH_EDGE);
    }
    expect(equatorSum / samples).toBeGreaterThan(edgeSum / (samples * 2));
  });

  it("has a wider seasonal swing at the poles than at the equator", () => {
    const weather = new WeatherSystem(11, BOUNDS, DEFAULT_PROFILE);
    const range = (pos: { x: number; y: number }) => {
      let min = Infinity;
      let max = -Infinity;
      for (let i = 0; i < 30; i++) {
        const temp = weather.temperature(i / 30, pos);
        min = Math.min(min, temp);
        max = Math.max(max, temp);
      }
      return max - min;
    };
    expect(range(NORTH_EDGE)).toBeGreaterThan(range(EQUATOR));
  });

  it("wraps timeOfYear seamlessly -- values just before 1.0 are close to values just after 0.0", () => {
    const weather = new WeatherSystem(3, BOUNDS, DEFAULT_PROFILE);
    const pos = { x: 2000, y: 3000 };
    const justBefore = weather.rainfall(0.999, pos);
    const justAfter = weather.rainfall(0.001, pos);
    expect(Math.abs(justBefore - justAfter)).toBeLessThan(0.2);
  });

  it("is spatially smooth -- weather at two nearby positions is closer than at two far-apart positions", () => {
    const weather = new WeatherSystem(5, BOUNDS, DEFAULT_PROFILE);
    const t = 0.4;
    const base = { x: 4000, y: 4000 };
    const near = { x: 4050, y: 4000 };
    const far = { x: 8900, y: 100 };
    const nearDiff = Math.abs(weather.rainfall(t, base) - weather.rainfall(t, near));
    const farDiff = Math.abs(weather.rainfall(t, base) - weather.rainfall(t, far));
    expect(nearDiff).toBeLessThanOrEqual(farDiff);
  });

  it("averages close to the profile's warmTemperatureC/coolTemperatureC at the equator/pole, once seasonal swing is averaged out over a year", () => {
    const weather = new WeatherSystem(13, POLE_TO_POLE_BOUNDS, DEFAULT_PROFILE);
    const equatorPoint = { x: 0, y: POLE_TO_POLE_BOUNDS.y1 / 2 };
    const polePoint = { x: 0, y: 0 };
    const yearAverage = (pos: { x: number; y: number }) => {
      let sum = 0;
      const samples = 60;
      for (let i = 0; i < samples; i++) sum += weather.temperature(i / samples, pos);
      return sum / samples;
    };
    // Seasonal term averages to ~0 over a full year; what's left is the
    // latitude baseline minus the average storminess cooling (up to
    // stormCoolingC, mean storminess ~0.5) -- so within a few degrees of the
    // profile's own reference value at each anchor latitude.
    expect(yearAverage(equatorPoint)).toBeGreaterThan(DEFAULT_PROFILE.warmTemperatureC - DEFAULT_PROFILE.stormCoolingC - 1);
    expect(yearAverage(equatorPoint)).toBeLessThan(DEFAULT_PROFILE.warmTemperatureC + 1);
    expect(yearAverage(polePoint)).toBeGreaterThan(DEFAULT_PROFILE.coolTemperatureC - DEFAULT_PROFILE.stormCoolingC - 1);
    expect(yearAverage(polePoint)).toBeLessThan(DEFAULT_PROFILE.coolTemperatureC + 1);
  });
});

describe("WeatherSystem storminess correlation (default profile)", () => {
  it("raises wind speed above its calm baseline exactly when rainfall (storminess) is high", () => {
    const weather = new WeatherSystem(9, BOUNDS, DEFAULT_PROFILE);
    let highRainWind = -Infinity;
    let lowRainWind = Infinity;
    let highRain = 0;
    let lowRain = 1;
    for (let i = 0; i < 60; i++) {
      const t = i / 60;
      const pos = { x: (i * 137) % 9000, y: 4500 };
      const rain = weather.rainfall(t, pos);
      const wind = weather.windSpeed(t, pos);
      if (rain > highRain) {
        highRain = rain;
        highRainWind = wind;
      }
      if (rain < lowRain) {
        lowRain = rain;
        lowRainWind = wind;
      }
    }
    expect(highRainWind).toBeGreaterThan(lowRainWind);
  });

  it("cools temperature below its clear-sky baseline exactly when rainfall (storminess) is high", () => {
    const weather = new WeatherSystem(9, BOUNDS, DEFAULT_PROFILE);
    let highRainTemp = Infinity;
    let lowRainTemp = -Infinity;
    let highRain = 0;
    let lowRain = 1;
    for (let i = 0; i < 60; i++) {
      const t = i / 60;
      const pos = { x: (i * 137) % 9000, y: 4500 };
      const rain = weather.rainfall(t, pos);
      const temp = weather.temperature(t, pos);
      if (rain > highRain) {
        highRain = rain;
        highRainTemp = temp;
      }
      if (rain < lowRain) {
        lowRain = rain;
        lowRainTemp = temp;
      }
    }
    expect(highRainTemp).toBeLessThan(lowRainTemp);
  });
});

describe("WeatherSystem profiles", () => {
  it("WEATHER_PROFILES has exactly the shared registry's named profiles", () => {
    expect(Object.keys(WEATHER_PROFILES).sort()).toEqual([...WEATHER_PROFILE_NAMES].sort());
  });

  it("default has no prevailing wind direction -- windDirection stays spread across the whole circle", () => {
    expect(DEFAULT_PROFILE.prevailingWindDirectionDeg).toBeNull();
    const weather = new WeatherSystem(21, BOUNDS, DEFAULT_PROFILE);
    let min = 360;
    let max = 0;
    for (let i = 0; i < 80; i++) {
      const dir = weather.windDirection(i / 80, { x: (i * 331) % 9000, y: (i * 577) % 9000 });
      min = Math.min(min, dir);
      max = Math.max(max, dir);
    }
    // Pure noise over 80 samples should easily spread across most of the circle.
    expect(max - min).toBeGreaterThan(270);
  });

  it("default has no wet-season bias -- wetSeasonAmplitude is 0", () => {
    expect(DEFAULT_PROFILE.wetSeasonAmplitude).toBe(0);
  });

  it("caribbean's wind direction always stays within prevailingWindDirectionDeg +- windDirectionSpreadDeg", () => {
    const weather = new WeatherSystem(21, CARIBBEAN_BOUNDS, CARIBBEAN_PROFILE);
    const { prevailingWindDirectionDeg, windDirectionSpreadDeg } = CARIBBEAN_PROFILE;
    for (let i = 0; i < 100; i++) {
      const dir = weather.windDirection(i / 100, { x: (i * 91) % 3000, y: (i * 233) % 1500 });
      expect(dir).toBeGreaterThanOrEqual(prevailingWindDirectionDeg! - windDirectionSpreadDeg);
      expect(dir).toBeLessThanOrEqual(prevailingWindDirectionDeg! + windDirectionSpreadDeg);
    }
  });

  it("caribbean is warm nearly everywhere, unlike default's dramatic equator-to-pole swing over the same bounds", () => {
    const caribbean = new WeatherSystem(21, CARIBBEAN_BOUNDS, CARIBBEAN_PROFILE);
    const top = { x: 1500, y: 0 };
    const bottom = { x: 1500, y: 1500 };
    const yearAverage = (weather: WeatherSystem, pos: { x: number; y: number }) => {
      let sum = 0;
      for (let i = 0; i < 30; i++) sum += weather.temperature(i / 30, pos);
      return sum / 30;
    };
    const topTemp = yearAverage(caribbean, top);
    const bottomTemp = yearAverage(caribbean, bottom);
    // Both edges of a Caribbean-tagged world stay in the tropics -- nowhere
    // near the profile's own cold end (Default's coolTemperatureC).
    expect(topTemp).toBeGreaterThan(15);
    expect(bottomTemp).toBeGreaterThan(15);
  });

  it("caribbean has a wet season that peaks near wetSeasonPeakTimeOfYear, well above the opposite (dry) half of the year", () => {
    const weather = new WeatherSystem(31, CARIBBEAN_BOUNDS, CARIBBEAN_PROFILE);
    const peak = CARIBBEAN_PROFILE.wetSeasonPeakTimeOfYear;
    const trough = (peak + 0.5) % 1;
    const averageAround = (center: number) => {
      let sum = 0;
      const n = 20;
      for (let i = 0; i < n; i++) {
        const t = (center - 0.05 + (i / n) * 0.1 + 1) % 1;
        sum += weather.rainfall(t, { x: (i * 61) % 3000, y: (i * 89) % 1500 });
      }
      return sum / n;
    };
    expect(averageAround(peak)).toBeGreaterThan(averageAround(trough));
  });
});
